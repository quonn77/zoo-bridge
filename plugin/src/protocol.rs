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
    /// A piece of a message over [`PART_BYTES`]; the pieces come in order.
    Part { last: bool, data: String },
}

/// Flow control this plugin announces to the sidecar ([`Outbound::Flow`]).
/// OpenIDEA closes a plugin WebSocket on a message over 1 MiB, or when more
/// than 256 messages / 8 MiB wait to be read: stay well under both.
pub const PART_BYTES: usize = 512 << 10;
pub const WINDOW_FRAMES: u32 = 128;
pub const WINDOW_BYTES: u32 = 4 << 20;

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
            "part" => Some(Inbound::Part {
                last: v.get("last").and_then(Value::as_bool).unwrap_or(false),
                data: v.get("data")?.as_str()?.to_owned(),
            }),
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
    /// First thing after connecting: the sidecar splits and paces what it sends.
    Flow,
    /// `n` frames were read: the sidecar may send that many more.
    Ack { n: u32 },
}

impl Outbound {
    /// The frames to send: the message itself, or its parts when it is over
    /// [`PART_BYTES`] (the host rejects a frame over 1 MiB).
    pub fn frames(&self) -> Vec<String> {
        let text = self.to_json().to_string();
        if text.len() <= PART_BYTES {
            return vec![text];
        }
        // Escaping can grow a piece up to 6 times; leave room for the frame.
        let budget = (PART_BYTES - 64) / 6;
        let mut out = Vec::new();
        let mut rest = text.as_str();
        while !rest.is_empty() {
            let mut end = budget.min(rest.len());
            while !rest.is_char_boundary(end) {
                end -= 1;
            }
            let (piece, tail) = rest.split_at(end);
            out.push(json!({ "t": "part", "last": tail.is_empty(), "data": piece }).to_string());
            rest = tail;
        }
        out
    }

    pub fn to_json(&self) -> Value {
        match self {
            Outbound::Webview(msg) => json!({ "t": "webview", "msg": msg }),
            Outbound::IdeResult { id, result: Ok(value) } => json!({ "t": "ide-result", "id": id, "ok": true, "value": value }),
            Outbound::IdeResult { id, result: Err(e) } => json!({ "t": "ide-result", "id": id, "ok": false, "error": e }),
            Outbound::Event { kind, data } => json!({ "t": "event", "kind": kind, "data": data }),
            Outbound::Command { id, args } => json!({ "t": "command", "id": id, "args": args }),
            Outbound::Shutdown => json!({ "t": "shutdown" }),
            Outbound::Flow => json!({ "t": "flow", "frames": WINDOW_FRAMES, "bytes": WINDOW_BYTES, "part": PART_BYTES }),
            Outbound::Ack { n } => json!({ "t": "ack", "n": n }),
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

    /// A message over the host's 1 MiB frame limit goes in parts that put it back together.
    #[test]
    fn large_messages_go_in_parts() {
        let big = "é".repeat(700_000) + "\"\\\n";
        let msg = Outbound::Webview(json!({ "type": "state", "text": big }));
        let frames = msg.frames();
        assert!(frames.len() > 1);
        let mut whole = String::new();
        for (i, f) in frames.iter().enumerate() {
            assert!(f.len() <= PART_BYTES, "frame {i} has {} bytes", f.len());
            match Inbound::parse(f) {
                Some(Inbound::Part { last, data }) => {
                    assert_eq!(last, i == frames.len() - 1);
                    whole.push_str(&data);
                }
                other => panic!("not a part: {other:?}"),
            }
        }
        assert_eq!(whole, msg.to_json().to_string());
        assert_eq!(Outbound::Shutdown.frames(), vec![r#"{"t":"shutdown"}"#.to_owned()]);
    }

    #[test]
    fn encodes_ide_results() {
        let ok = Outbound::IdeResult { id: 1, result: Ok(json!(3)) }.to_json();
        assert_eq!(ok, json!({ "t": "ide-result", "id": 1, "ok": true, "value": 3 }));
        let err = Outbound::IdeResult { id: 2, result: Err("no".into()) }.to_json();
        assert_eq!(err, json!({ "t": "ide-result", "id": 2, "ok": false, "error": "no" }));
    }
}
