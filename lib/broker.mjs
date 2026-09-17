import fs from "node:fs";
import net from "node:net";
import { SOCKET_PATH, AUDIT_LOG_PATH, ensureRunDir } from "./paths.mjs";

export class Broker {
  constructor({ socketPath } = {}) {
    this.socketPath = socketPath || SOCKET_PATH;
    this.server = null;
    this.clients = new Set();
    this.mcpClients = new Set();
    this.active = null;
    this.pending = new Map();
    this.ready = null;
    this.readyResolve = null;
    this.buffers = new WeakMap();
    this.roles = new WeakMap();
    this.nextId = 1;
    this.audit = [];
    this.sessionBySock = new WeakMap();
    this.tabTails = new Map();
    this._resetReady();
  }

  _resetReady() {
    this.ready = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  start({ reuse = false } = {}) {
    ensureRunDir();
    if (!reuse) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }
    return this._listenExclusive(reuse);
  }

  async _listenExclusive(reuse) {
    try {
      await this._listen();
      return;
    } catch (err) {
      if (!reuse || err.code !== "EADDRINUSE") {
        try {
          fs.unlinkSync(this.socketPath);
        } catch {
          // ignore
        }
        await this._listen();
        return;
      }
    }
    if (await canConnect(this.socketPath)) {
      const e = new Error("broker already running");
      e.code = "BROKER_RUNNING";
      throw e;
    }
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // ignore
    }
    await this._listen();
  }

  _listen() {
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // ignore
      }
      this.server = null;
    }
    this.server = net.createServer((sock) => this._onConnection(sock));
    return new Promise((resolve, reject) => {
      const onErr = (err) => {
        this.server.removeListener("error", onErr);
        reject(err);
      };
      this.server.once("error", onErr);
      this.server.listen(this.socketPath, () => {
        this.server.removeListener("error", onErr);
        resolve();
      });
    });
  }

  _onConnection(sock) {
    this.clients.add(sock);
    this.buffers.set(sock, "");
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => this._onData(sock, chunk));
    const drop = () => this._drop(sock);
    sock.on("close", drop);
    sock.on("error", drop);
  }

  _drop(sock) {
    this.clients.delete(sock);
    this.mcpClients.delete(sock);
    if (this.active === sock) {
      this.active = null;
      this._resetReady();
      this._broadcastMcp({ type: "extension-gone" });
    }
  }

  close() {
    for (const [, p] of this.pending) {
      if (p.reject) p.reject(new Error("broker closed"));
      else if (p.sock) {
        try {
          p.sock.write(JSON.stringify({ id: p.clientId, error: "broker closed" }) + "\n");
        } catch {
          // ignore
        }
      }
    }
    this.pending.clear();
    for (const sock of this.clients) {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.mcpClients.clear();
    this.active = null;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // ignore
    }
  }

  waitReady(timeoutMs = 20000) {
    if (this.active && !this.active.destroyed) {
      return Promise.resolve({ type: "ready" });
    }
    return withTimeout(this.ready, timeoutMs, "extension native port did not connect");
  }

  async request(method, params = {}, timeoutMs = 20000) {
    const run = () => this._requestNow(method, params, timeoutMs);
    const tabId = params && params.tabId;
    if (isTabWrite(method) && tabId != null) {
      return this._enqueueTab(tabId, run);
    }
    return run();
  }

  _requestNow(method, params, timeoutMs) {
    const sock = this.active;
    if (!sock || sock.destroyed) {
      return Promise.reject(new Error("extension is not connected"));
    }
    const id = this.nextId++;
    const msg = { id, method, params };
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      sock.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      this.pending.delete(id);
      return Promise.reject(err);
    }
    return withTimeout(p, timeoutMs, `request timeout: ${method}`);
  }

  _enqueueTab(tabId, run) {
    const prev = this.tabTails.get(tabId) || Promise.resolve();
    const next = prev.then(run, run);
    this.tabTails.set(
      tabId,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  _onData(sock, chunk) {
    const prev = this.buffers.get(sock) || "";
    let buf = prev + chunk;
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
      this._onMessage(sock, msg);
    }
    this.buffers.set(sock, buf);
  }

  _onMessage(sock, msg) {
    if (msg.type === "mcp-hello") {
      this.roles.set(sock, "mcp");
      this.mcpClients.add(sock);
      this.sessionBySock.set(sock, msg.sessionId || "local");
      this._send(sock, {
        type: "mcp-hello-ok",
        extensionReady: Boolean(this.active && !this.active.destroyed),
        pid: process.pid,
        version: "0.6.7",
        sessionId: msg.sessionId || "local",
      });
      return;
    }
    if (msg.type === "ready") {
      this.roles.set(sock, "extension");
      this.active = sock;
      if (this.readyResolve) {
        this.readyResolve(msg);
        this.readyResolve = null;
      }
      this._broadcastMcp({ type: "ready", extensionId: msg.extensionId, ts: msg.ts });
      return;
    }
    if (this.mcpClients.has(sock) && msg.method && msg.id != null) {
      this._forwardFromMcp(sock, msg);
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (p.done) p.done();
      if (p.sock) {
        this._send(p.sock, { id: p.clientId, result: msg.result, error: msg.error });
        return;
      }
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  }

  _forwardFromMcp(sock, msg) {
    const params = { ...(msg.params || {}) };
    if (params.sessionId == null) {
      params.sessionId = this.sessionBySock.get(sock) || "local";
    }
    const run = () => {
      if (!this.active || this.active.destroyed) {
        this._send(sock, { id: msg.id, error: "extension is not connected" });
        return Promise.resolve();
      }
      const hubId = this.nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (this.pending.has(hubId)) {
            this.pending.delete(hubId);
            this._send(sock, { id: msg.id, error: `request timeout: ${msg.method}` });
          }
          resolve();
        }, 20000);
        this.pending.set(hubId, {
          sock,
          clientId: msg.id,
          done: () => {
            clearTimeout(timer);
            resolve();
          },
        });
        this._send(this.active, { id: hubId, method: msg.method, params });
      });
    };
    const tabId = params.tabId;
    if (isTabWrite(msg.method) && tabId != null) {
      this._enqueueTab(tabId, run);
      return;
    }
    run();
  }

  _broadcastMcp(msg) {
    for (const sock of this.mcpClients) {
      this._send(sock, msg);
    }
  }

  _send(sock, msg) {
    if (!sock || sock.destroyed) return;
    try {
      sock.write(JSON.stringify(msg) + "\n");
    } catch {
      // ignore
    }
  }

  recordAudit(kind, detail) {
    const entry = { ts: new Date().toISOString(), kind, detail };
    this.audit.push(entry);
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");
  }
}

const TAB_WRITES = new Set([
  "tabs.close",
  "tabs.click",
  "tabs.domClick",
  "tabs.fill",
  "tabs.press",
  "tabs.hover",
  "tabs.scroll",
  "tabs.selectOption",
  "tabs.evaluate",
  "tabs.pageInfo",
  "tabs.fetchJson",
  "tabs.screenshot",
  "tabs.hasPointer",
  "tabs.wait",
  "tabs.performance",
  "tabs.css",
  "diagnostics.console",
  "diagnostics.network",
  "diagnostics.consoleGet",
  "diagnostics.networkGet",
]);

function isTabWrite(method) {
  return TAB_WRITES.has(method);
}

export function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export function canConnect(socketPath, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const done = (ok) => {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    sock.once("connect", () => {
      clearTimeout(t);
      done(true);
    });
    sock.once("error", () => {
      clearTimeout(t);
      done(false);
    });
  });
}
