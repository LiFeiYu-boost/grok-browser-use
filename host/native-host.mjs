import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { encodeNativeMessage, createNativeDecoder } from "../lib/native-framing.mjs";

const pluginRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const configPath = path.join(pluginRoot, "run", "config.json");
const fallbackLog = path.join(pluginRoot, "run", "native-host.log");

function log(line) {
  let logPath = fallbackLog;
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (cfg.hostLogPath) logPath = cfg.hostLogPath;
    }
  } catch {
    // ignore
  }
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...line }) + "\n"
    );
  } catch {
    // ignore
  }
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error(`missing runtime config: ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function connectSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    sock.setEncoding("utf8");
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

async function main() {
  const config = loadConfig();
  log({ event: "start", socketPath: config.socketPath, ppid: process.ppid });
  const sock = await connectSocket(config.socketPath);
  log({ event: "socket-connected" });

  let socketBuf = "";
  process.stdout.on("error", (err) => {
    log({ event: "stdout-error", error: String(err) });
  });
  const sendToChrome = (obj) => {
    if (process.stdout.destroyed) return;
    const ok = process.stdout.write(encodeNativeMessage(obj));
    if (!ok) log({ event: "stdout-backpressure" });
  };

  sock.on("data", (chunk) => {
    socketBuf += chunk;
    let idx;
    while ((idx = socketBuf.indexOf("\n")) !== -1) {
      const line = socketBuf.slice(0, idx).trim();
      socketBuf = socketBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        log({ event: "bad-socket-json", line, error: String(err) });
        continue;
      }
      sendToChrome(msg);
    }
  });

  sock.on("error", (err) => {
    log({ event: "socket-error", error: String(err) });
    process.exit(1);
  });
  sock.on("close", () => {
    log({ event: "socket-close" });
    process.exit(0);
  });

  const onNative = createNativeDecoder((msg) => {
    log({ event: "from-extension", method: msg.method || msg.type, id: msg.id });
    sock.write(JSON.stringify(msg) + "\n");
  });

  process.stdin.on("data", (chunk) => {
    try {
      onNative(chunk);
    } catch (err) {
      log({ event: "decode-error", error: String(err) });
      process.exit(1);
    }
  });
  process.stdin.on("end", () => {
    log({ event: "stdin-end" });
    sock.end();
  });
}

main().catch((err) => {
  log({ event: "fatal", error: String(err), stack: err.stack, home: os.homedir() });
  process.exit(1);
});
