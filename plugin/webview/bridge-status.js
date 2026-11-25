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
  // ---- What the sidecar is missing, and the consent to download it ----------
  // zoo-bridge/extension and zoo-bridge/ripgrep states (sidecar main.ts):
  // resolving | missing | downloading | ready | failed (| unavailable for
  // ripgrep). Nothing is downloaded until the user clicks Download.
  const deps = document.getElementById("zoo-bridge-deps");
  const dTitle = deps.querySelector(".zbd-title");
  const dBody = deps.querySelector(".zbd-body");
  const dProgress = deps.querySelector(".zbd-progress");
  const dBar = deps.querySelector(".zbd-bar");
  const dDownload = deps.querySelector(".zbd-download");
  const dLater = deps.querySelector(".zbd-later");
  let ext = {};
  let rg = {};
  let connected = false;
  let laterRipgrep = false;

  const mb = (bytes) => (bytes / 1048576).toFixed(1) + " MB";
  const sized = (what, s) => what + (s.size ? " (" + mb(s.size) + ")" : "");
  const host = (url) => {
    try {
      return new URL(url).host;
    } catch (_) {
      return "";
    }
  };

  function show(title, body, opts) {
    deps.hidden = false;
    deps.dataset.kind = opts.kind;
    dTitle.textContent = title;
    dBody.textContent = body;
    dBody.title = opts.tooltip || "";
    dDownload.hidden = !opts.download;
    dDownload.textContent = opts.download || "";
    dLater.hidden = !opts.later;
    dProgress.hidden = opts.progress === undefined;
    if (opts.progress !== undefined) {
      const pct = opts.progress === null ? null : Math.max(0, Math.min(100, Math.round(opts.progress)));
      dProgress.classList.toggle("zbd-indeterminate", pct === null);
      dBar.style.width = pct === null ? "" : pct + "%";
      if (pct === null) dProgress.removeAttribute("aria-valuenow");
      else dProgress.setAttribute("aria-valuenow", String(pct));
    }
  }

  function render() {
    if (!connected) {
      deps.hidden = true;
      return;
    }
    const extMissing = ext.state === "missing";
    const rgMissing = rg.state === "missing" && !(laterRipgrep && ext.state === "ready");

    if (ext.state === "downloading" || rg.state === "downloading") {
      const parts = [];
      if (ext.state === "downloading") parts.push("Zoo Code " + ext.version);
      if (rg.state === "downloading") parts.push("ripgrep " + rg.version);
      const total = ext.total || ext.size;
      const progress = ext.state === "downloading" && total ? (100 * (ext.received || 0)) / total : null;
      const done = ext.state === "downloading" && total ? mb(ext.received || 0) + " of " + mb(total) : "";
      if (progress !== null && progress >= 100 && rg.state !== "downloading") {
        show("Installing Zoo Code " + ext.version + "…", "Checking the SHA-256 and extracting the extension.", { kind: "progress", progress: null });
        return;
      }
      show("Downloading " + parts.join(" and ") + "…", done ? done + " from GitHub; each file is checked against the SHA-256 the plugin pins." : "From GitHub; each file is checked against the SHA-256 the plugin pins.", { kind: "progress", progress: progress, tooltip: [ext.url, rg.url].filter(Boolean).join("\n") });
      return;
    }
    if (ext.state === "failed" || rg.state === "failed") {
      const failed = ext.state === "failed" ? ext : rg;
      const what = ext.state === "failed" ? "Zoo Code" + (ext.version ? " " + ext.version : "") : "ripgrep " + rg.version;
      const retry = !!failed.url; // downloadable: retry; else nothing to download
      show(
        (retry ? "Could not download " : "Could not load ") + what + ".",
        (failed.error || "") + (retry ? " Behind a proxy, download it yourself: see the plugin's README." : ""),
        { kind: "error", download: retry ? "Retry" : "", later: ext.state === "ready" },
      );
      return;
    }
    if (extMissing || rgMissing) {
      const items = [];
      let bytes = 0;
      if (extMissing) {
        items.push(sized("Zoo Code " + ext.version, ext));
        bytes += ext.size || 0;
      }
      if (rgMissing) {
        items.push("ripgrep " + rg.version + " (" + (rg.size ? mb(rg.size) + ", " : "") + "for file search)");
        bytes += rg.size || 0;
      }
      const sources = [extMissing && host(ext.url), rgMissing && host(rg.url)].filter(Boolean);
      show(
        extMissing ? "Zoo Code " + ext.version + " is not on this machine." : "File search needs ripgrep.",
        "Download the official release" + (items.length > 1 ? "s" : "") + " of " + items.join(" and ") + " from " + (sources[0] || "GitHub") +
          "? " + (items.length > 1 ? "Each is" : "It is") + " checked against the SHA-256 the plugin pins.",
        {
          kind: "ask",
          download: "Download" + (bytes ? " (" + mb(bytes) + ")" : ""),
          later: !extMissing,
          tooltip: [extMissing && ext.url, rgMissing && rg.url].filter(Boolean).join("\n"),
        },
      );
      return;
    }
    if (rg.state === "unavailable" && ext.state === "ready" && !laterRipgrep) {
      show("ripgrep not found.", "Zoo Code's file search and listing will not work: install ripgrep (rg) on PATH and restart the extension host.", { kind: "warning", later: true });
      return;
    }
    deps.hidden = true;
  }

  window.addEventListener("zoo-bridge-deps", function (e) {
    const s = e.detail;
    if (s.type === "zoo-bridge/extension") ext = s;
    else rg = s;
    render();
  });
  window.addEventListener("zoo-bridge", function (e) {
    connected = e.detail.state === "connected";
    if (!connected) {
      ext = {};
      rg = {};
    }
    render();
  });
  dDownload.addEventListener("click", function () {
    dDownload.disabled = true;
    setTimeout(function () {
      dDownload.disabled = false;
    }, 1500);
    window.zooBridge.download();
  });
  dLater.addEventListener("click", function () {
    laterRipgrep = true;
    render();
  });
  // States that arrived before this script ran.
  connected = window.zooBridge.state === "connected";
  ext = window.zooBridge.deps.extension || {};
  rg = window.zooBridge.deps.ripgrep || {};
  render();

  // Until the first status arrives.
  setTimeout(function () {
    if (!banner.dataset.state) banner.hidden = false;
  }, 1500);
})();
