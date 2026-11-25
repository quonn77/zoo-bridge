# Changelog

Bridge for Zoo Code, an unofficial port of [Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code) to
[OpenIDEA](https://github.com/l0ng-ai/openidea). Packages are on the
[releases page](https://github.com/quonn77/zoo-bridge/releases).

## 0.3.0 (2026-11-25)

### Added
- Zoo Code 3.98.2. VS Code is no longer required: when VS Code does not have this exact version, the
  tool window offers to download Zoo Code's official release (`.vsix`, checked against its SHA-256)
  and shows the download progress. Setting *Zoo Code extension* points to a folder or `.vsix` of your
  own instead.
- ripgrep for Zoo Code's file search without VS Code: taken from `PATH`, or downloaded from the
  ripgrep 15.2.0 release (checked against its SHA-256) once you agree.
- One extension host per open project. Each window works on its own project; Zoo Code's settings,
  API keys and task history are shared, and the extension hosts merge their changes instead of
  overwriting each other's.
- The tool window starts the extension host when it opens. Settings *autoStart* (on by default) and
  *autoStartDelay* (milliseconds, 0 by default) control it. A host you stop stays stopped until you
  start it or reopen the tool window.

### Fixed
- The connection between the plugin and the extension host dropped during long tasks. OpenIDEA closes
  a plugin WebSocket on a message over 1 MiB or when more than 256 messages wait to be read, and Zoo
  Code's task state grows past that. Large messages now go in parts, the extension host waits for the
  plugin to read what it sent, and after a reconnection the page gets Zoo Code's whole state again
  (an approval asked in the meantime shows up).
- Zoo Code's notifications showed in whichever window had the focus. They now show in the window of
  their project.
- "Plugin crashed: timed out after 5 s" when the extension host started in a window that was still
  opening. Starting now runs as an IDE task, which may take up to 60 s.
- A page whose plugin restarted stayed on "connecting". It now asks again until it gets an answer.
- The tool window icon was dark grey on dark themes. It now uses OpenIDEA's icon grey and follows the
  theme.

### Requirements
- OpenIDEA with plugin API 1.10 or later.
- Node.js 20 or later on `PATH`.
- VS Code is optional.

## 0.2.1 (2026-11-21)

### Fixed
- Add to Context and Explain / Fix / Improve Code use the editor's text, unsaved changes included,
  instead of the file on disk.

## 0.2.0 (2026-11-20)

### Added
- Zoo Code's own UI and extension in the tool window, IDE file dialogs, telemetry off.

## 0.1.0

### Added
- Scaffold: tool window web view, Node.js sidecar started in a terminal session, WebSocket bridge.
