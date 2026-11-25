import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Bridge } from "../bridge.js";

/** A plugin stand-in that records messages from its first frame on (queued ones arrive with `open`). */
async function client(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?token=${token}`);
  const inbox: unknown[] = [];
  const waiters: ((m: unknown) => void)[] = [];
  ws.on("message", (data, isBinary) => {
    // OpenIDEA drops text frames: everything must arrive binary.
    assert.equal(isBinary, true);
    const msg = JSON.parse(String(data));
    const w = waiters.shift();
    if (w) w(msg);
    else inbox.push(msg);
  });
  await once(ws, "open");
  const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise<unknown>((r) => waiters.push(r)));
  return { ws, next };
}

async function started(): Promise<Bridge> {
  const bridge = new Bridge({ port: 0, token: "secret" });
  await bridge.listening();
  return bridge;
}

test("rejects a wrong token", async () => {
  const bridge = await started();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge?token=nope`);
  const [err] = await once(ws, "error");
  assert.match(String(err), /401/);
  await bridge.close();
});

test("queues messages until the plugin connects, then routes both ways", async () => {
  const bridge = await started();
  bridge.postToWebview({ type: "queued" });

  const plugin = await client(bridge.port, "secret");
  assert.deepEqual(await plugin.next(), { t: "webview", msg: { type: "queued" } });

  const got = once(bridge, "webview");
  plugin.ws.send(JSON.stringify({ t: "webview", msg: { type: "newTask" } }));
  assert.deepEqual(await got, [{ type: "newTask" }]);

  // IDE requests go to the page (window context), which relays them to the plugin.
  const answer = bridge.ide<number>("activeEditor");
  const req = (await plugin.next()) as { t: string; msg: { type: string; id: number; op: string } };
  assert.equal(req.t, "webview");
  assert.equal(req.msg.type, "zoo-bridge/ide");
  assert.equal(req.msg.op, "activeEditor");
  plugin.ws.send(JSON.stringify({ t: "ide-result", id: req.msg.id, ok: true, value: 42 }));
  assert.equal(await answer, 42);

  const failed = bridge.ide("openLocation");
  const req2 = (await plugin.next()) as { msg: { id: number } };
  plugin.ws.send(JSON.stringify({ t: "ide-result", id: req2.msg.id, ok: false, error: "no project" }));
  await assert.rejects(failed, /no project/);

  plugin.ws.close();
  await bridge.close();
});

/**
 * As OpenIDEA's plugin WebSocket: it closes the connection on a frame over
 * 1 MiB or when over 256 frames / 8 MiB wait unread. A plugin announcing
 * flow control must never get there, however much Zoo Code sends at once.
 */
test("with flow control, big messages and bursts stay within the host's limits", async () => {
  const bridge = await started();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge?token=secret`);
  await once(ws, "open");
  const window = { frames: 16, bytes: 2 << 20, part: 256 << 10 };
  ws.send(JSON.stringify({ t: "flow", ...window }));
  const unread: Buffer[] = [];
  let maxUnread = 0;
  let maxBytes = 0;
  ws.on("message", (data) => {
    const b = data as Buffer;
    assert.ok(b.length <= window.part, `frame of ${b.length} bytes`);
    unread.push(b);
    maxUnread = Math.max(maxUnread, unread.length);
    maxBytes = Math.max(maxBytes, unread.reduce((n, x) => n + x.length, 0));
  });

  const big = "x".repeat(3 << 20) + "é\"";
  for (let i = 0; i < 300; i++) bridge.postToWebview({ type: "partial", i });
  bridge.postToWebview({ type: "state", big });
  bridge.postToWebview({ type: "after" });

  // A slow plugin: reads up to 8 frames every few ms, then acknowledges them.
  const got: { type: string; i?: number; big?: string }[] = [];
  let partial = "";
  while (got.length < 302) {
    await new Promise((r) => setTimeout(r, 2));
    const batch = unread.splice(0, 8);
    for (const b of batch) {
      const m = JSON.parse(String(b)) as { t: string; last?: boolean; data?: string; msg?: never };
      if (m.t === "part") {
        partial += m.data;
        if (!m.last) continue;
        got.push((JSON.parse(partial) as { msg: never }).msg);
        partial = "";
      } else got.push(m.msg!);
    }
    if (batch.length) ws.send(JSON.stringify({ t: "ack", n: batch.length }));
  }
  assert.ok(maxUnread <= window.frames, `${maxUnread} frames unread`);
  assert.ok(maxBytes <= window.bytes + window.part, `${maxBytes} bytes unread`);
  assert.deepEqual(got.slice(0, 300).map((m) => m.i), [...Array(300).keys()]);
  assert.equal(got[300]!.big, big);
  assert.equal(got[301]!.type, "after");

  // From the plugin too: a page message in parts arrives whole.
  const text = JSON.stringify({ t: "webview", msg: { type: "image", data: "y".repeat(100_000) } });
  const received = once(bridge, "webview");
  ws.send(JSON.stringify({ t: "part", last: false, data: text.slice(0, 1000) }));
  ws.send(JSON.stringify({ t: "part", last: true, data: text.slice(1000) }));
  assert.equal(((await received)[0] as { data: string }).data.length, 100_000);
  ws.close();
  await bridge.close();
});

test("a new plugin instance replaces the old connection", async () => {
  const bridge = await started();
  const a = await client(bridge.port, "secret");
  const closed = once(a.ws, "close");
  const b = await client(bridge.port, "secret");
  const [code] = await closed;
  assert.equal(code, 4000);
  bridge.postToWebview({ type: "toB" });
  assert.deepEqual(await b.next(), { t: "webview", msg: { type: "toB" } });
  b.ws.close();
  await bridge.close();
});
