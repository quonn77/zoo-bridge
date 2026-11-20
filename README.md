# Bridge for Zoo Code

> **Bridge for Zoo Code** (repository `zoocode-openidea-plugin`) is an unofficial port of [Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code) to
> [OpenIDEA](https://github.com/l0ng-ai/openidea), licensed under the Apache License 2.0.
> It is not affiliated with, endorsed by, or maintained by Zoo Code Org.

Runs the Zoo Code VS Code extension from the user's own installation in a Node.js sidecar and shows
its UI in an OpenIDEA tool window, after the approach of
[Zoo Code for JetBrains](https://github.com/Zoo-Code-Org/Zoo-Code-Jetbrains).
Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). License: [LICENSE](LICENSE), [NOTICE](NOTICE).

Telemetry is off: the consent banner is not shown and Zoo Code's PostHog reports are never sent.

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

- The extension (newest Zoo Code installed in VS Code, or `ZOO_EXTENSION_DIR`) runs on an emulated
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

Requirements on the machine: OpenIDEA, Node.js ≥ 20 on `PATH`, and VS Code with Zoo Code installed (the
version the package was built for, see `webview/zoo/VERSION`; its ripgrep is used for file search).

1. Settings › Plugins › *Install Plugin from Package File…* → `zoobridge.bridge-for-zoo-code-<version>.oiplugin`.
   The package is unsigned unless built with a key: the install page says so.
2. Approve the capabilities (`process:node` runs the sidecar; `net:127.0.0.1` reaches it).
3. Open the **Zoo Bridge** tool window, *Start extension host*, configure a provider in Zoo Code.

No setting is needed: the sidecar is built into the plugin and written to its data directory.

## Package

```powershell
node scripts/package.mjs
```

builds `dist/<id>-<version>.oiplugin`: Zoo Code's UI (copied if missing), sidecar tests and bundle
(embedded into the WASM component), licence files, release version (dev suffix dropped, or
`--version x.y.z`), build, pack and check. `--key <file> --publisher <id>` signs it
(`openidea-plugin keygen <file>` once; keep the key secret).

## Build (development)

Prerequisites: Node.js ≥ 20, Rust with the `wasm32-wasip2` target, a host linker
(Windows: Visual Studio Build Tools with *Desktop development with C++*), the `openidea-plugin` CLI.

```powershell
rustup target add wasm32-wasip2
cargo install --locked --git https://github.com/l0ng-ai/openidea ide-host --bin openidea-plugin
```

Zoo Code webview UI (from the newest Zoo Code installed in VS Code, or pass the extension directory):

```powershell
node scripts/copy-webview-ui.mjs
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
serve only package files), and the sidecar loads the extension of that same version from VS Code
(`zoocodeorganization.zoo-code-<version>`), since UI and extension speak a protocol that changes
between releases. A different installed version still starts, with a warning.

When VS Code has installed a new Zoo Code release:

```powershell
node scripts/update-zoo.mjs
```

copies the new UI, bumps the plugin's dev version and rebuilds; then *Reload* the plugin and restart
the extension host. Check the sidecar log for `[vscode] not implemented: …`: a new release may use
VS Code APIs the sidecar does not emulate yet.

What needs what after a change:

| Changed | Do |
|---|---|
| `plugin/webview/*` | `node scripts/bump-dev-version.mjs`, *Reload*, reopen the tool window (web files are cached as immutable per version) |
| `plugin/src/*.rs`, `plugin.toml` | `openidea-plugin build`, Settings › Plugins › *Reload* |
| `sidecar/src/*` | `npm run build`, *Stop Extension Host*, *Start extension host* |

Page dev loop without the IDE: `node scripts/webview-harness.mjs plugin/webview 5199`, open
`http://127.0.0.1:5199/`; in the console `__online = true` then `__deliver({...})` to send messages.
