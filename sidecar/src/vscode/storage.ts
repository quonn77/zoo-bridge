// Persistent state behind ExtensionContext and workspace configuration:
// JSON files under the sidecar's data directory (the plugin's private,
// owner-only directory). Writes are debounced and atomic (tmp + rename).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "./types.js";

/** A JSON object kept in a file. */
export class JsonFile {
  private data: Record<string, unknown>;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly path: string) {
    try {
      this.data = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
    } catch (e) {
      console.error(`[zoo] ${path} is not valid JSON, starting empty:`, (e as Error).message);
      this.data = {};
    }
  }

  get(key: string): unknown {
    return this.data[key];
  }
  keys(): string[] {
    return Object.keys(this.data);
  }
  all(): Record<string, unknown> {
    return this.data;
  }
  set(key: string, value: unknown): void {
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    this.schedule();
  }

  /** Writes now (also called on shutdown). */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }
}

/** `vscode.Memento` (globalState / workspaceState). */
export class Memento {
  constructor(private readonly file: JsonFile) {}
  keys(): readonly string[] {
    return this.file.keys();
  }
  get<T>(key: string, defaultValue?: T): T | undefined {
    const v = this.file.get(key);
    return v === undefined ? defaultValue : (structuredClone(v) as T);
  }
  update(key: string, value: unknown): Thenable<void> {
    this.file.set(key, value === undefined ? undefined : structuredClone(value));
    return Promise.resolve();
  }
  setKeysForSync(_keys: readonly string[]): void {}
}

/**
 * `vscode.SecretStorage`. Kept in an owner-only file of the plugin's private
 * directory: OpenIDEA's own secret store is write-only for plugin code, so
 * the extension could not read its API keys back from it.
 */
export class SecretStorage {
  private readonly emitter = new EventEmitter<{ key: string }>();
  readonly onDidChange = this.emitter.event;
  constructor(private readonly file: JsonFile) {}
  get(key: string): Thenable<string | undefined> {
    const v = this.file.get(key);
    return Promise.resolve(typeof v === "string" ? v : undefined);
  }
  store(key: string, value: string): Thenable<void> {
    this.file.set(key, value);
    this.emitter.fire({ key });
    return Promise.resolve();
  }
  delete(key: string): Thenable<void> {
    this.file.set(key, undefined);
    this.emitter.fire({ key });
    return Promise.resolve();
  }
  keys(): Thenable<string[]> {
    return Promise.resolve(this.file.keys());
  }
}

type Thenable<T> = PromiseLike<T>;
