// The WebSocket the OpenIDEA plugin connects to (see docs/ARCHITECTURE.md §3).
//
// One plugin instance at a time: a new connection replaces the old one (an
// instance reclaimed while idle reconnects as a new one). Messages sent while
// no plugin is connected are queued and flushed on the next connection.

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

export type FromPlugin =
  | { t: "webview"; msg: unknown }
  | { t: "ide-result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "event"; kind: string; data: unknown }
  | { t: "command"; id: string; args: unknown }
  | { t: "shutdown" };

export type ToPlugin =
  | { t: "webview"; msg: unknown }
  | { t: "ide"; id: number; op: string; args: unknown }
  | { t: "notify"; level: "info" | "warning" | "error"; message: string }
  | { t: "ping" };

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
  private readonly queue: string[] = [];
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
    this.ping = setInterval(() => this.sendNow({ t: "ping" }), opts.pingMs ?? 60_000);
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
    if (!this.sendNow(msg)) {
      this.queue.push(JSON.stringify(msg));
      const max = this.opts.maxQueue ?? 1000;
      if (this.queue.length > max) this.queue.splice(0, this.queue.length - max);
    }
  }

  private sendNow(msg: ToPlugin): boolean {
    if (!this.connected) return false;
    sendFrame(this.socket!, JSON.stringify(msg));
    return true;
  }

  private attach(ws: WebSocket): void {
    this.socket?.close(4000, "replaced");
    this.socket = ws;
    ws.on("message", (data) => this.receive(data.toString()));
    ws.on("close", () => {
      if (this.socket === ws) {
        this.socket = undefined;
        this.emit("disconnected");
      }
    });
    for (const text of this.queue.splice(0)) sendFrame(ws, text);
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
