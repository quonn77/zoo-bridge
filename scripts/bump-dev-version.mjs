#!/usr/bin/env node
// Gives plugin/plugin.toml a fresh `-dev.<timestamp>` version.
//
// OpenIDEA serves web view files as `immutable` under a revision derived from
// the package digest, or `v<version>` when there is none (a linked dev
// folder). Without a new version the web view keeps the files it first
// loaded, even after Reload. Run this after changing plugin/webview, then
// Reload the plugin.
//
//   node scripts/bump-dev-version.mjs          → 0.2.0-dev.1795115134
//   node scripts/bump-dev-version.mjs --release → 0.2.0

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const manifest = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "plugin.toml");
const text = readFileSync(manifest, "utf8");
const m = /^version = "(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?"$/m.exec(text);
if (!m) {
  console.error(`no semver version line in ${manifest}`);
  process.exit(1);
}
const next = process.argv.includes("--release") ? m[1] : `${m[1]}-dev.${Math.floor(Date.now() / 1000)}`;
writeFileSync(manifest, text.replace(m[0], `version = "${next}"`));
console.log(`plugin.toml version ${m[0].slice(11, -1)} → ${next}`);
