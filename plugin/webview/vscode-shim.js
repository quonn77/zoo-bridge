// VS Code webview API on top of OpenIDEA's web view bridge.
//
// Zoo Code's webview-ui calls `acquireVsCodeApi()` and listens to `message`
// events on `window`. Here both go through `openidea.postMessage` /
// `openidea.onMessage` to the plugin, which relays them to the sidecar.
//
// The shim also owns the bridge connection: it asks the plugin to connect
// (`zoo-bridge/hello`), retries while the extension host is not running,
// and queues the page's messages until it is (Zoo sends `webviewDidLaunch`
// as soon as it mounts). State changes are `zoo-bridge` events on window.
//
// Must load before the webview-ui bundle.
(function () {
  "use strict";
  const oi = window.openidea;
  const send = (msg) => oi.postMessage(JSON.stringify(msg));

  // ---- bridge connection --------------------------------------------------
  const MAX_QUEUE = 500;
  const queue = [];
  let state = "connecting";
  let retry;

  function hello() {
    send({ type: "zoo-bridge/hello" });
  }

  function setState(next, detail, notice) {
    const was = state;
    state = next;
    clearTimeout(retry);
    if (next === "connected") {
      // Where the extension and ripgrep stand (zoo-bridge/extension, /ripgrep).
      if (was !== "connected") send({ type: "zoo-bridge/deps" });
      for (const msg of queue.splice(0)) send(msg);
    } else {
      retry = setTimeout(hello, next === "starting" ? 1000 : 3000);
    }
    window.dispatchEvent(new CustomEvent("zoo-bridge", { detail: { state: next, detail: detail || "", notice: notice } }));
  }

  /** The last zoo-bridge/extension and zoo-bridge/ripgrep states. */
  const deps = { extension: undefined, ripgrep: undefined };

  window.zooBridge = Object.freeze({
    get state() {
      return state;
    },
    get deps() {
      return { extension: deps.extension, ripgrep: deps.ripgrep };
    },
    start() {
      send({ type: "zoo-bridge/start" });
    },
    dismissNotice() {
      send({ type: "zoo-bridge/dismiss-notice" });
    },
    /** Runs one of the extension's commands in the host. */
    command(id) {
      if (state === "connected") send({ type: "zoo-bridge/command", id: id });
    },
    /** Ends the extension host (the plugin asks it to shut down). */
    stop() {
      send({ type: "zoo-bridge/stop" });
    },
    /** The user agreed: download what is missing (the extension, ripgrep). */
    download() {
      if (state === "connected") send({ type: "zoo-bridge/download" });
    },
  });

  // ---- acquireVsCodeApi ---------------------------------------------------
  // The frame has no storage (opaque origin): webview state lives in memory
  // for the life of the page, as VS Code keeps it for a hidden webview.
  let viewState;
  const api = Object.freeze({
    postMessage(msg) {
      if (state === "connected") send(msg);
      else if (queue.push(msg) > MAX_QUEUE) queue.shift();
    },
    getState() {
      return viewState;
    },
    setState(next) {
      viewState = next;
      return next;
    },
  });
  let acquired = false;
  window.acquireVsCodeApi = function () {
    if (acquired) throw new Error("An instance of the VS Code API has already been acquired");
    acquired = true;
    return api;
  };

  // ---- blank helper iframes ------------------------------------------------
  // Size sensors (react-use's useSize, used by the chat rows) put an empty
  // <iframe> in the element and listen to `resize` on its contentWindow. In
  // OpenIDEA's frame (sandbox without allow-same-origin) such a child gets an
  // opaque origin of its own, so touching its window throws a SecurityError
  // and the UI crashes. For blank iframes whose window is out of reach,
  // contentWindow answers with a stand-in that reports the element's size
  // changes through a ResizeObserver.
  (function patchBlankIframes() {
    const proto = window.HTMLIFrameElement && HTMLIFrameElement.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "contentWindow");
    if (!desc || !desc.get || typeof ResizeObserver !== "function") return;
    const standIns = new WeakMap();

    function isBlank(el) {
      const src = el.getAttribute("src");
      return !src || src === "about:blank";
    }
    function reachable(win) {
      try {
        void win.addEventListener;
        return true;
      } catch (_) {
        return false;
      }
    }
    function standIn(el) {
      let s = standIns.get(el);
      if (s) return s;
      const listeners = new Set();
      let observer;
      const fire = () => {
        const ev = new Event("resize");
        for (const fn of [...listeners]) {
          try {
            fn.call(s, ev);
          } catch (e) {
            console.error(e);
          }
        }
      };
      s = {
        addEventListener(type, fn) {
          if (type !== "resize" || typeof fn !== "function") return;
          listeners.add(fn);
          if (!observer) {
            observer = new ResizeObserver(fire);
            observer.observe(el);
          }
        },
        removeEventListener(type, fn) {
          if (type !== "resize") return;
          listeners.delete(fn);
          if (!listeners.size && observer) {
            observer.disconnect();
            observer = undefined;
          }
        },
        get innerWidth() {
          return el.clientWidth;
        },
        get innerHeight() {
          return el.clientHeight;
        },
        requestAnimationFrame: (cb) => window.requestAnimationFrame(cb),
        cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
      };
      standIns.set(el, s);
      return s;
    }

    Object.defineProperty(proto, "contentWindow", {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        const real = desc.get.call(this);
        if (!real || !isBlank(this) || reachable(real)) return real;
        return standIn(this);
      },
    });
  })();

  // ---- plugin → page ------------------------------------------------------
  // OpenIDEA delivers plugin messages to the frame as window `message` events
  // ({ tag: "openidea-view", text }) that its runtime turns into
  // `openidea.onMessage` calls. Its listener was registered before this
  // script, so stopping the event here hides the envelopes from Zoo Code's
  // own `message` listeners without breaking delivery.
  window.addEventListener("message", function (e) {
    const d = e.data;
    if (d && typeof d === "object" && typeof d.tag === "string" && d.tag.startsWith("openidea")) {
      e.stopImmediatePropagation();
    }
  });

  oi.onMessage(function (text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (data && data.type === "zoo-bridge/status") {
      setState(data.state, data.detail, data.notice);
      return;
    }
    // Where the Zoo Code extension and ripgrep stand (sidecar main.ts): shown
    // by bridge-status.js, never given to Zoo Code.
    if (data && (data.type === "zoo-bridge/extension" || data.type === "zoo-bridge/ripgrep")) {
      // Kept for scripts that load after it arrived (window.zooBridge.deps).
      deps[data.type === "zoo-bridge/extension" ? "extension" : "ripgrep"] = data;
      window.dispatchEvent(new CustomEvent("zoo-bridge-deps", { detail: data }));
      return;
    }
    if (data && data.type === "zoo-bridge/dialog") {
      runDialog(data);
      return;
    }
    // An IDE request of the sidecar (open a file, show a diff, read problems):
    // the plugin can run editor APIs only from a window event, which this
    // page's messages are, so the request makes a round trip through here.
    if (data && data.type === "zoo-bridge/ide") {
      send({ type: "zoo-bridge/ide-call", id: data.id, op: data.op, args: data.args });
      return;
    }
    window.dispatchEvent(new MessageEvent("message", { data: data }));
  });

  // ---- IDE file dialogs for the extension (window.showOpenDialog/SaveDialog) --
  // The sidecar has no UI: it asks the page, which has openidea.openFile /
  // saveFile. Open answers with the file's bytes (base64); save creates the
  // chosen file empty and answers with its path, which the extension writes.
  function base64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function runDialog(req) {
    const reply = (fields) => send(Object.assign({ type: "zoo-bridge/dialog-result", id: req.id }, fields));
    try {
      if (req.kind === "open") {
        const file = await oi.openFile({ filters: req.filters });
        reply(file ? { name: file.name, data: base64(new Uint8Array(file.data)) } : { name: null });
      } else {
        const path = await oi.saveFile({ name: req.name || "untitled", data: "", filters: req.filters });
        reply({ path: path || null });
      }
    } catch (e) {
      reply({ error: String((e && e.message) || e) });
    }
  }

  // ---- theme --------------------------------------------------------------
  // VS Code variables from OpenIDEA's (the subset Zoo Code's UI uses most).
  const MAP = {
    "--vscode-editor-background": "--openidea-bg",
    "--vscode-sideBar-background": "--openidea-bg",
    "--vscode-panel-background": "--openidea-bg",
    "--vscode-editor-foreground": "--openidea-fg",
    "--vscode-foreground": "--openidea-fg",
    "--vscode-sideBar-foreground": "--openidea-fg",
    "--vscode-descriptionForeground": "--openidea-fg-muted",
    "--vscode-disabledForeground": "--openidea-fg-muted",
    "--vscode-input-background": "--openidea-bg-input",
    "--vscode-input-foreground": "--openidea-fg",
    "--vscode-input-border": "--openidea-border",
    "--vscode-input-placeholderForeground": "--openidea-fg-muted",
    "--vscode-dropdown-background": "--openidea-bg-elevated",
    "--vscode-dropdown-foreground": "--openidea-fg",
    "--vscode-dropdown-border": "--openidea-border",
    "--vscode-editorWidget-background": "--openidea-bg-elevated",
    "--vscode-editorWidget-border": "--openidea-border",
    "--vscode-editorGroup-border": "--openidea-border",
    "--vscode-widget-border": "--openidea-border",
    "--vscode-panel-border": "--openidea-border",
    "--vscode-sideBarSectionHeader-border": "--openidea-border",
    "--vscode-focusBorder": "--openidea-focus-ring",
    "--vscode-textLink-foreground": "--openidea-link",
    "--vscode-textLink-activeForeground": "--openidea-link",
    "--vscode-textCodeBlock-background": "--openidea-bg-elevated",
    "--vscode-textPreformat-foreground": "--openidea-fg",
    "--vscode-button-background": "--openidea-accent",
    "--vscode-button-foreground": "--openidea-fg-on-accent",
    "--vscode-button-hoverBackground": "--openidea-accent",
    "--vscode-button-secondaryBackground": "--openidea-bg-elevated",
    "--vscode-button-secondaryForeground": "--openidea-fg",
    "--vscode-button-secondaryHoverBackground": "--openidea-bg-hover",
    "--vscode-badge-background": "--openidea-accent",
    "--vscode-badge-foreground": "--openidea-fg-on-accent",
    "--vscode-list-hoverBackground": "--openidea-bg-hover",
    "--vscode-list-activeSelectionBackground": "--openidea-bg-selected",
    "--vscode-list-activeSelectionForeground": "--openidea-fg-strong",
    "--vscode-list-inactiveSelectionBackground": "--openidea-bg-selected",
    "--vscode-toolbar-hoverBackground": "--openidea-bg-hover",
    "--vscode-menu-background": "--openidea-bg-elevated",
    "--vscode-menu-foreground": "--openidea-fg",
    "--vscode-quickInput-background": "--openidea-bg-elevated",
    "--vscode-quickInput-foreground": "--openidea-fg",
    "--vscode-notifications-background": "--openidea-bg-elevated",
    "--vscode-notifications-foreground": "--openidea-fg",
    "--vscode-scrollbarSlider-background": "--openidea-bg-hover",
    "--vscode-scrollbarSlider-hoverBackground": "--openidea-bg-selected",
    "--vscode-errorForeground": "--openidea-danger",
    "--vscode-editorError-foreground": "--openidea-danger",
    "--vscode-inputValidation-errorBorder": "--openidea-danger",
    "--vscode-editorWarning-foreground": "--openidea-warning",
    "--vscode-editorInfo-foreground": "--openidea-info",
    "--vscode-charts-green": "--openidea-success",
    "--vscode-charts-red": "--openidea-danger",
    "--vscode-charts-yellow": "--openidea-warning",
    "--vscode-charts-blue": "--openidea-info",
    "--vscode-testing-iconPassed": "--openidea-success",
    "--vscode-gitDecoration-addedResourceForeground": "--openidea-change-added",
    "--vscode-gitDecoration-modifiedResourceForeground": "--openidea-change-modified",
    "--vscode-gitDecoration-deletedResourceForeground": "--openidea-change-deleted",
    "--vscode-font-family": "--openidea-font-ui",
    "--vscode-editor-font-family": "--openidea-font-mono",
  };
  function applyTheme(theme) {
    const root = document.documentElement;
    const vars = (theme && theme.vars) || {};
    const read = (name) => vars[name] || getComputedStyle(root).getPropertyValue(name).trim();
    for (const [vs, oiVar] of Object.entries(MAP)) {
      const value = read(oiVar);
      if (value) root.style.setProperty(vs, value);
    }
    // In VS Code inputs (the chat box) are lighter than the panel; OpenIDEA's
    // input colour may equal its panel colour, which leaves Zoo's prompt box
    // invisible. Then inputs take the elevated surface instead.
    const same = (a, b) => a && b && a.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase();
    const panel = read("--openidea-bg");
    const elevated = read("--openidea-bg-elevated");
    if (elevated && (!read("--openidea-bg-input") || same(read("--openidea-bg-input"), panel))) {
      for (const vs of ["--vscode-input-background", "--vscode-textCodeBlock-background"]) root.style.setProperty(vs, elevated);
    }
    const size = read("--openidea-font-size");
    if (size) {
      root.style.setProperty("--vscode-font-size", size);
      root.style.setProperty("--vscode-editor-font-size", size);
    }
    root.style.setProperty("--vscode-font-weight", "normal");
    // Zoo Code's webview-ui ships no color-scheme: set it, or the frame gets
    // a white backdrop in a dark IDE.
    const dark = !!(theme && theme.dark);
    root.style.colorScheme = dark ? "dark" : "light";
    if (document.body) {
      document.body.classList.toggle("vscode-dark", dark);
      document.body.classList.toggle("vscode-light", !dark);
      document.body.dataset.vscodeThemeKind = dark ? "vscode-dark" : "vscode-light";
    }
  }
  applyTheme(oi.theme);
  oi.onThemeChange && oi.onThemeChange(applyTheme);
  document.addEventListener("DOMContentLoaded", function () {
    applyTheme(oi.theme);
    hello();
  });
})();
