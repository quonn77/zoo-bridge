// Dev tool: starts the sidecar and plays the OpenIDEA plugin + page, to see
// the extension activate and answer without the IDE.
//   node scripts/fake-plugin.mjs [<workspace>] [<data dir>]
// Prints what the sidecar posts to the web view (message types) and its log.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = process.argv[2] ?? process.cwd();
const dataDir = process.argv[3] ?? mkdtempSync(join(tmpdir(), "zoo-data-"));
const portFile = join(dataDir, "sidecar.port");
const token = "fake-plugin";

const child = spawn(process.execPath, [join(here, "..", "dist", "main.js")], {
  env: { ...process.env, ZOO_TOKEN: token, ZOO_PORT: "0", ZOO_PORT_FILE: portFile, ZOO_WORKSPACE: workspace, ZOO_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write(`  sidecar | ${d}`));
child.stderr.on("data", (d) => process.stdout.write(`  sidecar! ${d}`));

const deadline = Date.now() + 10_000;
while (!existsSync(portFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
const port = readFileSync(portFile, "utf8").trim();
const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?token=${token}`);
const seen = {};
ws.on("message", (data) => {
  const m = JSON.parse(String(data));
  if (m.t === "webview" && m.msg?.type === "zoo-bridge/ide") {
    // An IDE request relayed by the page: answer as the plugin would.
    console.log(`→ ide ${m.msg.op} ${JSON.stringify(m.msg.args).slice(0, 120)}`);
    ws.send(Buffer.from(JSON.stringify({ t: "ide-result", id: m.msg.id, ok: true, value: m.msg.op === "problems" ? {} : null })), { binary: true });
  } else if (m.t === "webview") {
    const type = m.msg?.type;
    seen[type] = (seen[type] ?? 0) + 1;
    if (seen[type] === 1)
      console.log(
        `→ webview ${type}${type === "state" ? ` (keys: ${Object.keys(m.msg.state ?? {}).length}, version ${m.msg.state?.version}, telemetry ${m.msg.state?.telemetrySetting})` : ""}`,
      );
  } else if (m.t === "ide") {
    console.log(`→ ide ${m.op} ${JSON.stringify(m.args).slice(0, 120)}`);
    ws.send(Buffer.from(JSON.stringify({ t: "ide-result", id: m.id, ok: true, value: null })), { binary: true });
  } else if (m.t !== "ping") {
    console.log(`→ ${JSON.stringify(m).slice(0, 200)}`);
  }
});
await new Promise((r) => ws.once("open", r));
console.log(`connected to sidecar on ${port}; data ${dataDir}`);
const send = (msg) => ws.send(Buffer.from(JSON.stringify({ t: "webview", msg })), { binary: true });
send({ type: "webviewDidLaunch" });

setTimeout(() => {
  console.log("summary:", JSON.stringify(seen));
  ws.send(Buffer.from(JSON.stringify({ t: "shutdown" })), { binary: true });
  setTimeout(() => process.exit(0), 1500);
}, Number(process.env.FAKE_WAIT_MS ?? 12000));
