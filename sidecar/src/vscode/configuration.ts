// `vscode.workspace.getConfiguration`: defaults from the extension's
// package.json (contributes.configuration), user values in settings.json of
// the data directory (flat "section.key" names, as VS Code's settings.json).

import { ConfigurationTarget, EventEmitter } from "./types.js";
import { JsonFile } from "./storage.js";

export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string): boolean;
}

/** Defaults the IDE would provide for settings the extension reads but does not contribute. */
const HOST_DEFAULTS: Record<string, unknown> = {
  "editor.tabSize": 4,
  "editor.insertSpaces": true,
  "files.eol": "auto",
  "files.exclude": {},
  "search.exclude": {},
  "http.proxy": "",
  "http.proxyStrictSSL": true,
  "terminal.integrated.shellIntegration.enabled": true,
};

export class Configuration {
  private readonly defaults = new Map<string, unknown>(Object.entries(HOST_DEFAULTS));
  private readonly emitter = new EventEmitter<ConfigurationChangeEvent>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly settings: JsonFile,
    contributes: unknown,
  ) {
    for (const block of ([] as unknown[]).concat(contributes ?? [])) {
      const props = (block as { properties?: Record<string, { default?: unknown }> })?.properties ?? {};
      for (const [key, schema] of Object.entries(props)) this.defaults.set(key, schema.default);
    }
  }

  private value(key: string): unknown {
    const user = this.settings.get(key);
    if (user !== undefined) return user;
    if (this.defaults.has(key)) return this.defaults.get(key);
    // An object setting read as a whole ("files.exclude" with "files.exclude.x" stored).
    const prefix = key + ".";
    const nested: Record<string, unknown> = {};
    let found = false;
    for (const [k, v] of [...this.defaults, ...Object.entries(this.settings.all())]) {
      if (k.startsWith(prefix)) {
        nested[k.slice(prefix.length)] = v;
        found = true;
      }
    }
    return found ? nested : undefined;
  }

  get(section?: string): WorkspaceConfiguration {
    const full = (key: string) => (section ? `${section}.${key}` : key);
    const self = this;
    const target: WorkspaceConfiguration = {
      get<T>(key: string, defaultValue?: T): T | undefined {
        const v = self.value(full(key));
        return v === undefined ? defaultValue : (structuredClone(v) as T);
      },
      has(key: string): boolean {
        return self.value(full(key)) !== undefined;
      },
      inspect<T>(key: string) {
        const k = full(key);
        return {
          key: k,
          defaultValue: self.defaults.get(k) as T | undefined,
          globalValue: self.settings.get(k) as T | undefined,
          workspaceValue: undefined,
          workspaceFolderValue: undefined,
        };
      },
      update(key: string, value: unknown, _target?: ConfigurationTarget | boolean): Promise<void> {
        const k = full(key);
        self.settings.set(k, value);
        self.emitter.fire({ affectsConfiguration: (s: string) => k === s || k.startsWith(s + ".") || s.startsWith(k + ".") });
        return Promise.resolve();
      },
    };
    // `config.someKey` property reads work as in VS Code.
    return new Proxy(target, {
      get(t, prop, receiver) {
        if (typeof prop === "string" && !(prop in t)) return self.value(full(prop));
        return Reflect.get(t, prop, receiver);
      },
    });
  }
}

export interface WorkspaceConfiguration {
  get<T>(key: string, defaultValue?: T): T | undefined;
  has(key: string): boolean;
  inspect<T>(key: string): { key: string; defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T };
  update(key: string, value: unknown, target?: ConfigurationTarget | boolean): Promise<void>;
}
