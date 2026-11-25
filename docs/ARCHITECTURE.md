# Zoo Code per OpenIDEA — architettura del porting

Porting di [Zoo-Code-Jetbrains](../../COTS/Zoo-Code-Jetbrains) (plugin IntelliJ, Kotlin) in un plugin
[OpenIDEA](https://github.com/l0ng-ai/openidea/tree/main/plugins) (API `openidea:plugin@1.13.0`).

## 1. Come funziona oggi il plugin JetBrains

```
IntelliJ (JVM, Kotlin ~30k LOC)                       Node.js
┌──────────────────────────────────┐   socket TCP    ┌──────────────────────────────┐
│ MainThread*Shape (32 actors):    │ ◄─────────────► │ extension_host (VS Code      │
│ documents, editors, fs, terminal,│ PersistentProt. │ ext host + RPCManager)       │
│ webviews, config, secrets, ...   │  + RPC VS Code  │  └─ Zoo Code VSIX (estensione│
│ JCEF webview  ◄── webview-ui     │                 │     VS Code originale)       │
└──────────────────────────────────┘                 └──────────────────────────────┘
```

Il lato Kotlin è un'implementazione parziale del "main thread" di VS Code: risponde alle chiamate RPC
dell'extension host (`$tryOpenDocument`, `$registerWebviewViewProvider`, `$createTerminal`, ...)
usando le API IntelliJ, e mostra la `webview-ui` di Zoo Code in JCEF.

## 2. Vincoli di OpenIDEA che cambiano il disegno

| Vincolo OpenIDEA | Conseguenza |
|---|---|
| Codice plugin = componente WASM (wasmtime, WASI p2), sandbox senza fs/rete/stdio | Niente Node *dentro* il plugin: l'extension host deve girare come processo esterno |
| Ogni chiamata nel plugin: 5 s wall clock (60 s con task aperto), 256 MiB, chiamate serializzate | Il WASM non può fare da server RPC long-running: solo da router a eventi |
| Istanza idle 5 min → reclaim; reclaim **uccide i `process.start` child** | Node lanciato con `process.start` muore. **`open-terminal-session` invece sopravvive al reclaim** |
| `net.websocket-connect` verso loopback (`ws://127.0.0.1`) + evento `websocket-ready` che risveglia il plugin | Canale bidirezionale Node ↔ WASM guidato da eventi, senza polling |
| View `web = "webview/index.html"`: iframe sandbox, origin opaca, niente rete, solo file del pacchetto, `openidea.postMessage/onMessage` | La `webview-ui` di Zoo Code può essere servita come web view (build Vite con `base: "./"`), con uno shim per `acquireVsCodeApi()` e per le variabili CSS `--vscode-*` |
| API editor/diff/terminale/notifiche disponibili solo dentro "command o event di una window" | Le azioni IDE richieste da Node arrivano come evento `websocket-ready` → eseguite lì |

## 3. Architettura proposta

```
OpenIDEA                                                          Node.js (sidecar)
┌───────────────────────────────────────────┐                    ┌───────────────────────────────────┐
│ Tool window "Zoo Code" (web view)          │                    │ host-shim (TypeScript, NUOVO)     │
│  webview-ui Zoo Code + vscode-shim.js      │                    │  ├─ server WS 127.0.0.1:<port>    │
│        ▲ openidea.postMessage/onMessage    │                    │  ├─ MainThread* in TS (porting    │
│        ▼                                   │                    │  │  dei Shape Kotlin): fs, config,│
│ Plugin WASM (Rust, "bridge" sottile)       │   WebSocket JSON   │  │  storage, documents, webviews… │
│  ├─ inoltra messaggi webview ⇄ sidecar     │ ◄────────────────► │  └─ "ide-request" → bridge per    │
│  ├─ esegue ide-request: open-location,     │  (websocket-ready) │     ciò che serve l'IDE           │
│  │  open-file-diff, apply-edits, notify,   │                    │                                   │
│  │  terminali, selezione editor            │                    │ extension_host (riuso da          │
│  ├─ inoltra eventi IDE (file-saved,        │                    │  Zoo-Code-Jetbrains) + Zoo VSIX   │
│  │  editor-focused, files-changed…)        │                    │  ▲ RPC VS Code in-process/socket  │
│  └─ avvia il sidecar con                   │                    └───────────────────────────────────┘
│     open-terminal-session("node", …)       │
└───────────────────────────────────────────┘
```

### Decisione (lotto 3): modulo `vscode` emulato, non l'extension host di VS Code

Il piano iniziale riusava `extension_host` di Zoo-Code-Jetbrains. Scartato:
- dipende dal sorgente di VS Code (`deps/vscode`, submodulo da clonare, patchare e buildare);
- richiede di riscrivere in TS i 32 `MainThread*Shape` del protocollo RPC (~30k LOC Kotlin).

Zoo Code 3.98.0 usa ~60 membri dei namespace (`window`, `workspace`, `commands`, `env`, …) e ~40
classi/enum. Il sidecar carica `dist/extension.js` con un `require("vscode")` intercettato
(`Module._load`) che restituisce un'implementazione in `sidecar/src/vscode/`:

| File | Cosa |
|---|---|
| `types.ts` | `Uri` (vscode-uri, la stessa di VS Code), `EventEmitter`, `Range`/`Position`/`Selection`, `WorkspaceEdit`, enum |
| `module.ts` | namespace; le API mancanti passano da un Proxy che le logga una volta e risponde con valori neutri |
| `storage.ts` | `globalState`/`workspaceState`/`secrets` su file JSON nella data dir privata del plugin |
| `configuration.ts` | `getConfiguration`: default da `contributes.configuration` + `settings.json` |
| `documents.ts` | `TextDocument` e `applyEdit` su disco (lotto 4: via editor IDE) |
| `../host.ts` | trova l'estensione, `ExtensionContext`, `activate`, `resolveWebviewView` sul bridge |

Rischio accettato: le API non implementate emergono a runtime (log `[vscode] not implemented: …`),
non a compile time. ripgrep (ricerca file) viene dall'installazione di VS Code (`env.appRoot`).

### Divisione delle responsabilità

**Sidecar Node (`sidecar/`, TypeScript)** — dove va la maggior parte del porting.
- Riusa `extension_host` di Zoo-Code-Jetbrains (bootstrap VS Code ext host, `RPCManager`, `ExtensionManager`).
- Sostituisce i 32 `MainThread*Shape.kt` con implementazioni TS. Quelle che non richiedono l'IDE
  (filesystem, configurazione, storage, secret state, logger, telemetry, output) restano interamente in Node.
- Quelle che richiedono l'IDE (documenti aperti, editor, diff, terminale, messaggi, status bar)
  diventano richieste JSON verso il bridge.
- Espone un server WebSocket su loopback; scrive porta + token in un file nella data dir del plugin.

**Plugin WASM (`plugin/`, Rust + SDK `openidea-plugin`)** — sottile, stateless dove possibile.
- Comando/attivazione `on-view:zoo` → se il sidecar non è vivo lo avvia con `open-terminal-session`,
  poi `websocket-connect` al loopback.
- `ViewEvent::Message` dalla webview → `ws.send`.
- `websocket-ready` → `drain` → smista: messaggi per la webview (`post_view_message`) oppure
  `ide-request` da eseguire con le API host e risposta sul WS.
- Sottoscrive `file-saved`, `editor-focused`, `files-changed`, `document-changed` e li inoltra.
- Comandi/menu: Nuovo task, Explain/Fix/Improve code (equivalenti ai context menu JetBrains), Settings, History.

**Web view (`plugin/webview/`)** — `webview-ui` di Zoo Code già buildata + `vscode-shim.js`:
- `acquireVsCodeApi()` → `{ postMessage: openidea.postMessage(JSON), getState/setState }`.
- `window.addEventListener('message')` alimentato da `openidea.onMessage`.
- Mappa `--openidea-*` → `--vscode-*` (oggi fatto dal tema Kotlin `theme/`).

### Richieste IDE tramite la pagina (lotto 4)

Le API editor/view di OpenIDEA (`open-location`, `open-file-diff`, `diagnostics.problems`) funzionano
solo da "un comando o evento di una finestra". `websocket-ready` è emesso senza finestra
(`sink.emit(None, …)`), quindi il sidecar non le chiede direttamente al plugin: le manda alla pagina
(`zoo-bridge/ide`), lo shim le rimanda al plugin (`zoo-bridge/ide-call`, evento della finestra della
tool window) e il plugin risponde al sidecar con `ide-result`. Serve la tool window aperta.

Modifiche ai file (flusso `DiffViewProvider` di Zoo): `vscode.diff` registra la proposta, il
documento resta in memoria (dirty) mentre Zoo scrive, l'IDE mostra il diff (sola lettura) quando lo
stream si ferma; approvare/rifiutare resta nella chat di Zoo, `save()` scrive il file.

### Un sidecar per progetto (lotto 6)

Zoo Code presuppone un solo workspace per processo, mentre il plugin WASM ha **una sola istanza per
tutte le finestre** di OpenIDEA. Quindi tutto è indicizzato per progetto: la chiave è un FNV-1a
della radice (`project_key`), presa dal progetto della finestra da cui arriva comando, messaggio
della pagina o evento.

- Sessione terminale `zoo-sidecar-<key>`, file della porta `<plugin-dir>/sidecar-<key>.port`,
  `ZOO_WORKSPACE` = radice del progetto; `ZooCode.conns` mappa chiave → WebSocket. Start da una
  seconda finestra dello stesso progetto si ricollega al sidecar che c'è.
- `websocket-ready` non ha finestra ma porta l'id della connessione: `drain` lavora sul sidecar di
  quella connessione. Gli altri eventi (salvataggi, focus, problemi, file) vanno al sidecar del
  progetto della loro finestra, se connesso.
- `post_view_message` arriva alla pagina di **tutte** le finestre: ogni messaggio va in una busta
  `{type:"zoo-bridge/to", project, page, msg}`. La pagina manda un `pageId` nell'hello; la risposta
  (indirizzata a quel `pageId`) le dice il suo progetto, e da lì lo shim tiene solo i messaggi del
  suo progetto. Così anche le richieste IDE (`zoo-bridge/ide`) le rigira una sola pagina.
- Il sidecar gira nel terminale della finestra, quindi si chiude con lei; la connessione chiusa
  porta la pagina a "disconnected".
- Dati condivisi fra i sidecar (`globalState.json`, `secrets.json`, `settings.json` in `zoo-data`):
  `JsonFile` scrive sotto un lock (`<file>.lock`, directory), rileggendo il file e applicando solo
  le chiavi cambiate dal processo; le scritture degli altri processi sono rilette (polling) per le
  chiavi non cambiate localmente, e `SecretStorage`/la configurazione lo notificano. La cronologia
  dei task di Zoo è già un file per task con watcher (`TaskHistoryStore`); `workspaceState` è già per
  progetto.

### Protocollo bridge (WS JSON)

Frame **binari** (JSON UTF-8) in entrambe le direzioni: l'host OpenIDEA accoda per il plugin solo
`Message::Binary`, i frame di testo vengono scartati in silenzio. La porta è scelta dal sidecar
(`0` = libera) e scritta in `<plugin-dir>/sidecar-<key>.port`: su alcune macchine intere fasce di
porte loopback non sono utilizzabili.

```jsonc
// sidecar → plugin
{ "t": "webview", "view": "zoo", "msg": { ... } }               // da inoltrare alla webview
{ "t": "ide", "id": 42, "op": "openFileDiff", "args": { ... } }  // richiesta azione IDE
// plugin → sidecar
{ "t": "webview", "msg": { ... } }                               // dalla webview
{ "t": "ide-result", "id": 42, "ok": true, "value": ... }
{ "t": "event", "kind": "file-saved", "data": "..." }
```

## 4. Mappa MainThread Shape → implementazione

| Shape Kotlin | Dove | API OpenIDEA usata |
|---|---|---|
| FileSystem, FileSystemEventService | Node | — (+ `files-changed` inoltrato) |
| Configuration, Storage, SecretState | Node | (opz. `settings.get`, `secrets`) |
| Logger, Console, Output, Telemetry, Errors | Node | — |
| WebviewViews, Webviews | Node + bridge | `views.post-message`, web view |
| Documents, TextEditors, EditorTabs | bridge | `editor.*`, `editor.apply-edits-at`, `views.open-location`, eventi |
| BulkEdits | bridge | `editor.apply-edits-at` / `project.write` |
| Terminal*, TerminalShellIntegration | bridge (ridotto) | `open-terminal-session`, `write-terminal`; output via `process.start` |
| MessageService, Dialogs, StatusBar, Window | bridge | notifiche, status item, dialoghi web view |
| Commands | Node + bridge | `contributes.commands` |
| Clipboard | bridge | `clipboard` |
| Search | Node (ripgrep) | — |
| LanguageFeatures, LanguageModelTools, Debug, Task, Urls | stub / fuori MVP | — |
| diff "zoo-diff" (DiffViewProvider) | bridge | `views.open-file-diff` |

## 5. Capability richieste (`plugin.toml`)

- `process:node` (alto) — avvio sidecar.
- `net:127.0.0.1` — WebSocket loopback verso il sidecar.
- `project.read`, `project.write`, `editor.read`, `editor.write`, `events`, `storage`, `clipboard`.
- Il traffico LLM parte dal sidecar Node, non dal WASM: nessun `net:<provider>` nel plugin.

## 6. Rischi / punti aperti

1. **Sidecar in un tab terminale visibile**: l'unico modo documentato per un processo che sopravvive al
   reclaim. Alternativa: `process.start` + ri-avvio a ogni attivazione (perdita stato task in corso).
2. **Peso web view**: limite 256 MiB / 4096 file — la `webview-ui` Zoo sta ampiamente sotto.
3. **CSP iframe**: niente rete → immagini remote/markdown con URL esterni non si caricano; da verificare
   cosa usa la webview (font codicon va incluso nel pacchetto).
4. **Diff accetta/rifiuta**: JetBrains usa un editor diff interattivo; OpenIDEA `open-file-diff` è in
   sola visualizzazione → approvazione resta nei pulsanti della chat Zoo.
5. **Remote projects**: il plugin gira sul server remoto, `process:node` va risolto lì.
6. **Bundle Node**: `extension_host` dipende dal submodulo `deps/vscode` (build pesante). Il sidecar
   va distribuito già buildato dentro il pacchetto (`fs.plugin-dir`), con Node di sistema.

## 7. Piano a lotti

1. **Scaffold**: `plugin.toml`, crate Rust bridge (connessione WS, relay webview), web view placeholder,
   sidecar Node con server WS echo. Verifica con `openidea-plugin check` / `link`.
2. **Webview reale**: copia `webview-ui` dalla VSIX, `vscode-shim.js`, mapping tema.
3. **Ext host**: integrazione `extension_host` nel sidecar, MainThread Node-only (fs, config, storage,
   secrets, logger, webviews) → chat funzionante con un provider LLM.
4. **Editor**: Documents/TextEditors/BulkEdits/diff via bridge.
5. **Terminale + comandi/menu contestuali**.
6. **Packaging**: build sidecar + webview nel pacchetto, test su Windows/Linux.
