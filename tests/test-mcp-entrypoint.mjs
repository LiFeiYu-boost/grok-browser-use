import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PLUGIN_ROOT } from "../lib/paths.mjs";

test("initialize works through the documented symlink installation without launching Chrome", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbu-entry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const alias = path.join(dir, "plugin");
  fs.symlinkSync(PLUGIN_ROOT, alias);
  const result = spawnSync(process.execPath, [path.join(alias, "mcp/server.mjs")], {
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } }) + "\n",
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const initialized = JSON.parse(result.stdout.trim());
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.serverInfo.name, "grok-browser-use");
  assert.equal(initialized.result.serverInfo.version, "0.6.11");
});
