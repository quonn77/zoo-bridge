# Bridge for Zoo Code

> **Bridge for Zoo Code** (repository [`quonn77/zoo-bridge`](https://github.com/quonn77/zoo-bridge)) is an unofficial port of [Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code) to
> [OpenIDEA](https://github.com/l0ng-ai/openidea), licensed under the Apache License 2.0.
> It is not affiliated with, endorsed by, or maintained by Zoo Code Org.

Runs the Zoo Code VS Code extension (from the user's VS Code, or the official release downloaded once the
user agrees) in a Node.js sidecar and shows
its UI in an OpenIDEA tool window, after the approach of
[Zoo Code for JetBrains](https://github.com/Zoo-Code-Org/Zoo-Code-Jetbrains).
Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). License: [LICENSE](LICENSE), [NOTICE](NOTICE).

Telemetry is off: the consent banner is not shown and Zoo Code's PostHog reports are never sent.

## Capabilities

| Capability | Risk | Why |
|---|---|---|
| `process:node` | high | Runs the sidecar (Node.js), which hosts the Zoo Code extension. The sidecar is built from `sidecar/` and embedded in the plugin; Zoo Code's agent then runs the commands the user approves (or auto-approves) in Zoo Code's own UI, in the project, as it does in VS Code. |
| `net:127.0.0.1` | medium | The plugin talks to its sidecar over a loopback WebSocket (random free port, per-install token). The plugin itself reaches nothing else; requests to LLM providers are made by the Zoo Code extension in the sidecar, to the providers the user configures. |
| `project.read`, `editor.read`, `events`, `storage` | low | Project root, focused editor and selection for Zoo Code's editor commands; file, focus and problems events; the bridge token and the "unofficial port" notice state. |
| `project.write`, `editor.write` (optional) | high / medium | Reserved for editing through the IDE editor; edits are written by the sidecar today, after the user approves them in Zoo Code's diff view. |
| `clipboard` (optional) | medium | Copy and paste in the web view (Zoo Code's copy buttons). |

## What the package contains

- `dist/plugin.wasm`: built from `plugin/src` (Rust), with the sidecar from `sidecar/src` embedded
  (bundled by esbuild, not minified: `npm run bundle`).
- `webview/*.js|css|html`: this repository's page, theme bridge and toolbar.
- `webview/zoo/`: **third-party code** — the webview UI of [Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code)
  (Apache-2.0), the build published in its VS Code extension (minified as Zoo Code ships it), copied by
  `scripts/copy-webview-ui.mjs` with its `LICENSE.txt`, its version in `VERSION`, and two URL rewrites
  listed in `MODIFICATIONS.md`. It is not built from this repository: it is Zoo Code's own release.
- The Zoo Code extension itself is **not** in the package: the sidecar loads it from the user's
  VS Code installation, or downloads the official release `.vsix` pinned in `plugin/zoo-code.json`
  (URL and SHA-256) once the user agrees. See
  [Where the extension comes from](#where-the-extension-comes-from).

| Folder | What | Language |
|---|---|---|
| `plugin/` | OpenIDEA plugin: manifest, WASM bridge, web view | Rust (`wasm32-wasip2`), JS |
| `sidecar/` | Node.js process hosting the Zoo Code extension, WebSocket bridge server | TypeScript |
| `scripts/` | `copy-webview-ui.mjs` (Zoo webview UI → web view), `webview-harness.mjs` (page dev server) | Node |
| `docs/` | Architecture and porting plan | — |

## Status

**Lot 1 — bridge** ✔ verified in OpenIDEA: web view ⇄ WASM plugin ⇄ sidecar, both directions.

- `plugin.toml`: tool window `chat` (web view), commands, editor context menu, settings.
- WASM bridge: starts the sidecar in a terminal session, loopback WebSocket (binary frames, port
  picked by the sidecar), `ide` requests (`openLocation`, `activeEditor`), IDE events forwarded.
- Sidecar bridge server: token auth, queue while disconnected, keep-alive ping, `ide()` requests.

**Lot 2 — Zoo Code UI** ✔ verified in OpenIDEA.

- `plugin/webview/index.html` = Zoo Code's own page (`getHtmlContent`) with package-relative paths.
- `vscode-shim.js`: `acquireVsCodeApi()`, connection/retry/queue, `--openidea-*` → `--vscode-*`, color-scheme.
- Banner with *Start extension host* while the sidecar is not connected.
- `debug.html`: the lot 1 bridge diagnostics page.

**Lot 3 — Zoo Code extension in the sidecar** ✔ end to end in the dev harness (page ⇄ real sidecar);
to verify in OpenIDEA.

- The extension (see [Where the extension comes from](#where-the-extension-comes-from)) runs on an emulated
  `vscode` module (`sidecar/src/vscode/`, see docs/ARCHITECTURE.md).
- State, settings and API keys in the plugin's private data directory (`zoo-data/`).
- Commands: New Task, History, Settings; editor menu Add to Context / Explain / Fix / Improve Code.
- Not yet: no IDE dialogs for `showInputBox`/`showQuickPick`.

**Lot 4 — editor** ✔ in unit tests (Zoo's diff flow on the emulated API); to verify in OpenIDEA.

- Proposed changes open in the IDE's diff viewer (read-only; approve/reject in Zoo's chat); the file
  is written only when Zoo saves it.
- Editors and tabs as Zoo expects them (`visibleTextEditors`, `tabGroups`, `vscode.diff`).
- `languages.getDiagnostics` answers from the IDE's problems (refreshed on `problems-changed`), so
  Zoo reports new errors after an edit.
- IDE requests go through the tool window page (window context): it must be open.

**Lot 5 — commands** ✔ end to end (`npm run e2e`: a mock model makes Zoo run a command in the sidecar).

- Zoo Code runs the model's commands with its inline runner (its default, `terminalShellIntegrationDisabled`):
  a child process of the sidecar in the workspace, output in the chat. Shell: `COMSPEC` (cmd.exe) on
  Windows, `SHELL` elsewhere, as Zoo does in VS Code with the same setting, and what it tells the model.
- The bridge's token and port are removed from the environment commands inherit.
- Commands do not show in an IDE terminal tab (OpenIDEA gives plugins no way to read a terminal's
  output back, which Zoo needs). Long-running servers (`npm run dev`) are better started by hand.
- Editor menu: Add to Context, Explain / Fix / Improve Code.

`cd sidecar; node scripts/fake-plugin.mjs <workspace> <data dir>` runs the sidecar against a fake
plugin; the harness with `?sidecar=<port>&token=<token>` drives Zoo's real UI against a running sidecar.

## Install

Requirements on the machine: OpenIDEA and Node.js ≥ 20 on `PATH`. VS Code is optional: when it has
Zoo Code of the version the package was built for (`webview/zoo/VERSION`), that extension and VS Code's
ripgrep are used; otherwise the plugin downloads what is missing, once you agree (see below).

1. Settings › Plugins › *Install Plugin from Package File…* → `quonn77.zoo-bridge-<version>.oiplugin`.
   The package is unsigned unless built with a key: the install page says so.
2. Approve the capabilities (`process:node` runs the sidecar; `net:127.0.0.1` reaches it).
3. Open the **Zoo Bridge** tool window, *Start extension host*, configure a provider in Zoo Code.

No setting is needed: the sidecar is built into the plugin and written to its data directory.

**More windows.** Each open project has its own extension host (one Node.js process with Zoo Code,
started from that project's window): Zoo Bridge in a window works on that window's project. Zoo
Code's settings, API keys and task history are shared by all projects; the processes merge their
changes instead of overwriting each other's.

### Where the extension comes from

The sidecar looks for the Zoo Code extension in this order (`sidecar/src/extension.ts`):

1. Settings › Plugins › Bridge for Zoo Code › *Zoo Code extension*, when set: an extension folder or
   a `.vsix` file, used whatever its version.
2. VS Code's extensions folder, only with exactly the version of the bundled UI.
3. The plugin's cache (`zoo-data/extensions/` in its data directory): a `.vsix` extracted earlier.
4. The official release `.vsix` pinned in `plugin/zoo-code.json`, from
   `github.com/Zoo-Code-Org/Zoo-Code/releases`, downloaded **only after the user agrees** in the tool
   window. It is used only if its SHA-256 is the pinned one; it is then extracted (only its
   `extension/` folder, refusing unsafe paths) into the cache and older cached versions are removed.

### Where ripgrep comes from

Zoo Code searches and lists files with [ripgrep](https://github.com/BurntSushi/ripgrep), which it runs
from `vscode.env.appRoot` (`node_modules/@vscode/ripgrep/bin/`), as VS Code ships it; it never looks
on `PATH`. The sidecar gives it an appRoot, in this order (`sidecar/src/ripgrep.ts`):

1. `ZOO_APP_ROOT` (development).
2. A VS Code installation, with its own ripgrep.
3. The plugin's cache (`zoo-data/ripgrep/`), filled by 4 or 5.
4. `rg` on `PATH`, copied into the cache.
5. The official ripgrep release pinned in `plugin/ripgrep.json` (one archive per platform: Windows,
   Linux and macOS, x64 and arm64, with its SHA-256), downloaded **only after the user agrees**,
   together with the extension when both are missing. Only the `rg` binary is taken from the
   archive, and only if the archive's SHA-256 is the pinned one. ripgrep is MIT / Unlicense.

Zoo Code looks ripgrep up on every search, so a download takes effect without a restart.

The downloads are made by the sidecar (Node.js), not through the plugin's `net` capability. Behind a
proxy that Node.js does not use, download the `.vsix` yourself and set it as *Zoo Code extension*,
and put `rg` on `PATH`.

## Package

```powershell
node scripts/package.mjs
```

builds `dist/<id>-<version>.oiplugin`: Zoo Code's UI (copied from `--vsix <file>` when missing; it
must be the version pinned in `plugin/zoo-code.json`), sidecar tests and bundle
(embedded into the WASM component), licence files, release version (dev suffix dropped, or
`--version x.y.z`), build, pack and check. `--key <file> --publisher quonn77` signs it (the publisher is the id prefix: `quonn77` owns `quonn77.*`)
(`openidea-plugin keygen <file>` once; keep the key secret).

## Build (development)

Prerequisites: Node.js ≥ 20, Rust with the `wasm32-wasip2` target, a host linker
(Windows: Visual Studio Build Tools with *Desktop development with C++*), the `openidea-plugin` CLI.

```powershell
rustup target add wasm32-wasip2
cargo install --locked --git https://github.com/l0ng-ai/openidea ide-host --bin openidea-plugin
```

Zoo Code webview UI, from the release `.vsix` the plugin pins (a
[Zoo Code release](https://github.com/Zoo-Code-Org/Zoo-Code/releases) asset; this also writes
`plugin/zoo-code.json`), or from an extension directory / the newest Zoo Code in VS Code (no pin: the
plugin then cannot download the extension, and `cargo test` says so):

```powershell
node scripts/copy-webview-ui.mjs path\to\zoo-code-3.98.2.vsix
```

Sidecar:

```powershell
cd sidecar; npm install; npm test; npm run build
```

Plugin:

```powershell
cd plugin; cargo test; openidea-plugin build; openidea-plugin link .
```

Then open the **Zoo Bridge** tool window and click *Start extension host*. A build without a sidecar
bundle (`npm run bundle` in `sidecar/` makes one) needs Settings › Plugins › Bridge for Zoo Code ›
*sidecar entry script* = absolute path of `sidecar/dist/main.js`; setting it also overrides the bundle
while developing the sidecar.

### Zoo Code updates

The plugin is tied to one Zoo Code version: its UI is copied into the package (OpenIDEA web views
serve only package files), and the sidecar must run the extension of that same version, since UI and
extension speak a protocol that changes between releases. `plugin/zoo-code.json` pins that version's
release `.vsix` (URL and SHA-256). See [Where the extension comes from](#where-the-extension-comes-from).

To move to a new Zoo Code release:

```powershell
node scripts/update-zoo.mjs path\to\zoo-code-<version>.vsix
```

copies the new UI, pins the `.vsix`, bumps the plugin's dev version and rebuilds; then *Reload* the
plugin and restart the extension host. Check that the URL it prints serves that very file (the
sidecar downloads it), and the sidecar log for `[vscode] not implemented: …`: a new release may use
VS Code APIs the sidecar does not emulate yet.

`npm run e2e` and `npm run e2e:context` use the pinned version: Zoo Code of that version in VS Code,
`ZOO_EXTENSION` (an extension folder or `.vsix`), or else a download of the pinned `.vsix`.
`npm run e2e:search` runs Zoo's `search_files` and `list_files` without VS Code (`ZOO_NO_VSCODE=1`),
with ripgrep from `PATH`, the cache or the pinned release.

What needs what after a change:

| Changed | Do |
|---|---|
| `plugin/webview/*` | `node scripts/bump-dev-version.mjs`, *Reload*, reopen the tool window (web files are cached as immutable per version) |
| `plugin/src/*.rs`, `plugin.toml` | `openidea-plugin build`, Settings › Plugins › *Reload* |
| `sidecar/src/*` | `npm run build`, *Stop Extension Host*, *Start extension host* |

Page dev loop without the IDE: `node scripts/webview-harness.mjs plugin/webview 5199`, open
`http://127.0.0.1:5199/`; in the console `__online = true` then `__deliver({...})` to send messages.
