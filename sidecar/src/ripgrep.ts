// ripgrep for Zoo Code's file search and listing.
//
// Zoo Code runs ripgrep from `vscode.env.appRoot` (node_modules/@vscode/
// ripgrep/bin/rg, and a few variants), the way VS Code ships it; it never
// looks on PATH. The sidecar gives it an appRoot, looked for in this order:
//
//   1. ZOO_APP_ROOT;
//   2. a VS Code installation (its own ripgrep);
//   3. the plugin's cache (<data>/ripgrep), filled by 4 or 5;
//   4. `rg` on PATH, copied into the cache;
//   5. the official ripgrep release the plugin pins (plugin/ripgrep.json, one
//      archive per platform with its SHA-256), downloaded after the user
//      agrees, verified, and its `rg` binary copied into the cache.
//
// For 3–5 the appRoot is the cache folder even while it is still empty: Zoo
// Code resolves ripgrep on every search, so a download made later is used
// without restarting.

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readTarGzFile } from "./tar.js";
import { readCentralDirectory, readEntry } from "./zip.js";

export interface RipgrepAsset {
  url: string;
  sha256: string;
  /** The binary's path inside the archive. */
  file: string;
}

/** plugin/ripgrep.json: archives by `${process.platform}-${process.arch}`. */
export interface RipgrepPin {
  version: string;
  assets: Record<string, RipgrepAsset>;
}

export const RG = process.platform === "win32" ? "rg.exe" : "rg";
/** Where Zoo Code looks first under appRoot. */
export const BIN_DIR = ["node_modules", "@vscode", "ripgrep", "bin"];

/** Ripgrep locations Zoo Code probes under `vscode.env.appRoot`. */
const RIPGREP_DIRS = [
  BIN_DIR,
  ["node_modules", "vscode-ripgrep", "bin"],
  ["node_modules.asar.unpacked", "@vscode", "ripgrep", "bin"],
  ["node_modules.asar.unpacked", "vscode-ripgrep", "bin"],
  ["node_modules.asar.unpacked", "@vscode", "ripgrep-universal", "bin"],
];

const MARKER = ".zoo-bridge.json";

/**
 * A VS Code `resources/app` holding ripgrep. Recent VS Code builds keep it in
 * a versioned folder (`Microsoft VS Code/<hash>/`).
 */
export function findVscodeAppRoot(): string | undefined {
  const installs = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code"),
    process.env.ProgramFiles && join(process.env.ProgramFiles, "Microsoft VS Code"),
    "/usr/share/code",
    "/Applications/Visual Studio Code.app/Contents",
  ].filter((p): p is string => !!p && existsSync(p));
  const candidates: string[] = [];
  for (const dir of installs) {
    candidates.push(join(dir, "resources", "app"), join(dir, "Resources", "app"));
    for (const sub of readdirSync(dir)) candidates.push(join(dir, sub, "resources", "app"));
  }
  return candidates.find((c) => RIPGREP_DIRS.some((parts) => existsSync(join(c, ...parts))));
}

/** `rg` on PATH, if any. */
export function findOnPath(path = process.env.PATH ?? ""): string | undefined {
  const sep = process.platform === "win32" ? ";" : ":";
  return path
    .split(sep)
    .filter(Boolean)
    .map((d) => join(d.replace(/^"|"$/g, ""), RG))
    .find((f) => existsSync(f));
}

export function readRipgrepPin(env: NodeJS.ProcessEnv = process.env): RipgrepPin | undefined {
  try {
    const pin = JSON.parse(env.ZOO_RIPGREP ?? "") as RipgrepPin;
    return pin && typeof pin.version === "string" && pin.assets ? pin : undefined;
  } catch {
    return undefined;
  }
}

/** This machine's archive in the pin, if the release has one. */
export function assetFor(pin: RipgrepPin | undefined, platform = process.platform, arch = process.arch): RipgrepAsset | undefined {
  const a = pin?.assets[`${platform}-${arch}`];
  return a && a.url.startsWith("https://") && /^[0-9a-f]{64}$/.test(a.sha256) && a.file ? a : undefined;
}

export type RipgrepSource = "env" | "vscode" | "cache" | "path" | "download";

export type RipgrepResolution =
  | { appRoot: string; source: RipgrepSource; ready: true }
  /** Not on the machine: appRoot is the cache, which a download fills. */
  | { appRoot: string; ready: false; asset?: RipgrepAsset; version?: string };

export interface RipgrepOptions {
  /** The cache folder, used as appRoot (`<data>/ripgrep`). */
  cacheDir: string;
  pin?: RipgrepPin;
  /** Skip VS Code (tests, or a machine where it must not be used). */
  skipVscode?: boolean;
  envAppRoot?: string;
  path?: string;
}

function cached(cacheDir: string): { source?: string } | undefined {
  if (!existsSync(join(cacheDir, ...BIN_DIR, RG))) return undefined;
  try {
    return JSON.parse(readFileSync(join(cacheDir, MARKER), "utf8")) as { source?: string };
  } catch {
    return undefined;
  }
}

/** Puts `binary` into a fresh cache folder, replacing the old one when complete. */
function installBinary(cacheDir: string, binary: Buffer, marker: Record<string, unknown>): void {
  const tmp = join(dirname(cacheDir), `.ripgrep-${randomUUID()}`);
  try {
    const bin = join(tmp, ...BIN_DIR, RG);
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, binary);
    if (process.platform !== "win32") chmodSync(bin, 0o755);
    writeFileSync(join(tmp, MARKER), JSON.stringify(marker));
    rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5 });
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, cacheDir);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= 20 || !(code === "EPERM" || code === "EACCES" || code === "EBUSY")) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 + attempt * 50);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function resolveRipgrep(opts: RipgrepOptions): RipgrepResolution {
  const { cacheDir } = opts;
  const envAppRoot = opts.envAppRoot ?? process.env.ZOO_APP_ROOT;
  if (envAppRoot && RIPGREP_DIRS.some((parts) => existsSync(join(envAppRoot, ...parts)))) return { appRoot: envAppRoot, source: "env", ready: true };
  const vscode = opts.skipVscode ? undefined : findVscodeAppRoot();
  if (vscode) return { appRoot: vscode, source: "vscode", ready: true };
  if (cached(cacheDir)) return { appRoot: cacheDir, source: "cache", ready: true };
  const onPath = findOnPath(opts.path);
  if (onPath) {
    installBinary(cacheDir, readFileSync(onPath), { source: "path", from: onPath });
    return { appRoot: cacheDir, source: "path", ready: true };
  }
  const asset = assetFor(opts.pin);
  return { appRoot: cacheDir, ready: false, asset, version: asset && opts.pin?.version };
}

/** Downloads the pinned archive, checks its SHA-256 and installs its `rg` into the cache. */
export async function downloadRipgrep(asset: RipgrepAsset, version: string, cacheDir: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(asset.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download of ${asset.url} failed: HTTP ${res.status}`);
  const archive = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (sha256 !== asset.sha256) throw new Error(`downloaded ripgrep ${version} has SHA-256 ${sha256}, expected ${asset.sha256}: not used`);
  let binary: Buffer | undefined;
  if (asset.url.endsWith(".zip")) {
    const entry = readCentralDirectory(archive).find((e) => e.name === asset.file);
    binary = entry && readEntry(archive, entry);
  } else if (asset.url.endsWith(".tar.gz")) {
    binary = readTarGzFile(archive, asset.file);
  }
  if (!binary) throw new Error(`${asset.file} not found in ${asset.url}`);
  installBinary(cacheDir, binary, { source: "download", version, url: asset.url, sha256 });
}
