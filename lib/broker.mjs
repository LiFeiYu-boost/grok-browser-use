import fs from "node:fs";
import net from "node:net";
import { SOCKET_PATH, AUDIT_LOG_PATH, ensureRunDir } from "./paths.mjs";

export class Broker {
  constructor() {
    this.server = null;
    this.clients = new Set();
    this.active = null;
    this.pending = new Map();
    this.ready = null;
    this.readyResolve = null;
    this.buffers = new WeakMap();
    this.nextId = 1;
    this.audit = [];
    this._resetReady();
  }

  _resetReady() {
    this.ready = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  start() {
    ensureRunDir();
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // ignore
    }
    this.server = net.createServer((sock) => {
      this.clients.add(sock);
      this.buffers.set(sock, "");
      sock.setEncoding("utf8");
      sock.on("data", (chunk) => this._onData(sock, chunk));
      const drop = () => {
        this.clients.delete(sock);
        if (this.active === sock) {
          this.active = [...this.clients][this.clients.size - 1] || null;
        }
      };
      sock.on("close", drop);
      sock.on("error", drop);
    });
    return new Promise((resolve, reject) => {
      this.server.listen(SOCKET_PATH, () => resolve());
      this.server.on("error", reject);
    });
  }

  close() {
    for (const [, p] of this.pending) {
      p.reject(new Error("broker closed"));
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
    this.active = null;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // ignore
    }
  }

  waitReady(timeoutMs = 20000) {
    return withTimeout(this.ready, timeoutMs, "extension native port did not connect");
  }

  async request(method, params = {}, timeoutMs = 20000) {
    const sock = this.active;
    if (!sock || sock.destroyed) {
      throw new Error("extension is not connected");
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
      throw err;
    }
    return await withTimeout(p, timeoutMs, `request timeout: ${method}`);
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
    if (msg.type === "ready") {
      this.active = sock;
      if (this.readyResolve) {
        this.readyResolve(msg);
        this.readyResolve = null;
      }
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  }

  recordAudit(kind, detail) {
    const entry = { ts: new Date().toISOString(), kind, detail };
    this.audit.push(entry);
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n");
  }
}

function withTimeout(promise, ms, message) {
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
