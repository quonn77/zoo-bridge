//! JSON messages on the bridge WebSocket (see `docs/ARCHITECTURE.md` §3).

use serde_json::{Value, json};

/// Sidecar → plugin.
#[derive(Debug, PartialEq)]
pub enum Inbound {
    /// A message for the web view (Zoo Code's `postMessage` to its webview).
    Webview(Value),
    /// An action only the IDE can do; answered with [`Outbound::IdeResult`].
    Ide { id: u64, op: String, args: Value },
    /// `vscode.window.show*Message`.
    Notify { level: String, message: String },
    /// Keep-alive: delivering it counts as use, so the instance is not reclaimed.
    Ping,
}

impl Inbound {
    pub fn parse(text: &str) -> Option<Inbound> {
        let v: Value = serde_json::from_str(text).ok()?;
        match v.get("t")?.as_str()? {
            "webview" => Some(Inbound::Webview(v.get("msg")?.clone())),
            "ide" => Some(Inbound::Ide {
                id: v.get("id")?.as_u64()?,
                op: v.get("op")?.as_str()?.to_owned(),
                args: v.get("args").cloned().unwrap_or(Value::Null),
            }),
            "notify" => Some(Inbound::Notify {
                level: v.get("level").and_then(Value::as_str).unwrap_or("info").to_owned(),
                message: v.get("message").and_then(Value::as_str).unwrap_or_default().to_owned(),
            }),
            "ping" => Some(Inbound::Ping),
            _ => None,
        }
    }
}

/// Plugin → sidecar.
#[derive(Debug)]
pub enum Outbound {
    Webview(Value),
    IdeResult { id: u64, result: Result<Value, String> },
    Event { kind: String, data: Value },
    Command { id: String, args: Value },
    Shutdown,
}

impl Outbound {
    pub fn to_json(&self) -> Value {
        match self {
            Outbound::Webview(msg) => json!({ "t": "webview", "msg": msg }),
            Outbound::IdeResult { id, result: Ok(value) } => json!({ "t": "ide-result", "id": id, "ok": true, "value": value }),
            Outbound::IdeResult { id, result: Err(e) } => json!({ "t": "ide-result", "id": id, "ok": false, "error": e }),
            Outbound::Event { kind, data } => json!({ "t": "event", "kind": kind, "data": data }),
            Outbound::Command { id, args } => json!({ "t": "command", "id": id, "args": args }),
            Outbound::Shutdown => json!({ "t": "shutdown" }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sidecar_messages() {
        assert_eq!(
            Inbound::parse(r#"{"t":"webview","msg":{"type":"state"}}"#),
            Some(Inbound::Webview(json!({ "type": "state" })))
        );
        assert_eq!(
            Inbound::parse(r#"{"t":"ide","id":7,"op":"openLocation","args":{"path":"a"}}"#),
            Some(Inbound::Ide { id: 7, op: "openLocation".into(), args: json!({ "path": "a" }) })
        );
        assert_eq!(Inbound::parse(r#"{"t":"ping"}"#), Some(Inbound::Ping));
        assert_eq!(Inbound::parse(r#"{"t":"nope"}"#), None);
        assert_eq!(Inbound::parse("not json"), None);
    }

    #[test]
    fn encodes_ide_results() {
        let ok = Outbound::IdeResult { id: 1, result: Ok(json!(3)) }.to_json();
        assert_eq!(ok, json!({ "t": "ide-result", "id": 1, "ok": true, "value": 3 }));
        let err = Outbound::IdeResult { id: 2, result: Err("no".into()) }.to_json();
        assert_eq!(err, json!({ "t": "ide-result", "id": 2, "ok": false, "error": "no" }));
    }
}
