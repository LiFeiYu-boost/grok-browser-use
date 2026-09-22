import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeLspMessage, createLspDecoder } from "./native-framing.mjs";
import { NODE_BIN, PLUGIN_ROOT } from "./paths.mjs";

const serverPath = path.join(PLUGIN_ROOT, "mcp", "server.mjs");

export function startMcpServer(extraEnv = {}) {
  const child = spawn(NODE_BIN, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GROK_BROWSER_TARGET: extraEnv.GROK_BROWSER_TARGET || "cft",
      ...extraEnv,
    },
  });
  let nextId = 1;
  const pending = new Map();
  const stderr = [];

  child.stderr.on("data", (d) => {
    stderr.push(d.toString());
  });

  const decode = createLspDecoder((msg) => {
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });
  child.stdout.on("data", decode);

  function request(method, params) {
    const id = nextId++;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`mcp timeout: ${method}`));
        }
      }, 40000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    child.stdin.write(encodeLspMessage({ jsonrpc: "2.0", id, method, params }));
    return p;
  }

  function notify(method, params) {
    child.stdin.write(
      encodeLspMessage({ jsonrpc: "2.0", method, params })
    );
  }

  async function callTool(name, args) {
    const result = await request("tools/call", { name, arguments: args });
    const text = result.content && result.content[0] && result.content[0].text;
    if (result.isError) throw new Error(text || "tool error");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async function close() {
    for (const request of pending.values()) request.reject(new Error("MCP client closed"));
    pending.clear();
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  return { child, request, notify, callTool, close, stderr };
}

void fileURLToPath;
