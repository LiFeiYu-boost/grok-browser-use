import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { restoreDailyNativeHost } from "../lib/install-host-manifest.mjs";
import { BrowserControlServer } from "../mcp/server.mjs";
import { PID_PATH } from "../lib/paths.mjs";

test("CfT shutdown without a paused daily host performs no manifest writes", (t) => {
  const writes = [];
  // Even when run against the old implementation, this test cannot overwrite
  // the user's native-host manifest.
  t.mock.method(fs, "writeFileSync", (file) => writes.push(file));
  t.mock.method(fs, "mkdirSync", () => {});
  t.mock.method(fs, "chmodSync", () => {});
  restoreDailyNativeHost(null);
  restoreDailyNativeHost([]);
  assert.deepEqual(writes, []);
});

test("an MCP shutdown kills only its own CfT, even if another instance published the PID file", async (t) => {
  const signals = [];
  t.mock.method(process, "kill", (pid, signal) => {
    if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    signals.push({ pid, signal });
  });
  const exists = fs.existsSync, read = fs.readFileSync;
  t.mock.method(fs, "existsSync", (file) => file === PID_PATH || exists(file));
  t.mock.method(fs, "readFileSync", (file, ...args) => file === PID_PATH
    ? JSON.stringify({ pid: 42002, binary: "Chrome for Testing" }) : read(file, ...args));
  t.mock.method(fs, "unlinkSync", () => {});
  const server = new BrowserControlServer();
  server.mode = "headless";
  server.launched = { pid: 42001 };
  await server.shutdown();
  assert.deepEqual(signals, [{ pid: -42001, signal: "SIGTERM" }]);
});
