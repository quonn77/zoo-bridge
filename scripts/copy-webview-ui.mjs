#!/usr/bin/env node
// Copies Zoo Code's webview UI into the OpenIDEA web view package.
//
//   node scripts/copy-webview-ui.mjs [<zoo-code extension dir or .vsix-extracted "extension" dir>]
//
// Without an argument it uses the newest Zoo Code installed in VS Code
// (~/.vscode/extensions/zoocodeorganization.zoo-code-*).
//
// Output: plugin/webview/zoo/ with the same layout Zoo Code's getHtmlContent()
// expects (webview-ui/build/assets, webview-ui/audio, assets/codicons,
// assets/vscode-material-icons/icons, assets/images), source maps left out.
//
// OpenIDEA serves a web view from <scheme>/<plugin id>/<revision>/<path>, so
// root-absolute URLs ("/assets/…") escape the package. Two of them in Zoo's
// Vite build are rewritten to be relative; the script fails if they are not
// found, so a changed bundle is noticed instead of silently broken.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "plugin", "webview", "zoo");

function newestInstalled() {
  const dir = join(homedir(), ".vscode", "extensions");
  if (!existsSync(dir)) return undefined;
  const versions = readdirSync(dir)
    .map((name) => /^zoocodeorganization\.zoo-code-(\d+)\.(\d+)\.(\d+)$/.exec(name))
    .filter(Boolean)
    .sort((a, b) => a.slice(1).map(Number).reduce((r, n, i) => r || n - Number(b[i + 1]), 0));
  return versions.length ? join(dir, versions.at(-1)[0]) : undefined;
}

const src = process.argv[2] ?? newestInstalled();
if (!src || !existsSync(join(src, "webview-ui", "build", "assets", "index.js"))) {
  console.error("Zoo Code extension not found: pass the extension directory (the one holding webview-ui/ and assets/).");
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));

const PARTS = [
  ["webview-ui", "build"],
  ["webview-ui", "audio"],
  ["assets", "codicons"],
  ["assets", "vscode-material-icons", "icons"],
  ["assets", "images"],
];

rmSync(out, { recursive: true, force: true });
let files = 0;
let bytes = 0;
for (const part of PARTS) {
  const from = join(src, ...part);
  if (!existsSync(from)) {
    console.error(`missing ${relative(src, from)} in ${src}`);
    process.exit(1);
  }
  cpSync(from, join(out, ...part), {
    recursive: true,
    filter: (p) => {
      if (p.endsWith(".map")) return false;
      const s = statSync(p);
      if (s.isFile()) {
        files++;
        bytes += s.size;
      }
      return true;
    },
  });
}

function patch(file, from, to, what) {
  const text = readFileSync(file, "utf8");
  const count = text.split(from).length - 1;
  if (count === 0) {
    console.error(`cannot rewrite ${what} in ${relative(out, file)}: pattern not found (Zoo Code ${pkg.version} bundle changed?)`);
    process.exit(1);
  }
  writeFileSync(file, text.split(from).join(to));
  console.log(`rewrote ${what}: ${count}×`);
}

const assets = join(out, "webview-ui", "build", "assets");
// Vite's preload helper: deps ("assets/x.js") are resolved from the site root.
patch(join(assets, "index.js"), "e=>`/`+e", "e=>new URL(`../`+e,import.meta.url).href", "Vite preload base");
// KaTeX fonts referenced from the site root.
patch(join(assets, "index.css"), "url(/assets/", "url(./", "CSS asset URLs");

writeFileSync(join(out, "VERSION"), `${pkg.name} ${pkg.version}\n`);
// Apache License 2.0, section 4: the license goes with the redistributed
// files, and modified files are marked.
cpSync(join(src, "LICENSE.txt"), join(out, "LICENSE.txt"));
writeFileSync(
  join(out, "MODIFICATIONS.md"),
  `# Modifications to the Zoo Code webview UI

Copied from Zoo Code ${pkg.version} (Apache License 2.0, see LICENSE.txt) by
scripts/copy-webview-ui.mjs of zoo-bridge (github.com/quonn77/zoo-bridge). Source maps are left
out. These files were changed so the UI loads from an OpenIDEA web view
package, where root-absolute URLs ("/assets/…") resolve outside the package:

- \`webview-ui/build/assets/index.js\`: Vite's preload helper resolves
  dependencies relative to the module (\`new URL("../" + dep, import.meta.url)\`)
  instead of from the site root.
- \`webview-ui/build/assets/index.css\`: \`url(/assets/…)\` → \`url(./…)\`.

No other file is modified.
`,
);
mkdirSync(out, { recursive: true });
console.log(`Zoo Code ${pkg.version} webview UI → ${relative(root, out)} (${files} files, ${(bytes / 1048576).toFixed(1)} MiB)`);
if (files > 4000) console.warn("warning: close to OpenIDEA's limit of 4096 files per web view directory");
