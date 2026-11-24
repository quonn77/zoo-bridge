// Minimal ZIP reader for VSIX packages (a VSIX is a ZIP file).
//
// Reads the central directory, supports the two methods VSIX packages use
// (0 stored, 8 deflate), checks each entry's CRC-32 and refuses what it does
// not understand (ZIP64, encryption) instead of guessing. Entries are
// extracted only under a prefix ("extension/") and only to paths inside the
// destination: absolute names, drive letters, backslashes and ".." are
// rejected (zip slip).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function readCentralDirectory(zip: Buffer): ZipEntry[] {
  // The end-of-central-directory record is in the last 22 + 65535 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file: end of central directory not found");
  const count = zip.readUInt16LE(eocd + 10);
  const offset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error("ZIP64 archives are not supported");

  const entries: ZipEntry[] = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== CENTRAL) throw new Error(`bad central directory entry ${i}`);
    const flags = zip.readUInt16LE(p + 8);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const name = zip.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    if (flags & 1) throw new Error(`encrypted entry: ${name}`);
    entries.push({
      name,
      method: zip.readUInt16LE(p + 10),
      crc: zip.readUInt32LE(p + 16),
      compressedSize: zip.readUInt32LE(p + 20),
      size: zip.readUInt32LE(p + 24),
      localHeaderOffset: zip.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readEntry(zip: Buffer, e: ZipEntry): Buffer {
  const h = e.localHeaderOffset;
  if (zip.readUInt32LE(h) !== LOCAL) throw new Error(`bad local header: ${e.name}`);
  const start = h + 30 + zip.readUInt16LE(h + 26) + zip.readUInt16LE(h + 28);
  const raw = zip.subarray(start, start + e.compressedSize);
  let data: Buffer;
  if (e.method === 0) data = Buffer.from(raw);
  else if (e.method === 8) data = inflateRawSync(raw);
  else throw new Error(`unsupported compression method ${e.method}: ${e.name}`);
  if (data.length !== e.size || crc32(data) >>> 0 !== e.crc) throw new Error(`corrupt entry (size or CRC-32): ${e.name}`);
  return data;
}

/** The path below `prefix` an entry extracts to, or an error for unsafe names. */
export function safeRelativePath(name: string, prefix: string): string | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const rel = name.slice(prefix.length);
  if (rel === "" || rel.endsWith("/")) return undefined; // directory entries
  if (name.includes("\\") || name.includes("\0") || /^[A-Za-z]:/.test(rel) || rel.startsWith("/")) throw new Error(`unsafe entry name: ${name}`);
  if (rel.split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error(`unsafe entry name: ${name}`);
  return rel;
}

/** Extracts the entries under `prefix` into `dest`; returns the number of files written. */
export function extractZip(zipFile: string, dest: string, prefix: string): number {
  const zip = readFileSync(zipFile);
  const root = resolve(dest);
  let files = 0;
  for (const e of readCentralDirectory(zip)) {
    const rel = safeRelativePath(e.name, prefix);
    if (rel === undefined) continue;
    const target = resolve(root, ...rel.split("/"));
    if (!target.startsWith(root + sep)) throw new Error(`unsafe entry name: ${e.name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readEntry(zip, e));
    files++;
  }
  return files;
}

/** Reads one file of the archive, or undefined when it is not there. */
export function readZipFile(zipFile: string, name: string): Buffer | undefined {
  const zip = readFileSync(zipFile);
  const e = readCentralDirectory(zip).find((x) => x.name === name);
  return e ? readEntry(zip, e) : undefined;
}
