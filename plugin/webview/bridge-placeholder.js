// Bridge diagnostics UI (debug.html): shows the bridge state, starts the
// sidecar and logs the messages Zoo Code's webview-ui would receive.
// Connection, retries and queueing are the shim's (vscode-shim.js).
(function () {
  "use strict";
  const vscode = window.acquireVsCodeApi();
  const dot = document.getElementById("dot");
  const stateEl = document.getElementById("state");
  const start = document.getElementById("start");
  const log = document.getElementById("log");

  function line(text) {
    log.textContent += text + "\n";
    log.scrollTop = log.scrollHeight;
  }

  window.addEventListener("zoo-bridge", function (e) {
    const s = e.detail;
    dot.className = "dot " + s.state;
    stateEl.textContent = s.state + (s.detail ? " — " + s.detail : "");
    start.hidden = s.state === "connected" || s.state === "starting";
    // Echo test on every (re)connection: the lot 1 sidecar answers with the same message.
    if (s.state === "connected") vscode.postMessage({ type: "echo", text: "hello from the web view" });
  });

  window.addEventListener("message", function (e) {
    if (e.data && typeof e.data.tag === "string" && e.data.tag.startsWith("openidea")) return;
    line("← " + JSON.stringify(e.data).slice(0, 2000));
  });

  start.addEventListener("click", function () {
    window.zooBridge.start();
  });
})();
