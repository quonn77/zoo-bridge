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
