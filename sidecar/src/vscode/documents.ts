// Text documents and workspace edits, with VS Code's semantics: text edits
// change the document in memory and mark it dirty; `save()` writes the file
// (Zoo Code streams a proposed change into the document, then saves it when
// the user approves, or restores the original). File operations (create,
// delete, rename) act on disk at once, as in VS Code.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, basename } from "node:path";
import { URI } from "vscode-uri";
import { EndOfLine, EventEmitter, Position, Range, TextEdit, WorkspaceEdit } from "./types.js";

const LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript",
  ".cjs": "javascript", ".json": "json", ".md": "markdown", ".py": "python", ".java": "java", ".kt": "kotlin",
  ".groovy": "groovy", ".gradle": "groovy", ".xml": "xml", ".html": "html", ".css": "css", ".scss": "scss",
  ".go": "go", ".rs": "rust", ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp", ".rb": "ruby",
  ".php": "php", ".sh": "shellscript", ".ps1": "powershell", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
  ".sql": "sql", ".proto": "proto3", ".swift": "swift", ".vue": "vue", ".svelte": "svelte",
};

export function languageOf(path: string): string {
  const name = basename(path).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return LANGUAGES[extname(name)] ?? "plaintext";
}

export class TextLine {
  constructor(
    readonly lineNumber: number,
    readonly text: string,
    readonly rangeIncludingLineBreak: Range,
  ) {}
  get range(): Range {
    return new Range(this.lineNumber, 0, this.lineNumber, this.text.length);
  }
  get firstNonWhitespaceCharacterIndex(): number {
    const m = /\S/.exec(this.text);
    return m ? m.index : this.text.length;
  }
  get isEmptyOrWhitespace(): boolean {
    return this.firstNonWhitespaceCharacterIndex === this.text.length;
  }
}

export class TextDocument {
  private text: string;
  private lines: string[] = [];
  private lineStarts: number[] = [];
  version = 1;
  isDirty = false;
  isClosed = false;
  readonly isUntitled = false;
  readonly languageId: string;

  /** Called after `save()` wrote the file (Documents fires onDidSave). */
  onSaved?: (doc: TextDocument) => void;

  constructor(
    readonly uri: URI,
    text: string,
    languageId?: string,
  ) {
    this.text = text;
    this.languageId = languageId ?? languageOf(uri.fsPath);
    this.index();
  }

  get fileName(): string {
    return this.uri.fsPath;
  }
  get lineCount(): number {
    return this.lines.length;
  }
  get eol(): EndOfLine {
    return this.text.includes("\r\n") ? EndOfLine.CRLF : EndOfLine.LF;
  }

  getText(range?: Range): string {
    if (!range) return this.text;
    return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }
  lineAt(lineOrPos: number | Position): TextLine {
    const line = typeof lineOrPos === "number" ? lineOrPos : lineOrPos.line;
    if (line < 0 || line >= this.lines.length) throw new Error(`Illegal value for line: ${line}`);
    const start = this.lineStarts[line];
    const next = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] : this.text.length;
    return new TextLine(line, this.lines[line], new Range(this.positionAt(start), this.positionAt(next)));
  }
  offsetAt(p: Position): number {
    const line = Math.min(Math.max(p.line, 0), this.lines.length - 1);
    return this.lineStarts[line] + Math.min(Math.max(p.character, 0), this.lines[line].length);
  }
  positionAt(offset: number): Position {
    offset = Math.min(Math.max(offset, 0), this.text.length);
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return new Position(lo, Math.min(offset - this.lineStarts[lo], this.lines[lo].length));
  }
  validateRange(r: Range): Range {
    return new Range(this.validatePosition(r.start), this.validatePosition(r.end));
  }
  validatePosition(p: Position): Position {
    return this.positionAt(this.offsetAt(p));
  }
  getWordRangeAtPosition(p: Position, regex = /[\w$]+/g): Range | undefined {
    const line = this.lines[p.line] ?? "";
    const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
    for (const m of line.matchAll(re)) {
      if (m.index! <= p.character && p.character <= m.index! + m[0].length) {
        return new Range(p.line, m.index!, p.line, m.index! + m[0].length);
      }
    }
    return undefined;
  }
  async save(): Promise<boolean> {
    if (this.uri.scheme !== "file") return false;
    mkdirSync(dirname(this.uri.fsPath), { recursive: true });
    writeFileSync(this.uri.fsPath, this.text);
    this.isDirty = false;
    this.onSaved?.(this);
    return true;
  }

  /** Applies edits (non-overlapping, in any order) to the in-memory text. */
  applyEdits(edits: TextEdit[]): void {
    const sorted = edits
      .map((e) => ({ start: this.offsetAt(e.range.start), end: this.offsetAt(e.range.end), text: e.newText }))
      .sort((a, b) => b.start - a.start || b.end - a.end);
    let text = this.text;
    for (const e of sorted) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    this.setText(text);
  }

  setText(text: string): void {
    this.text = text;
    this.version++;
    this.index();
  }

  private index(): void {
    this.lines = [];
    this.lineStarts = [];
    const re = /\r\n|\r|\n/g;
    let start = 0;
    for (let m = re.exec(this.text); m; m = re.exec(this.text)) {
      this.lines.push(this.text.slice(start, m.index));
      this.lineStarts.push(start);
      start = m.index + m[0].length;
    }
    this.lines.push(this.text.slice(start));
    this.lineStarts.push(start);
  }
}

export interface DocumentChange {
  document: TextDocument;
  contentChanges: { range: Range; text: string }[];
  reason: undefined;
}

/** Open documents by URI string. */
export class Documents {
  private readonly docs = new Map<string, TextDocument>();
  readonly onDidChange = new EventEmitter<DocumentChange>();
  readonly onDidSave = new EventEmitter<TextDocument>();

  all(): TextDocument[] {
    return [...this.docs.values()];
  }

  private track(doc: TextDocument): TextDocument {
    doc.onSaved = (d) => this.onDidSave.fire(d);
    this.docs.set(doc.uri.toString(), doc);
    return doc;
  }

  open(uri: URI): TextDocument {
    const key = uri.toString();
    let doc = this.docs.get(key);
    if (!doc) {
      doc = this.track(new TextDocument(uri, existsSync(uri.fsPath) ? readFileSync(uri.fsPath, "utf8") : ""));
    } else if (!doc.isDirty && existsSync(uri.fsPath)) {
      const disk = readFileSync(uri.fsPath, "utf8");
      if (disk !== doc.getText()) doc.setText(disk);
    }
    return doc;
  }

  untitled(content: string, language?: string): TextDocument {
    const uri = URI.from({ scheme: "untitled", path: `Untitled-${this.docs.size + 1}` });
    return this.track(new TextDocument(uri, content, language));
  }

  /** Reloads a document from disk, dropping unsaved changes (`workbench.action.files.revert`). */
  revert(doc: TextDocument): void {
    if (doc.uri.scheme === "file" && existsSync(doc.uri.fsPath)) doc.setText(readFileSync(doc.uri.fsPath, "utf8"));
    doc.isDirty = false;
  }

  /**
   * `workspace.applyEdit`. Text edits change the documents in memory (dirty
   * until saved); file operations act on disk.
   */
  apply(edit: WorkspaceEdit): boolean {
    const touched = new Map<string, TextDocument>();
    for (const e of edit.entries) {
      switch (e.kind) {
        case "edit": {
          const doc = this.open(e.uri);
          const pending = touched.get(e.uri.toString()) ?? doc;
          touched.set(e.uri.toString(), pending);
          break;
        }
        case "create": {
          const p = e.uri.fsPath;
          if (existsSync(p) && e.options?.ignoreIfExists) break;
          if (existsSync(p) && !e.options?.overwrite) return false;
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, e.options?.contents ?? "");
          break;
        }
        case "delete": {
          const p = e.uri.fsPath;
          if (!existsSync(p)) {
            if (e.options?.ignoreIfNotExists) break;
            return false;
          }
          rmSync(p, { recursive: !!e.options?.recursive });
          this.docs.delete(e.uri.toString());
          break;
        }
        case "rename": {
          if (existsSync(e.to.fsPath)) {
            if (e.options?.ignoreIfExists) break;
            if (!e.options?.overwrite) return false;
          }
          mkdirSync(dirname(e.to.fsPath), { recursive: true });
          renameSync(e.from.fsPath, e.to.fsPath);
          this.docs.delete(e.from.toString());
          break;
        }
      }
    }
    for (const [key, doc] of touched) {
      const edits = edit.get(URI.parse(key));
      doc.applyEdits(edits);
      doc.isDirty = true;
      this.onDidChange.fire({ document: doc, contentChanges: edits.map((e) => ({ range: e.range, text: e.newText })), reason: undefined });
    }
    return true;
  }
}
