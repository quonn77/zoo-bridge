// Sidecar entry point, started by the plugin in a terminal session:
//   ZOO_PORT, ZOO_PORT_FILE, ZOO_TOKEN, ZOO_WORKSPACE, ZOO_DATA_DIR  node dist/main.js
// Optional: ZOO_EXTENSION_DIR (default: newest Zoo Code in VS Code),
// ZOO_LANGUAGE, ZOO_APP_ROOT (where node_modules/@vscode/ripgrep is).

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Bridge } from "./bridge.js";
import { ExtensionHost } from "./host.js";

// 0 = any free loopback port (fixed ports may be reserved on the machine);
// the bound port is written to ZOO_PORT_FILE, where the plugin reads it.
const port = Number(process.env.ZOO_PORT ?? 0);
const portFile = process.env.ZOO_PORT_FILE ?? "";
const token = process.env.ZOO_TOKEN ?? "";
const workspace = process.env.ZOO_WORKSPACE || process.cwd();
const dataDir = process.env.ZOO_DATA_DIR || join(homedir(), ".zoo-openidea");

if (!token) {
  console.error("ZOO_TOKEN is not set: start the sidecar from the Bridge for Zoo Code plugin (Zoo Bridge: Start Extension Host).");
  process.exit(2);
}
// Zoo Code runs the model's commands with this process's environment: the
// bridge secret and its address must not reach them (a command could
// otherwise connect to the bridge as the plugin).
for (const k of ["ZOO_TOKEN", "ZOO_PORT", "ZOO_PORT_FILE"]) delete process.env[k];

const bridge = new Bridge({ port, token });
let host: ExtensionHost | undefined;
try {
  host = new ExtensionHost({
    bridge,
    workspaceRoot: workspace,
    dataDir,
    extensionDir: process.env.ZOO_EXTENSION_DIR || undefined,
    expectedVersion: process.env.ZOO_EXPECTED_VERSION || undefined,
  });
} catch (e) {
  console.error(`[zoo] ${(e as Error).message}`);
}

bridge.on("connected", () => console.log("[zoo] plugin connected"));
bridge.on("disconnected", () => console.log("[zoo] plugin disconnected (waiting for the next instance)"));
bridge.on("webview", (msg) => {
  if (host) host.fromWebview(msg);
  else bridge.postToWebview({ type: "echo", workspace, received: msg });
});
bridge.on("event", (kind, data) => host?.ideEvent(kind, data));
bridge.on("command", (id, args) => {
  host?.runCommand(id, args).catch((e: Error) => console.error(`[zoo] command ${id}: ${e.message}`));
});
bridge.on("shutdown", () => void stop(0));

let stopping = false;
async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log("[zoo] shutting down");
  if (portFile) rmSync(portFile, { force: true });
  await host?.stop();
  await bridge.close();
  process.exit(code);
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
process.on("unhandledRejection", (e) => console.error("[zoo] unhandled rejection:", e));
process.on("uncaughtException", (e) => console.error("[zoo] uncaught exception:", e));

bridge
  .listening()
  .then(async () => {
    if (portFile) {
      mkdirSync(dirname(portFile), { recursive: true });
      writeFileSync(portFile, String(bridge.port));
    }
    console.log(`[zoo] Zoo Code sidecar listening on ws://127.0.0.1:${bridge.port}/bridge (workspace ${workspace})`);
    if (host) {
      console.log(`[zoo] extension: ${host.extensionDir}`);
      await host.start();
    }
  })
  .catch((e: Error) => {
    console.error(`[zoo] startup failed: ${e.stack ?? e.message}`);
    // Keep the terminal tab readable instead of closing it at once.
    setTimeout(() => process.exit(1), 60_000);
  });
