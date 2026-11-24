import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeZip } from "./zipfixture.js";
import { extractZip, readZipFile, safeRelativePath } from "../zip.js";

test("extracts only the entries under the prefix, with their contents", () => {
  const zip = makeZip([
    { name: "extension.vsixmanifest", data: "<xml/>" },
    { name: "extension/package.json", data: '{"version":"1.2.3"}' },
    { name: "extension/dist/extension.js", data: "module.exports = 1;\n".repeat(100) },
    { name: "extension/dist/", data: "" },
  ]);
  const dest = mkdtempSync(join(tmpdir(), "zoo-zip-out-"));
  assert.equal(extractZip(zip, dest, "extension/"), 2);
  assert.deepEqual(readdirSync(dest).sort(), ["dist", "package.json"]);
  assert.equal(readFileSync(join(dest, "dist", "extension.js"), "utf8"), "module.exports = 1;\n".repeat(100));
  assert.equal(readZipFile(zip, "extension/package.json")?.toString(), '{"version":"1.2.3"}');
  assert.equal(readZipFile(zip, "missing"), undefined);
});

test("rejects entry names that would escape the destination (zip slip)", () => {
  for (const name of ["extension/../evil.js", "extension/a/../../evil.js", "extension//abs.js", "extension/C:/evil.js", "extension/a\\..\\evil.js"]) {
    assert.throws(() => safeRelativePath(name, "extension/"), /unsafe entry name/, name);
    const zip = makeZip([{ name, data: "x" }]);
    const dest = mkdtempSync(join(tmpdir(), "zoo-zip-out-"));
    assert.throws(() => extractZip(zip, dest, "extension/"), /unsafe entry name/, name);
    assert.equal(existsSync(join(dest, "..", "evil.js")), false);
  }
});

test("rejects an entry whose CRC-32 does not match", () => {
  const zip = makeZip([{ name: "extension/a.txt", data: "hello", badCrc: true }]);
  assert.throws(() => extractZip(zip, mkdtempSync(join(tmpdir(), "zoo-zip-out-")), "extension/"), /corrupt entry/);
});

test("rejects a file that is not a ZIP", () => {
  const file = join(mkdtempSync(join(tmpdir(), "zoo-zip-")), "x.vsix");
  writeFileSync(file, "not a zip file at all, just some text that is long enough");
  assert.throws(() => extractZip(file, mkdtempSync(join(tmpdir(), "zoo-zip-out-")), "extension/"), /not a ZIP file/);
});
