// Where the Zoo Code extension the sidecar runs comes from.
//
// The plugin bundles the webview UI of one Zoo Code version and pins that
// version's release VSIX (URL and SHA-256, plugin/zoo-code.json). The
// extension must be the same version, since UI and extension speak a protocol
// that changes between releases. It is looked for, in this order:
//
//   1. the `zooExtension` setting: an extension folder or a .vsix file;
//   2. VS Code's extensions folder, only with exactly the pinned version;
//   3. the plugin's cache, a VSIX extracted earlier whose SHA-256 matched;
//   4. the release VSIX, downloaded after the user agrees, verified against
//      the pinned SHA-256 and extracted to the cache.
//
// Without a pin (a development build whose UI was not copied from a VSIX),
// the newest Zoo Code in VS Code is used, as before, with a warning when its
// version differs.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extractZip } from "./zip.js";

/** The release VSIX the plugin pins (plugin/zoo-code.json). */
export interface PinnedVsix {
  version: string;
  url: string;
  sha256: string;
}

export type ExtensionSource = "setting" | "vscode" | "cache" | "download" | "vscode-other-version";

export type Resolution =
  | { dir: string; source: ExtensionSource }
  /** Nothing usable on the machine: the pinned VSIX can be downloaded. */
  | { missing: true; pinned: PinnedVsix }
  /** Nothing usable and nothing to download. */
  | { missing: true; pinned?: undefined };

export interface ResolveOptions {
  /** The `zooExtension` setting (ZOO_EXTENSION): an extension folder or a .vsix. */
  setting?: string;
  /** The Zoo Code version whose UI the plugin bundles. */
  expectedVersion?: string;
  pinned?: PinnedVsix;
  /** Where downloaded or set VSIX files are extracted (`<data>/extensions`). */
  cacheDir: string;
  /** VS Code's extensions folder (default ~/.vscode/extensions). */
  vscodeExtensionsDir?: string;
}

/** Written into an extracted extension once it is complete. */
const MARKER = ".zoo-bridge.json";
const VSCODE_NAME = /^zoocodeorganization\.zoo-code-(\d+)\.(\d+)\.(\d+)$/;

export function readPinned(env: NodeJS.ProcessEnv = process.env): PinnedVsix | undefined {
  const { ZOO_EXPECTED_VERSION: version, ZOO_VSIX_URL: url, ZOO_VSIX_SHA256: sha256 } = env;
  if (!version || !url || !sha256 || !/^[0-9a-f]{64}$/.test(sha256) || !url.startsWith("https://")) return undefined;
  return { version, url, sha256 };
}

function versionOf(dir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

function vscodeExtensions(dir: string): { dir: string; version: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => VSCODE_NAME.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]) || Number(a[2]) - Number(b[2]) || Number(a[3]) - Number(b[3]))
    .map((m) => ({ dir: join(dir, m[0]), version: `${m[1]}.${m[2]}.${m[3]}` }))
    .filter((e) => existsSync(join(e.dir, "package.json")));
}

/** The cache folder of a VSIX: by version, plus the hash for one that is not the pinned file. */
function cacheFolder(cacheDir: string, version: string, sha256: string, pinned?: PinnedVsix): string {
  return join(cacheDir, pinned && sha256 === pinned.sha256 ? `zoo-code-${version}` : `zoo-code-${version}-${sha256.slice(0, 12)}`);
}

function readMarker(dir: string): { sha256?: string; version?: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as { sha256?: string; version?: string };
  } catch {
    return undefined;
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * On Windows a folder whose files were just written may be briefly held (an
 * antivirus scanning them, the search indexer): the rename then fails with
 * EPERM, EACCES or EBUSY. Retry for a few seconds before giving up.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 20 || !(code === "EPERM" || code === "EACCES" || code === "EBUSY")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 + attempt * 50);
    }
  }
}

/**
 * Extracts a VSIX into the cache: into a temporary folder first, renamed when
 * complete, so an interrupted extraction never looks like a cached extension.
 */
export function extractToCache(vsix: string, sha256: string, cacheDir: string, pinned?: PinnedVsix): { dir: string; version: string } {
  mkdirSync(cacheDir, { recursive: true });
  const tmp = join(cacheDir, `.extract-${randomUUID()}`);
  try {
    extractZip(vsix, tmp, "extension/");
    const version = versionOf(tmp);
    if (!version) throw new Error(`${basename(vsix)} has no extension/package.json: not a Zoo Code VSIX`);
    writeFileSync(join(tmp, MARKER), JSON.stringify({ version, sha256, source: basename(vsix) }));
    const dir = cacheFolder(cacheDir, version, sha256, pinned);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    renameWithRetry(tmp, dir);
    return { dir, version };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Removes cached extensions other than `keep`, and leftovers of interrupted work. */
export function pruneCache(cacheDir: string, keep: string): void {
  if (!existsSync(cacheDir)) return;
  for (const name of readdirSync(cacheDir)) {
    const p = join(cacheDir, name);
    if (p === keep) continue;
    if (name.startsWith("zoo-code-") || name.startsWith(".extract-") || name.startsWith(".download-")) rmSync(p, { recursive: true, force: true });
  }
}

export async function resolveExtension(opts: ResolveOptions): Promise<Resolution> {
  const { setting, expectedVersion, pinned, cacheDir } = opts;
  const vscodeDir = opts.vscodeExtensionsDir ?? join(homedir(), ".vscode", "extensions");

  // 1. The setting: the user's explicit choice, used whatever its version.
  if (setting) {
    if (!existsSync(setting)) throw new Error(`zooExtension setting: ${setting} does not exist`);
    if (statSync(setting).isDirectory()) {
      if (!versionOf(setting)) throw new Error(`zooExtension setting: ${setting} has no package.json (not a Zoo Code extension folder)`);
      return { dir: setting, source: "setting" };
    }
    if (!setting.toLowerCase().endsWith(".vsix")) throw new Error(`zooExtension setting: ${setting} is neither a folder nor a .vsix file`);
    const sha256 = await sha256File(setting);
    const cached = (existsSync(cacheDir) ? readdirSync(cacheDir, { withFileTypes: true }) : []).find((d) => d.isDirectory() && readMarker(join(cacheDir, d.name))?.sha256 === sha256);
    if (cached) return { dir: join(cacheDir, cached.name), source: "setting" };
    return { dir: extractToCache(setting, sha256, cacheDir, pinned).dir, source: "setting" };
  }

  // 2. VS Code, with exactly the version of the bundled UI.
  const installed = vscodeExtensions(vscodeDir);
  const exact = expectedVersion ? installed.find((e) => e.version === expectedVersion) : undefined;
  if (exact) return { dir: exact.dir, source: "vscode" };

  // 3. The cache: the pinned VSIX, extracted earlier.
  if (pinned) {
    const dir = cacheFolder(cacheDir, pinned.version, pinned.sha256, pinned);
    const marker = readMarker(dir);
    if (marker?.sha256 === pinned.sha256 && versionOf(dir) === pinned.version) return { dir, source: "cache" };
    // 4. Nothing on the machine: the pinned VSIX can be downloaded.
    return { missing: true, pinned };
  }

  // No pin: the newest Zoo Code in VS Code, whatever its version.
  const newest = installed.at(-1);
  if (newest) return { dir: newest.dir, source: "vscode-other-version" };
  return { missing: true };
}

export interface DownloadProgress {
  received: number;
  total?: number;
}

/**
 * Downloads the pinned VSIX, checks its SHA-256 and extracts it to the cache.
 * Nothing is kept when the hash differs.
 */
export async function downloadExtension(
  pinned: PinnedVsix,
  cacheDir: string,
  onProgress?: (p: DownloadProgress) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `.download-${randomUUID()}.vsix`);
  try {
    const res = await fetchImpl(pinned.url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`download of ${pinned.url} failed: HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || undefined;
    const hash = createHash("sha256");
    let received = 0;
    let last = 0;
    const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      if (onProgress && (received - last >= 1 << 20 || received === total)) {
        last = received;
        onProgress({ received, total });
      }
    });
    await pipeline(body, createWriteStream(file));
    const sha256 = hash.digest("hex");
    if (sha256 !== pinned.sha256) {
      throw new Error(`downloaded Zoo Code ${pinned.version} has SHA-256 ${sha256}, expected ${pinned.sha256}: not used`);
    }
    const { dir, version } = extractToCache(file, sha256, cacheDir, pinned);
    if (version !== pinned.version) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`downloaded VSIX is Zoo Code ${version}, expected ${pinned.version}`);
    }
    return dir;
  } finally {
    rmSync(file, { force: true });
  }
}
