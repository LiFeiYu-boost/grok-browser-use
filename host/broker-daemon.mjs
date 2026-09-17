#!/usr/bin/env node
import fs from "node:fs";
import { Broker } from "../lib/broker.mjs";
import {
  DAILY_SOCKET_PATH,
  DAEMON_LOG_PATH,
  DAEMON_PID_PATH,
  DEFAULT_DAILY_SOCKET_PATH,
  ensureRunDir,
  writeRuntimeConfig,
} from "../lib/paths.mjs";

function log(line) {
  const rec = { ts: new Date().toISOString(), pid: process.pid, ...line };
  const text = JSON.stringify(rec) + "\n";
  try {
    fs.appendFileSync(DAEMON_LOG_PATH, text);
  } catch {
    // ignore
  }
  try {
    process.stderr.write(text);
  } catch {
    // ignore
  }
}

async function main() {
  ensureRunDir();
  const socketPath = process.env.GROK_BROWSER_DAILY_SOCKET || DAILY_SOCKET_PATH;
  const manageHost = socketPath === DEFAULT_DAILY_SOCKET_PATH;
  if (manageHost) {
    writeRuntimeConfig({ socketPath, mode: "daily", target: "daily", daemon: true });
  }
  const broker = new Broker({ socketPath });
  try {
    await broker.start({ reuse: true });
  } catch (err) {
    if (err && err.code === "BROKER_RUNNING") {
      log({ event: "already-running", socketPath });
      process.exit(0);
    }
    throw err;
  }
  if (manageHost) {
    fs.writeFileSync(DAEMON_PID_PATH, String(process.pid));
  }
  log({ event: "listen", socketPath, manageHost });

  const shutdown = () => {
    log({ event: "shutdown" });
    try {
      broker.close();
    } catch {
      // ignore
    }
    try {
      const cur = fs.readFileSync(DAEMON_PID_PATH, "utf8").trim();
      if (cur === String(process.pid)) fs.unlinkSync(DAEMON_PID_PATH);
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log({ event: "fatal", error: String(err && err.message ? err.message : err), stack: err.stack });
  process.exit(1);
});
