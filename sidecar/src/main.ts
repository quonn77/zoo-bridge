// Sidecar entry point, started by the plugin in a terminal session:
//   ZOO_PORT, ZOO_PORT_FILE, ZOO_TOKEN, ZOO_WORKSPACE, ZOO_DATA_DIR  node dist/main.js
// Optional: ZOO_EXPECTED_VERSION, ZOO_VSIX_URL, ZOO_VSIX_SHA256 (the Zoo Code
// version of the bundled UI and its pinned release VSIX), ZOO_EXTENSION (the
// zooExtension setting: an extension folder or a .vsix; ZOO_EXTENSION_DIR is
// the older name), ZOO_AUTO_DOWNLOAD=1 (download without asking: tests),
// ZOO_RIPGREP (the pinned ripgrep release, plugin/ripgrep.json), ZOO_APP_ROOT
// (where node_modules/@vscode/ripgrep is), ZOO_NO_VSCODE=1 (never use VS Code's
// extension or ripgrep: tests), ZOO_LANGUAGE.
// See extension.ts and ripgrep.ts for where the extension and ripgrep come from;
// the page's zoo-bridge/download message downloads whatever is missing.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Bridge } from "./bridge.js";
import { downloadExtension, pruneCache, readPinned, resolveExtension, type ExtensionSource, type PinnedVsix } from "./extension.js";
import { ExtensionHost } from "./host.js";
import { downloadRipgrep, readRipgrepPin, resolveRipgrep, type RipgrepResolution } from "./ripgrep.js";

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
const skipVscode = process.env.ZOO_NO_VSCODE === "1";
const ripgrepPin = readRipgrepPin();
const ripgrepDir = join(dataDir, "ripgrep");

const bridge = new Bridge({ port, token });
let host: ExtensionHost | undefined;
/** Page messages that arrive before the extension is there (Zoo's webviewDidLaunch among them). */
const pending: unknown[] = [];
/** What the page shows about the extension (zoo-bridge/extension), repeated on reconnect. */
let extensionState: Record<string, unknown> = { state: "resolving" };
let downloading = false;
let ripgrep: RipgrepResolution | undefined;
let ripgrepState: Record<string, unknown> = { state: "resolving" };
let ripgrepDownloading = false;

function setRipgrepState(s: Record<string, unknown>): void {
  ripgrepState = s;
  bridge.postToWebview({ type: "zoo-bridge/ripgrep", ...s });
}

/** Where Zoo Code finds ripgrep; see ripgrep.ts. Reported to the page. */
function findRipgrep(): RipgrepResolution {
  const r = resolveRipgrep({ cacheDir: ripgrepDir, pin: ripgrepPin, skipVscode });
  if (r.ready) {
    console.log(`[zoo] ripgrep (${r.source}): ${r.appRoot}`);
    setRipgrepState({ state: "ready", source: r.source });
  } else if (r.asset) {
    console.log(`[zoo] ripgrep is not on this machine: waiting for the user to allow the download of ripgrep ${r.version} (${r.asset.url})`);
    setRipgrepState({ state: "missing", version: r.version, url: r.asset.url, size: r.asset.size });
  } else {
    console.warn(`[zoo] ripgrep not found and no release for ${process.platform}-${process.arch}: Zoo Code's file search and listing will fail (install ripgrep on PATH)`);
    setRipgrepState({ state: "unavailable" });
  }
  return r;
}

async function downloadRg(): Promise<void> {
  const r = ripgrep;
  if (!r || r.ready || !r.asset || !r.version || ripgrepDownloading) return;
  ripgrepDownloading = true;
  console.log(`[zoo] downloading ripgrep ${r.version} from ${r.asset.url}`);
  setRipgrepState({ state: "downloading", version: r.version, url: r.asset.url, size: r.asset.size });
  try {
    await downloadRipgrep(r.asset, r.version, ripgrepDir);
    // Same appRoot: Zoo Code finds the binary on its next search.
    ripgrep = { appRoot: r.appRoot, source: "download", ready: true };
    console.log(`[zoo] ripgrep ${r.version} installed in ${r.appRoot}`);
    setRipgrepState({ state: "ready", source: "download", version: r.version });
  } catch (e) {
    const error = (e as Error).message;
    console.error(`[zoo] ${error}`);
    setRipgrepState({ state: "failed", version: r.version, url: r.asset.url, size: r.asset.size, error });
  } finally {
    ripgrepDownloading = false;
  }
}

/** The page's zoo-bridge/download (the user agreed), or ZOO_AUTO_DOWNLOAD: whatever is missing. */
async function downloadMissing(): Promise<void> {
  await Promise.all([downloadRg(), pinned && !host ? download(pinned) : undefined]);
}

function setExtensionState(s: Record<string, unknown>): void {
  extensionState = s;
  bridge.postToWebview({ type: "zoo-bridge/extension", ...s });
}

async function startHost(dir: string, source: ExtensionSource): Promise<void> {
  console.log(`[zoo] extension (${source}): ${dir}`);
  if (source === "cache" || source === "download") pruneCache(cacheDir, dir);
  const h = new ExtensionHost({ bridge, workspaceRoot: workspace, dataDir, extensionDir: dir, expectedVersion, appRoot: ripgrep?.appRoot });
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
    setExtensionState({ state: "failed", version: p.version, url: p.url, size: p.size, error });
  } finally {
    downloading = false;
  }
}

bridge.on("connected", () => {
  console.log("[zoo] plugin connected");
  if (!host) bridge.postToWebview({ type: "zoo-bridge/extension", ...extensionState });
  bridge.postToWebview({ type: "zoo-bridge/ripgrep", ...ripgrepState });
});
bridge.on("disconnected", () => console.log("[zoo] plugin disconnected (waiting for the next instance)"));
bridge.on("webview", (msg) => {
  const type = (msg as { type?: unknown } | null)?.type;
  if (type === "zoo-bridge/download") {
    void downloadMissing();
    return;
  }
  // A page that just loaded asks where the extension and ripgrep stand.
  if (type === "zoo-bridge/deps") {
    bridge.postToWebview({ type: "zoo-bridge/extension", ...extensionState });
    bridge.postToWebview({ type: "zoo-bridge/ripgrep", ...ripgrepState });
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
      ripgrep = findRipgrep();
      found = await resolveExtension({ setting, expectedVersion, pinned, cacheDir, vscodeExtensionsDir: skipVscode ? join(dataDir, "no-vscode") : undefined });
      if ("dir" in found && autoDownload) await downloadRg();
      if ("dir" in found) return await startHost(found.dir, found.source);
    } catch (e) {
      // Tell the page instead of leaving it on "resolving".
      setExtensionState({ state: "failed", error: (e as Error).message });
      throw e;
    }
    if (found.pinned && autoDownload) await downloadMissing();
    else if (found.pinned) {
      console.log(`[zoo] Zoo Code ${found.pinned.version} is not on this machine: waiting for the user to allow the download (${found.pinned.url})`);
      setExtensionState({ state: "missing", version: found.pinned.version, url: found.pinned.url, size: found.pinned.size });
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
