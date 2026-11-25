import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JsonFile, SecretStorage, withFileLock } from "../vscode/storage.js";

const tmp = () => mkdtempSync(join(tmpdir(), "zoo-store-"));
const disk = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

test("two sidecars writing the same file keep each other's keys", () => {
  const path = join(tmp(), "globalState.json");
  writeFileSync(path, JSON.stringify({ shared: 1 }));
  const a = new JsonFile(path, 0);
  const b = new JsonFile(path, 0);
  a.set("fromA", "a");
  b.set("fromB", "b");
  a.flush();
  b.flush(); // before the fix: b wrote its whole view and dropped fromA
  assert.deepEqual(disk(path), { shared: 1, fromA: "a", fromB: "b" });
  b.set("shared", undefined);
  b.flush();
  assert.deepEqual(disk(path), { fromA: "a", fromB: "b" });
  a.dispose();
  b.dispose();
});

test("reload takes in other processes' writes but keeps unwritten local changes", () => {
  const path = join(tmp(), "secrets.json");
  const a = new JsonFile(path, 0);
  const b = new JsonFile(path, 0);
  const seen: string[][] = [];
  b.onDidChangeExternally((keys) => seen.push(keys));
  b.set("mine", "local, not written yet");
  a.set("profile", "new provider");
  a.set("mine", "from a");
  a.flush();
  // mtime resolution: make sure the change is visible as a newer file.
  const t = new Date(Date.now() + 2000);
  utimesSync(path, t, t);
  b.reload();
  assert.equal(b.get("profile"), "new provider");
  assert.equal(b.get("mine"), "local, not written yet");
  assert.deepEqual(seen, [["profile"]]);
  b.flush();
  assert.equal(disk(path).mine, "local, not written yet");
  assert.equal(disk(path).profile, "new provider");
  a.dispose();
  b.dispose();
});

test("SecretStorage reports keys another sidecar stored", async () => {
  const path = join(tmp(), "secrets.json");
  const other = new JsonFile(path, 0);
  const mine = new JsonFile(path, 0);
  const secrets = new SecretStorage(mine);
  const changed: string[] = [];
  secrets.onDidChange((e) => changed.push(e.key));
  other.set("roo_cline_config_api_config", "{\"x\":1}");
  other.flush();
  const t = new Date(Date.now() + 2000);
  utimesSync(path, t, t);
  mine.reload();
  assert.deepEqual(changed, ["roo_cline_config_api_config"]);
  assert.equal(await secrets.get("roo_cline_config_api_config"), "{\"x\":1}");
  other.dispose();
  mine.dispose();
});

test("a stale lock (a process that died holding it) is taken over", () => {
  const path = join(tmp(), "settings.json");
  mkdirSync(`${path}.lock`);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${path}.lock`, old, old);
  assert.equal(withFileLock(path, () => 42), 42);
  assert.equal(existsSync(`${path}.lock`), false);
});

test("two real processes writing concurrently lose no key", async () => {
  const path = join(tmp(), "globalState.json");
  const storage = pathToFileURL(join(import.meta.dirname, "..", "vscode", "storage.js")).href;
  const writer = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const code = `
        const { JsonFile } = await import(${JSON.stringify(storage)});
        const f = new JsonFile(${JSON.stringify(path)}, 0);
        for (let i = 0; i < 40; i++) { f.set("${name}" + i, i); f.flush(); }
        f.dispose();`;
      const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" });
      p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`${name} exited ${c}`))));
    });
  await Promise.all([writer("a"), writer("b")]);
  const keys = Object.keys(disk(path));
  assert.equal(keys.length, 80, `missing: ${80 - keys.length}`);
});
