//! Bridge for Zoo Code (unofficial port of Zoo Code to OpenIDEA) — the WASM bridge.
//!
//! The Zoo Code extension (a VS Code extension) runs in a Node.js sidecar,
//! started in a terminal session so that it survives idle reclaim of this
//! instance. This plugin only routes messages:
//!
//! * web view (`chat`) ⇄ sidecar, over a loopback WebSocket;
//! * sidecar `ide` requests → OpenIDEA host APIs, answered with `ide-result`;
//! * IDE events (file saved, editor focus…) → sidecar.
//!
//! See `docs/ARCHITECTURE.md` for the protocol.

mod protocol;

use openidea_plugin::host::{self, Command, WebSocket, WebSocketRequest};
use openidea_plugin::views::{Body, View, ViewEvent, Viewport, Views};
use openidea_plugin::{Error, Event, EventKind, Invocation, NotificationLevel, Plugin, register_plugin};
use protocol::{Inbound, Outbound};
use serde_json::{Value, json};

pub const VIEW: &str = "chat";
const TOKEN_KEY: &str = "sidecar.token";
/// Messages taken from the WebSocket per drain: the host's maximum
/// (a larger limit fails with "invalid drain limit").
const DRAIN_LIMIT: u32 = 32;

/// One sidecar per open project: Zoo Code assumes one workspace per process.
///
/// This plugin has one instance for all OpenIDEA windows, so everything is
/// keyed by the project of the window a command, page message or event comes
/// from ([`project_key`]): the sidecar's terminal session, its port file and
/// its WebSocket. The tool window pages of all windows receive every view
/// message, so each message names its project (and, for a hello's answer, its
/// page): see [`post_to_view`].
#[derive(Default)]
pub struct ZooCode {
    /// Connected sidecars by project key.
    conns: std::collections::BTreeMap<String, WebSocket>,
    /// Their projects: the sidecar's notifications show in that project's
    /// window only (the WebSocket events that carry them have no window).
    projects: std::collections::BTreeMap<String, host::Project>,
}

/// A short stable key for a project root (FNV-1a of the root).
pub fn project_key(root: &str) -> String {
    let root = root.trim_end_matches(['/', '\\']).replace('\\', "/");
    fnv1a(&root)[..12].to_owned()
}

/// The terminal session that runs the project's sidecar.
fn terminal_key(key: &str) -> String {
    format!("zoo-sidecar-{key}")
}

/// The fixed port from the settings; 0 lets the sidecar pick a free one
/// (fixed loopback ports may be reserved on the machine).
fn configured_port() -> u16 {
    host::setting_number("port").map(|p| p as u16).unwrap_or(0)
}

/// `name` inside the plugin's private, owner-only data directory.
fn data_path(name: &str) -> Result<String, Error> {
    let dir = host::fs::plugin_dir()?;
    let sep = if dir.contains('\\') { '\\' } else { '/' };
    Ok(format!("{}{sep}{name}", dir.trim_end_matches(['/', '\\'])))
}

/// Where the project's sidecar writes the port it bound.
fn port_file(key: &str) -> Result<String, Error> {
    data_path(&format!("sidecar-{key}.port"))
}

/// The port the project's running sidecar listens on: the one it wrote to
/// its port file (none while it is not running), or the configured one,
/// which only fits a single project.
fn port(key: &str) -> Option<u16> {
    match configured_port() {
        0 => host::fs::read_file(&port_file(key).ok()?).ok()?.trim().parse().ok(),
        p => Some(p),
    }
}

/// The project of the window `ctx` comes from; with no window project, the
/// only open one.
fn window_project(ctx: &Invocation) -> Result<host::Project, Error> {
    if let Some(p) = ctx.project() {
        return Ok(p);
    }
    let mut all = host::projects()?;
    match all.len() {
        1 => Ok(all.remove(0)),
        0 => Err(Error::Invalid("open a project first".into())),
        _ => Err(Error::Invalid("run this from the window of the project".into())),
    }
}

/// The shared secret the sidecar checks on connect. Kept in storage so a
/// reclaimed instance reconnects to the sidecar it started.
fn token() -> Result<String, Error> {
    if let Some(t) = host::storage::get(TOKEN_KEY)? {
        return Ok(t);
    }
    use std::hash::{BuildHasher, Hasher};
    // RandomState is seeded from WASI randomness.
    let mut t = String::new();
    for _ in 0..2 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(0x5A00_C0DE);
        t.push_str(&format!("{:016x}", h.finish()));
    }
    host::storage::set(TOKEN_KEY, &t)?;
    Ok(t)
}

/// Sends `msg` to the tool window pages. The host delivers it to the page of
/// every window, so it goes in an envelope naming its project (and the page,
/// for an answer to that page's hello); the shim drops what is not its own.
fn post_to_view(project: Option<&str>, page: Option<&str>, msg: &Value) -> Result<(), Error> {
    let envelope = json!({ "type": "zoo-bridge/to", "project": project, "page": page, "msg": msg });
    host::post_view_message(VIEW, &envelope.to_string())
}

/// Storage key: the user hid the "unofficial port" line.
const NOTICE_HIDDEN_KEY: &str = "notice.hidden";

/// The Zoo Code version whose webview UI is in this package
/// (`webview/zoo/VERSION`, written by scripts/copy-webview-ui.mjs): the
/// sidecar must run the same extension version, as the UI and the extension
/// talk a protocol that changes between releases.
pub fn bundled_zoo_version() -> &'static str {
    const VERSION_FILE: &str = include_str!("../webview/zoo/VERSION");
    VERSION_FILE.split_whitespace().nth(1).unwrap_or("")
}

/// The release VSIX of the bundled Zoo Code version (`zoo-code.json`, written
/// by scripts/copy-webview-ui.mjs): `(url, sha256)`, which the sidecar
/// downloads, after the user agrees, when that version is not on the machine.
/// None when it pins another version than the bundled UI's.
pub fn pinned_vsix_size() -> Option<u64> {
    let pin: Value = serde_json::from_str(include_str!("../zoo-code.json")).ok()?;
    pin.get("size")?.as_u64()
}

/// See [`pinned_vsix_size`] for the size; `(url, sha256)` here.
pub fn pinned_vsix() -> Option<(String, String)> {
    const PIN: &str = include_str!("../zoo-code.json");
    let pin: Value = serde_json::from_str(PIN).ok()?;
    let field = |k: &str| pin.get(k).and_then(Value::as_str).map(str::to_owned);
    if field("version")? != bundled_zoo_version() {
        return None;
    }
    let (url, sha256) = (field("vsix")?, field("sha256")?);
    (url.starts_with("https://") && sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit())).then_some((url, sha256))
}

/// The ripgrep release the sidecar may download for Zoo Code's file search
/// when neither VS Code nor PATH has one (`ripgrep.json`: one archive per
/// platform with its SHA-256), as compact JSON for `ZOO_RIPGREP`.
pub fn pinned_ripgrep() -> Option<String> {
    const PIN: &str = include_str!("../ripgrep.json");
    let pin: Value = serde_json::from_str(PIN).ok()?;
    pin.get("assets")?.as_object()?;
    serde_json::to_string(&pin).ok()
}

/// The `editor` argument of Zoo Code's editor commands: path, first
/// selection, and the document as the editor holds it (text and version),
/// which may differ from the file on disk when it has unsaved changes.
fn editor_context(editor: &openidea_plugin::TextEditor) -> Result<Value, Error> {
    let doc = editor.document()?;
    let selection = editor
        .selections()?
        .into_iter()
        .next()
        .map(|r| json!([r.start.line, r.start.character, r.end.line, r.end.character]));
    Ok(json!({
        "editor": { "path": editor.path(), "selection": selection, "text": doc.text, "version": doc.version }
    }))
}

/// The bridge state for the pages of project `key` (or one page of it).
fn status(key: &str, page: Option<&str>, state: &str, detail: &str) -> Result<(), Error> {
    let notice = host::storage::get(NOTICE_HIDDEN_KEY).ok().flatten().is_none();
    let msg = json!({ "type": "zoo-bridge/status", "state": state, "detail": detail, "notice": notice, "project": key });
    post_to_view(Some(key), page, &msg)
}

/// The bundled sidecar (see build.rs); empty in a development build without one.
const EMBEDDED_SIDECAR: &str = include_str!(concat!(env!("OUT_DIR"), "/sidecar.mjs"));
const SIDECAR_FILE: &str = "sidecar.mjs";
const SIDECAR_HASH_KEY: &str = "sidecar.hash";

/// FNV-1a: tells whether the sidecar written to disk is this build's.
fn fnv1a(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// The script node runs: the `sidecarScript` setting when set (development),
/// else the embedded sidecar, written to the plugin's data directory when it
/// is missing or from another build.
fn sidecar_script() -> Result<String, Error> {
    if let Some(script) = host::setting_string("sidecarScript").filter(|s| !s.is_empty()) {
        return Ok(script);
    }
    if EMBEDDED_SIDECAR.is_empty() {
        return Err(Error::Invalid(
            "this build has no embedded sidecar: set Settings › Plugins › Bridge for Zoo Code › sidecar entry script".into(),
        ));
    }
    let path = data_path(SIDECAR_FILE)?;
    let hash = fnv1a(EMBEDDED_SIDECAR);
    let current = host::storage::get(SIDECAR_HASH_KEY)?.as_deref() == Some(hash.as_str()) && host::fs::stat(&path).is_ok();
    if !current {
        host::fs::write_file(&path, EMBEDDED_SIDECAR)?;
        host::storage::set(SIDECAR_HASH_KEY, &hash)?;
    }
    Ok(path)
}

impl ZooCode {
    /// Starts the sidecar of the window's project in its terminal session
    /// (focuses it when it runs); returns the project key.
    fn start_sidecar(&mut self, ctx: &Invocation) -> Result<String, Error> {
        let project = window_project(ctx)?;
        let workspace = project.root()?;
        let key = project_key(&workspace);
        // Already running (started from another window of the same project?).
        if self.connect(ctx)?.is_some() {
            return Ok(key);
        }
        let script = sidecar_script()?;
        let name = workspace.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or_default().to_owned();
        let cmd = Command::new("node")
            .arg(&script)
            .env("ZOO_PORT", &configured_port().to_string())
            .env("ZOO_PORT_FILE", &port_file(&key)?)
            .env("ZOO_TOKEN", &token()?)
            .env("ZOO_WORKSPACE", &workspace)
            // Extension state, settings and API keys (owner-only, removed on uninstall).
            .env("ZOO_DATA_DIR", &data_path("zoo-data")?)
            .env("ZOO_EXPECTED_VERSION", bundled_zoo_version());
        // Where the extension comes from: see sidecar/src/extension.ts.
        let cmd = match pinned_vsix() {
            Some((url, sha256)) => {
                let cmd = cmd.env("ZOO_VSIX_URL", &url).env("ZOO_VSIX_SHA256", &sha256);
                // Shown to the user when asking to download it.
                match pinned_vsix_size() {
                    Some(size) => cmd.env("ZOO_VSIX_SIZE", &size.to_string()),
                    None => cmd,
                }
            }
            None => cmd,
        };
        let cmd = match pinned_ripgrep() {
            Some(pin) => cmd.env("ZOO_RIPGREP", &pin),
            None => cmd,
        };
        let cmd = match host::setting_string("zooExtension").filter(|s| !s.is_empty()) {
            Some(path) => cmd.env("ZOO_EXTENSION", &path),
            None => cmd,
        };
        // The window answers once the terminal runs, which in a window that is
        // still starting (or right after OpenIDEA starts) takes more than the
        // 5 s a plugin call may last: the host then restarts the plugin. An
        // open task gives the call up to 60 s, and shows in the status bar.
        let _task = host::begin_task(&format!("Starting Zoo Code extension host — {name}"), false);
        host::open_terminal_session(&terminal_key(&key), &format!("Zoo Code Extension Host — {name}"), &cmd)?;
        Ok(key)
    }

    /// Connects to the running sidecar of the window's project; its key, or
    /// `None` while it is not listening.
    fn connect(&mut self, ctx: &Invocation) -> Result<Option<String>, Error> {
        let project = window_project(ctx)?;
        let key = project_key(&project.root()?);
        if self.conns.contains_key(&key) {
            return Ok(Some(key));
        }
        let Some(port) = port(&key) else { return Ok(None) };
        let req = WebSocketRequest {
            url: format!("ws://127.0.0.1:{port}/bridge?token={}", token()?),
            headers: Vec::new(),
            subprotocol: String::new(),
        };
        match WebSocket::connect(&project, &req) {
            Ok(ws) => {
                host::subscribe(EventKind::WebsocketReady)?;
                for kind in [EventKind::FileSaved, EventKind::EditorFocused, EventKind::FilesChanged, EventKind::ProblemsChanged] {
                    // Optional context for the extension: a missing one is not fatal.
                    let _ = host::subscribe(kind);
                }
                self.conns.insert(key.clone(), ws);
                self.projects.insert(key.clone(), project);
                Ok(Some(key))
            }
            Err(_) => Ok(None),
        }
    }

    /// The key of the window's project when its sidecar is connected, without connecting.
    fn connected_key(&self, ctx: &Invocation) -> Option<String> {
        let key = project_key(&window_project(ctx).ok()?.root().ok()?);
        self.conns.contains_key(&key).then_some(key)
    }

    fn send(&mut self, key: &str, msg: &Outbound) -> Result<(), Error> {
        let Some(ws) = self.conns.get(key) else { return Err(Error::Invalid("Zoo Code extension host is not connected".into())) };
        if let Err(e) = ws.send(msg.to_json().to_string().as_bytes()) {
            self.conns.remove(key);
            return Err(e);
        }
        Ok(())
    }

    /// Window events go to the sidecar of that window's project, if connected.
    fn forward(&mut self, ctx: &Invocation, kind: &str, data: Value) {
        if let Some(key) = self.connected_key(ctx) {
            let _ = self.send(&key, &Outbound::Event { kind: kind.into(), data });
        }
    }

    /// Takes what sidecar connection `connection` sent and dispatches it.
    fn drain(&mut self, connection: u64, ctx: &Invocation) {
        let Some(key) = self.conns.iter().find(|(_, ws)| ws.id() == connection).map(|(k, _)| k.clone()) else { return };
        loop {
            let Some(ws) = self.conns.get(&key) else { return };
            let batch = match ws.drain(DRAIN_LIMIT) {
                Ok(b) => b,
                Err(e) => {
                    self.conns.remove(&key);
                    let _ = status(&key, None, "disconnected", &format!("drain failed: {e}"));
                    return;
                }
            };
            let more = batch.messages.len() as u32 == DRAIN_LIMIT;
            for raw in &batch.messages {
                let Ok(text) = std::str::from_utf8(raw) else { continue };
                match Inbound::parse(text) {
                    Some(Inbound::Webview(msg)) => {
                        let _ = post_to_view(Some(&key), None, &msg);
                    }
                    Some(Inbound::Ide { id, op, args }) => {
                        let result = self.run_ide(&op, &args, ctx);
                        let _ = self.send(&key, &Outbound::IdeResult { id, result });
                    }
                    Some(Inbound::Notify { level, message }) => {
                        let level = match level.as_str() {
                            "error" => NotificationLevel::Error,
                            "warning" => NotificationLevel::Warning,
                            _ => NotificationLevel::Info,
                        };
                        // host::notify would show it in the focused window,
                        // whichever project that is.
                        match self.projects.get(&key) {
                            Some(project) => {
                                let _ = project.notify(level, "Zoo Bridge", &message, &[]);
                            }
                            None => host::notify(level, "Zoo Bridge", &message),
                        }
                    }
                    Some(Inbound::Ping) | None => {}
                }
            }
            if batch.closed {
                self.conns.remove(&key);
                let _ = status(&key, None, "disconnected", "");
                return;
            }
            if !more {
                return;
            }
        }
    }

    /// The IDE side of the extension host's main-thread services.
    ///
    /// Editor and view APIs only work from a command or event of a window,
    /// which `websocket-ready` is not (the host emits it without one). So the
    /// sidecar sends these requests through the tool window page
    /// (`zoo-bridge/ide` → `zoo-bridge/ide-call`), whose messages are window
    /// events, and they run here with that window's context.
    fn run_ide(&mut self, op: &str, args: &Value, ctx: &Invocation) -> Result<Value, String> {
        let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
        let o = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_owned);
        let n = |k: &str| args.get(k).and_then(Value::as_u64).unwrap_or(0) as u32;
        match op {
            "openLocation" => host::open_location(&s("path"), n("line"), n("column")).map(|()| Value::Null).map_err(|e| e.to_string()),
            // A proposed change: the file before (none: new file) and after.
            "openFileDiff" => {
                let diff = openidea_plugin::FileDiff {
                    left: o("left"),
                    right: o("right"),
                    left_label: o("leftLabel"),
                    right_label: o("rightLabel"),
                    title: o("title"),
                };
                host::open_file_diff(&diff, o("fileName").as_deref()).map(|()| Value::Null).map_err(|e| e.to_string())
            }
            // The IDE's problems (language servers, builds…), for vscode.languages.getDiagnostics.
            "problems" => {
                let files = host::problems(o("path").as_deref()).map_err(|e| e.to_string())?;
                let mut by_path = serde_json::Map::new();
                for f in files {
                    let entry = by_path.entry(f.path).or_insert_with(|| Value::Array(Vec::new()));
                    if let Value::Array(list) = entry {
                        for d in f.diagnostics {
                            let severity = match d.severity {
                                openidea_plugin::Severity::Error => 0,
                                openidea_plugin::Severity::Warning => 1,
                                openidea_plugin::Severity::Info => 2,
                                _ => 3,
                            };
                            list.push(json!({
                                "range": [d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character],
                                "severity": severity,
                                "message": d.message,
                                "code": d.code,
                                "source": d.source.unwrap_or_else(|| f.source.clone()),
                            }));
                        }
                    }
                }
                Ok(Value::Object(by_path))
            }
            "activeEditor" => {
                let Some(editor) = ctx.editor() else { return Ok(Value::Null) };
                let doc = editor.document().map_err(|e| e.to_string())?;
                let selections: Vec<Value> = editor
                    .selections()
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .map(|r| json!([r.start.line, r.start.character, r.end.line, r.end.character]))
                    .collect();
                Ok(json!({ "path": editor.path(), "version": doc.version, "text": doc.text, "selections": selections }))
            }
            _ => Err(format!("unsupported ide op: {op}")),
        }
    }

    /// Runs one of Zoo Code's commands in the window's sidecar, with the tool window in front.
    fn zoo_command(&mut self, id: &str, args: Value, ctx: &Invocation) -> Result<Option<String>, Error> {
        host::reveal_view(VIEW)?;
        let Some(key) = self.connect(ctx)? else {
            return Err(Error::Invalid("Zoo Code extension host is not running: Zoo Bridge: Start Extension Host".into()));
        };
        self.send(&key, &Outbound::Command { id: id.into(), args })?;
        Ok(None)
    }

    /// Ends the sidecar of the window's project; returns the project key.
    fn stop_sidecar(&mut self, ctx: &Invocation) -> Result<String, Error> {
        let key = project_key(&window_project(ctx)?.root()?);
        if self.connect(ctx)?.is_some() {
            let _ = self.send(&key, &Outbound::Shutdown);
        }
        self.conns.remove(&key);
        Ok(key)
    }

    /// The window's project key, and its sidecar's when connected.
    fn keys(&mut self, ctx: &Invocation) -> Result<(String, Option<String>), Error> {
        let key = project_key(&window_project(ctx)?.root()?);
        let connected = self.connect(ctx)?;
        Ok((key, connected))
    }

    fn from_webview(&mut self, text: &str, ctx: &Invocation) -> Result<(), Error> {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return Ok(()) };
        // The page's id: the answer to its hello goes to it alone.
        let page = msg.get("page").and_then(Value::as_str).map(str::to_owned);
        // Bridge control messages from the shim; everything else is Zoo Code's.
        match msg.get("type").and_then(Value::as_str) {
            Some("zoo-bridge/hello") => {
                // Zoo Code's page sends its own `webviewDidLaunch` once the
                // shim has flushed its queue on `connected`. The answer tells
                // the page its project, whose messages it keeps.
                let (key, connected) = self.keys(ctx)?;
                match connected {
                    Some(_) => status(&key, page.as_deref(), "connected", ""),
                    None => status(&key, page.as_deref(), "offline", "Zoo Code extension host not running"),
                }
            }
            // The tool window opened with the sidecar offline (sent once per
            // page, a moment after its hello): start it unless autoStart is
            // off. Not part of the hello: opening the terminal can take
            // seconds in a window that is still starting, and a call over
            // the host's limit restarts the plugin.
            Some("zoo-bridge/autostart") => {
                let (key, connected) = self.keys(ctx)?;
                if connected.is_some() || !host::setting_bool("autoStart").unwrap_or(true) {
                    return Ok(());
                }
                let key = self.start_sidecar(ctx).inspect_err(|e| {
                    let _ = status(&key, page.as_deref(), "offline", &e.to_string());
                })?;
                let state = if self.conns.contains_key(&key) { "connected" } else { "starting" };
                status(&key, None, state, "")
            }
            Some("zoo-bridge/dismiss-notice") => host::storage::set(NOTICE_HIDDEN_KEY, "1"),
            // An IDE request of the sidecar relayed by the page (see run_ide).
            Some("zoo-bridge/ide-call") => {
                let id = msg.get("id").and_then(Value::as_u64).unwrap_or(0);
                let op = msg.get("op").and_then(Value::as_str).unwrap_or_default().to_owned();
                let args = msg.get("args").cloned().unwrap_or(Value::Null);
                let result = self.run_ide(&op, &args, ctx);
                let Some(key) = self.connect(ctx)? else { return Ok(()) };
                self.send(&key, &Outbound::IdeResult { id, result })
            }
            // Toolbar: one of Zoo Code's view title commands.
            Some("zoo-bridge/command") => {
                let id = msg.get("id").and_then(Value::as_str).unwrap_or_default();
                if !id.starts_with("zoo-code.") {
                    return Ok(());
                }
                match self.keys(ctx)? {
                    (key, None) => status(&key, None, "offline", "Zoo Code extension host not running"),
                    (_, Some(key)) => self.send(&key, &Outbound::Command { id: id.into(), args: Value::Null }),
                }
            }
            Some("zoo-bridge/stop") => {
                let key = self.stop_sidecar(ctx)?;
                status(&key, None, "offline", "Zoo Code extension host stopped")
            }
            Some("zoo-bridge/start") => {
                let key = self.start_sidecar(ctx)?;
                let state = if self.conns.contains_key(&key) { "connected" } else { "starting" };
                status(&key, None, state, "")
            }
            _ => match self.keys(ctx)? {
                (key, None) => status(&key, None, "offline", "Zoo Code extension host not running"),
                (_, Some(key)) => self.send(&key, &Outbound::Webview(msg)),
            },
        }
    }
}

impl Plugin for ZooCode {
    fn deactivate(&mut self) {
        // Dropping the WebSockets closes them; the sidecars keep running and
        // wait for the next instance.
        self.conns.clear();
    }

    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "start-sidecar" => {
                self.start_sidecar(ctx)?;
                Ok(Some("Zoo Code extension host starting".into()))
            }
            "stop-sidecar" => {
                self.stop_sidecar(ctx)?;
                Ok(None)
            }
            "new-task" | "history" | "settings" => {
                let zoo = match id {
                    "new-task" => "zoo-code.plusButtonClicked",
                    "history" => "zoo-code.historyButtonClicked",
                    _ => "zoo-code.settingsButtonClicked",
                };
                self.zoo_command(zoo, Value::Null, ctx)
            }
            "add-to-context" | "explain-code" | "fix-code" | "improve-code" => {
                let zoo = match id {
                    "add-to-context" => "zoo-code.addToContext",
                    "explain-code" => "zoo-code.explainCode",
                    "fix-code" => "zoo-code.fixCode",
                    _ => "zoo-code.improveCode",
                };
                // Zoo Code reads the file and selection from its active editor:
                // send the editor's own text (unsaved changes included), not
                // just its path, so the selection refers to what the user sees.
                let editor = ctx.editor().ok_or_else(|| Error::Invalid("focus an editor first".into()))?;
                self.zoo_command(zoo, editor_context(&editor)?, ctx)
            }
            _ => Err(Error::NotFound(format!("command {id}"))),
        }
    }

    fn handle_events(&mut self, events: &[Event], ctx: &Invocation) {
        for event in events {
            match event {
                // No window: the event names its connection.
                Event::WebSocketReady(ready) => self.drain(ready.connection, ctx),
                Event::FileSaved(path) => self.forward(ctx, "file-saved", json!(path)),
                Event::EditorFocused(path) => self.forward(ctx, "editor-focused", json!(path)),
                // The sidecar asks for the problems through the page (needs a window).
                Event::Other { kind, .. } if kind == "problems-changed" => self.forward(ctx, kind, Value::Null),
                Event::FilesChanged(fc) => {
                    let data = json!({ "created": fc.created, "modified": fc.modified, "removed": fc.removed });
                    self.forward(ctx, "files-changed", data);
                }
                _ => {}
            }
        }
    }
}

impl Views for ZooCode {
    // A web view: the page is the package's `webview/index.html`; render is
    // only asked for when the page cannot load.
    fn render(&mut self, view: &str, _viewport: Option<Viewport>, _ctx: &Invocation) -> Result<View, Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        Ok(View::new(Body::Message("Zoo Code web view is loading…".into())))
    }

    fn handle(&mut self, view: &str, event: ViewEvent, ctx: &Invocation) -> Result<(), Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        match event {
            ViewEvent::Message(text) => self.from_webview(&text, ctx),
            _ => Ok(()),
        }
    }
}

register_plugin!(ZooCode, views);

#[cfg(test)]
mod tests {
    use openidea_plugin::Plugin;
    use openidea_plugin::views::{ViewEvent, Views};

    #[test]
    fn project_keys_are_stable_per_root_and_distinct() {
        let a = super::project_key("C:\\work\\alpha");
        assert_eq!(a.len(), 12);
        assert_eq!(a, super::project_key("C:/work/alpha/"), "separators and a trailing slash do not matter");
        assert_ne!(a, super::project_key("C:\\work\\beta"));
    }

    /// Lot 6: each window's page learns its own project from the answer to its
    /// hello; the host delivers view messages to every window, so they name it.
    #[test]
    fn each_window_page_gets_its_own_project() {
        use openidea_plugin::mock::MockHost;
        let host = MockHost::install().with_capabilities(&["storage", "project.read", "process:node"]);
        let mut plugin = super::ZooCode::default();
        let mut hello = |root: &str, page: &str| {
            host.set_project_root(Some(root));
            let ctx = host.invocation();
            plugin.handle(super::VIEW, ViewEvent::Message(format!(r#"{{"type":"zoo-bridge/hello","page":"{page}"}}"#)), &ctx).unwrap();
            let (_, last) = host.view_messages().last().cloned().unwrap();
            serde_json::from_str::<serde_json::Value>(&last).unwrap()
        };
        let a = hello("/work/alpha", "page-a");
        let b = hello("/work/beta", "page-b");
        assert_eq!(a["type"], "zoo-bridge/to");
        assert_eq!(a["page"], "page-a");
        assert_eq!(a["project"], super::project_key("/work/alpha"));
        assert_eq!(a["msg"]["type"], "zoo-bridge/status");
        assert_eq!(a["msg"]["state"], "offline");
        assert_eq!(b["page"], "page-b");
        assert_eq!(b["project"], super::project_key("/work/beta"));
        assert_ne!(a["project"], b["project"]);
    }

    /// Lot 6: Start from two windows runs two sidecars, one per project.
    #[test]
    fn start_runs_one_sidecar_per_project() {
        use openidea_plugin::mock::MockHost;
        let host = MockHost::install().with_capabilities(&["storage", "project.read", "process:node"]);
        host.set_setting("sidecarScript", "\"/dev/sidecar/main.js\"");
        let mut plugin = super::ZooCode::default();
        for root in ["/work/alpha", "/work/beta"] {
            host.set_project_root(Some(root));
            plugin.run_command("start-sidecar", &host.invocation(), None).unwrap();
        }
        for root in ["/work/alpha", "/work/beta"] {
            let key = super::terminal_key(&super::project_key(root));
            assert!(host.finish_terminal(&key).is_some(), "no sidecar session {key} for {root}");
        }
    }

    /// Opening the tool window starts the sidecar (the page's autostart,
    /// apart from its hello), unless autoStart is off; hellos never do.
    #[test]
    fn opening_the_tool_window_starts_the_sidecar() {
        use openidea_plugin::mock::MockHost;
        let host = MockHost::install().with_capabilities(&["storage", "project.read", "process:node"]);
        host.set_setting("sidecarScript", "\"/dev/sidecar/main.js\"");
        let mut plugin = super::ZooCode::default();
        let mut send = |root: &str, kind: &str| {
            host.set_project_root(Some(root));
            let before = host.view_messages().len();
            let msg = format!(r#"{{"type":"zoo-bridge/{kind}","page":"p"}}"#);
            plugin.handle(super::VIEW, ViewEvent::Message(msg), &host.invocation()).unwrap();
            let state = host.view_messages().get(before).map(|(_, m)| {
                let v: serde_json::Value = serde_json::from_str(m).unwrap();
                v["msg"]["state"].as_str().unwrap_or_default().to_owned()
            });
            let started = host.finish_terminal(&super::terminal_key(&super::project_key(root))).is_some();
            (state.unwrap_or_default(), started)
        };
        assert_eq!(send("/work/alpha", "hello"), ("offline".into(), false), "a hello never starts it");
        assert_eq!(send("/work/alpha", "autostart"), ("starting".into(), true));
        host.set_setting("autoStart", "false");
        assert_eq!(send("/work/beta", "autostart"), (String::new(), false), "autoStart off");
    }

    /// A release must pin the VSIX of the very Zoo Code version whose UI it
    /// bundles, or the sidecar has nothing to download (copy the UI from the
    /// release .vsix: scripts/copy-webview-ui.mjs writes both).
    #[test]
    fn the_ripgrep_pin_covers_the_desktop_platforms() {
        let pin: serde_json::Value = serde_json::from_str(&super::pinned_ripgrep().expect("ripgrep.json")).unwrap();
        for platform in ["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] {
            let a = &pin["assets"][platform];
            assert!(a["url"].as_str().is_some_and(|u| u.starts_with("https://github.com/BurntSushi/ripgrep/releases/download/")), "{platform}");
            assert_eq!(a["sha256"].as_str().map(str::len), Some(64), "{platform}");
            assert!(a["file"].as_str().is_some_and(|f| f.ends_with("/rg") || f.ends_with("/rg.exe")), "{platform}");
        }
    }

    #[test]
    fn the_pinned_vsix_is_the_bundled_ui_version() {
        let (url, sha256) = super::pinned_vsix().expect("zoo-code.json pins the bundled UI's version");
        assert!(url.ends_with(&format!("/v{0}/zoo-code-{0}.vsix", super::bundled_zoo_version())), "{url}");
        assert_eq!(sha256.len(), 64);
    }

    /// Review of PR l0ng-ai/openidea-plugins#294: editor commands must carry
    /// the editor's text, which may be unsaved and differ from the disk.
    #[test]
    fn editor_commands_carry_the_editors_unsaved_text() {
        use openidea_plugin::mock::MockHost;
        let host = MockHost::install().with_capabilities(&["editor.read"]);
        host.open_editor("/project/code.ts", "typescript", "let x = old_value;\n", &[(0, 8, 0, 17)]);
        host.type_in_editor("// unsaved\n");
        let ctx = host.invocation();
        let editor = ctx.editor().expect("focused editor");
        let v = super::editor_context(&editor).expect("context");
        let e = &v["editor"];
        assert_eq!(e["path"], "/project/code.ts");
        assert_eq!(e["text"], "let x = old_value;\n// unsaved\n");
        assert_eq!(e["version"], 2);
        assert_eq!(e["selection"], serde_json::json!([0, 8, 0, 17]));
    }

    #[test]
    fn sidecar_hash_changes_with_the_content() {
        assert_eq!(super::fnv1a(""), "cbf29ce484222325");
        assert_ne!(super::fnv1a("a"), super::fnv1a("b"));
    }

    #[test]
    fn bundled_version_is_read_from_the_webview_copy() {
        let v = super::bundled_zoo_version();
        assert!(v.split('.').count() == 3 && v.split('.').all(|p| p.parse::<u32>().is_ok()), "{v:?}");
    }
}
