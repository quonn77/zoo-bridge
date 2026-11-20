// End-to-end check of command execution through the sidecar, with no IDE and
// no real model: a mock OpenAI-compatible server makes Zoo Code call
// `execute_command`, Zoo runs it with its own runner inside the sidecar, and
// the command's output must come back to the "model" as the tool result.
//
//   node scripts/e2e-execute.mjs        (exit code 0 = pass)

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const MARK = "zoo-bridge-e2e";
const dataDir = mkdtempSync(join(tmpdir(), "zoo-e2e-"));
const workspace = mkdtempSync(join(tmpdir(), "zoo-e2e-ws-"));
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
      if (!tools.includes("execute_command")) fail(`no execute_command tool offered: ${tools.join(",")}`);
      // The marker is built by the shell, so it can only reach the model as command output.
      return sse(res, toolCall("execute_command", { command: process.platform === "win32" ? "echo zoo-bridge-%COMPUTERNAME:~0,0%e2e [%ZOO_TOKEN%]" : "echo zoo-bridge-$(printf e2e) [${ZOO_TOKEN-}]" }));
    }
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
const child = spawn(process.execPath, [join(here, "..", "dist", "main.js")], {
  env: { ...process.env, ZOO_TOKEN: "e2e", ZOO_PORT: "0", ZOO_PORT_FILE: portFile, ZOO_WORKSPACE: workspace, ZOO_DATA_DIR: dataDir, ZOO_EXPECTED_VERSION: "3.98.0" },
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
let output = "";
ws.on("message", (data) => {
  const m = JSON.parse(String(data));
  if (m.t === "webview" && m.msg?.type === "zoo-bridge/ide") send({ t: "ide-result", id: m.msg.id, ok: true, value: m.msg.op === "problems" ? {} : null });
  const texts = JSON.stringify(m);
  if (texts.includes(MARK) && texts.includes("command_output")) output = texts;
});
await new Promise((r) => ws.once("open", r));
send({ t: "webview", msg: { type: "webviewDidLaunch" } });
await new Promise((r) => setTimeout(r, 4000)); // activation and state
send({ t: "webview", msg: { type: "newTask", text: "Run the end-to-end check command." } });

// ---- wait for the command's output to reach the model as a tool result ---------------
const until = Date.now() + 60000;
let toolResult;
while (Date.now() < until) {
  const turn = requests.filter((r) => (r.tools ?? []).length)[1];
  const msg = turn?.messages.find((m) => m.role === "tool");
  if (msg) {
    toolResult = JSON.stringify(msg);
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}
send({ t: "shutdown" });
await new Promise((r) => setTimeout(r, 1500));
child.kill();
mock.close();

if (!toolResult) {
  console.error(log.join("").split("\n").filter((l) => !/Vercel AI Gateway/.test(l)).slice(-30).join("\n"));
  fail("the model never got the command's result");
}
if (!toolResult.includes(MARK)) fail(`tool result without the command output: ${toolResult.slice(0, 600)}`);
if (toolResult.includes("[e2e]")) fail("the bridge token reached the command's environment");
console.log(`PASS: Zoo ran "echo ${MARK}" in the sidecar; output reached the model${output ? " and the chat" : ""}.`);
process.exit(0);
