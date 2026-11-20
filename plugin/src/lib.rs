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
const TERMINAL_KEY: &str = "zoo-sidecar";
/// Where the sidecar writes the port it bound, inside the plugin's data directory.
const PORT_FILE: &str = "sidecar.port";
const TOKEN_KEY: &str = "sidecar.token";
/// Messages taken from the WebSocket per drain: the host's maximum
/// (a larger limit fails with "invalid drain limit").
const DRAIN_LIMIT: u32 = 32;

#[derive(Default)]
pub struct ZooCode {
    ws: Option<WebSocket>,
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

fn port_file() -> Result<String, Error> {
    data_path(PORT_FILE)
}

/// The port the running sidecar listens on: the configured one, or the one
/// it wrote to its port file (none while it is not running).
fn port() -> Option<u16> {
    match configured_port() {
        0 => host::fs::read_file(&port_file().ok()?).ok()?.trim().parse().ok(),
        p => Some(p),
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

fn post_to_view(msg: &Value) -> Result<(), Error> {
    host::post_view_message(VIEW, &msg.to_string())
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

fn status(state: &str, detail: &str) -> Result<(), Error> {
    let notice = host::storage::get(NOTICE_HIDDEN_KEY).ok().flatten().is_none();
    post_to_view(&json!({ "type": "zoo-bridge/status", "state": state, "detail": detail, "notice": notice }))
}

impl ZooCode {
    /// Starts the sidecar in its terminal session (focuses it when it runs).
    fn start_sidecar(&self, ctx: &Invocation) -> Result<(), Error> {
        let script = host::setting_string("sidecarScript").filter(|s| !s.is_empty()).ok_or_else(|| {
            Error::Invalid("set Settings › Plugins › Bridge for Zoo Code › sidecar entry script first".into())
        })?;
        let workspace = ctx.project().map(|p| p.root()).transpose()?.unwrap_or_default();
        let cmd = Command::new("node")
            .arg(&script)
            .env("ZOO_PORT", &configured_port().to_string())
            .env("ZOO_PORT_FILE", &port_file()?)
            .env("ZOO_TOKEN", &token()?)
            .env("ZOO_WORKSPACE", &workspace)
            // Extension state, settings and API keys (owner-only, removed on uninstall).
            .env("ZOO_DATA_DIR", &data_path("zoo-data")?)
            .env("ZOO_EXPECTED_VERSION", bundled_zoo_version());
        host::open_terminal_session(TERMINAL_KEY, "Zoo Code Extension Host", &cmd)?;
        Ok(())
    }

    /// Connects to a running sidecar; `Ok(false)` while it is not listening yet.
    fn connect(&mut self, ctx: &Invocation) -> Result<bool, Error> {
        if self.ws.is_some() {
            return Ok(true);
        }
        let Some(port) = port() else { return Ok(false) };
        let project = match ctx.project() {
            Some(p) => p,
            None => host::projects()?.into_iter().next().ok_or_else(|| Error::Invalid("open a project first".into()))?,
        };
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
                self.ws = Some(ws);
                Ok(true)
            }
            Err(_) => Ok(false),
        }
    }

    fn send(&mut self, msg: &Outbound) -> Result<(), Error> {
        let Some(ws) = &self.ws else { return Err(Error::Invalid("Zoo Code extension host is not connected".into())) };
        if let Err(e) = ws.send(msg.to_json().to_string().as_bytes()) {
            self.ws = None;
            return Err(e);
        }
        Ok(())
    }

    /// Takes what the sidecar sent and dispatches it.
    fn drain(&mut self, ctx: &Invocation) {
        loop {
            let Some(ws) = &self.ws else { return };
            let batch = match ws.drain(DRAIN_LIMIT) {
                Ok(b) => b,
                Err(e) => {
                    self.ws = None;
                    let _ = status("disconnected", &format!("drain failed: {e}"));
                    return;
                }
            };
            let more = batch.messages.len() as u32 == DRAIN_LIMIT;
            for raw in &batch.messages {
                let Ok(text) = std::str::from_utf8(raw) else { continue };
                match Inbound::parse(text) {
                    Some(Inbound::Webview(msg)) => {
                        let _ = post_to_view(&msg);
                    }
                    Some(Inbound::Ide { id, op, args }) => {
                        let result = self.run_ide(&op, &args, ctx);
                        let _ = self.send(&Outbound::IdeResult { id, result });
                    }
                    Some(Inbound::Notify { level, message }) => {
                        let level = match level.as_str() {
                            "error" => NotificationLevel::Error,
                            "warning" => NotificationLevel::Warning,
                            _ => NotificationLevel::Info,
                        };
                        host::notify(level, "Zoo Bridge", &message);
                    }
                    Some(Inbound::Ping) | None => {}
                }
            }
            if batch.closed {
                self.ws = None;
                let _ = status("disconnected", "");
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

    /// Runs one of Zoo Code's commands in the sidecar, with the tool window in front.
    fn zoo_command(&mut self, id: &str, args: Value, ctx: &Invocation) -> Result<Option<String>, Error> {
        host::reveal_view(VIEW)?;
        if !self.connect(ctx)? {
            return Err(Error::Invalid("Zoo Code extension host is not running: Zoo Bridge: Start Extension Host".into()));
        }
        self.send(&Outbound::Command { id: id.into(), args })?;
        Ok(None)
    }

    fn from_webview(&mut self, text: &str, ctx: &Invocation) -> Result<(), Error> {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return Ok(()) };
        // Bridge control messages from the shim; everything else is Zoo Code's.
        match msg.get("type").and_then(Value::as_str) {
            Some("zoo-bridge/hello") => {
                // Zoo Code's page sends its own `webviewDidLaunch` once the
                // shim has flushed its queue on `connected`.
                if self.connect(ctx)? {
                    status("connected", "")
                } else {
                    status("offline", "Zoo Code extension host not running")
                }
            }
            Some("zoo-bridge/dismiss-notice") => host::storage::set(NOTICE_HIDDEN_KEY, "1"),
            // An IDE request of the sidecar relayed by the page (see run_ide).
            Some("zoo-bridge/ide-call") => {
                let id = msg.get("id").and_then(Value::as_u64).unwrap_or(0);
                let op = msg.get("op").and_then(Value::as_str).unwrap_or_default().to_owned();
                let args = msg.get("args").cloned().unwrap_or(Value::Null);
                let result = self.run_ide(&op, &args, ctx);
                if !self.connect(ctx)? {
                    return Ok(());
                }
                self.send(&Outbound::IdeResult { id, result })
            }
            // Toolbar: one of Zoo Code's view title commands.
            Some("zoo-bridge/command") => {
                let id = msg.get("id").and_then(Value::as_str).unwrap_or_default();
                if !id.starts_with("zoo-code.") {
                    return Ok(());
                }
                if !self.connect(ctx)? {
                    return status("offline", "Zoo Code extension host not running");
                }
                self.send(&Outbound::Command { id: id.into(), args: Value::Null })
            }
            Some("zoo-bridge/stop") => {
                if self.connect(ctx)? {
                    let _ = self.send(&Outbound::Shutdown);
                }
                self.ws = None;
                status("offline", "Zoo Code extension host stopped")
            }
            Some("zoo-bridge/start") => {
                self.start_sidecar(ctx)?;
                status("starting", "")
            }
            _ => {
                if !self.connect(ctx)? {
                    return status("offline", "Zoo Code extension host not running");
                }
                self.send(&Outbound::Webview(msg))
            }
        }
    }
}

impl Plugin for ZooCode {
    fn deactivate(&mut self) {
        // Dropping the WebSocket closes it; the sidecar keeps running and
        // waits for the next instance.
        self.ws = None;
    }

    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "start-sidecar" => {
                self.start_sidecar(ctx)?;
                Ok(Some("Zoo Code extension host starting".into()))
            }
            "stop-sidecar" => {
                if self.connect(ctx)? {
                    self.send(&Outbound::Shutdown)?;
                }
                self.ws = None;
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
                // Zoo Code reads the file and selection from its active editor.
                let editor = ctx.editor().ok_or_else(|| Error::Invalid("focus an editor first".into()))?;
                let selection = editor.selections()?.into_iter().next().map(|r| {
                    json!([r.start.line, r.start.character, r.end.line, r.end.character])
                });
                self.zoo_command(zoo, json!({ "editor": { "path": editor.path(), "selection": selection } }), ctx)
            }
            _ => Err(Error::NotFound(format!("command {id}"))),
        }
    }

    fn handle_events(&mut self, events: &[Event], ctx: &Invocation) {
        for event in events {
            match event {
                Event::WebSocketReady(_) => self.drain(ctx),
                Event::FileSaved(path) => {
                    let _ = self.send(&Outbound::Event { kind: "file-saved".into(), data: json!(path) });
                }
                Event::EditorFocused(path) => {
                    let _ = self.send(&Outbound::Event { kind: "editor-focused".into(), data: json!(path) });
                }
                Event::Other { kind, .. } if kind == "problems-changed" => {
                    // The sidecar asks for the problems through the page (needs a window).
                    let _ = self.send(&Outbound::Event { kind: kind.clone(), data: Value::Null });
                }
                Event::FilesChanged(fc) => {
                    let data = json!({ "created": fc.created, "modified": fc.modified, "removed": fc.removed });
                    let _ = self.send(&Outbound::Event { kind: "files-changed".into(), data });
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
    #[test]
    fn bundled_version_is_read_from_the_webview_copy() {
        let v = super::bundled_zoo_version();
        assert!(v.split('.').count() == 3 && v.split('.').all(|p| p.parse::<u32>().is_ok()), "{v:?}");
    }
}
