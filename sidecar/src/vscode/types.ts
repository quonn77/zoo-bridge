// Classes and enums of the `vscode` module, as far as Zoo Code uses them.
// Semantics follow vscode.d.ts; anything not listed is reported by the
// module proxy (see ./module.ts) the first time it is touched.

import { URI, Utils } from "vscode-uri";

// ---- Uri ----------------------------------------------------------------------

/**
 * `vscode.Uri`: vscode-uri's URI is the implementation VS Code itself uses
 * (file/parse/from/isUri, fsPath, with, toJSON); joinPath lives in its Utils.
 */
export const Uri = URI as typeof URI & { joinPath: typeof Utils.joinPath };
if (!("joinPath" in URI)) Object.defineProperty(URI, "joinPath", { value: Utils.joinPath });

// ---- events / disposables -----------------------------------------------------

export class Disposable {
  static from(...items: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const d of items) d?.dispose?.();
    });
  }
  private done = false;
  constructor(private readonly onDispose: () => unknown) {}
  dispose(): unknown {
    if (this.done) return;
    this.done = true;
    return this.onDispose();
  }
}

export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: Disposable[]) => Disposable;

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => unknown>();
  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const bound = thisArgs ? listener.bind(thisArgs) : listener;
    this.listeners.add(bound);
    const d = new Disposable(() => this.listeners.delete(bound));
    disposables?.push(d);
    return d;
  };
  fire(data: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(data);
      } catch (e) {
        console.error("[vscode] event listener failed:", e);
      }
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

/** An event nobody fires. */
export const noEvent: Event<never> = () => new Disposable(() => undefined);

export class CancellationError extends Error {
  constructor() {
    super("Canceled");
    this.name = "Canceled";
  }
}

export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested: Event<unknown>;
}

export class CancellationTokenSource {
  private emitter = new EventEmitter<unknown>();
  readonly token: CancellationToken = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
  cancel(): void {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    this.emitter.fire(undefined);
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

// ---- text ---------------------------------------------------------------------

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
  isBefore(o: Position): boolean {
    return this.line < o.line || (this.line === o.line && this.character < o.character);
  }
  isBeforeOrEqual(o: Position): boolean {
    return this.isBefore(o) || this.isEqual(o);
  }
  isAfter(o: Position): boolean {
    return !this.isBeforeOrEqual(o);
  }
  isAfterOrEqual(o: Position): boolean {
    return !this.isBefore(o);
  }
  isEqual(o: Position): boolean {
    return this.line === o.line && this.character === o.character;
  }
  compareTo(o: Position): number {
    return this.isBefore(o) ? -1 : this.isEqual(o) ? 0 : 1;
  }
  translate(lineDelta: number | { lineDelta?: number; characterDelta?: number } = 0, characterDelta = 0): Position {
    if (typeof lineDelta === "object") return this.translate(lineDelta.lineDelta ?? 0, lineDelta.characterDelta ?? 0);
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
  with(line: number | { line?: number; character?: number } = this.line, character = this.character): Position {
    if (typeof line === "object") return new Position(line.line ?? this.line, line.character ?? this.character);
    return new Position(line, character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(startOrLine: Position | number, endOrChar: Position | number, endLine?: number, endChar?: number) {
    const a = typeof startOrLine === "number" ? new Position(startOrLine, endOrChar as number) : startOrLine;
    const b = typeof startOrLine === "number" ? new Position(endLine!, endChar!) : (endOrChar as Position);
    [this.start, this.end] = a.isBeforeOrEqual(b) ? [a, b] : [b, a];
  }
  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }
  contains(p: Position | Range): boolean {
    if (p instanceof Range) return this.contains(p.start) && this.contains(p.end);
    return p.isAfterOrEqual(this.start) && p.isBeforeOrEqual(this.end);
  }
  isEqual(o: Range): boolean {
    return this.start.isEqual(o.start) && this.end.isEqual(o.end);
  }
  intersection(o: Range): Range | undefined {
    const s = this.start.isAfter(o.start) ? this.start : o.start;
    const e = this.end.isBefore(o.end) ? this.end : o.end;
    return s.isAfter(e) ? undefined : new Range(s, e);
  }
  union(o: Range): Range {
    return new Range(this.start.isBefore(o.start) ? this.start : o.start, this.end.isAfter(o.end) ? this.end : o.end);
  }
  with(start: Position | { start?: Position; end?: Position } = this.start, end: Position = this.end): Range {
    if (!(start instanceof Position)) return new Range(start.start ?? this.start, start.end ?? this.end);
    return new Range(start, end);
  }
}

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;
  constructor(anchor: Position | number, active: Position | number, activeLine?: number, activeChar?: number) {
    const a = typeof anchor === "number" ? new Position(anchor, active as number) : anchor;
    const b = typeof anchor === "number" ? new Position(activeLine!, activeChar!) : (active as Position);
    super(a, b);
    this.anchor = a;
    this.active = b;
  }
  get isReversed(): boolean {
    return this.anchor.isAfter(this.active);
  }
}

export class TextEdit {
  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }
  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }
  static delete(range: Range): TextEdit {
    return new TextEdit(range, "");
  }
  constructor(
    public range: Range,
    public newText: string,
  ) {}
}

export type WorkspaceEditEntry =
  | { kind: "edit"; uri: URI; edit: TextEdit }
  | { kind: "create"; uri: URI; options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array } }
  | { kind: "delete"; uri: URI; options?: { recursive?: boolean; ignoreIfNotExists?: boolean } }
  | { kind: "rename"; from: URI; to: URI; options?: { overwrite?: boolean; ignoreIfExists?: boolean } };

export class WorkspaceEdit {
  readonly entries: WorkspaceEditEntry[] = [];
  get size(): number {
    return new Set(this.entries.map((e) => (e.kind === "rename" ? e.from : e.uri).toString())).size;
  }
  replace(uri: URI, range: Range, newText: string): void {
    this.entries.push({ kind: "edit", uri, edit: TextEdit.replace(range, newText) });
  }
  insert(uri: URI, position: Position, newText: string): void {
    this.entries.push({ kind: "edit", uri, edit: TextEdit.insert(position, newText) });
  }
  delete(uri: URI, range: Range): void {
    this.entries.push({ kind: "edit", uri, edit: TextEdit.delete(range) });
  }
  set(uri: URI, edits: TextEdit[]): void {
    for (const edit of edits) this.entries.push({ kind: "edit", uri, edit });
  }
  has(uri: URI): boolean {
    return this.entries.some((e) => (e.kind === "rename" ? e.from : e.uri).toString() === uri.toString());
  }
  get(uri: URI): TextEdit[] {
    return this.entries.flatMap((e) => (e.kind === "edit" && e.uri.toString() === uri.toString() ? [e.edit] : []));
  }
  createFile(uri: URI, options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array }): void {
    this.entries.push({ kind: "create", uri, options });
  }
  deleteFile(uri: URI, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }): void {
    this.entries.push({ kind: "delete", uri, options });
  }
  renameFile(from: URI, to: URI, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): void {
    this.entries.push({ kind: "rename", from, to, options });
  }
}

export class RelativePattern {
  readonly baseUri: URI;
  readonly base: string;
  constructor(
    base: string | URI | { uri: URI },
    readonly pattern: string,
  ) {
    this.baseUri = typeof base === "string" ? URI.file(base) : "uri" in base && URI.isUri(base.uri) ? base.uri : (base as URI);
    this.base = this.baseUri.fsPath;
  }
}

// ---- misc classes -------------------------------------------------------------

export class ThemeIcon {
  static readonly File = new ThemeIcon("file");
  static readonly Folder = new ThemeIcon("folder");
  constructor(
    readonly id: string,
    readonly color?: unknown,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class MarkdownString {
  constructor(
    public value = "",
    public supportThemeIcons = false,
  ) {}
  appendText(v: string): this {
    this.value += v;
    return this;
  }
  appendMarkdown(v: string): this {
    this.value += v;
    return this;
  }
  appendCodeblock(code: string, lang = ""): this {
    this.value += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    return this;
  }
}

export class CodeActionKind {
  static readonly Empty = new CodeActionKind("");
  static readonly QuickFix = new CodeActionKind("quickfix");
  static readonly Refactor = new CodeActionKind("refactor");
  static readonly RefactorRewrite = new CodeActionKind("refactor.rewrite");
  static readonly Source = new CodeActionKind("source");
  constructor(readonly value: string) {}
  append(part: string): CodeActionKind {
    return new CodeActionKind(this.value ? `${this.value}.${part}` : part);
  }
  contains(other: CodeActionKind): boolean {
    return this.value === "" || other.value === this.value || other.value.startsWith(this.value + ".");
  }
  intersects(other: CodeActionKind): boolean {
    return this.contains(other) || other.contains(this);
  }
}

export class CodeAction {
  command?: unknown;
  edit?: WorkspaceEdit;
  diagnostics?: unknown[];
  isPreferred?: boolean;
  constructor(
    public title: string,
    public kind?: CodeActionKind,
  ) {}
}

export class Diagnostic {
  source?: string;
  code?: string | number;
  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity = DiagnosticSeverity.Error,
  ) {}
}

export class TabInputText {
  constructor(readonly uri: URI) {}
}
export class TabInputTextDiff {
  constructor(
    readonly original: URI,
    readonly modified: URI,
  ) {}
}

// Language model API (vscode.lm): Zoo uses these only with its VS Code LM provider.
export class LanguageModelTextPart {
  constructor(public value: string) {}
}
export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}
export class LanguageModelToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}
export class LanguageModelChatMessage {
  static User(content: unknown, name?: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content, name);
  }
  static Assistant(content: unknown, name?: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content, name);
  }
  constructor(
    public role: LanguageModelChatMessageRole,
    public content: unknown,
    public name?: string,
  ) {}
}

// ---- enums --------------------------------------------------------------------

export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}
export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}
export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3,
}
export enum UIKind {
  Desktop = 1,
  Web = 2,
}
export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}
export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}
export enum TextEditorSelectionChangeKind {
  Keyboard = 1,
  Mouse = 2,
  Command = 3,
}
export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}
export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4,
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7,
}
export enum DecorationRangeBehavior {
  OpenOpen = 0,
  ClosedClosed = 1,
  OpenClosed = 2,
  ClosedOpen = 3,
}
export enum EndOfLine {
  LF = 1,
  CRLF = 2,
}
export enum TerminalExitReason {
  Unknown = 0,
  Shutdown = 1,
  Process = 2,
  User = 3,
  Extension = 4,
}
export enum FileChangeType {
  Changed = 1,
  Created = 2,
  Deleted = 3,
}
