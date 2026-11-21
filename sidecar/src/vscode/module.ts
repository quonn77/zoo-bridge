// The `vscode` module the extension gets from `require("vscode")`.
//
// Built on a Host (bridge to the OpenIDEA plugin, workspace, storage). APIs
// Zoo Code needs are implemented; anything else is reported once by a proxy
// and answers with a harmless value, so a missing API shows up in the
// sidecar's log instead of crashing activation.

import { spawn } from "node:child_process";
import { existsSync, promises as fsp, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { URI, Utils } from "vscode-uri";
import type { Bridge } from "../bridge.js";
import { Configuration } from "./configuration.js";
import { Documents, TextDocument } from "./documents.js";
import * as T from "./types.js";

export interface Host {
  bridge: Bridge;
  workspaceRoot: string;
  configuration: Configuration;
  documents: Documents;
  extensionId: string;
  extensionPath: string;
  packageJSON: Record<string, unknown>;
  appRoot: string;
  machineId: string;
  language: string;
  /** Where files picked in an open dialog are copied (the page gets bytes, not a path). */
  importsDir: string;
  /** The IDE's file dialogs, shown by the tool window page (`openidea.openFile` / `saveFile`). */
  dialog(kind: "open", options: { filters?: DialogFilter[] }): Promise<{ name: string; data: Uint8Array } | null>;
  dialog(kind: "save", options: { name: string; filters?: DialogFilter[] }): Promise<string | null>;
}

export interface DialogFilter {
  name: string;
  extensions: string[];
}

/** VS Code's `{ "JSON": ["json"] }` as OpenIDEA's `[{ name, extensions }]`. */
function dialogFilters(filters?: Record<string, string[]>): DialogFilter[] | undefined {
  if (!filters) return undefined;
  return Object.entries(filters)
    .map(([name, extensions]) => ({ name, extensions: extensions.filter((e) => e !== "*") }))
    .filter((f) => f.extensions.length > 0);
}

/** A glob (`**`, `*`, `?`, `{a,b}`, `[abc]`) as a regular expression over `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more directories; a trailing "**" anything.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      re += "(?:";
      inGroup = true;
    } else if (c === "}" && inGroup) {
      re += ")";
      inGroup = false;
    } else if (c === "," && inGroup) re += "|";
    else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end > i) {
        re += "[" + glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
        i = end;
      } else re += "\\[";
    } else re += c.replace(/[.+^$()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
}

/** Whether a watcher pattern (glob string or RelativePattern) covers an absolute path. */
function watchMatcher(pattern: unknown, workspaceRoot: string): (fsPath: string) => boolean {
  const slash = (p: string) => p.split(sep).join("/");
  if (pattern instanceof T.RelativePattern || (pattern && typeof pattern === "object" && "pattern" in pattern)) {
    const p = pattern as { base?: string; baseUri?: URI; pattern: string };
    const base = p.baseUri?.fsPath ?? p.base ?? workspaceRoot;
    const re = globToRegExp(p.pattern);
    return (fsPath) => {
      const rel = relative(base, fsPath);
      return !rel.startsWith("..") && !isAbsolute(rel) && re.test(slash(rel));
    };
  }
  const glob = String(pattern ?? "**/*");
  const re = globToRegExp(slash(glob));
  return isAbsolute(glob) ? (fsPath) => re.test(slash(fsPath)) : (fsPath) => re.test(slash(relative(workspaceRoot, fsPath)));
}

const reported = new Set<string>();
function missing(path: string): void {
  if (reported.has(path)) return;
  reported.add(path);
  console.warn(`[vscode] not implemented: ${path}`);
}

/** Wraps a namespace so that unknown members are reported and harmless. */
function namespace<T extends object>(name: string, impl: T): T {
  return new Proxy(impl, {
    get(target, prop, receiver) {
      if (typeof prop !== "string" || prop in target) return Reflect.get(target, prop, receiver);
      if (prop === "then" || prop === "toJSON") return undefined;
      missing(`${name}.${prop}`);
      if (prop.startsWith("onDid") || prop.startsWith("onWill")) return T.noEvent;
      return (..._args: unknown[]) => undefined;
    },
  });
}

/** An object whose `on*` members are events and other methods do nothing (watchers, terminals, decorations…). */
function inert(name: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return new Proxy(fields, {
    get(target, prop) {
      if (typeof prop !== "string" || prop in target) return Reflect.get(target, prop);
      if (prop === "then" || prop === "toJSON") return undefined;
      if (prop.startsWith("on")) return T.noEvent;
      if (prop === "dispose") return () => undefined;
      missing(`${name}.${prop}`);
      return () => undefined;
    },
  });
}

export class FileSystemError extends Error {
  static FileNotFound(uri?: unknown) {
    return new FileSystemError(`File not found: ${String(uri)}`, "FileNotFound");
  }
  static FileExists(uri?: unknown) {
    return new FileSystemError(`File exists: ${String(uri)}`, "FileExists");
  }
  static FileNotADirectory(uri?: unknown) {
    return new FileSystemError(`Not a directory: ${String(uri)}`, "FileNotADirectory");
  }
  static FileIsADirectory(uri?: unknown) {
    return new FileSystemError(`Is a directory: ${String(uri)}`, "FileIsADirectory");
  }
  static NoPermissions(uri?: unknown) {
    return new FileSystemError(`No permissions: ${String(uri)}`, "NoPermissions");
  }
  static Unavailable(uri?: unknown) {
    return new FileSystemError(`Unavailable: ${String(uri)}`, "Unavailable");
  }
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = `${code} (FileSystemError)`;
  }
}

function fsError(e: unknown, uri: URI): Error {
  switch ((e as NodeJS.ErrnoException).code) {
    case "ENOENT":
      return FileSystemError.FileNotFound(uri);
    case "EEXIST":
      return FileSystemError.FileExists(uri);
    case "ENOTDIR":
      return FileSystemError.FileNotADirectory(uri);
    case "EISDIR":
      return FileSystemError.FileIsADirectory(uri);
    case "EACCES":
    case "EPERM":
      return FileSystemError.NoPermissions(uri);
    default:
      return e as Error;
  }
}

export interface WebviewViewRegistration {
  provider: { resolveWebviewView(view: unknown, context: unknown, token: unknown): unknown };
  options?: { webviewOptions?: { retainContextWhenHidden?: boolean } };
}

export interface VscodeModule {
  api: Record<string, unknown>;
  webviewViews: Map<string, WebviewViewRegistration>;
  commands: Map<string, (...args: unknown[]) => unknown>;
  /**
   * The focused editor changed (path, or none), with its selection
   * [startLine, startChar, endLine, endChar] and, when known, the editor's
   * text (unsaved changes included), which then replaces the disk content.
   */
  setActiveEditor(path: string | null, selection?: number[], text?: string): void;
  /** The IDE's problems of all files (replaces the snapshot). */
  setProblems(byPath: Record<string, { range: number[]; severity: number; message: string; source?: string; code?: string }[]>): void;
  /** Files changed on disk outside the extension. */
  filesChanged(created: string[], modified: string[], removed: string[]): void;
}

export function createVscode(host: Host): VscodeModule {
  const { bridge, documents } = host;
  const root = URI.file(host.workspaceRoot);
  const folder = { uri: root, name: root.fsPath.split(/[\\/]/).pop() || root.fsPath, index: 0 };

  const webviewViews = new Map<string, WebviewViewRegistration>();
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const contentProviders = new Map<string, { provideTextDocumentContent(uri: URI, token: unknown): unknown }>();

  const onDidOpenTextDocument = new T.EventEmitter<TextDocument>();
  const onDidChangeActiveTextEditor = new T.EventEmitter<unknown>();
  const onDidChangeVisibleTextEditors = new T.EventEmitter<unknown[]>();
  const onDidChangeTextEditorSelection = new T.EventEmitter<unknown>();
  const onDidChangeDiagnostics = new T.EventEmitter<{ uris: URI[] }>();

  // ---- diagnostics: the IDE's problems, refreshed by the host ---------------------------
  // languages.getDiagnostics is synchronous: it answers from this snapshot.
  const diagKey = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p).split("\\").join("/");
  const diagnostics = new Map<string, { path: string; list: T.Diagnostic[] }>();
  const watchers = new Set<{
    matches(fsPath: string): boolean;
    ignore: { created: boolean; changed: boolean; deleted: boolean };
    created: T.EventEmitter<URI>;
    changed: T.EventEmitter<URI>;
    deleted: T.EventEmitter<URI>;
  }>();

  // ---- editors and tabs -------------------------------------------------------------
  // The sidecar keeps VS Code's model of editors and tabs, which Zoo Code
  // reads (visibleTextEditors, tabGroups) and waits on (its diff view resolves
  // when the file shows up among the visible editors). The IDE is told where
  // it matters: files opened for the user, and proposed changes as a diff.
  type Editor = ReturnType<typeof textEditor>;
  function textEditor(doc: TextDocument, selection = new T.Selection(0, 0, 0, 0)) {
    return {
      document: doc,
      selection,
      get selections() {
        return [this.selection];
      },
      set selections(v: T.Selection[]) {
        if (v[0]) this.selection = v[0];
      },
      get visibleRanges() {
        return [new T.Range(0, 0, Math.max(doc.lineCount - 1, 0), 0)];
      },
      viewColumn: T.ViewColumn.One,
      options: { tabSize: 4, insertSpaces: true },
      async edit(cb: (b: { replace(r: T.Range, t: string): void; insert(p: T.Position, t: string): void; delete(r: T.Range): void }) => void) {
        const we = new T.WorkspaceEdit();
        cb({
          replace: (r, t) => we.replace(doc.uri, r, t),
          insert: (p, t) => we.insert(doc.uri, p, t),
          delete: (r) => we.delete(doc.uri, r),
        });
        return documents.apply(we);
      },
      // Scrolling the editor: the IDE shows the change in its diff viewer.
      revealRange() {},
      setDecorations() {},
      show() {},
      hide() {},
    };
  }

  const editors = new Map<string, Editor>(); // visible, by document URI
  let activeEditor: Editor | undefined;
  interface Tab {
    label: string;
    input: unknown;
    isActive: boolean;
    isDirty: boolean;
    isPinned: boolean;
    isPreview: boolean;
    group: unknown;
  }
  const tabGroup = { tabs: [] as Tab[], isActive: true, viewColumn: T.ViewColumn.One, get activeTab() { return this.tabs.find((t) => t.isActive); } };
  const tabUri = (t: Tab) => (t.input instanceof T.TabInputTextDiff ? t.input.modified : t.input instanceof T.TabInputText ? t.input.uri : undefined);

  function addTab(label: string, input: unknown): Tab {
    for (const t of tabGroup.tabs) t.isActive = false;
    const tab: Tab = { label, input, isActive: true, isDirty: false, isPinned: false, isPreview: false, group: tabGroup };
    tabGroup.tabs.push(tab);
    return tab;
  }

  /** Makes `doc` visible and active (synchronously, as Zoo waits for the event). */
  function showEditor(doc: TextDocument, selection?: T.Selection): Editor {
    const key = doc.uri.toString();
    let ed = editors.get(key);
    if (!ed) {
      ed = textEditor(doc, selection);
      editors.set(key, ed);
    } else if (selection) ed.selection = selection;
    activeEditor = ed;
    onDidChangeVisibleTextEditors.fire([...editors.values()]);
    onDidChangeActiveTextEditor.fire(ed);
    return ed;
  }

  /** Closes tabs; an editor stays visible while one of its tabs is open. */
  function closeTabs(tabs: Tab[]): boolean {
    tabGroup.tabs = tabGroup.tabs.filter((t) => !tabs.includes(t));
    for (const t of tabs) {
      if (t.input instanceof T.TabInputTextDiff) diffs.delete(t.input.modified.toString());
      const uri = tabUri(t);
      if (uri && !tabGroup.tabs.some((o) => tabUri(o)?.toString() === uri.toString())) {
        const ed = editors.get(uri.toString());
        editors.delete(uri.toString());
        if (ed && activeEditor === ed) activeEditor = [...editors.values()].pop();
      }
    }
    onDidChangeVisibleTextEditors.fire([...editors.values()]);
    onDidChangeActiveTextEditor.fire(activeEditor);
    return true;
  }

  async function showTextDocument(target: unknown, options?: unknown) {
    const doc = target instanceof TextDocument ? target : await openTextDocument(target as URI);
    const o = (typeof options === "object" ? options : {}) as { selection?: T.Range; preserveFocus?: boolean };
    const line = o.selection?.start.line ?? 0;
    const column = o.selection?.start.character ?? 0;
    if (!tabGroup.tabs.some((t) => tabUri(t)?.toString() === doc.uri.toString())) addTab(Utils.basename(doc.uri), new T.TabInputText(doc.uri));
    const ed = showEditor(doc, o.selection ? new T.Selection(line, column, line, column) : undefined);
    // Open it in the IDE too, unless it is being shown as a proposed change.
    if (doc.uri.scheme === "file" && !diffs.has(doc.uri.toString())) {
      bridge.ide("openLocation", { path: doc.uri.fsPath, line, column }).catch((e: Error) => console.warn("[vscode] showTextDocument:", e.message));
    }
    return ed;
  }

  // ---- proposed changes: vscode.diff ----------------------------------------------
  // Zoo Code opens `vscode.diff(<original>, <file>)` and streams the new
  // content into the file's document. The IDE gets the result in its diff
  // viewer once the stream pauses (it is read-only there: approving or
  // rejecting stays in Zoo Code's chat).
  interface DiffSession {
    original: string | null; // null: a new file
    doc: TextDocument;
    title: string;
    timer?: NodeJS.Timeout;
    shown?: string; // text last shown
  }
  const diffs = new Map<string, DiffSession>();

  function scheduleDiff(s: DiffSession, delay = 1200): void {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      const text = s.doc.getText();
      if (text === s.shown || !diffs.has(s.doc.uri.toString())) return;
      s.shown = text;
      const rel = relPath(s.doc.uri.fsPath) ?? Utils.basename(s.doc.uri);
      bridge
        .ide("openFileDiff", {
          left: s.original,
          right: text,
          leftLabel: s.original === null ? undefined : "Original",
          rightLabel: "Zoo Code proposal",
          title: `${rel}: Zoo Code proposal`,
          fileName: rel,
        })
        .catch((e: Error) => console.warn("[vscode] diff:", e.message));
    }, delay);
  }

  documents.onDidChange.event((e) => {
    const s = diffs.get(e.document.uri.toString());
    if (s) scheduleDiff(s);
  });

  async function openDiff(left: URI, right: URI, title?: string) {
    let original: string | null = "";
    const provider = contentProviders.get(left.scheme);
    if (provider) original = String((await provider.provideTextDocumentContent(left, new T.CancellationTokenSource().token)) ?? "");
    else if (left.scheme === "file") original = existsSync(left.fsPath) ? readFileSync(left.fsPath, "utf8") : null;
    else if (left.query) original = Buffer.from(left.query, "base64").toString("utf8");
    if (original === "" && right.scheme === "file" && !existsSync(right.fsPath)) original = null;
    const doc = right.scheme === "file" ? documents.open(right) : await openTextDocument(right);
    const session: DiffSession = { original, doc, title: title ?? Utils.basename(right) };
    diffs.set(right.toString(), session);
    addTab(session.title, new T.TabInputTextDiff(left, right));
    showEditor(doc);
    onDidOpenTextDocument.fire(doc);
    scheduleDiff(session, 300);
  }

  // ---- documents ----------------------------------------------------------------
  async function openTextDocument(arg?: unknown): Promise<TextDocument> {
    if (arg === undefined || (typeof arg === "object" && arg !== null && !URI.isUri(arg))) {
      const o = (arg ?? {}) as { content?: string; language?: string };
      return documents.untitled(o.content ?? "", o.language);
    }
    const uri = typeof arg === "string" ? URI.file(arg) : (arg as URI);
    const provider = contentProviders.get(uri.scheme);
    if (provider) {
      const text = String((await provider.provideTextDocumentContent(uri, new T.CancellationTokenSource().token)) ?? "");
      return new TextDocument(uri, text);
    }
    const doc = documents.open(uri);
    onDidOpenTextDocument.fire(doc);
    return doc;
  }

  // ---- workspace.fs -------------------------------------------------------------
  const fs = namespace("workspace.fs", {
    async stat(uri: URI) {
      try {
        const s = await fsp.stat(uri.fsPath);
        return {
          type: s.isDirectory() ? T.FileType.Directory : s.isFile() ? T.FileType.File : T.FileType.Unknown,
          ctime: s.ctimeMs,
          mtime: s.mtimeMs,
          size: s.size,
        };
      } catch (e) {
        throw fsError(e, uri);
      }
    },
    async readFile(uri: URI) {
      try {
        return new Uint8Array(await fsp.readFile(uri.fsPath));
      } catch (e) {
        throw fsError(e, uri);
      }
    },
    async writeFile(uri: URI, content: Uint8Array) {
      try {
        await fsp.mkdir(Utils.dirname(uri).fsPath, { recursive: true });
        await fsp.writeFile(uri.fsPath, content);
      } catch (e) {
        throw fsError(e, uri);
      }
    },
    async readDirectory(uri: URI) {
      try {
        const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
        return entries.map((d) => [d.name, d.isDirectory() ? T.FileType.Directory : d.isFile() ? T.FileType.File : d.isSymbolicLink() ? T.FileType.SymbolicLink : T.FileType.Unknown]);
      } catch (e) {
        throw fsError(e, uri);
      }
    },
    async createDirectory(uri: URI) {
      await fsp.mkdir(uri.fsPath, { recursive: true });
    },
    async delete(uri: URI, options?: { recursive?: boolean }) {
      try {
        await fsp.rm(uri.fsPath, { recursive: !!options?.recursive });
      } catch (e) {
        throw fsError(e, uri);
      }
    },
    async rename(from: URI, to: URI, options?: { overwrite?: boolean }) {
      if (!options?.overwrite && (await fsp.stat(to.fsPath).then(() => true, () => false))) throw FileSystemError.FileExists(to);
      await fsp.rename(from.fsPath, to.fsPath);
    },
    async copy(from: URI, to: URI, options?: { overwrite?: boolean }) {
      await fsp.cp(from.fsPath, to.fsPath, { recursive: true, force: !!options?.overwrite, errorOnExist: !options?.overwrite });
    },
    isWritableFileSystem: (scheme: string) => scheme === "file",
  });

  const relPath = (p: string) => {
    const rel = relative(host.workspaceRoot, p);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : undefined;
  };

  const workspace = namespace("workspace", {
    get workspaceFolders() {
      return [folder];
    },
    get rootPath() {
      return host.workspaceRoot;
    },
    get name() {
      return folder.name;
    },
    workspaceFile: undefined,
    isTrusted: true,
    fs,
    get textDocuments() {
      return documents.all();
    },
    getConfiguration: (section?: string) => host.configuration.get(section),
    onDidChangeConfiguration: host.configuration.onDidChange,
    onDidChangeWorkspaceFolders: T.noEvent,
    onDidOpenTextDocument: onDidOpenTextDocument.event,
    onDidCloseTextDocument: T.noEvent,
    onDidChangeTextDocument: documents.onDidChange.event,
    onDidSaveTextDocument: documents.onDidSave.event,
    onDidCreateFiles: T.noEvent,
    onDidDeleteFiles: T.noEvent,
    onDidRenameFiles: T.noEvent,
    getWorkspaceFolder: (uri: URI) => (uri.scheme === "file" && relPath(uri.fsPath) !== undefined ? folder : undefined),
    asRelativePath(pathOrUri: string | URI, includeWorkspaceFolder?: boolean) {
      const p = typeof pathOrUri === "string" ? pathOrUri : pathOrUri.fsPath;
      const rel = relPath(p);
      if (rel === undefined) return typeof pathOrUri === "string" ? pathOrUri : pathOrUri.fsPath;
      return includeWorkspaceFolder ? `${folder.name}/${rel}` : rel;
    },
    openTextDocument,
    applyEdit: async (edit: T.WorkspaceEdit) => documents.apply(edit),
    registerTextDocumentContentProvider(scheme: string, provider: { provideTextDocumentContent(uri: URI, token: unknown): unknown }) {
      contentProviders.set(scheme, provider);
      return new T.Disposable(() => contentProviders.delete(scheme));
    },
    createFileSystemWatcher(pattern: unknown, ignoreCreate?: boolean, ignoreChange?: boolean, ignoreDelete?: boolean) {
      const matches = watchMatcher(pattern, host.workspaceRoot);
      const w = {
        matches,
        ignore: { created: !!ignoreCreate, changed: !!ignoreChange, deleted: !!ignoreDelete },
        created: new T.EventEmitter<URI>(),
        changed: new T.EventEmitter<URI>(),
        deleted: new T.EventEmitter<URI>(),
      };
      watchers.add(w);
      return inert("FileSystemWatcher", {
        onDidCreate: w.created.event,
        onDidChange: w.changed.event,
        onDidDelete: w.deleted.event,
        ignoreCreateEvents: !!ignoreCreate,
        ignoreChangeEvents: !!ignoreChange,
        ignoreDeleteEvents: !!ignoreDelete,
        dispose: () => watchers.delete(w),
      });
    },
    async findFiles() {
      missing("workspace.findFiles");
      return [];
    },
    async saveAll() {
      return true;
    },
  });

  // ---- window -------------------------------------------------------------------
  const notify = (level: "info" | "warning" | "error") => async (message: string, ...items: unknown[]) => {
    bridge.notify(level, String(message));
    // Buttons need a dialog in the IDE (lot 4): no choice is made.
    void items;
    return undefined;
  };


  const window = namespace("window", {
    get activeTextEditor() {
      return activeEditor;
    },
    get visibleTextEditors() {
      return [...editors.values()];
    },
    activeColorTheme: { kind: T.ColorThemeKind.Dark },
    state: { focused: true, active: true },
    tabGroups: inert("window.tabGroups", {
      get all() {
        return [tabGroup];
      },
      activeTabGroup: tabGroup,
      onDidChangeTabs: T.noEvent,
      onDidChangeTabGroups: T.noEvent,
      close: async (tabs: Tab | Tab[] | unknown) => closeTabs((Array.isArray(tabs) ? tabs : [tabs]).filter((t): t is Tab => tabGroup.tabs.includes(t as Tab))),
    }),
    onDidChangeActiveTextEditor: onDidChangeActiveTextEditor.event,
    onDidChangeVisibleTextEditors: onDidChangeVisibleTextEditors.event,
    onDidChangeTextEditorSelection: onDidChangeTextEditorSelection.event,
    onDidChangeTextEditorVisibleRanges: T.noEvent,
    onDidChangeActiveColorTheme: T.noEvent,
    onDidChangeWindowState: T.noEvent,
    onDidOpenTerminal: T.noEvent,
    onDidCloseTerminal: T.noEvent,
    onDidChangeActiveTerminal: T.noEvent,
    onDidChangeTerminalShellIntegration: T.noEvent,
    onDidStartTerminalShellExecution: T.noEvent,
    onDidEndTerminalShellExecution: T.noEvent,
    terminals: [],
    activeTerminal: undefined,
    showInformationMessage: notify("info"),
    showWarningMessage: notify("warning"),
    showErrorMessage: notify("error"),
    async showInputBox() {
      missing("window.showInputBox (no IDE dialog yet)");
      return undefined;
    },
    async showQuickPick() {
      missing("window.showQuickPick (no IDE dialog yet)");
      return undefined;
    },
    // The IDE's dialogs through the tool window page. Opening yields the
    // file's bytes, not its path: they are copied to importsDir, which is
    // enough for Zoo's "import settings" and attachments.
    async showOpenDialog(options?: { canSelectFiles?: boolean; canSelectFolders?: boolean; filters?: Record<string, string[]> }) {
      if (options?.canSelectFolders && options.canSelectFiles === false) {
        bridge.notify("info", "Zoo Bridge: choosing a folder is not available in OpenIDEA yet.");
        return undefined;
      }
      const file = await host.dialog("open", { filters: dialogFilters(options?.filters) });
      if (!file) return undefined;
      const safe = file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
      const dir = join(host.importsDir, `${Date.now()}`);
      await fsp.mkdir(dir, { recursive: true });
      const path = join(dir, safe);
      await fsp.writeFile(path, file.data);
      return [URI.file(path)];
    },
    async showSaveDialog(options?: { defaultUri?: URI; filters?: Record<string, string[]>; saveLabel?: string }) {
      const name = options?.defaultUri ? Utils.basename(options.defaultUri) : "untitled";
      const path = await host.dialog("save", { name, filters: dialogFilters(options?.filters) });
      return path ? URI.file(path) : undefined;
    },
    showTextDocument,
    createTextEditorDecorationType: (options: unknown) => inert("TextEditorDecorationType", { key: `decoration-${Math.random()}`, options }),
    createOutputChannel(name: string, options?: unknown) {
      const log = (level: string) => (msg: unknown, ...rest: unknown[]) => console.log(`[${name}]${level}`, msg, ...rest);
      return inert("OutputChannel", {
        name,
        logLevel: 2,
        onDidChangeLogLevel: T.noEvent,
        append: (v: string) => process.stdout.write(`[${name}] ${v}`),
        appendLine: log(""),
        replace: () => undefined,
        clear: () => undefined,
        show: () => undefined,
        hide: () => undefined,
        trace: log(" trace"),
        debug: log(" debug"),
        info: log(" info"),
        warn: log(" warn"),
        error: log(" error"),
        options,
      });
    },
    createStatusBarItem: () => inert("StatusBarItem", { text: "", show: () => undefined, hide: () => undefined }),
    createTerminal(options?: unknown) {
      missing("window.createTerminal (commands run without a terminal until lot 5)");
      return inert("Terminal", {
        name: (options as { name?: string })?.name ?? "Zoo Code",
        processId: Promise.resolve(undefined),
        exitStatus: undefined,
        shellIntegration: undefined,
        creationOptions: options ?? {},
        sendText: () => undefined,
        show: () => undefined,
        hide: () => undefined,
      });
    },
    createWebviewPanel(viewType: string, title: string) {
      missing(`window.createWebviewPanel(${viewType}) — only the tool window view is shown`);
      bridge.notify("info", `Zoo Bridge: "${title}" in an editor tab is not available in OpenIDEA yet.`);
      const webview = inert("Webview", { html: "", options: {}, cspSource: "", onDidReceiveMessage: T.noEvent, postMessage: async () => false, asWebviewUri: (u: URI) => u });
      return inert("WebviewPanel", { viewType, title, webview, visible: false, active: false, reveal: () => undefined, onDidDispose: T.noEvent, onDidChangeViewState: T.noEvent });
    },
    registerWebviewViewProvider(viewId: string, provider: WebviewViewRegistration["provider"], options?: WebviewViewRegistration["options"]) {
      webviewViews.set(viewId, { provider, options });
      return new T.Disposable(() => webviewViews.delete(viewId));
    },
    registerUriHandler: () => new T.Disposable(() => undefined),
    registerTreeDataProvider: () => new T.Disposable(() => undefined),
    async withProgress<R>(_options: unknown, task: (progress: { report(v: unknown): void }, token: T.CancellationToken) => Promise<R>) {
      return task({ report: () => undefined }, new T.CancellationTokenSource().token);
    },
    setStatusBarMessage: () => new T.Disposable(() => undefined),
  });

  // ---- commands -----------------------------------------------------------------
  const builtins: Record<string, (...args: unknown[]) => unknown> = {
    setContext: () => undefined,
    "vscode.open": (uri: unknown) => showTextDocument(uri as URI),
    "vscode.diff": (left: unknown, right: unknown, title: unknown) => openDiff(left as URI, right as URI, title as string | undefined),
    "workbench.action.closeActiveEditor": () => {
      const tab = tabGroup.activeTab ?? tabGroup.tabs[tabGroup.tabs.length - 1];
      return tab ? closeTabs([tab]) : undefined;
    },
    "workbench.action.focusSideBar": () => undefined,
    "workbench.view.extension.zoo-code-ActivityBar": () => undefined,
    "workbench.action.files.revert": () => {
      if (activeEditor) documents.revert(activeEditor.document);
    },
    "workbench.action.reloadWindow": () => bridge.notify("info", "Zoo Bridge: restart the extension host to reload."),
  };
  const commandsNs = namespace("commands", {
    registerCommand(id: string, cb: (...args: unknown[]) => unknown, thisArg?: unknown) {
      commands.set(id, thisArg ? cb.bind(thisArg) : cb);
      return new T.Disposable(() => commands.delete(id));
    },
    registerTextEditorCommand(id: string, cb: (...args: unknown[]) => unknown) {
      commands.set(id, (...args) => cb(activeEditor, undefined, ...args));
      return new T.Disposable(() => commands.delete(id));
    },
    async executeCommand(id: string, ...args: unknown[]) {
      const cmd = commands.get(id) ?? builtins[id];
      if (cmd) return cmd(...args);
      missing(`command ${id}`);
      return undefined;
    },
    async getCommands() {
      return [...commands.keys(), ...Object.keys(builtins)];
    },
  });

  // ---- env ----------------------------------------------------------------------
  let clipboard = "";
  const env = namespace("env", {
    appName: "OpenIDEA",
    appRoot: host.appRoot,
    appHost: "desktop",
    uriScheme: "openidea",
    language: host.language,
    machineId: host.machineId,
    sessionId: `${host.machineId}-${Date.now()}`,
    remoteName: undefined,
    // The shell Zoo Code runs commands with (its inline runner: COMSPEC / SHELL).
    shell: process.platform === "win32" ? process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe" : process.env.SHELL || "/bin/sh",
    uiKind: T.UIKind.Desktop,
    isTelemetryEnabled: false,
    isNewAppInstall: false,
    onDidChangeTelemetryEnabled: T.noEvent,
    onDidChangeShell: T.noEvent,
    clipboard: {
      readText: async () => clipboard,
      writeText: async (v: string) => {
        clipboard = v;
      },
    },
    async openExternal(uri: URI) {
      const target = uri.toString(true);
      if (!/^https?:/i.test(target)) return false;
      const [cmd, args] =
        process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
      spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return true;
    },
    asExternalUri: async (uri: URI) => uri,
  });

  // ---- languages / extensions / others ---------------------------------------------
  const languages = namespace("languages", {
    getDiagnostics(uri?: URI) {
      if (uri) return diagnostics.get(diagKey(uri.fsPath))?.list ?? [];
      return [...diagnostics.values()].map((d) => [URI.file(d.path), d.list]);
    },
    onDidChangeDiagnostics: onDidChangeDiagnostics.event,
    registerCodeActionsProvider: () => new T.Disposable(() => undefined),
    createDiagnosticCollection: (name?: string) => inert("DiagnosticCollection", { name, set: () => undefined, delete: () => undefined, clear: () => undefined }),
    getLanguages: async () => [],
  });

  const self = {
    id: host.extensionId,
    extensionUri: URI.file(host.extensionPath),
    extensionPath: host.extensionPath,
    isActive: true,
    packageJSON: host.packageJSON,
    extensionKind: 1,
    exports: undefined,
    activate: async () => undefined,
  };
  const extensions = namespace("extensions", {
    getExtension: (id: string) => (id.toLowerCase() === host.extensionId.toLowerCase() ? self : undefined),
    get all() {
      return [self];
    },
    onDidChange: T.noEvent,
  });

  const authentication = namespace("authentication", {
    getSession: async () => undefined,
    onDidChangeSessions: T.noEvent,
  });
  const lm = namespace("lm", {
    selectChatModels: async () => [],
    onDidChangeChatModels: T.noEvent,
    tools: [],
    registerTool: () => new T.Disposable(() => undefined),
  });

  const api: Record<string, unknown> = {
    // A CommonJS module: bundlers' interop reads this flag.
    __esModule: false,
    version: "1.100.0",
    ...T,
    Uri: T.Uri,
    FileSystemError,
    window,
    workspace,
    commands: commandsNs,
    env,
    languages,
    extensions,
    authentication,
    lm,
    l10n: namespace("l10n", { t: (msg: string | { message: string }, ...args: unknown[]) => format(typeof msg === "string" ? msg : msg.message, args), bundle: undefined, uri: undefined }),
    debug: namespace("debug", { activeDebugSession: undefined, onDidStartDebugSession: T.noEvent }),
    tasks: namespace("tasks", { onDidEndTask: T.noEvent }),
    scm: namespace("scm", {}),
  };

  return {
    api: namespace("vscode", api),
    webviewViews,
    commands,
    setActiveEditor(path, selection, text) {
      if (!path) {
        activeEditor = undefined;
        onDidChangeActiveTextEditor.fire(undefined);
        return;
      }
      const uri = URI.file(path);
      const doc = typeof text === "string" ? documents.syncFromEditor(uri, text) : documents.open(uri);
      if (!tabGroup.tabs.some((t) => tabUri(t)?.toString() === doc.uri.toString())) addTab(Utils.basename(doc.uri), new T.TabInputText(doc.uri));
      const [sl, sc, el, ec] = selection && selection.length === 4 ? selection : [0, 0, 0, 0];
      showEditor(doc, new T.Selection(sl, sc, el, ec));
    },
    setProblems(byPath) {
      const changed: URI[] = [];
      const seen = new Set<string>();
      for (const [path, list] of Object.entries(byPath)) {
        const key = diagKey(path);
        seen.add(key);
        const diags = list.map((d) => {
          const [sl, sc, el, ec] = d.range;
          const diag = new T.Diagnostic(new T.Range(sl, sc, el, ec), d.message, d.severity as T.DiagnosticSeverity);
          if (d.source) diag.source = d.source;
          if (d.code) diag.code = d.code;
          return diag;
        });
        diagnostics.set(key, { path, list: diags });
        changed.push(URI.file(path));
      }
      for (const [key, d] of diagnostics) {
        if (!seen.has(key)) {
          diagnostics.delete(key);
          changed.push(URI.file(d.path));
        }
      }
      if (changed.length) onDidChangeDiagnostics.fire({ uris: changed });
    },
    filesChanged(created, modified, removed) {
      const abs = (p: string) => URI.file(isAbsolute(p) ? p : join(host.workspaceRoot, p));
      // Only paths matching each watcher's pattern: a watcher for ".roo/mcp.json"
      // must not hear about the ".roo" directory (Zoo would read it as a file).
      for (const w of watchers) {
        if (!w.ignore.created) for (const p of created) if (w.matches(abs(p).fsPath)) w.created.fire(abs(p));
        if (!w.ignore.changed) for (const p of modified) if (w.matches(abs(p).fsPath)) w.changed.fire(abs(p));
        if (!w.ignore.deleted) for (const p of removed) if (w.matches(abs(p).fsPath)) w.deleted.fire(abs(p));
      }
    },
  };
}

function format(message: string, args: unknown[]): string {
  const named = args.length === 1 && typeof args[0] === "object" && args[0] !== null ? (args[0] as Record<string, unknown>) : undefined;
  return message.replace(/\{(\w+)\}/g, (m, k) => {
    const v = named ? named[k] : args[Number(k)];
    return v === undefined ? m : String(v);
  });
}
