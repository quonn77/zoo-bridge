// End-to-end check of Zoo Code's editor commands with unsaved editor text,
// as asked in the review of l0ng-ai/openidea-plugins#294: the plugin sends
// the editor's text with the path and selection (as its run_command does),
// the sidecar runs Zoo Code's own `zoo-code.addToContext`, and the context
// Zoo Code puts in the chat box must be the selected editor text, while the
// files on disk stay untouched.
//
//   node scripts/e2e-editor-context.mjs        (exit code 0 = pass)

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// The Zoo Code version whose UI the plugin bundles (as plugin/src/lib.rs passes it).
const bundledZooVersion = readFileSync(new URL("../../plugin/webview/zoo/VERSION", import.meta.url), "utf8").trim().split(" ")[1];
// The pinned release VSIX (as plugin/src/lib.rs passes it): without Zoo Code
// ${bundledZooVersion} in VS Code or ZOO_EXTENSION_DIR, the sidecar downloads it.
const pin = JSON.parse(readFileSync(new URL("../../plugin/zoo-code.json", import.meta.url), "utf8"));
const pinEnv = pin.version === bundledZooVersion ? { ZOO_VSIX_URL: pin.vsix, ZOO_VSIX_SHA256: pin.sha256, ZOO_AUTO_DOWNLOAD: "1" } : {};

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "zoo-ctx-"));
const workspace = mkdtempSync(join(tmpdir(), "zoo-ctx-ws-"));
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const cases = [
  { name: "modified, unsaved", file: "code.ts", disk: "let x = old_value;\n", editor: "let x = new_value;\n", selection: [0, 8, 0, 17] },
  { name: "empty on disk, content only in the editor", file: "empty.ts", disk: "", editor: "new_value\n", selection: [0, 0, 0, 9] },
  { name: "saved (control)", file: "saved.ts", disk: "let y = new_value;\n", editor: "let y = new_value;\n", selection: [0, 8, 0, 17] },
];
for (const c of cases) writeFileSync(join(workspace, c.file), c.disk);

const portFile = join(dataDir, "sidecar.port");
const entry = process.env.ZOO_SIDECAR_ENTRY || join(here, "..", "dist", "main.js");
const child = spawn(process.execPath, [entry], {
  env: { ...process.env, ZOO_TOKEN: "ctx", ZOO_PORT: "0", ZOO_PORT_FILE: portFile, ZOO_WORKSPACE: workspace, ZOO_DATA_DIR: dataDir, ZOO_EXPECTED_VERSION: bundledZooVersion, ...pinEnv },
  stdio: ["ignore", "pipe", "pipe"],
});
const log = [];
child.stdout.on("data", (d) => log.push(String(d)));
child.stderr.on("data", (d) => log.push(String(d)));
const deadline = Date.now() + 15000;
while (!existsSync(portFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
if (!existsSync(portFile)) fail("sidecar did not start");

const ws = new WebSocket(`ws://127.0.0.1:${readFileSync(portFile, "utf8").trim()}/bridge?token=ctx`);
const send = (o) => ws.send(Buffer.from(JSON.stringify(o)), { binary: true });
const chatBox = [];
let extension = {};
ws.on("message", (data) => {
  const m = JSON.parse(String(data));
  if (m.t === "webview" && m.msg?.type === "zoo-bridge/extension") extension = m.msg;
  if (m.t === "webview" && m.msg?.type === "zoo-bridge/ide") send({ t: "ide-result", id: m.msg.id, ok: true, value: m.msg.op === "problems" ? {} : null });
  if (m.t === "webview" && m.msg?.type === "invoke" && m.msg.invoke === "setChatBoxMessage") chatBox.push(String(m.msg.text ?? ""));
});
await new Promise((r) => ws.once("open", r));
send({ t: "webview", msg: { type: "webviewDidLaunch" } });
// The extension: found on the machine, or downloaded (ZOO_AUTO_DOWNLOAD).
for (const until = Date.now() + 300000; extension.state !== "ready" && extension.state !== "failed" && Date.now() < until; ) await new Promise((r) => setTimeout(r, 200));
if (extension.state !== "ready") {
  console.error(log.join("").split("\n").filter((l) => !/Vercel AI Gateway|persistence-trace/.test(l)).slice(-20).join("\n"));
  fail(`extension not ready: ${JSON.stringify(extension)}`);
}
console.log(`extension: Zoo Code ${extension.version} (${extension.source})`);
await new Promise((r) => setTimeout(r, 4000)); // activation

let failed = 0;
for (const c of cases) {
  const path = join(workspace, c.file);
  const before = chatBox.length;
  // What plugin/src/lib.rs sends for Add to Context.
  send({ t: "command", id: "zoo-code.addToContext", args: { editor: { path, selection: c.selection, text: c.editor, version: 2 } } });
  const until = Date.now() + 5000;
  while (chatBox.length === before && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  const text = chatBox[before];
  const ok = text !== undefined && text.includes("new_value") && !text.includes("old_value") && readFileSync(path, "utf8") === c.disk;
  console.log(`${ok ? "ok  " : "FAIL"} ${c.name}: context ${text === undefined ? "(none)" : JSON.stringify(text.slice(0, 120))}; disk ${readFileSync(path, "utf8") === c.disk ? "unchanged" : "CHANGED"}`);
  if (!ok) failed++;
}

send({ t: "shutdown" });
await new Promise((r) => setTimeout(r, 1500));
child.kill();
if (failed) {
  console.error(log.join("").split("\n").filter((l) => !/Vercel AI Gateway|persistence-trace/.test(l)).slice(-20).join("\n"));
  fail(`${failed} of ${cases.length} cases`);
}
console.log(`PASS: Zoo Code's Add to Context uses the editor's text in all ${cases.length} cases; files on disk untouched.`);
process.exit(0);
