// The WebSocket the OpenIDEA plugin connects to (see docs/ARCHITECTURE.md §3).
//
// One plugin instance at a time: a new connection replaces the old one (an
// instance reclaimed while idle reconnects as a new one). Messages sent while
// no plugin is connected are queued and flushed on the next connection.
//
// OpenIDEA's plugin WebSocket closes the connection when a message is over
// 1 MiB, or when more than 256 messages / 8 MiB wait for the plugin to read
// them. Zoo Code sends its whole state (which grows with the task) and bursts
// of streaming updates, so a plugin that announces flow control
// (`{t:"flow"}`, first thing after connecting) gets:
// - messages over `part` bytes split into `{t:"part"}` frames, in order;
// - at most `frames` / `bytes` frames it has not acknowledged (`{t:"ack"}`
//   after each read). The rest waits here.

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

export type FromPlugin =
  | { t: "webview"; msg: unknown }
  | { t: "ide-result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "event"; kind: string; data: unknown }
  | { t: "command"; id: string; args: unknown }
  | { t: "shutdown" }
  | { t: "flow"; frames: number; bytes: number; part: number }
  | { t: "ack"; n: number }
  | { t: "part"; last: boolean; data: string };

export type ToPlugin =
  | { t: "webview"; msg: unknown }
  | { t: "ide"; id: number; op: string; args: unknown }
  | { t: "notify"; level: "info" | "warning" | "error"; message: string }
  | { t: "ping" };

/** Flow control a plugin announced (see the top of this file). */
interface Flow {
  frames: number;
  bytes: number;
  part: number;
}

/** A message waiting to be sent, and how many of its parts already went out. */
interface Outgoing {
  text: string;
  parts: string[] | undefined;
  sent: number;
}

/** `text` as part frames of at most `max` UTF-8 bytes each. */
export function splitParts(text: string, max: number): string[] {
  // Room for the frame's own JSON; a character escapes to at most 6 bytes.
  const budget = Math.max(1024, Math.floor((max - 64) / 6));
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    let end = Math.min(text.length, i + budget);
    // Do not split a surrogate pair.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    out.push(JSON.stringify({ t: "part", last: end >= text.length, data: text.slice(i, end) }));
    i = end;
  }
  return out;
}

export interface BridgeOptions {
  port: number;
  token: string;
  /** Keep-alive period: a delivered message keeps the plugin instance from idle reclaim (5 min). */
  pingMs?: number;
  /** How long an `ide` request may wait for its answer. */
  ideTimeoutMs?: number;
  /** Most messages kept while no plugin is connected. */
  maxQueue?: number;
}

export interface BridgeEvents {
  webview: [msg: unknown];
  event: [kind: string, data: unknown];
  command: [id: string, args: unknown];
  shutdown: [];
  connected: [];
  disconnected: [];
}

/**
 * OpenIDEA's host-owned WebSocket queues only binary frames for the plugin
 * (text frames are dropped), so JSON goes out as UTF-8 bytes.
 */
function sendFrame(ws: WebSocket, text: string): void {
  ws.send(Buffer.from(text, "utf8"), { binary: true });
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Bridge extends EventEmitter<BridgeEvents> {
  private readonly server: WebSocketServer;
  private socket: WebSocket | undefined;
  /** Messages not sent yet, oldest first (the first may be partly sent). */
  private readonly queue: Outgoing[] = [];
  /** The connected plugin's flow control: undefined until it says, null for none. */
  private flow: Flow | null | undefined;
  private flowTimer: NodeJS.Timeout | undefined;
  /** Sizes of the frames sent and not acknowledged yet. */
  private inflight: number[] = [];
  private inflightBytes = 0;
  /** Parts of a message from the plugin. */
  private incoming = "";
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private readonly ping: NodeJS.Timeout;

  constructor(private readonly opts: BridgeOptions) {
    super();
    this.server = new WebSocketServer({
      host: "127.0.0.1",
      port: opts.port,
      path: "/bridge",
      verifyClient: ({ req }: { req: IncomingMessage }) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        return sameToken(url.searchParams.get("token") ?? "", opts.token);
      },
    });
    this.server.on("connection", (ws) => this.attach(ws));
    // Only when idle: anything else being sent keeps the instance in use too.
    this.ping = setInterval(() => {
      if (this.connected && this.queue.length === 0) this.send({ t: "ping" });
    }, opts.pingMs ?? 60_000);
    this.ping.unref();
  }

  /** Resolves once the server listens. */
  listening(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server.address()) return resolve();
      this.server.once("listening", resolve);
      this.server.once("error", reject);
    });
  }

  /** The bound port (useful when `port` was 0). */
  get port(): number {
    const addr = this.server.address();
    return typeof addr === "object" && addr ? addr.port : this.opts.port;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Posts to Zoo Code's web view. */
  postToWebview(msg: unknown): void {
    this.send({ t: "webview", msg });
  }

  notify(level: "info" | "warning" | "error", message: string): void {
    this.send({ t: "notify", level, message });
  }

  /**
   * Asks the plugin to do something only the IDE can do (open a file, show a
   * diff, read problems). The request goes through the tool window page:
   * OpenIDEA runs editor APIs only from a window's command or event, and the
   * page's messages are window events while `websocket-ready` is not. So
   * this needs the tool window open; otherwise it times out.
   */
  ide<T = unknown>(op: string, args: unknown = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ide request ${op} timed out (is the Zoo Bridge tool window open?)`));
      }, this.opts.ideTimeoutMs ?? 15_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ t: "webview", msg: { type: "zoo-bridge/ide", id, op, args } });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.ping);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge closed"));
    }
    this.pending.clear();
    this.socket?.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private send(msg: ToPlugin): void {
    this.queue.push({ text: JSON.stringify(msg), parts: undefined, sent: 0 });
    const max = this.opts.maxQueue ?? 1000;
    // Drop the oldest, but never a message whose first parts already went out.
    while (this.queue.length > max) this.queue.splice(this.queue[0]!.sent > 0 ? 1 : 0, 1);
    this.pump();
  }

  /** Sends what the plugin's flow control allows. */
  private pump(): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.flow === undefined) return;
    const flow = this.flow;
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      if (!flow) {
        sendFrame(ws, head.text);
        this.queue.shift();
        continue;
      }
      head.parts ??= Buffer.byteLength(head.text) > flow.part ? splitParts(head.text, flow.part) : [head.text];
      const frame = head.parts[head.sent]!;
      const size = Buffer.byteLength(frame);
      // Over the window: wait for an ack (one frame always goes, or nothing would).
      if (this.inflight.length > 0 && (this.inflight.length >= flow.frames || this.inflightBytes + size > flow.bytes)) return;
      sendFrame(ws, frame);
      this.inflight.push(size);
      this.inflightBytes += size;
      if (++head.sent === head.parts.length) this.queue.shift();
    }
  }

  private attach(ws: WebSocket): void {
    this.socket?.close(4000, "replaced");
    this.socket = ws;
    this.incoming = "";
    this.inflight = [];
    this.inflightBytes = 0;
    // A message cut by the last connection goes again whole.
    if (this.queue[0]) this.queue[0].sent = 0;
    // A plugin that does flow control says so first; an older one never does.
    this.flow = undefined;
    clearTimeout(this.flowTimer);
    this.flowTimer = setTimeout(() => {
      if (this.socket === ws && this.flow === undefined) {
        this.flow = null;
        this.pump();
      }
    }, 1000);
    ws.on("message", (data) => this.receive(data.toString()));
    ws.on("close", (code, reason) => {
      if (this.socket === ws) {
        this.socket = undefined;
        clearTimeout(this.flowTimer);
        if (this.queue[0]) this.queue[0].sent = 0;
        console.log(`[zoo] connection closed (${code}${reason.length ? " " + reason.toString() : ""}) at ${new Date().toISOString()}`);
        this.emit("disconnected");
      }
    });
    this.emit("connected");
  }

  private receive(text: string): void {
    let msg: FromPlugin;
    try {
      msg = JSON.parse(text) as FromPlugin;
    } catch {
      return;
    }
    switch (msg.t) {
      case "flow":
        this.flow = { frames: Math.max(1, msg.frames), bytes: Math.max(4096, msg.bytes), part: Math.max(4096, msg.part) };
        clearTimeout(this.flowTimer);
        this.pump();
        break;
      case "ack":
        for (let i = 0; i < msg.n && this.inflight.length > 0; i++) this.inflightBytes -= this.inflight.shift()!;
        this.pump();
        break;
      case "part":
        this.incoming += msg.data;
        if (msg.last) {
          const whole = this.incoming;
          this.incoming = "";
          this.receive(whole);
        }
        break;
      case "webview":
        this.emit("webview", msg.msg);
        break;
      case "ide-result": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error ?? "ide request failed"));
        break;
      }
      case "event":
        this.emit("event", msg.kind, msg.data);
        break;
      case "command":
        this.emit("command", msg.id, msg.args);
        break;
      case "shutdown":
        this.emit("shutdown");
        break;
    }
  }
}
