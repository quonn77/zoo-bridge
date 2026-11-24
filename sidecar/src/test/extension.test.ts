import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadExtension, pruneCache, readPinned, resolveExtension, type PinnedVsix } from "../extension.js";
import { makeZip } from "./zipfixture.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function vsix(version: string): { file: string; sha256: string } {
  const file = makeZip([
    { name: "extension.vsixmanifest", data: "<xml/>" },
    { name: "extension/package.json", data: JSON.stringify({ name: "zoo-code", version }) },
    { name: "extension/dist/extension.js", data: "exports.activate = () => {};\n" },
  ]);
  return { file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

function vscodeExtension(root: string, version: string): string {
  const dir = join(root, `zoocodeorganization.zoo-code-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "zoo-code", version }));
  return dir;
}

/** A fetch that serves `file` for `url`, and 404 otherwise. */
function fetchFrom(url: string, file: string): typeof fetch {
  return (async (u: string | URL | Request) => {
    if (String(u) !== url) return new Response("not found", { status: 404 });
    const body = readFileSync(file);
    return new Response(body, { headers: { "content-length": String(body.length) } });
  }) as typeof fetch;
}

const URL_ = "https://example.invalid/zoo-code-3.98.2.vsix";

test("VS Code's extension is used only with exactly the pinned version", async () => {
  const vscode = tmp("zoo-vsc-");
  const cacheDir = join(tmp("zoo-data-"), "extensions");
  const pinned: PinnedVsix = { version: "3.98.2", url: URL_, sha256: "a".repeat(64) };
  vscodeExtension(vscode, "3.98.0");
  vscodeExtension(vscode, "3.99.0");
  assert.deepEqual(await resolveExtension({ expectedVersion: "3.98.2", pinned, cacheDir, vscodeExtensionsDir: vscode }), { missing: true, pinned });
  const exact = vscodeExtension(vscode, "3.98.2");
  assert.deepEqual(await resolveExtension({ expectedVersion: "3.98.2", pinned, cacheDir, vscodeExtensionsDir: vscode }), { dir: exact, source: "vscode" });
});

test("without a pin, the newest VS Code extension is used whatever its version", async () => {
  const vscode = tmp("zoo-vsc-");
  vscodeExtension(vscode, "3.98.0");
  const newest = vscodeExtension(vscode, "3.99.0");
  const r = await resolveExtension({ expectedVersion: "3.98.2", cacheDir: tmp("zoo-cache-"), vscodeExtensionsDir: vscode });
  assert.deepEqual(r, { dir: newest, source: "vscode-other-version" });
  assert.deepEqual(await resolveExtension({ cacheDir: tmp("zoo-cache-"), vscodeExtensionsDir: tmp("zoo-vsc-") }), { missing: true });
});

test("download: verified, extracted to the cache, then found there without VS Code", async () => {
  const { file, sha256 } = vsix("3.98.2");
  const cacheDir = join(tmp("zoo-data-"), "extensions");
  const pinned: PinnedVsix = { version: "3.98.2", url: URL_, sha256 };
  const progress: number[] = [];
  const dir = await downloadExtension(pinned, cacheDir, (p) => progress.push(p.received), fetchFrom(URL_, file));
  assert.equal(dir, join(cacheDir, "zoo-code-3.98.2"));
  assert.ok(existsSync(join(dir, "dist", "extension.js")));
  assert.ok(progress.length > 0);
  assert.deepEqual(readdirSync(cacheDir), ["zoo-code-3.98.2"], "no temporary files left");
  const r = await resolveExtension({ expectedVersion: "3.98.2", pinned, cacheDir, vscodeExtensionsDir: tmp("zoo-vsc-") });
  assert.deepEqual(r, { dir, source: "cache" });
});

test("download: a file whose SHA-256 differs is not used and leaves nothing behind", async () => {
  const { file } = vsix("3.98.2");
  const cacheDir = join(tmp("zoo-data-"), "extensions");
  const pinned: PinnedVsix = { version: "3.98.2", url: URL_, sha256: "0".repeat(64) };
  await assert.rejects(downloadExtension(pinned, cacheDir, undefined, fetchFrom(URL_, file)), /SHA-256 .* expected 0{64}: not used/);
  assert.deepEqual(readdirSync(cacheDir), []);
  await assert.rejects(downloadExtension({ ...pinned, url: "https://example.invalid/other" }, cacheDir, undefined, fetchFrom(URL_, file)), /HTTP 404/);
  assert.deepEqual(readdirSync(cacheDir), []);
});

test("a cache folder without a matching marker (interrupted or tampered) is not used", async () => {
  const { file, sha256 } = vsix("3.98.2");
  const cacheDir = join(tmp("zoo-data-"), "extensions");
  const pinned: PinnedVsix = { version: "3.98.2", url: URL_, sha256 };
  const dir = await downloadExtension(pinned, cacheDir, undefined, fetchFrom(URL_, file));
  writeFileSync(join(dir, ".zoo-bridge.json"), JSON.stringify({ version: "3.98.2", sha256: "f".repeat(64) }));
  assert.deepEqual(await resolveExtension({ expectedVersion: "3.98.2", pinned, cacheDir, vscodeExtensionsDir: tmp("zoo-vsc-") }), { missing: true, pinned });
});

test("the setting wins: an extension folder, or a .vsix extracted to the cache once", async () => {
  const vscode = tmp("zoo-vsc-");
  const cacheDir = join(tmp("zoo-data-"), "extensions");
  const pinned: PinnedVsix = { version: "3.98.2", url: URL_, sha256: "a".repeat(64) };
  vscodeExtension(vscode, "3.98.2");
  const folder = vscodeExtension(tmp("zoo-own-"), "3.97.0");
  assert.deepEqual(await resolveExtension({ setting: folder, expectedVersion: "3.98.2", pinned, cacheDir, vscodeExtensionsDir: vscode }), { dir: folder, source: "setting" });

  const { file, sha256 } = vsix("3.98.1");
  const first = await resolveExtension({ setting: file, expectedVersion: "3.98.2", pinned, cacheDir, vscodeExtensionsDir: vscode });
  assert.deepEqual(first, { dir: join(cacheDir, `zoo-code-3.98.1-${sha256.slice(0, 12)}`), source: "setting" });
  const again = await resolveExtension({ setting: file, expectedVersion: "3.98.2", pinned, cacheDir, vscodeExtensionsDir: vscode });
  assert.deepEqual(again, first);

  await assert.rejects(resolveExtension({ setting: join(vscode, "nope"), cacheDir }), /does not exist/);
  const txt = join(tmp("zoo-own-"), "x.txt");
  writeFileSync(txt, "x");
  await assert.rejects(resolveExtension({ setting: txt, cacheDir }), /neither a folder nor a \.vsix/);
});

test("pruneCache keeps the extension in use and removes the rest", () => {
  const cacheDir = tmp("zoo-cache-");
  for (const d of ["zoo-code-3.98.0", "zoo-code-3.98.2", ".extract-x", ".download-y.vsix", "other"]) mkdirSync(join(cacheDir, d));
  pruneCache(cacheDir, join(cacheDir, "zoo-code-3.98.2"));
  assert.deepEqual(readdirSync(cacheDir).sort(), ["other", "zoo-code-3.98.2"]);
});

test("readPinned accepts only a complete https pin with a SHA-256", () => {
  const ok = { ZOO_EXPECTED_VERSION: "3.98.2", ZOO_VSIX_URL: URL_, ZOO_VSIX_SHA256: "a".repeat(64) };
  assert.deepEqual(readPinned(ok), { version: "3.98.2", url: URL_, sha256: "a".repeat(64) });
  assert.equal(readPinned({ ...ok, ZOO_VSIX_URL: "http://example.invalid/x.vsix" }), undefined);
  assert.equal(readPinned({ ...ok, ZOO_VSIX_SHA256: "xyz" }), undefined);
  assert.equal(readPinned({ ZOO_EXPECTED_VERSION: "3.98.2" }), undefined);
});
