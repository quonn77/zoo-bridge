// Sidecar entry point, started by the plugin in a terminal session:
//   ZOO_PORT, ZOO_PORT_FILE, ZOO_TOKEN, ZOO_WORKSPACE, ZOO_DATA_DIR  node dist/main.js
// Optional: ZOO_EXPECTED_VERSION, ZOO_VSIX_URL, ZOO_VSIX_SHA256 (the Zoo Code
// version of the bundled UI and its pinned release VSIX), ZOO_EXTENSION (the
// zooExtension setting: an extension folder or a .vsix; ZOO_EXTENSION_DIR is
// the older name), ZOO_AUTO_DOWNLOAD=1 (download without asking: tests),
// ZOO_LANGUAGE, ZOO_APP_ROOT (where node_modules/@vscode/ripgrep is).
// See extension.ts for where the extension comes from.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Bridge } from "./bridge.js";
import { downloadExtension, pruneCache, readPinned, resolveExtension, type ExtensionSource, type PinnedVsix } from "./extension.js";
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

const expectedVersion = process.env.ZOO_EXPECTED_VERSION || undefined;
const pinned = readPinned();
const setting = process.env.ZOO_EXTENSION || process.env.ZOO_EXTENSION_DIR || undefined;
const cacheDir = join(dataDir, "extensions");
const autoDownload = process.env.ZOO_AUTO_DOWNLOAD === "1";

const bridge = new Bridge({ port, token });
let host: ExtensionHost | undefined;
/** Page messages that arrive before the extension is there (Zoo's webviewDidLaunch among them). */
const pending: unknown[] = [];
/** What the page shows about the extension (zoo-bridge/extension), repeated on reconnect. */
let extensionState: Record<string, unknown> = { state: "resolving" };
let downloading = false;

function setExtensionState(s: Record<string, unknown>): void {
  extensionState = s;
  bridge.postToWebview({ type: "zoo-bridge/extension", ...s });
}

async function startHost(dir: string, source: ExtensionSource): Promise<void> {
  console.log(`[zoo] extension (${source}): ${dir}`);
  if (source === "cache" || source === "download") pruneCache(cacheDir, dir);
  const h = new ExtensionHost({ bridge, workspaceRoot: workspace, dataDir, extensionDir: dir, expectedVersion });
  host = h;
  setExtensionState({ state: "ready", source, version: h.version });
  for (const msg of pending.splice(0)) h.fromWebview(msg);
  await h.start();
}

async function download(p: PinnedVsix): Promise<void> {
  if (downloading || host) return;
  downloading = true;
  console.log(`[zoo] downloading Zoo Code ${p.version} from ${p.url}`);
  setExtensionState({ state: "downloading", version: p.version, url: p.url, received: 0 });
  try {
    const dir = await downloadExtension(p, cacheDir, ({ received, total }) =>
      setExtensionState({ state: "downloading", version: p.version, url: p.url, received, total }),
    );
    await startHost(dir, "download");
  } catch (e) {
    const error = (e as Error).message;
    console.error(`[zoo] ${error}`);
    setExtensionState({ state: "failed", version: p.version, url: p.url, error });
  } finally {
    downloading = false;
  }
}

bridge.on("connected", () => {
  console.log("[zoo] plugin connected");
  if (!host) bridge.postToWebview({ type: "zoo-bridge/extension", ...extensionState });
});
bridge.on("disconnected", () => console.log("[zoo] plugin disconnected (waiting for the next instance)"));
bridge.on("webview", (msg) => {
  const type = (msg as { type?: unknown } | null)?.type;
  if (type === "zoo-bridge/download-extension") {
    if (pinned && !host) void download(pinned);
    return;
  }
  if (host) host.fromWebview(msg);
  else pending.push(msg);
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
    let found: Awaited<ReturnType<typeof resolveExtension>>;
    try {
      found = await resolveExtension({ setting, expectedVersion, pinned, cacheDir });
      if ("dir" in found) return await startHost(found.dir, found.source);
    } catch (e) {
      // Tell the page instead of leaving it on "resolving".
      setExtensionState({ state: "failed", error: (e as Error).message });
      throw e;
    }
    if (found.pinned && autoDownload) await download(found.pinned);
    else if (found.pinned) {
      console.log(`[zoo] Zoo Code ${found.pinned.version} is not on this machine: waiting for the user to allow the download (${found.pinned.url})`);
      setExtensionState({ state: "missing", version: found.pinned.version, url: found.pinned.url });
    } else {
      const error = "Zoo Code extension not found: install it in VS Code or set Settings › Plugins › Bridge for Zoo Code › Zoo Code extension.";
      console.error(`[zoo] ${error}`);
      setExtensionState({ state: "failed", error });
    }
  })
  .catch((e: Error) => {
    console.error(`[zoo] startup failed: ${e.stack ?? e.message}`);
    // Keep the terminal tab readable instead of closing it at once.
    setTimeout(() => process.exit(1), 60_000);
  });
