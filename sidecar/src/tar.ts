// Minimal reader for .tar.gz archives (ripgrep's Linux and macOS releases).
//
// Reads ustar/GNU headers, follows GNU long names ("L") and pax "path"
// records, and returns one regular file by its name; nothing is written to
// disk here, so archive paths cannot escape anywhere.

import { gunzipSync } from "node:zlib";

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.toString("utf8", 0, end < 0 ? raw.length : end);
}

function octal(block: Buffer, start: number, length: number): number {
  const s = field(block, start, length).trim();
  if (!/^[0-7]*$/.test(s)) throw new Error(`bad tar number: ${JSON.stringify(s)}`);
  return s ? parseInt(s, 8) : 0;
}

export interface TarEntry {
  name: string;
  type: string;
  mode: number;
  data: Buffer;
}

export function readTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let p = 0;
  let longName: string | undefined;
  while (p + 512 <= tar.length) {
    const h = tar.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break; // end of archive
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8)) throw new Error(`bad tar header checksum at offset ${p}`);
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48); // NUL is a regular file
    const data = tar.subarray(p + 512, p + 512 + size);
    if (data.length !== size) throw new Error("truncated tar archive");
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "x") {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (path) longName = path[1];
      continue;
    }
    if (type === "g") continue;
    const prefix = field(h, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    longName = undefined;
    entries.push({ name, type, mode: octal(h, 100, 8), data });
  }
  return entries;
}

/** A regular file of a .tar.gz, or undefined when it is not there. */
export function readTarGzFile(tgz: Buffer, name: string): Buffer | undefined {
  const e = readTar(gunzipSync(tgz)).find((x) => x.name === name && (x.type === "0" || x.type === "7"));
  return e ? Buffer.from(e.data) : undefined;
}
