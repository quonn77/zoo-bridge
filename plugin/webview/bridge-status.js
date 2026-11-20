// Banner above Zoo Code's UI while its extension host is not connected,
// with a button that starts it. The connection itself is the shim's.
(function () {
  "use strict";
  const banner = document.getElementById("zoo-bridge-banner");
  const text = banner.querySelector(".zoo-bridge-text");
  const start = banner.querySelector(".zoo-bridge-start");
  const LABELS = {
    offline: "Zoo Code extension host is not running.",
    disconnected: "Zoo Code extension host disconnected.",
    starting: "Starting the Zoo Code extension host…",
  };

  window.addEventListener("zoo-bridge", function (e) {
    const s = e.detail;
    banner.dataset.state = s.state;
    banner.hidden = s.state === "connected";
    text.textContent = (LABELS[s.state] || s.state) + (s.detail && !LABELS[s.state] ? " " + s.detail : "");
    text.title = s.detail || "";
    start.hidden = s.state === "starting" || s.state === "connected";
  });
  start.addEventListener("click", function () {
    window.zooBridge.start();
  });

  // Toolbar: Zoo Code's view title commands run in the extension host; the
  // stop button ends the host. Usable only while connected.
  const toolbar = document.getElementById("zoo-bridge-toolbar");
  const buttons = toolbar.querySelectorAll("button");
  const setEnabled = (on) => buttons.forEach((b) => (b.disabled = !on));
  setEnabled(false);
  window.addEventListener("zoo-bridge", function (e) {
    setEnabled(e.detail.state === "connected");
  });
  toolbar.addEventListener("click", function (e) {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.dataset.command) window.zooBridge.command(b.dataset.command);
    else if (b.dataset.bridge === "stop") window.zooBridge.stop();
  });

  // "Unofficial port" line: the plugin says whether it was hidden before
  // (status `notice`); hiding it is remembered by the plugin.
  const notice = document.getElementById("zoo-bridge-notice");
  window.addEventListener("zoo-bridge", function (e) {
    if (typeof e.detail.notice === "boolean") notice.hidden = !e.detail.notice;
  });
  notice.querySelector(".zoo-bridge-notice-close").addEventListener("click", function () {
    notice.hidden = true;
    window.zooBridge.dismissNotice();
  });
  // Until the first status arrives.
  setTimeout(function () {
    if (!banner.dataset.state) banner.hidden = false;
  }, 1500);
})();
