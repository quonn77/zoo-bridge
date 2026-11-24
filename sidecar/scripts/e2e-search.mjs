// End-to-end check of Zoo Code's file search and listing without VS Code: the
// sidecar runs with ZOO_NO_VSCODE=1 (neither VS Code's extension nor its
// ripgrep), so ripgrep comes from PATH, the plugin's cache or the pinned
// release download (plugin/ripgrep.json). A mock OpenAI-compatible server
// makes Zoo Code call `search_files` and `list_files`; their results must
// reach the "model".
//
//   node scripts/e2e-search.mjs         (exit code 0 = pass)
// ZOO_EXTENSION=<zoo-code-x.y.z.vsix> avoids downloading the extension too.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// The Zoo Code version whose UI the plugin bundles (as plugin/src/lib.rs passes it).
const bundledZooVersion = readFileSync(new URL("../../plugin/webview/zoo/VERSION", import.meta.url), "utf8").trim().split(" ")[1];
// The pinned release VSIX (as plugin/src/lib.rs passes it): without Zoo Code
// ${bundledZooVersion} in VS Code or ZOO_EXTENSION_DIR, the sidecar downloads it.
const pin = JSON.parse(readFileSync(new URL("../../plugin/zoo-code.json", import.meta.url), "utf8"));
const pinEnv = pin.version === bundledZooVersion ? { ZOO_VSIX_URL: pin.vsix, ZOO_VSIX_SHA256: pin.sha256, ZOO_AUTO_DOWNLOAD: "1" } : {};
// The pinned ripgrep release (as plugin/src/lib.rs passes it), and no VS Code.
pinEnv.ZOO_RIPGREP = JSON.stringify(JSON.parse(readFileSync(new URL("../../plugin/ripgrep.json", import.meta.url), "utf8")));
pinEnv.ZOO_NO_VSCODE = "1";
pinEnv.ZOO_AUTO_DOWNLOAD = "1";

const here = dirname(fileURLToPath(import.meta.url));
const NEEDLE = "needle_" + "4242";
const dataDir = mkdtempSync(join(tmpdir(), "zoo-e2e-"));
const workspace = mkdtempSync(join(tmpdir(), "zoo-e2e-ws-"));
mkdirSync(join(workspace, "src", "deep"), { recursive: true });
writeFileSync(join(workspace, "src", "deep", "found.ts"), `export const x = "${NEEDLE}";\n`);
writeFileSync(join(workspace, "src", "other.ts"), "export const y = 1;\n");
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

// ---- mock model ------------------------------------------------------------
const requests = [];
const sse = (res, chunks) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
};
const toolCall = (name, args) => [
  { id: "c", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { id: "c", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
];
const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
    const json = JSON.parse(body || "{}");
    requests.push(json);
    const tools = (json.tools ?? []).map((t) => t.function?.name);
    console.log(`mock: request ${requests.length}, ${json.messages?.length} messages, tools: ${tools.length}`);
    // Side calls (task title, …) come without tools: answer with plain text.
    if (!tools.length) {
      return sse(res, [
        { id: "c", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: "E2E" }, finish_reason: null }] },
        { id: "c", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    }
    const toolTurns = requests.filter((r) => (r.tools ?? []).length);
    if (toolTurns.length === 1) {
      if (!tools.includes("search_files") || !tools.includes("list_files")) fail(`search_files/list_files not offered: ${tools.join(",")}`);
      return sse(res, toolCall("search_files", { path: ".", regex: "needle_\\d+", file_pattern: null }));
    }
    if (toolTurns.length === 2) return sse(res, toolCall("list_files", { path: ".", recursive: true }));
    return sse(res, toolCall("attempt_completion", { result: "done" }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mockPort = mock.address().port;

// ---- Zoo Code state: provider = mock, auto-approve `echo` ----------------------------
// The active provider lives in globalState (apiProvider, …) plus the openAiApiKey
// secret; the profiles list in roo_cline_config_api_config.
const mockModel = { contextWindow: 128000, maxTokens: -1, supportsImages: false, supportsPromptCache: false };
writeFileSync(
  join(dataDir, "secrets.json"),
  JSON.stringify({
    openAiApiKey: "x",
    roo_cline_config_api_config: JSON.stringify({
      currentApiConfigName: "mock",
      apiConfigs: {
        mock: {
          id: "mock",
          apiProvider: "openai",
          openAiBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
          openAiApiKey: "x",
          openAiModelId: "mock-model",
          openAiCustomModelInfo: { contextWindow: 128000, maxTokens: -1, supportsImages: false, supportsPromptCache: false },
        },
      },
      modeApiConfigs: {},
    }),
  }),
);
writeFileSync(
  join(dataDir, "globalState.json"),
  JSON.stringify({
    currentApiConfigName: "mock",
    apiProvider: "openai",
    openAiBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
    openAiModelId: "mock-model",
    openAiCustomModelInfo: mockModel,
    mode: "code",
    autoApprovalEnabled: true,
    alwaysAllowExecute: true,
    allowedCommands: ["echo"],
    alwaysAllowReadOnly: true,
    terminalShellIntegrationDisabled: true,
    defaultCommandsMigrationCompleted: true,
    enableCheckpoints: false,
    telemetrySetting: "disabled",
  }),
);

// ---- sidecar + fake plugin ---------------------------------------------------------
const portFile = join(dataDir, "sidecar.port");
// ZOO_SIDECAR_ENTRY: test another build of the sidecar (e.g. plugin/sidecar-bundle/main.mjs).
const entry = process.env.ZOO_SIDECAR_ENTRY || join(here, "..", "dist", "main.js");
console.log(`sidecar: ${entry}`);
const child = spawn(process.execPath, [entry], {
  env: { ...process.env, ZOO_TOKEN: "e2e", ZOO_PORT: "0", ZOO_PORT_FILE: portFile, ZOO_WORKSPACE: workspace, ZOO_DATA_DIR: dataDir, ZOO_EXPECTED_VERSION: bundledZooVersion, ...pinEnv },
  stdio: ["ignore", "pipe", "pipe"],
});
const log = [];
child.stdout.on("data", (d) => log.push(String(d)));
child.stderr.on("data", (d) => log.push(String(d)));
const deadline = Date.now() + 15000;
while (!existsSync(portFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
if (!existsSync(portFile)) fail("sidecar did not start");
const ws = new WebSocket(`ws://127.0.0.1:${readFileSync(portFile, "utf8").trim()}/bridge?token=e2e`);
const send = (o) => ws.send(Buffer.from(JSON.stringify(o)), { binary: true });
let extension = {};
let ripgrep = {};
ws.on("message", (data) => {
  const m = JSON.parse(String(data));
  if (m.t === "webview" && m.msg?.type === "zoo-bridge/extension") extension = m.msg;
  if (m.t === "webview" && m.msg?.type === "zoo-bridge/ripgrep") ripgrep = m.msg;
  if (m.t === "webview" && m.msg?.type === "zoo-bridge/ide") send({ t: "ide-result", id: m.msg.id, ok: true, value: m.msg.op === "problems" ? {} : null });
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
await new Promise((r) => setTimeout(r, 4000)); // activation and state
send({ t: "webview", msg: { type: "newTask", text: "Find the needle and list the files." } });

// ---- wait for both tool results to reach the model ------------------------------------
const toolResultOf = (turn) => {
  const msgs = requests.filter((r) => (r.tools ?? []).length)[turn]?.messages ?? [];
  const tool = msgs.filter((m) => m.role === "tool").pop();
  return tool && JSON.stringify(tool);
};
const until = Date.now() + 60000;
while (Date.now() < until && !toolResultOf(2)) await new Promise((r) => setTimeout(r, 250));
const search = toolResultOf(1);
const list = toolResultOf(2);
send({ t: "shutdown" });
await new Promise((r) => setTimeout(r, 1500));
child.kill();
mock.close();

console.log(`ripgrep: ${JSON.stringify(ripgrep)}`);
if (!search || !list) {
  console.error(log.join("").split("\n").filter((l) => !/Vercel AI Gateway|persistence-trace/.test(l)).slice(-30).join("\n"));
  fail("the model never got both tool results");
}
if (ripgrep.state !== "ready") fail(`ripgrep not ready: ${JSON.stringify(ripgrep)}`);
if (/Could not find ripgrep/i.test(search + list)) fail(`ripgrep not found by Zoo Code: ${search.slice(0, 400)}`);
if (!search.includes(NEEDLE) || !search.includes("found.ts")) fail(`search_files result without the match: ${search.slice(0, 600)}`);
if (!list.includes("found.ts") || !list.includes("other.ts")) fail(`list_files result without the files: ${list.slice(0, 600)}`);
console.log(`PASS: without VS Code, Zoo Code's search_files found ${NEEDLE} in src/deep/found.ts and list_files listed the workspace (ripgrep: ${ripgrep.source}).`);
process.exit(0);
