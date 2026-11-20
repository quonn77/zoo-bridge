#!/usr/bin/env node
// Moves the plugin to the Zoo Code version installed in VS Code, in one step:
// copies its webview UI into the package (which also fixes the version the
// sidecar must load), bumps the plugin's dev version and rebuilds.
//
//   node scripts/update-zoo.mjs [<zoo-code extension dir>]
//
// Then: Settings › Plugins › Reload, Stop/Start the extension host.
// Check the sidecar log for "[vscode] not implemented: …" lines: a new Zoo
// Code release may use VS Code APIs the sidecar does not emulate yet.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// No shell for node itself (its path may hold spaces); the CLI is found on PATH through one.
const run = (cmd, args, cwd = root, shell = false) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell });
const version = () => {
  try {
    return readFileSync(join(root, "plugin", "webview", "zoo", "VERSION"), "utf8").trim();
  } catch {
    return "none";
  }
};

const before = version();
run(process.execPath, [join(root, "scripts", "copy-webview-ui.mjs"), ...process.argv.slice(2)]);
const after = version();
run(process.execPath, [join(root, "scripts", "bump-dev-version.mjs")]);
run("openidea-plugin", ["build"], join(root, "plugin"), process.platform === "win32");
console.log(before === after ? `\nStill on ${after}: package rebuilt.` : `\nZoo Code UI ${before} → ${after}: package rebuilt.`);
console.log("Next: Settings › Plugins › Reload, then Zoo Bridge: Stop / Start Extension Host.");
