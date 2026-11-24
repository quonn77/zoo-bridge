import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetFor, BIN_DIR, downloadRipgrep, readRipgrepPin, resolveRipgrep, RG, type RipgrepAsset, type RipgrepPin } from "../ripgrep.js";
import { readTar, readTarGzFile } from "../tar.js";
import { makeTarGz, makeZip } from "./zipfixture.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const serve = (url: string, body: Buffer): typeof fetch =>
  (async (u: string | URL | Request) => (String(u) === url ? new Response(new Uint8Array(body)) : new Response("no", { status: 404 }))) as typeof fetch;
const binIn = (appRoot: string) => join(appRoot, ...BIN_DIR, RG);

test("tar.gz: regular files, GNU long names, missing names", () => {
  const long = `ripgrep-15.2.0-x86_64-unknown-linux-musl/${"d".repeat(120)}/rg`;
  const tgz = makeTarGz([
    { name: "ripgrep-15.2.0-x86_64-unknown-linux-musl/README.md", data: "readme" },
    { name: "ripgrep-15.2.0-x86_64-unknown-linux-musl/rg", data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), mode: 0o755 },
    { name: long, data: "deep", longName: true },
  ]);
  assert.deepEqual(readTarGzFile(tgz, "ripgrep-15.2.0-x86_64-unknown-linux-musl/rg"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  assert.equal(readTarGzFile(tgz, long)?.toString(), "deep");
  assert.equal(readTarGzFile(tgz, "nope"), undefined);
});

test("tar: a corrupt header is refused", () => {
  const tar = Buffer.alloc(2048);
  tar.write("name", 0);
  tar.write("0000000\0", 148);
  assert.throws(() => readTar(tar), /checksum/);
});

test("resolve: ZOO_APP_ROOT, then the cache, then rg on PATH (copied), then missing", () => {
  const cacheDir = join(tmp("zoo-data-"), "ripgrep");
  const env = tmp("zoo-approot-");
  mkdirSync(join(env, ...BIN_DIR), { recursive: true });
  writeFileSync(binIn(env), "rg");
  assert.deepEqual(resolveRipgrep({ cacheDir, skipVscode: true, envAppRoot: env, path: "" }), { appRoot: env, source: "env", ready: true });

  const pin: RipgrepPin = { version: "15.2.0", assets: { [`${process.platform}-${process.arch}`]: { url: "https://example.invalid/rg.zip", sha256: "a".repeat(64), file: "x/rg" } } };
  const missing = resolveRipgrep({ cacheDir, skipVscode: true, pin, path: "" });
  assert.deepEqual(missing, { appRoot: cacheDir, ready: false, asset: pin.assets[`${process.platform}-${process.arch}`], version: "15.2.0" });
  assert.deepEqual(resolveRipgrep({ cacheDir, skipVscode: true, path: "" }), { appRoot: cacheDir, ready: false, asset: undefined, version: undefined });

  const pathDir = tmp("zoo-path-");
  writeFileSync(join(pathDir, RG), "rg from PATH");
  assert.deepEqual(resolveRipgrep({ cacheDir, skipVscode: true, path: pathDir }), { appRoot: cacheDir, source: "path", ready: true });
  assert.equal(readFileSync(binIn(cacheDir), "utf8"), "rg from PATH");
  assert.deepEqual(resolveRipgrep({ cacheDir, skipVscode: true, path: "" }), { appRoot: cacheDir, source: "cache", ready: true });
});

test("download: the zip's rg is installed only with the pinned SHA-256", async () => {
  const cacheDir = join(tmp("zoo-data-"), "ripgrep");
  const zip = readFileSync(makeZip([
    { name: "ripgrep-15.2.0-x86_64-pc-windows-msvc/COPYING", data: "licence" },
    { name: "ripgrep-15.2.0-x86_64-pc-windows-msvc/rg.exe", data: "MZ fake rg" },
  ]));
  const asset: RipgrepAsset = { url: "https://example.invalid/rg.zip", sha256: sha(zip), file: "ripgrep-15.2.0-x86_64-pc-windows-msvc/rg.exe" };
  await assert.rejects(downloadRipgrep({ ...asset, sha256: "0".repeat(64) }, "15.2.0", cacheDir, serve(asset.url, zip)), /not used/);
  assert.equal(existsSync(cacheDir), false, "nothing installed on a bad hash");
  await downloadRipgrep(asset, "15.2.0", cacheDir, serve(asset.url, zip));
  assert.equal(readFileSync(binIn(cacheDir), "utf8"), "MZ fake rg");
  assert.deepEqual(resolveRipgrep({ cacheDir, skipVscode: true, path: "" }), { appRoot: cacheDir, source: "cache", ready: true });
});

test("download: the tar.gz's rg is installed executable", async () => {
  const cacheDir = join(tmp("zoo-data-"), "ripgrep");
  const tgz = makeTarGz([{ name: "ripgrep-15.2.0-x86_64-unknown-linux-musl/rg", data: "ELF fake rg", mode: 0o755 }]);
  const asset: RipgrepAsset = { url: "https://example.invalid/rg.tar.gz", sha256: sha(tgz), file: "ripgrep-15.2.0-x86_64-unknown-linux-musl/rg" };
  await downloadRipgrep(asset, "15.2.0", cacheDir, serve(asset.url, tgz));
  assert.equal(readFileSync(binIn(cacheDir), "utf8"), "ELF fake rg");
  if (process.platform !== "win32") assert.ok(statSync(binIn(cacheDir)).mode & 0o100);
  await assert.rejects(downloadRipgrep({ ...asset, file: "x/rg" }, "15.2.0", tmp("zoo-c-"), serve(asset.url, tgz)), /not found in/);
});

test("the pin: this platform's https asset with a SHA-256, read from ZOO_RIPGREP", () => {
  const a = { url: "https://example.invalid/rg.zip", sha256: "b".repeat(64), file: "x/rg.exe" };
  const pin = readRipgrepPin({ ZOO_RIPGREP: JSON.stringify({ version: "15.2.0", assets: { "win32-x64": a, "linux-x64": { ...a, url: "http://x" } } }) });
  assert.deepEqual(assetFor(pin, "win32", "x64"), a);
  assert.equal(assetFor(pin, "linux", "x64"), undefined, "not https");
  assert.equal(assetFor(pin, "freebsd", "x64"), undefined);
  assert.equal(readRipgrepPin({ ZOO_RIPGREP: "not json" }), undefined);
});
