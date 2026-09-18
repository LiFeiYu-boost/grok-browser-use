import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { withTimeout } from "./broker.mjs";
import { mcpSessionId } from "./session-id.mjs";
import {
  AUDIT_LOG_PATH,
  DAILY_SOCKET_PATH,
  DAEMON_LOG_PATH,
  HOST_SCRIPT,
  NODE_BIN,
  PLUGIN_ROOT,
  ensureRunDir,
  writeRuntimeConfig,
  linkDailyBrokerAlias,
} from "./paths.mjs";
import { installNativeHostManifest } from "./install-host-manifest.mjs";

export class BrokerClient {
  constructor({ socketPath } = {}) {
    this.socketPath = socketPath || DAILY_SOCKET_PATH;
    this.sock = null;
    this.extensionReady = false;
    this.pending = new Map();
    this.nextId = 1;
    this.audit = [];
    this.hubPid = null;
    this._ready = null;
    this._readyResolve = null;
    this._helloResolve = null;
    this._resetReady();
  }

  get active() {
    return this.extensionReady && this.sock && !this.sock.destroyed;
  }

  _resetReady() {
    this.extensionReady = false;
    this._ready = new Promise((resolve) => {
      this._readyResolve = resolve;
    });
  }

  waitReady(timeoutMs = 20000) {
    if (this.active) return Promise.resolve({ type: "ready" });
    return withTimeout(this._ready, timeoutMs, "extension native port did not connect");
  }

  async connect({ timeoutMs = 1500 } = {}) {
    const sock = await connectUnix(this.socketPath, timeoutMs);
    this.sock = sock;
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        this._onMessage(msg);
      }
    });
    sock.on("close", () => {
      this.extensionReady = false;
      if (this.sock === sock) this.sock = null;
      for (const [, p] of this.pending) p.reject(new Error("broker socket closed"));
      this.pending.clear();
    });
    sock.on("error", () => {});
    const hello = await this._hello(timeoutMs);
    this.hubPid = hello.pid || null;
    if (hello.extensionReady) {
      this.extensionReady = true;
      if (this._readyResolve) {
        this._readyResolve(hello);
        this._readyResolve = null;
      }
    }
    return hello;
  }

  _hello(timeoutMs) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this._helloResolve = null;
        reject(new Error("legacy broker (no mcp-hello-ok)"));
      }, timeoutMs);
      this._helloResolve = (msg) => {
        clearTimeout(t);
        this._helloResolve = null;
        resolve(msg);
      };
      try {
        this.sock.write(
          JSON.stringify({
            type: "mcp-hello",
            pid: process.pid,
            version: "0.6.9",
            sessionId: mcpSessionId(),
          }) + "\n"
        );
      } catch (err) {
        clearTimeout(t);
        this._helloResolve = null;
        reject(err);
      }
    });
  }

  _onMessage(msg) {
    if (msg.type === "mcp-hello-ok") {
      this._helloResolve?.(msg);
      return;
    }
    if (msg.type === "ready") {
      this.extensionReady = true;
      if (this._readyResolve) {
        this._readyResolve(msg);
        this._readyResolve = null;
      }
      return;
    }
    if (msg.type === "extension-gone") {
      this._resetReady();
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }

  async request(method, params = {}, timeoutMs = 20000) {
    if (!this.sock || this.sock.destroyed) {
      throw new Error("extension is not connected");
    }
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      this.sock.write(JSON.stringify({ id, method, params }) + "\n");
    } catch (err) {
      this.pending.delete(id);
      throw err;
    }
    return await withTimeout(p, timeoutMs, `request timeout: ${method}`);
  }

  close() {
    for (const [, p] of this.pending) {
      p.reject(new Error("broker closed"));
    }
    this.pending.clear();
    try {
      this.sock?.end();
    } catch {
      // ignore
    }
    this.sock = null;
    this.extensionReady = false;
  }

  recordAudit(kind, detail) {
    const entry = { ts: new Date().toISOString(), kind, detail };
    this.audit.push(entry);
    try {
      fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");
    } catch {
      // ignore
    }
  }
}

function connectUnix(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    const t = setTimeout(() => {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      reject(new Error("connect timeout: " + socketPath));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(t);
      resolve(sock);
    });
    sock.once("error", (err) => {
      clearTimeout(t);
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      reject(err);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function spawnBrokerDaemon({ socketPath = DAILY_SOCKET_PATH } = {}) {
  ensureRunDir();
  const daemonJs = path.join(PLUGIN_ROOT, "host", "broker-daemon.mjs");
  const out = fs.openSync(DAEMON_LOG_PATH, "a");
  const child = spawn(NODE_BIN, [daemonJs], {
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      GROK_BROWSER_DAILY_SOCKET: socketPath,
    },
    cwd: PLUGIN_ROOT,
  });
  child.unref();
  try {
    fs.closeSync(out);
  } catch {
    // ignore
  }
  return child.pid;
}

export function restartDailyNativeHost() {
  let out = "";
  try {
    out = execFileSync("pgrep", ["-f", HOST_SCRIPT], { encoding: "utf8" });
  } catch {
    return { killed: [] };
  }
  const killed = [];
  for (const line of out.trim().split(/\s+/)) {
    const pid = Number(line.trim());
    if (!pid || pid === process.pid) continue;
    let skip = false;
    try {
      const lsof = execFileSync("lsof", ["-p", String(pid), "-Fn"], { encoding: "utf8" });
      if (/cft-\d+\.sock/.test(lsof)) skip = true;
    } catch {
      // ignore
    }
    if (skip) continue;
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      // ignore
    }
  }
  return { killed };
}

export async function ensureDailyBroker({
  socketPath = DAILY_SOCKET_PATH,
  installHost = true,
  nudgeNativeHost = true,
} = {}) {
  ensureRunDir();
  if (installHost) {
    writeRuntimeConfig({ socketPath, mode: "daily", target: "daily" });
    installNativeHostManifest(null, { dailyChrome: true });
    try {
      linkDailyBrokerAlias();
    } catch {
      // ignore
    }
  }

  const tryClient = async () => {
    const client = new BrokerClient({ socketPath });
    try {
      await client.connect({ timeoutMs: 800 });
      return client;
    } catch {
      try {
        client.close();
      } catch {
        // ignore
      }
      return null;
    }
  };

  let client = await tryClient();
  if (client) {
    if (nudgeNativeHost && installHost && !client.extensionReady) {
      restartDailyNativeHost();
    }
    return client;
  }

  spawnBrokerDaemon({ socketPath });

  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    client = await tryClient();
    if (client) {
      if (nudgeNativeHost && installHost && !client.extensionReady) {
        restartDailyNativeHost();
      }
      return client;
    }
    await sleep(80);
  }
  throw new Error("daily broker daemon did not become ready at " + socketPath);
}
