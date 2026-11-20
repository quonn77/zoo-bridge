// Dev harness: serves plugin/webview like OpenIDEA's web view scheme, with a
// stub of the frame bridge (window.openidea, dark theme) injected first into
// HTML pages. In the page console: __deliver(msg) sends a plugin message,
// __sent lists what the page posted, __online = true answers hello with
// "connected".
//   node scripts/webview-harness.mjs plugin/webview 5199
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const [dir, port = "5199"] = process.argv.slice(2);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2",
  ".wasm": "application/wasm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".gif": "image/gif" };

const STUB = `<script>
(function(){
  const vars = {"--openidea-bg":"#1e1f22","--openidea-bg-elevated":"#2b2d30","--openidea-bg-hover":"#393b40",
    "--openidea-bg-selected":"#2e436e","--openidea-bg-input":"#1e1f22","--openidea-fg":"#dfe1e5","--openidea-fg-strong":"#ffffff",
    "--openidea-fg-muted":"#868a91","--openidea-border":"#393b40","--openidea-focus-ring":"#3574f0","--openidea-link":"#548af7",
    "--openidea-accent":"#3574f0","--openidea-fg-on-accent":"#ffffff","--openidea-danger":"#f75464","--openidea-warning":"#f2c55c",
    "--openidea-success":"#5fb865","--openidea-info":"#548af7","--openidea-font-ui":"system-ui, sans-serif",
    "--openidea-font-mono":"monospace","--openidea-font-size":"13px"};
  for (const [k,v] of Object.entries(vars)) document.documentElement.style.setProperty(k,v);
  document.documentElement.dataset.theme = "dark";
  const listeners = [];
  window.__sent = [];
  window.__deliver = (obj) => listeners.forEach(l => l(JSON.stringify(obj)));
  // ?sidecar=<port>&token=<token>: play the plugin against a running sidecar.
  const q = new URLSearchParams(location.search);
  let ws;
  if (q.get("sidecar")) {
    ws = new WebSocket("ws://127.0.0.1:" + q.get("sidecar") + "/bridge?token=" + encodeURIComponent(q.get("token") || ""));
    ws.binaryType = "arraybuffer";
    const enc = new TextEncoder(), dec = new TextDecoder();
    ws.onopen = () => { window.__online = true; window.__deliver({type:"zoo-bridge/status", state:"connected", detail:""}); };
    ws.onclose = () => { window.__online = false; window.__deliver({type:"zoo-bridge/status", state:"disconnected", detail:"sidecar closed"}); };
    ws.onmessage = (e) => {
      const m = JSON.parse(typeof e.data === "string" ? e.data : dec.decode(e.data));
      if (m.t === "webview") window.__deliver(m.msg);
      else if (m.t === "ide") { console.log("[ide]", m.op, JSON.stringify(m.args).slice(0,200)); ws.send(enc.encode(JSON.stringify({t:"ide-result", id:m.id, ok:true, value:null}))); }
      else if (m.t === "notify") console.log("[notify]", m.level, m.message);
    };
    window.__ws = ws;
    window.__sendToSidecar = (obj) => ws.send(enc.encode(JSON.stringify(obj)));
  }
  window.openidea = {
    theme: { dark: true, vars },
    onThemeChange(){},
    postMessage(text){ window.__sent.push(JSON.parse(text)); console.log("[to plugin]", text.slice(0,200));
      const m = JSON.parse(text);
      if (m.type === "zoo-bridge/hello") setTimeout(() => window.__deliver({type:"zoo-bridge/status", state: window.__online ? "connected" : "offline", detail:"stub"}), 50);
      // As the plugin: IDE calls are answered here (logged), toolbar commands
      // and stop are its own; the rest goes to the sidecar.
      else if (ws && ws.readyState === 1 && m.type === "zoo-bridge/ide-call") { console.log("[ide]", m.op, JSON.stringify(m.args).slice(0, 200)); window.__sendToSidecar({t:"ide-result", id:m.id, ok:true, value: m.op === "problems" ? {} : null}); }
      else if (ws && ws.readyState === 1 && m.type === "zoo-bridge/command") window.__sendToSidecar({t:"command", id:m.id, args:null});
      else if (ws && ws.readyState === 1 && m.type === "zoo-bridge/stop") window.__sendToSidecar({t:"shutdown"});
      else if (ws && ws.readyState === 1 && m.type !== "zoo-bridge/start" && m.type !== "zoo-bridge/dismiss-notice") window.__sendToSidecar({t:"webview", msg:m});
    },
    onMessage(fn){ listeners.push(fn); },
    // Dialog stubs: __openFile = { name, text } is "picked"; __savePath is "chosen".
    async openFile(o){ console.log("[openFile]", JSON.stringify(o)); const f = window.__openFile; return f ? { name: f.name, data: new TextEncoder().encode(f.text) } : null; },
    async saveFile(o){ console.log("[saveFile]", o.name, JSON.stringify(o.filters)); return window.__savePath || null; },
  };
})();
</script>`;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(dir, path));
  if (!file.startsWith(normalize(dir))) { res.writeHead(403).end(); return; }
  try {
    let body = await readFile(file);
    const type = TYPES[extname(file)] || "application/octet-stream";
    if (type === "text/html") body = Buffer.from(body.toString().replace("<head>", "<head>" + STUB));
    res.writeHead(200, { "content-type": type }).end(body);
  } catch { res.writeHead(404).end("not found: " + path); }
}).listen(Number(port), "127.0.0.1", () => console.log(`serving ${dir} on http://127.0.0.1:${port}/`));
