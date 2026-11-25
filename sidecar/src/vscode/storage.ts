// Persistent state behind ExtensionContext and workspace configuration:
// JSON files under the sidecar's data directory (the plugin's private,
// owner-only directory). Writes are debounced and atomic (tmp + rename).
//
// One sidecar runs per open project, and they share globalState.json,
// secrets.json and settings.json. So a write never replaces the file with
// this process's whole view: under a lock it re-reads the file and applies
// only the keys this process changed. Changes other processes write are
// picked up (polled), for the keys this process has not changed meanwhile.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "./types.js";

const DELETED = Symbol("deleted");
/** A lock older than this is from a process that died while holding it. */
const STALE_LOCK_MS = 10_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `fn` holding `<path>.lock` (a directory: creating one is atomic). */
export function withFileLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        // Released meanwhile.
      }
      if (attempt > 250) throw new Error(`${path}: locked by another process`);
      sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch (e) {
    console.error(`[zoo] ${path} is not valid JSON, reading it as empty:`, (e as Error).message);
    return {};
  }
}

/** A JSON object kept in a file, shared with other sidecar processes. */
export class JsonFile {
  private data: Record<string, unknown>;
  private timer: NodeJS.Timeout | undefined;
  /** Keys this process changed and has not written yet. */
  private readonly dirty = new Map<string, unknown>();
  /** mtime of the file as this process last wrote or read it. */
  private seen = 0;
  private watching = false;
  private readonly changed = new EventEmitter<string[]>();
  /** Keys another process changed in the file. */
  readonly onDidChangeExternally = this.changed.event;

  constructor(
    private readonly path: string,
    /** Poll the file for other processes' writes (ms; 0: never). */
    private readonly pollMs = 1000,
  ) {
    this.data = readJson(path);
    this.seen = this.mtime();
    if (pollMs > 0) {
      watchFile(path, { interval: pollMs, persistent: false }, () => this.reload());
      this.watching = true;
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
    this.dirty.set(key, value === undefined ? DELETED : value);
    this.schedule();
  }

  /** Writes this process's changes now (also called on shutdown). */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dirty.size === 0) return;
    withFileLock(this.path, () => {
      const merged = readJson(this.path);
      for (const [k, v] of this.dirty) {
        if (v === DELETED) delete merged[k];
        else merged[k] = v;
      }
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
      this.dirty.clear();
      this.data = merged;
      this.seen = this.mtime();
    });
  }

  /** Takes in what other processes wrote, except keys changed here and not yet written. */
  reload(): void {
    const mtime = this.mtime();
    if (mtime === this.seen) return;
    this.seen = mtime;
    const disk = readJson(this.path);
    const changed: string[] = [];
    for (const k of new Set([...Object.keys(disk), ...Object.keys(this.data)])) {
      if (this.dirty.has(k)) continue;
      if (JSON.stringify(disk[k]) === JSON.stringify(this.data[k])) continue;
      if (k in disk) this.data[k] = disk[k];
      else delete this.data[k];
      changed.push(k);
    }
    if (changed.length) this.changed.fire(changed);
  }

  dispose(): void {
    this.flush();
    if (this.watching) unwatchFile(this.path);
    this.watching = false;
  }

  private mtime(): number {
    try {
      return statSync(this.path).mtimeMs;
    } catch {
      return 0;
    }
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
  constructor(private readonly file: JsonFile) {
    // A key stored by another project's sidecar (e.g. a provider profile).
    file.onDidChangeExternally((keys) => keys.forEach((key) => this.emitter.fire({ key })));
  }
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
