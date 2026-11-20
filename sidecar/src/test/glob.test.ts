import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp } from "../vscode/module.js";

test("watcher globs match files, not their directories", () => {
  const mcp = globToRegExp("**/.roo/mcp.json");
  assert.ok(mcp.test(".roo/mcp.json"));
  assert.ok(mcp.test("sub/dir/.roo/mcp.json"));
  assert.ok(!mcp.test(".roo"), "the .roo directory itself must not match (EISDIR)");
  assert.ok(!mcp.test(".roo/mcp.json.bak"));
  // Zoo's project MCP watcher: RelativePattern(cwd, ".roo/mcp.json"). Any other
  // path reaching it is read as the config ("invalid JSON", "config deleted").
  const project = globToRegExp(".roo/mcp.json");
  assert.ok(project.test(".roo/mcp.json"));
  for (const other of [".roo", "src/Main.java", "pom.xml", "a/.roo/mcp.json"]) assert.ok(!project.test(other), other);
});

test("stars, alternatives and classes", () => {
  assert.ok(globToRegExp("*.{ts,tsx}").test("a.tsx"));
  assert.ok(!globToRegExp("*.{ts,tsx}").test("dir/a.ts"), "* does not cross directories");
  assert.ok(globToRegExp("src/**").test("src/a/b.c"));
  assert.ok(globToRegExp("file?.[jt]s").test("file1.js"));
  assert.ok(!globToRegExp("file?.[jt]s").test("file1.cs"));
  assert.ok(globToRegExp(".roomodes").test(".roomodes"));
  assert.ok(!globToRegExp(".roomodes").test("xroomodes"), "dots are literal");
});
