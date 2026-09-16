#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Broker } from "../lib/broker.mjs";
import { launchCft, killCftTree, killLaunchedCft } from "../lib/launch-cft.mjs";
import { installNativeHostManifest } from "../lib/install-host-manifest.mjs";
import { encodeLspMessage, createLspDecoder } from "../lib/native-framing.mjs";
import {
  MODE_PATH,
  ARTIFACTS_DIR,
  writeRuntimeConfig,
  EXTENSION_ID,
  ensureRunDir,
} from "../lib/paths.mjs";

const TOOLS = [
  {
    name: "status",
    description: "Browser-control connection status. Does not activate any window.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_tabs",
    description: "List open tabs in the attached Chrome (daily profile or isolated CfT). Does not activate them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "new_tab",
    description:
      "Open a tab in the Grok Browser tab group. Shows a pointer overlay. Defaults to visible so the user can watch.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        show: { type: "boolean", description: "Default true. Set false to keep the tab backgrounded." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "close_tab",
    description: "Close a tab by tabId.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "snapshot",
    description: "Accessibility-ish snapshot with uids for click/fill. Does not activate the tab.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description: "Click an element by snapshot uid. Coordinate clicks and window drags are not available.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" }, uid: { type: "string" } },
      required: ["tabId", "uid"],
      additionalProperties: false,
    },
  },
  {
    name: "fill",
    description: "Fill an input by snapshot uid.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        uid: { type: "string" },
        value: { type: "string" },
      },
      required: ["tabId", "uid", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "press",
    description: "Press a key in the tab (for example Enter).",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" }, key: { type: "string" } },
      required: ["tabId", "key"],
      additionalProperties: false,
    },
  },
  {
    name: "evaluate",
    description: "Run a JS function source in the tab, e.g. () => document.title",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" }, function: { type: "string" } },
      required: ["tabId", "function"],
      additionalProperties: false,
    },
  },
  {
    name: "screenshot",
    description: "PNG screenshot of a tab via CDP. Saves under tests/artifacts if fileName is set.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        fileName: { type: "string" },
      },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "run_parallel",
    description:
      "Run many tab operations at once. Each op is {tabId, op, ...}. op: snapshot|click|fill|press|evaluate|screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        ops: { type: "array", items: { type: "object" } },
      },
      required: ["ops"],
      additionalProperties: false,
    },
  },
  {
    name: "audit_log",
    description: "Return focus/activate/bounds audit entries. Must stay empty in unattended acceptance.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_console_message",
    description: "Get one console message by msgid from list_console_messages / console. Does not open DevTools.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        msgid: { type: "number" },
      },
      required: ["tabId", "msgid"],
      additionalProperties: false,
    },
  },
  {
    name: "get_network_request",
    description:
      "Get one request by reqid including headers and a truncated body (CDP Network.getResponseBody). Does not open DevTools.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        reqid: { type: "number" },
      },
      required: ["tabId", "reqid"],
      additionalProperties: false,
    },
  },
  {
    name: "console",
    description:
      "List console messages for a Grok Browser tab via CDP Runtime (same data chrome-devtools-mcp list_console_messages uses). Background read; does not open the DevTools UI.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        level: { type: "string", description: "log|info|warn|error|debug|all" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "network",
    description:
      "List network requests for a Grok Browser tab via CDP Network (same protocol chrome-devtools-mcp list_network_requests uses). Background read; does not open the DevTools UI.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        failedOnly: { type: "boolean" },
        limit: { type: "number" },
        resourceTypes: {
          type: "array",
          items: { type: "string" },
          description: "document|stylesheet|image|script|xhr|fetch|other|...",
        },
        includePreserved: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "wait_for",
    description:
      "Wait without opening DevTools: network idle, a console pattern, or a selector/uid.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        networkIdle: { type: "boolean" },
        idleMs: { type: "number" },
        consolePattern: { type: "string" },
        selector: { type: "string" },
        uid: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "performance",
    description: "LCP / TTFB / long-task summary from Performance + PerformanceObserver. No Lighthouse UI.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "css_styles",
    description: "Computed styles for a snapshot uid (CSS.getComputedStyleForNode).",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        uid: { type: "string" },
      },
      required: ["tabId", "uid"],
      additionalProperties: false,
    },
  },
];

const FORBIDDEN_KEYS = ["bringToFront", "resize_page", "drag"];

class BrowserControlServer {
  constructor() {
    this.broker = new Broker();
    this.launched = null;
    this.mode = "daily";
    this.started = null;
  }

  async startBrowser() {
    ensureRunDir();
    const target = process.env.GROK_BROWSER_TARGET || "daily";
    this.mode = target === "cft" ? "headless" : "daily";
    writeRuntimeConfig({ mode: this.mode, target });
    installNativeHostManifest(null, { dailyChrome: true });
    await this.broker.start();
    if (this.mode === "daily") {
      const ready = await this.broker.waitReady(20000);
      this.started = {
        ready,
        pid: null,
        mode: this.mode,
        target: "daily",
        note: "attached to daily Google Chrome; will not kill Chrome on shutdown",
      };
      return this.started;
    }
    this.launched = launchCft({
      mode: "headless",
      userDataDir: path.join(ARTIFACTS_DIR, `cft-mcp-${process.pid}`),
    });
    const ready = await this.broker.waitReady(25000);
    this.started = { ready, pid: this.launched.pid, mode: "headless", target: "cft" };
    return this.started;
  }

  async shutdown() {
    try {
      this.broker.close();
    } catch {
      // ignore
    }
    if (this.mode === "daily") {
      this.launched = null;
      return;
    }
    if (this.launched) {
      killCftTree(this.launched.pid);
      this.launched = null;
    }
    try {
      killLaunchedCft();
    } catch {
      // ignore
    }
  }

  async callTool(name, args = {}) {
    if (FORBIDDEN_KEYS.includes(name)) {
      throw new Error(`${name} is not available; window focus/drag is forbidden`);
    }
    if (args.show === true) {
      this.broker.recordAudit("show", { tool: name, args });
    }
    switch (name) {
      case "status":
        return {
          connected: Boolean(this.broker.active),
          mode: this.mode,
          extensionId: EXTENSION_ID,
          pid: this.launched && this.launched.pid,
          started: this.started,
        };
      case "list_tabs":
        return await this.broker.request("tabs.list");
      case "new_tab":
        return await this.broker.request("tabs.create", {
          url: args.url,
          show: args.show !== false,
        });
      case "close_tab":
        return await this.broker.request("tabs.close", { tabId: args.tabId });
      case "snapshot":
        return await this.broker.request("tabs.snapshot", { tabId: args.tabId });
      case "click":
        return await this.broker.request("tabs.click", {
          tabId: args.tabId,
          uid: args.uid,
        });
      case "fill":
        return await this.broker.request("tabs.fill", {
          tabId: args.tabId,
          uid: args.uid,
          value: args.value,
        });
      case "press":
        return await this.broker.request("tabs.press", {
          tabId: args.tabId,
          key: args.key,
        });
      case "evaluate":
        return await this.broker.request("tabs.evaluate", {
          tabId: args.tabId,
          function: args.function,
        });
      case "screenshot":
        return await this.saveScreenshot(args.tabId, args.fileName);
      case "run_parallel":
        return await this.runParallel(args.ops || []);
      case "audit_log": {
        const ext = await this.broker.request("audit.get").catch(() => ({ entries: [] }));
        return { broker: this.broker.audit, extension: ext.entries || [] };
      }
      case "console":
        return await this.broker.request("diagnostics.console", {
          tabId: args.tabId,
          level: args.level,
          limit: args.limit,
        });
      case "network":
        return await this.broker.request("diagnostics.network", {
          tabId: args.tabId,
          failedOnly: args.failedOnly,
          limit: args.limit,
          resourceTypes: args.resourceTypes,
          includePreserved: args.includePreserved,
        });
      case "get_console_message":
        return await this.broker.request("diagnostics.consoleGet", {
          tabId: args.tabId,
          msgid: args.msgid,
        });
      case "get_network_request":
        return await this.broker.request("diagnostics.networkGet", {
          tabId: args.tabId,
          reqid: args.reqid,
        });
      case "wait_for":
        return await this.broker.request("tabs.wait", args);
      case "performance":
        return await this.broker.request("tabs.performance", { tabId: args.tabId });
      case "css_styles":
        return await this.broker.request("tabs.css", {
          tabId: args.tabId,
          uid: args.uid,
        });
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  async saveScreenshot(tabId, fileName) {
    const shot = await this.broker.request("tabs.screenshot", { tabId });
    const name = fileName || `tab-${tabId}.png`;
    const filePath = path.join(ARTIFACTS_DIR, name);
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(shot.pngBase64, "base64"));
    return { filePath, bytes: fs.statSync(filePath).size };
  }

  async runParallel(ops) {
    const results = await Promise.all(
      ops.map(async (op, index) => {
        try {
          const { op: kind, ...rest } = op;
          const value = await this.callTool(kind, rest);
          return { index, ok: true, op: kind, value };
        } catch (err) {
          return {
            index,
            ok: false,
            op: op.op,
            error: String(err && err.message ? err.message : err),
          };
        }
      })
    );
    return { results };
  }
}

function textResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

async function main() {
  const server = new BrowserControlServer();
  let starting = server.startBrowser();

  const write = (msg) => {
    process.stdout.write(encodeLspMessage(msg));
  };

  const handle = async (msg) => {
    if (!msg || msg.method == null) return;
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        write({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "grok-browser-use", version: "0.5.0" },
          },
        });
        return;
      }
      if (method === "notifications/initialized") {
        await starting;
        return;
      }
      if (method === "tools/list") {
        write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        return;
      }
      if (method === "tools/call") {
        await starting;
        const name = params.name;
        const args = params.arguments || {};
        const result = await server.callTool(name, args);
        write({ jsonrpc: "2.0", id, result: textResult(result) });
        return;
      }
      if (method === "ping") {
        write({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (id != null) {
        write({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `method not found: ${method}` },
        });
      }
    } catch (err) {
      if (id != null) {
        write({
          jsonrpc: "2.0",
          id,
          result: errorResult(String(err && err.message ? err.message : err)),
        });
      }
    }
  };

  const decode = createLspDecoder((msg) => {
    handle(msg);
  });
  process.stdin.on("data", decode);
  process.stdin.on("end", async () => {
    await server.shutdown();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    await server.shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await server.shutdown();
    process.exit(0);
  });

  starting = starting.catch((err) => {
    process.stderr.write(`browser start failed: ${err}\n`);
    throw err;
  });
}

main();
