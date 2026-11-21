import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URI } from "vscode-uri";
import type { Bridge } from "../bridge.js";
import { Configuration } from "../vscode/configuration.js";
import { Documents } from "../vscode/documents.js";
import { createVscode } from "../vscode/module.js";
import { JsonFile } from "../vscode/storage.js";
import * as T from "../vscode/types.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "zoo-editor-"));
  const ideCalls: { op: string; args: Record<string, unknown> }[] = [];
  const bridge = {
    ide: async (op: string, args: Record<string, unknown>) => {
      ideCalls.push({ op, args });
      return null;
    },
    notify: () => undefined,
    postToWebview: () => undefined,
  } as unknown as Bridge;
  const vs = createVscode({
    bridge,
    workspaceRoot: root,
    configuration: new Configuration(new JsonFile(join(root, ".settings.json")), []),
    documents: new Documents(),
    extensionId: "test.ext",
    extensionPath: root,
    packageJSON: {},
    appRoot: root,
    machineId: "m",
    language: "en",
    importsDir: join(root, ".imports"),
    dialog: (async () => null) as never,
  });
  const api = vs.api as Record<string, any>;
  return { root, api, vs, ideCalls };
}

test("Zoo's diff flow: the file editor becomes visible, edits stay in memory until saved", async () => {
  const { root, api, ideCalls } = setup();
  const file = join(root, "a.txt");
  writeFileSync(file, "old\n");
  const uri = URI.file(file);

  // As DiffViewProvider.openDiffEditor: wait for the file among the visible editors.
  const visible = new Promise<any>((resolve) =>
    api.window.onDidChangeVisibleTextEditors((eds: any[]) => {
      const ed = eds.find((e) => e.document.uri.fsPath === uri.fsPath);
      if (ed) resolve(ed);
    }),
  );
  await api.window.showTextDocument(uri, { preview: false, preserveFocus: true });
  const original = URI.parse("zoo-diff:a.txt").with({ query: Buffer.from("old\n").toString("base64") });
  await api.commands.executeCommand("vscode.diff", original, uri, "a.txt: Original ↔ Zoo Code's Changes (Editable)");
  const editor = await visible;
  assert.ok(api.window.tabGroups.all[0].tabs.some((t: any) => t.input instanceof T.TabInputTextDiff));

  // Streamed content: in memory, dirty, not on disk.
  const doc = editor.document;
  const edit = new T.WorkspaceEdit();
  edit.replace(uri, new T.Range(0, 0, doc.lineCount, 0), "new\ncontent\n");
  assert.equal(await api.workspace.applyEdit(edit), true);
  assert.equal(doc.getText(), "new\ncontent\n");
  assert.equal(doc.isDirty, true);
  assert.equal(readFileSync(file, "utf8"), "old\n");

  // The IDE gets the proposal as a diff once the stream pauses.
  await new Promise((r) => setTimeout(r, 1500));
  const diff = ideCalls.find((c) => c.op === "openFileDiff");
  assert.ok(diff, JSON.stringify(ideCalls));
  assert.equal(diff.args.left, "old\n");
  assert.equal(diff.args.right, "new\ncontent\n");

  // Approve: save writes the file; closing the diff tabs hides the editor.
  await doc.save();
  assert.equal(readFileSync(file, "utf8"), "new\ncontent\n");
  assert.equal(doc.isDirty, false);
  const diffTabs = api.window.tabGroups.all.flatMap((g: any) => g.tabs).filter((t: any) => t.input instanceof T.TabInputTextDiff);
  await api.window.tabGroups.close(diffTabs);
  assert.ok(!api.window.tabGroups.all[0].tabs.some((t: any) => t.input instanceof T.TabInputTextDiff));
});

test("a new file's diff has no left side", async () => {
  const { root, api, ideCalls } = setup();
  const uri = URI.file(join(root, "new.txt"));
  await api.commands.executeCommand("vscode.diff", URI.parse("zoo-diff:new.txt").with({ query: "" }), uri, "new.txt: New File");
  const edit = new T.WorkspaceEdit();
  edit.insert(uri, new T.Position(0, 0), "hello");
  await api.workspace.applyEdit(edit);
  await new Promise((r) => setTimeout(r, 1500));
  const diff = ideCalls.filter((c) => c.op === "openFileDiff").pop();
  assert.equal(diff?.args.left, null);
  assert.equal(diff?.args.right, "hello");
  assert.equal(existsSync(uri.fsPath), false, "not written before save");
});

// Review of PR l0ng-ai/openidea-plugins#294: editor commands (Add to Context,
// Explain/Fix/Improve) must see the editor's text, not the file on disk.
test("editor commands see unsaved editor text, without saving it", () => {
  const { root, api, vs } = setup();
  const file = join(root, "code.ts");
  writeFileSync(file, "let x = old_value;\n");
  vs.setActiveEditor(file, [0, 8, 0, 17], "let x = new_value;\n");
  const ed = api.window.activeTextEditor;
  assert.equal(ed.document.getText(ed.selection), "new_value");
  assert.equal(ed.document.isDirty, true);
  assert.equal(readFileSync(file, "utf8"), "let x = old_value;\n", "unsaved changes stay unsaved");
});

test("editor commands see content that exists only in the editor (empty file on disk)", () => {
  const { root, api, vs } = setup();
  const file = join(root, "empty.ts");
  writeFileSync(file, "");
  vs.setActiveEditor(file, [0, 0, 0, 9], "new_value\n");
  const ed = api.window.activeTextEditor;
  assert.equal(ed.document.getText(ed.selection), "new_value");
  assert.equal(ed.document.isDirty, true);
  assert.equal(readFileSync(file, "utf8"), "");
});

test("a saved file's editor text leaves the document clean", () => {
  const { root, api, vs } = setup();
  const file = join(root, "saved.ts");
  writeFileSync(file, "let x = new_value;\n");
  vs.setActiveEditor(file, [0, 8, 0, 17], "let x = new_value;\n");
  const ed = api.window.activeTextEditor;
  assert.equal(ed.document.getText(ed.selection), "new_value");
  assert.equal(ed.document.isDirty, false);
});

test("diagnostics come from the IDE snapshot", () => {
  const { root, api, vs } = setup();
  const file = join(root, "B.java");
  let fired = 0;
  api.languages.onDidChangeDiagnostics(() => fired++);
  vs.setProblems({ [file]: [{ range: [2, 4, 2, 9], severity: 0, message: "cannot find symbol", source: "javac" }] });
  const diags = api.languages.getDiagnostics(URI.file(file));
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, T.DiagnosticSeverity.Error);
  assert.equal(diags[0].range.start.line, 2);
  assert.equal(diags[0].source, "javac");
  assert.equal(api.languages.getDiagnostics().length, 1);
  vs.setProblems({});
  assert.equal(api.languages.getDiagnostics(URI.file(file)).length, 0);
  assert.equal(fired, 2);
});
