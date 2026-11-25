// Loads and activates the Zoo Code extension with the emulated `vscode`
// module, and connects its sidebar webview to the bridge.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { URI } from "vscode-uri";
import type { Bridge } from "./bridge.js";
import { Configuration } from "./vscode/configuration.js";
import { Documents } from "./vscode/documents.js";
import { createVscode, type VscodeModule } from "./vscode/module.js";
import { JsonFile, Memento, SecretStorage } from "./vscode/storage.js";
import * as T from "./vscode/types.js";

/** The webview view Zoo Code registers (package.json contributes.views). */
const SIDEBAR_VIEW = "zoo-code.SidebarProvider";

export interface HostOptions {
  bridge: Bridge;
  workspaceRoot: string;
  /** Private data directory (state, secrets, settings, storage). */
  dataDir: string;
  /** The extension directory; default: Zoo Code installed in VS Code (see findInstalledExtension). */
  extensionDir?: string;
  /** The Zoo Code version whose UI the plugin bundles (ZOO_EXPECTED_VERSION). */
  expectedVersion?: string;
  /** `vscode.env.appRoot`, where Zoo Code finds ripgrep (see ripgrep.ts). */
  appRoot?: string;
}

/**
 * `zoocodeorganization.zoo-code-x.y.z` in VS Code's extensions folder: the
 * `expected` version when installed (the one whose UI the plugin bundles),
 * else the newest.
 */
export function findInstalledExtension(expected?: string): string | undefined {
  const dir = join(homedir(), ".vscode", "extensions");
  if (!existsSync(dir)) return undefined;
  const found = readdirSync(dir)
    .map((name) => /^zoocodeorganization\.zoo-code-(\d+)\.(\d+)\.(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]) || Number(a[2]) - Number(b[2]) || Number(a[3]) - Number(b[3]));
  const exact = expected ? found.find((m) => `${m[1]}.${m[2]}.${m[3]}` === expected) : undefined;
  const pick = exact ?? found[found.length - 1];
  return pick ? join(dir, pick[0]) : undefined;
}

export class ExtensionHost {
  private vscode!: VscodeModule;
  private readonly files: JsonFile[] = [];
  private readonly webviewMessages = new T.EventEmitter<unknown>();
  private readonly early: unknown[] = [];
  private resolved = false;
  private extensionExports: { deactivate?: () => unknown } | undefined;
  readonly extensionDir: string;
  readonly version: string;

  constructor(private readonly opts: HostOptions) {
    const dir = opts.extensionDir ?? findInstalledExtension(opts.expectedVersion);
    if (!dir || !existsSync(join(dir, "package.json"))) {
      throw new Error("Zoo Code extension not found: install it in VS Code or set ZOO_EXTENSION_DIR.");
    }
    this.extensionDir = dir;
    this.version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
    this.mismatch =
      opts.expectedVersion && opts.expectedVersion !== this.version
        ? `Zoo Code ${this.version} is installed, but this plugin's UI is for ${opts.expectedVersion}: ` +
          `install Zoo Code ${opts.expectedVersion} in VS Code, or update the plugin's UI ` +
          `(scripts/copy-webview-ui.mjs). Some screens may not work until then.`
        : undefined;
  }

  /** Set when the extension and the bundled UI are different Zoo Code versions. */
  readonly mismatch: string | undefined;

  private file(...parts: string[]): JsonFile {
    const f = new JsonFile(join(this.opts.dataDir, ...parts));
    this.files.push(f);
    return f;
  }

  async start(): Promise<void> {
    const { bridge, workspaceRoot, dataDir } = this.opts;
    mkdirSync(dataDir, { recursive: true });
    if (this.mismatch) {
      console.warn(`[zoo] ${this.mismatch}`);
      bridge.notify("warning", `Zoo Bridge: ${this.mismatch}`);
    }
    const pkg = JSON.parse(readFileSync(join(this.extensionDir, "package.json"), "utf8")) as Record<string, unknown> & {
      publisher: string;
      name: string;
      main: string;
      contributes?: { configuration?: unknown };
    };
    const extensionId = `${pkg.publisher}.${pkg.name}`;
    const state = this.file("state.json");
    const machineId = (state.get("machineId") as string | undefined) ?? randomUUID();
    state.set("machineId", machineId);

    const appRoot = this.opts.appRoot;
    this.vscode = createVscode({
      bridge,
      workspaceRoot,
      configuration: new Configuration(this.file("settings.json"), pkg.contributes?.configuration),
      documents: new Documents(),
      extensionId,
      extensionPath: this.extensionDir,
      packageJSON: pkg,
      appRoot: appRoot ?? this.extensionDir,
      machineId,
      language: process.env.ZOO_LANGUAGE || Intl.DateTimeFormat().resolvedOptions().locale.split("-")[0] || "en",
      importsDir: join(dataDir, "imports"),
      dialog: ((kind: "open" | "save", options: unknown) => this.dialog(kind, options)) as never,
    });

    // `require("vscode")` from the extension gets the emulated module.
    const api = this.vscode.api;
    const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
    const load = mod._load;
    mod._load = function (request, parent, isMain) {
      return request === "vscode" ? api : load.call(this, request, parent, isMain);
    };

    const workspaceKey = createHash("sha256").update(workspaceRoot.toLowerCase()).digest("hex").slice(0, 16);
    const globalStorage = join(dataDir, "globalStorage", extensionId.toLowerCase());
    const workspaceStorage = join(dataDir, "workspaceStorage", workspaceKey, extensionId.toLowerCase());
    const logs = join(dataDir, "logs");
    for (const d of [globalStorage, workspaceStorage, logs]) mkdirSync(d, { recursive: true });

    // Telemetry off, and the consent banner never shown: Zoo Code sends usage
    // and error reports to PostHog only when telemetrySetting is "enabled"
    // (and vscode.env.isTelemetryEnabled, false here). See fromWebview.
    const globalState = new Memento(this.file("globalState.json"));
    if (globalState.get("telemetrySetting") !== "disabled") await globalState.update("telemetrySetting", "disabled");

    const extensionUri = URI.file(this.extensionDir);
    const context = {
      subscriptions: [] as { dispose(): unknown }[],
      extensionUri,
      extensionPath: this.extensionDir,
      extension: { id: extensionId, extensionUri, extensionPath: this.extensionDir, packageJSON: pkg, isActive: true, extensionKind: 1 },
      extensionMode: T.ExtensionMode.Production,
      globalState,
      workspaceState: new Memento(this.file("workspaceStorage", workspaceKey, "workspaceState.json")),
      secrets: new SecretStorage(this.file("secrets.json")),
      globalStorageUri: URI.file(globalStorage),
      globalStoragePath: globalStorage,
      storageUri: URI.file(workspaceStorage),
      storagePath: workspaceStorage,
      logUri: URI.file(logs),
      logPath: logs,
      asAbsolutePath: (p: string) => join(this.extensionDir, p),
      environmentVariableCollection: {
        persistent: false,
        description: undefined,
        replace: () => undefined,
        append: () => undefined,
        prepend: () => undefined,
        get: () => undefined,
        forEach: () => undefined,
        delete: () => undefined,
        clear: () => undefined,
        getScoped: () => context.environmentVariableCollection,
      },
      languageModelAccessInformation: { onDidChange: T.noEvent, canSendRequest: () => undefined },
    };

    const extRequire = createRequire(join(this.extensionDir, "package.json"));
    const ext = extRequire(join(this.extensionDir, pkg.main)) as { activate(ctx: unknown): unknown; deactivate?: () => unknown };
    console.log(`[zoo] activating ${extensionId} ${this.version}`);
    this.extensionExports = ext;
    await ext.activate(context);
    console.log(`[zoo] activated; commands: ${this.vscode.commands.size}, webview views: ${[...this.vscode.webviewViews.keys()].join(", ")}`);

    await this.resolveSidebar();
  }

  /** Gives Zoo Code its webview view, backed by the tool window's page. */
  private async resolveSidebar(): Promise<void> {
    const reg = this.vscode.webviewViews.get(SIDEBAR_VIEW);
    if (!reg) {
      console.error(`[zoo] the extension registered no ${SIDEBAR_VIEW}`);
      return;
    }
    const { bridge } = this.opts;
    const visibility = new T.EventEmitter<void>();
    let html = "";
    let options: unknown = {};
    const webview = {
      get html() {
        return html;
      },
      // The page itself is the plugin's static copy of webview-ui; the HTML
      // Zoo builds (with vscode-resource URIs) is not used.
      set html(v: string) {
        html = v;
      },
      get options() {
        return options;
      },
      set options(v: unknown) {
        options = v;
      },
      cspSource: "openidea-plugin:",
      asWebviewUri: (uri: URI) => uri,
      onDidReceiveMessage: this.webviewMessages.event,
      postMessage: async (msg: unknown) => {
        bridge.postToWebview(msg);
        return true;
      },
    };
    const view = {
      viewType: SIDEBAR_VIEW,
      webview,
      title: "Zoo Code",
      description: undefined,
      badge: undefined,
      visible: true,
      show: () => undefined,
      onDidDispose: T.noEvent,
      onDidChangeVisibility: visibility.event,
    };
    await reg.provider.resolveWebviewView(view, { state: undefined }, new T.CancellationTokenSource().token);
    this.provider = reg.provider as { postStateToWebview?: () => Promise<void> };
    this.resolved = true;
    for (const msg of this.early.splice(0)) this.webviewMessages.fire(msg);
    console.log("[zoo] sidebar webview resolved");
  }

  private provider: { postStateToWebview?: () => Promise<void> } | undefined;

  /**
   * Sends Zoo Code's whole state to the page again: after a lost connection
   * the page may have missed updates (an approval asked meanwhile, say).
   */
  resync(): void {
    this.provider?.postStateToWebview?.().catch((e: Error) => console.warn(`[zoo] resync: ${e.message}`));
  }

  /** A message from the page (Zoo Code's webview-ui, or the shim's dialog answers). */
  fromWebview(msg: unknown): void {
    const m = msg as { type?: string; id?: number; text?: string } | null;
    if (m?.type === "zoo-bridge/dialog-result") {
      const p = this.dialogs.get(m.id ?? -1);
      if (p) {
        this.dialogs.delete(m.id!);
        p(m);
      }
      return;
    }
    // Telemetry stays off whatever the page asks (see start()).
    if (m?.type === "telemetrySetting") msg = { ...m, text: "disabled" };
    // The page is open: IDE requests can go through it now.
    if (m?.type === "webviewDidLaunch") this.refreshProblems(500);
    if (this.resolved) this.webviewMessages.fire(msg);
    else this.early.push(msg);
  }

  private readonly dialogs = new Map<number, (result: unknown) => void>();
  private nextDialog = 1;

  /** Asks the tool window page to show the IDE's open/save dialog. */
  private dialog(kind: "open" | "save", options: unknown): Promise<unknown> {
    const id = this.nextDialog++;
    const answer = new Promise<Record<string, unknown>>((resolve) => {
      this.dialogs.set(id, resolve as (r: unknown) => void);
      // A dialog nobody answers (page closed) gives up after 10 minutes.
      setTimeout(() => {
        if (this.dialogs.delete(id)) resolve({ error: "no answer from the page" });
      }, 600_000).unref();
    });
    this.opts.bridge.postToWebview({ type: "zoo-bridge/dialog", id, kind, ...(options as object) });
    return answer.then((r) => {
      if (r.error) {
        console.warn(`[zoo] ${kind} dialog: ${String(r.error)}`);
        return null;
      }
      if (kind === "save") return (r.path as string | null) ?? null;
      if (!r.name || typeof r.data !== "string") return null;
      return { name: r.name as string, data: new Uint8Array(Buffer.from(r.data, "base64")) };
    });
  }

  private problemsTimer: NodeJS.Timeout | undefined;

  /** Reads the IDE's problems into the diagnostics snapshot (debounced). */
  private refreshProblems(delay = 300): void {
    clearTimeout(this.problemsTimer);
    this.problemsTimer = setTimeout(() => {
      this.opts.bridge
        .ide<Record<string, { range: number[]; severity: number; message: string; source?: string; code?: string }[]>>("problems")
        .then((byPath) => this.vscode?.setProblems(byPath ?? {}))
        .catch((e: Error) => console.warn(`[zoo] problems: ${e.message}`));
    }, delay);
  }

  /** An IDE event forwarded by the plugin. */
  ideEvent(kind: string, data: unknown): void {
    switch (kind) {
      case "problems-changed":
        this.refreshProblems();
        break;
      case "editor-focused":
        this.vscode?.setActiveEditor(typeof data === "string" ? data : null);
        break;
      case "files-changed": {
        const d = (data ?? {}) as { created?: string[]; modified?: string[]; removed?: string[] };
        this.vscode?.filesChanged(d.created ?? [], d.modified ?? [], d.removed ?? []);
        break;
      }
    }
  }

  /**
   * A command from the IDE (menus, shortcuts). With `editor` the command acts
   * on that file and selection, as Zoo Code's editor commands read
   * `window.activeTextEditor`.
   */
  async runCommand(id: string, args: unknown): Promise<unknown> {
    const cmd = this.vscode?.commands.get(id);
    if (!cmd) throw new Error(`unknown command ${id}`);
    const editor = (args as { editor?: { path?: string; selection?: number[]; text?: string } } | null)?.editor;
    // The editor's text, not the file on disk: the selection refers to it,
    // and it may hold unsaved changes (or the only copy of the content).
    if (editor?.path) this.vscode.setActiveEditor(editor.path, editor.selection, editor.text);
    return cmd();
  }

  async stop(): Promise<void> {
    try {
      await this.extensionExports?.deactivate?.();
    } catch (e) {
      console.error("[zoo] deactivate failed:", e);
    }
    for (const f of this.files) f.dispose();
  }
}
