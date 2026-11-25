#!/usr/bin/env node
// Builds the installable package: dist/<id>-<version>.oiplugin.
//
//   node scripts/package.mjs [--version 0.3.0] [--key <file> --publisher <id>] [--skip-tests]
//
// 1. Zoo Code's webview UI in plugin/webview/zoo (copied from VS Code if missing)
// 2. sidecar tests, then the sidecar bundled into plugin/sidecar-bundle/main.mjs
//    (embedded into the WASM component by plugin/build.rs)
// 3. LICENSE and NOTICE copied into the package
// 4. the release version (the dev suffix dropped, or --version)
// 5. openidea-plugin build, pack (signed with --key/--publisher, else unsigned),
//    and check of the .oiplugin as installing would check it
//
// Needs: Node.js, npm dependencies in sidecar/ (npm ci), Rust with wasm32-wasip2,
// the openidea-plugin CLI, and for step 1, when plugin/webview/zoo is empty,
// the pinned Zoo Code release .vsix (--vsix <file>, see plugin/zoo-code.json).

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "plugin");
const sidecar = join(root, "sidecar");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const step = (title) => console.log(`\n== ${title}`);
// No shell for node itself (its path may hold spaces); the CLIs are found on PATH through one.
const run = (cmd, argv, cwd = root, shell = false) => execFileSync(cmd, argv, { cwd, stdio: "inherit", shell });
const cli = (argv, cwd = plugin) => run("openidea-plugin", argv, cwd, process.platform === "win32");

step("Zoo Code webview UI");
if (!existsSync(join(plugin, "webview", "zoo", "VERSION"))) {
  // The pinned release VSIX, as the release must bundle the UI of that very file.
  const pin = JSON.parse(readFileSync(join(plugin, "zoo-code.json"), "utf8"));
  const vsix = opt("--vsix");
  if (!vsix) {
    console.error(`no Zoo Code UI in plugin/webview/zoo: pass --vsix <zoo-code-${pin.version}.vsix> (${pin.vsix})`);
    process.exit(1);
  }
  run(process.execPath, [join(root, "scripts", "copy-webview-ui.mjs"), vsix]);
}
const uiVersion = readFileSync(join(plugin, "webview", "zoo", "VERSION"), "utf8").trim();
const pinned = JSON.parse(readFileSync(join(plugin, "zoo-code.json"), "utf8"));
console.log(`${uiVersion}; pinned VSIX ${pinned.version} ${pinned.sha256}`);
if (uiVersion.split(" ")[1] !== pinned.version) {
  console.error("plugin/zoo-code.json pins another Zoo Code version than the bundled UI: copy the UI from the pinned .vsix");
  process.exit(1);
}

step("Sidecar");
if (!existsSync(join(sidecar, "node_modules"))) run("npm", ["ci"], sidecar, true);
if (!args.includes("--skip-tests")) run("npm", ["test"], sidecar, true);
run(process.execPath, [join(sidecar, "scripts", "bundle.mjs")]);

step("Licence files");
for (const f of ["LICENSE", "NOTICE"]) copyFileSync(join(root, f), join(plugin, f));

step("Version");
const manifestPath = join(plugin, "plugin.toml");
const manifest = readFileSync(manifestPath, "utf8");
const m = /^version = "(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?"$/m.exec(manifest);
if (!m) throw new Error("no version line in plugin.toml");
const version = opt("--version") ?? m[1];
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`);
writeFileSync(manifestPath, manifest.replace(m[0], `version = "${version}"`));
const id = /^id = "([^"]+)"$/m.exec(manifest)[1];
console.log(`${id} ${version}`);

step("Build");
cli(["build"]);

step("Pack");
const out = join(root, "dist");
mkdirSync(out, { recursive: true });
const file = join(out, `${id}-${version}.oiplugin`);
const key = opt("--key");
const publisher = opt("--publisher");
if (!!key !== !!publisher) throw new Error("--key and --publisher go together");
cli(["pack", plugin, ...(key ? ["--key", key, "--publisher", publisher] : []), "--out", file], root);
if (!key) console.log("unsigned: OpenIDEA shows a warning on the install page (sign with --key/--publisher)");

step("Check");
cli(["check", file], root);
console.log(`\n${file}\nInstall: Settings › Plugins › Install Plugin from Package File…`);
