// Bundles the sidecar into one ES module, which the plugin embeds and writes
// to its data directory at start (OpenIDEA gives plugin code no path to its
// own package files). Output: plugin/sidecar-bundle/main.mjs.
//
//   node scripts/bundle.mjs

import { build } from "esbuild";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, "..", "..", "plugin", "sidecar-bundle", "main.mjs");

await build({
  entryPoints: [join(here, "..", "src", "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Readable on purpose: the package must contain no minified code that
  // isn't plainly built from this repository (community registry rule).
  minify: false,
  legalComments: "inline",
  // ws loads these native accelerators when present and works without them.
  external: ["bufferutil", "utf-8-validate"],
  // CommonJS dependencies (ws) call require(); give the ES module one.
  banner: { js: 'import { createRequire as __zooCreateRequire } from "node:module"; const require = __zooCreateRequire(import.meta.url);' },
  logLevel: "warning",
});

console.log(`sidecar bundle → ${outfile} (${(statSync(outfile).size / 1024).toFixed(0)} KiB)`);
