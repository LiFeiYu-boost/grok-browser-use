#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Broker } from "../lib/broker.mjs";
import { launchCft, killCftTree, killLaunchedCft, writeCftHostWrapper } from "../lib/launch-cft.mjs";
import { restoreDailyNativeHost } from "../lib/install-host-manifest.mjs";
import { McpStdio } from "../lib/native-framing.mjs";
import { ensureDailyBroker } from "../lib/broker-client.mjs";
import { mcpSessionId, sessionGroupTitle, withSession } from "../lib/session-id.mjs";
import {
  MODE_PATH,
  ARTIFACTS_DIR,
  RUN_DIR,
  EXTENSION_ID,
  ensureRunDir,
} from "../lib/paths.mjs";

const TOOLS = [
  {
    name: "debugger_detach_all",
    description:
      "Detach chrome.debugger from every tab this extension attached. Use if a TikTok/Partner page went white or SSO login no-ops.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "probes_unregister",
    description:
      "Unregister MAIN-world fetch/XHR probes. They are not injected on tiktok.com / tiktokshop.com.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "status",
    description:
      "grok-browser-use connection status (connected/connecting/disconnected). Does not activate any window. MCP stays up even if the extension is asleep. Includes this Grok session's tab group.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_tabs",
    description:
      "List tabs in this Grok session's tab group (Grok Browser · <id>). Does not activate them. Pass scope=all to see every Grok session group (still not the user's other tabs).",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "session (default) or all Grok Browser groups",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "new_tab",
    description:
      "Open a tab in this Grok session's tab group (Grok Browser · <id>). Shows a pointer overlay. Defaults to visible so the user can watch.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        show: { type: "boolean", description: "Default true. Set false to keep the tab backgrounded." },
        wait: { type: "boolean", description: "Default true. Wait for network idle after load." },
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
    description:
      "Compact a11y snapshot (role/name/destructive/inViewport) with uids, including same-origin iframes. Does not activate the tab.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description:
      "Click a snapshot uid with a real CDP mouse event. Destructive controls (logout/delete) are refused unless confirmDestructive is true. Waits for network idle unless wait is false.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        uid: { type: "string" },
        confirmDestructive: { type: "boolean" },
        wait: { type: "boolean" },
      },
      required: ["tabId", "uid"],
      additionalProperties: false,
    },
  },
  {
    name: "hover",
    description: "Move the pointer onto a snapshot uid (CDP mouseMoved). Does not click.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" }, uid: { type: "string" } },
      required: ["tabId", "uid"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description: "Scroll a uid into view, or scroll the page by dx/dy CSS pixels.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        uid: { type: "string" },
        dx: { type: "number" },
        dy: { type: "number" },
      },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "select_option",
    description: "Choose an option in a <select> by value or visible label.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        uid: { type: "string" },
        value: { type: "string" },
        label: { type: "string" },
      },
      required: ["tabId", "uid"],
      additionalProperties: false,
    },
  },
  {
    name: "fill",
    description: "Fill an input by snapshot uid. Destructive fields need confirmDestructive.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        uid: { type: "string" },
        value: { type: "string" },
        confirmDestructive: { type: "boolean" },
        wait: { type: "boolean" },
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
    description:
      "Run a JS function source in the tab, e.g. () => document.title. Not available on tiktok.com / tiktokshop.com (use page_info / fetch_json).",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" }, function: { type: "string" } },
      required: ["tabId", "function"],
      additionalProperties: false,
    },
  },
  {
    name: "page_info",
    description:
      "DOM-safe page summary without eval or chrome.debugger: href, title, text excerpt, cookie names, /api/ resource URLs.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "fetch_json",
    description:
      "Same-origin fetch() with credentials from the tab, no eval and no debugger. Use on Partner Center / SSO.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        url: { type: "string" },
        method: { type: "string" },
        headers: { type: "object" },
        body: {},
      },
      required: ["tabId", "url"],
      additionalProperties: false,
    },
  },
  {
    name: "screenshot",
    description: "PNG screenshot of a tab via CDP. Waits for network idle unless wait is false. Saves under tests/artifacts if fileName is set.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        fileName: { type: "string" },
        wait: { type: "boolean" },
      },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "run_parallel",
    description:
      "Run many tab operations at once. Each op is {tabId, op, ...}. op: snapshot|click|fill|press|evaluate|screenshot|hover|scroll|select_option.",
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
    this.broker = null;
    this.launched = null;
    this.mode = "daily";
    this.started = null;
    this.pausedDailyHost = null;
    this.sharedDaily = false;
  }

  brokerConnected() {
    if (!this.broker) return false;
    if (typeof this.broker.active === "boolean") return this.broker.active;
    return Boolean(this.broker.active && !this.broker.active.destroyed);
  }

  connectionState() {
    if (this.brokerConnected()) return "connected";
    return this.started && this.started.connecting ? "connecting" : "disconnected";
  }

  sessionMeta() {
    const sessionId = mcpSessionId();
    return { sessionId, tabGroup: sessionGroupTitle(sessionId) };
  }

  req(method, params = {}) {
    return this.broker.request(method, withSession(params));
  }

  async ensureConnected(timeoutMs) {
    if (this.brokerConnected()) return;
    const waitMs = timeoutMs || (this.mode === "daily" ? 45000 : 15000);
    try {
      await this.broker.waitReady(waitMs);
    } catch (err) {
      throw new Error(
        "grok-browser-use is not connected. Open Google Chrome with the unpacked grok-browser-use extension loaded. " +
          String(err && err.message ? err.message : err)
      );
    }
  }

  async startBrowser() {
    ensureRunDir();
    const target = process.env.GROK_BROWSER_TARGET || "daily";
    this.mode = target === "cft" ? "headless" : "daily";
    if (this.mode === "daily") {
      const isolated = Boolean(process.env.GROK_BROWSER_DAILY_SOCKET);
      this.broker = await ensureDailyBroker({
        installHost: !isolated,
        nudgeNativeHost: !isolated,
      });
      this.sharedDaily = true;
    } else {
      const cftSock = path.join(RUN_DIR, `cft-${process.pid}.sock`);
      this.broker = new Broker({ socketPath: cftSock });
      const wrapper = writeCftHostWrapper(cftSock);
      this.launched = launchCft({
        mode: "headless",
        userDataDir: path.join(ARTIFACTS_DIR, `cft-mcp-${process.pid}`),
        hostPath: wrapper,
        socketPath: cftSock,
      });
      await this.broker.start();
    }
    if (this.mode === "daily") {
      this.started = {
        pid: this.broker.hubPid || null,
        mode: this.mode,
        target: "daily",
        connecting: !this.brokerConnected(),
        sharedBroker: true,
        note: "shared daily broker; MCP stays up if the extension is asleep",
      };
      this.broker
        .waitReady(60000)
        .then((ready) => {
          this.started = {
            ready,
            pid: this.broker.hubPid || null,
            mode: this.mode,
            target: "daily",
            connecting: false,
            connected: true,
            sharedBroker: true,
            note: "attached to daily Google Chrome via shared broker; will not kill Chrome on shutdown",
          };
        })
        .catch((err) => {
          this.started = {
            ...this.started,
            connecting: false,
            connected: false,
            error: String(err && err.message ? err.message : err),
          };
        });
      return this.started;
    }
    const ready = await this.broker.waitReady(25000);
    this.started = { ready, pid: this.launched.pid, mode: "headless", target: "cft" };
    return this.started;
  }

  async shutdown() {
    try {
      if (this.broker) this.broker.close();
    } catch {
      // ignore
    }
    this.broker = null;
    if (this.mode === "daily") {
      this.launched = null;
      return;
    }
    try {
      restoreDailyNativeHost(this.pausedDailyHost);
    } catch {
      // restore daily native host after CfT tests
    }
    this.pausedDailyHost = null;
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
    if (name !== "status") {
      await this.ensureConnected();
    }
    switch (name) {
      case "status":
        return {
          connected: this.brokerConnected(),
          connectionState: this.connectionState(),
          mode: this.mode,
          extensionId: EXTENSION_ID,
          pid: this.launched && this.launched.pid,
          hubPid: this.broker && this.broker.hubPid,
          sharedBroker: this.sharedDaily,
          ...this.sessionMeta(),
          started: this.started,
          hint: this.brokerConnected()
            ? undefined
            : "Open Google Chrome with the unpacked grok-browser-use extension. Native host com.xai.grok.browser must be installed.",
        };
      case "debugger_detach_all":
        return await this.req("debugger.detachAll");
      case "probes_unregister":
        return await this.req("probes.unregister");
      case "list_tabs": {
        const rows = await this.req("tabs.list", { scope: args.scope });
        const tabs = Array.isArray(rows) ? rows : (rows && rows.tabs) || [];
        return {
          ...this.sessionMeta(),
          scope: args.scope === "all" ? "all" : "session",
          tabs,
        };
      }
      case "new_tab":
        return await this.req("tabs.create", {
          url: args.url,
          show: args.show !== false,
          wait: args.wait,
        });
      case "close_tab":
        return await this.req("tabs.close", { tabId: args.tabId });
      case "snapshot":
        return await this.req("tabs.snapshot", { tabId: args.tabId });
      case "click":
        return await this.req("tabs.click", {
          tabId: args.tabId,
          uid: args.uid,
          confirmDestructive: args.confirmDestructive,
          wait: args.wait,
        });
      case "hover":
        return await this.req("tabs.hover", {
          tabId: args.tabId,
          uid: args.uid,
        });
      case "scroll":
        return await this.req("tabs.scroll", {
          tabId: args.tabId,
          uid: args.uid,
          dx: args.dx,
          dy: args.dy,
        });
      case "select_option":
        return await this.req("tabs.selectOption", {
          tabId: args.tabId,
          uid: args.uid,
          value: args.value,
          label: args.label,
        });
      case "fill":
        return await this.req("tabs.fill", {
          tabId: args.tabId,
          uid: args.uid,
          value: args.value,
          confirmDestructive: args.confirmDestructive,
          wait: args.wait,
        });
      case "press":
        return await this.req("tabs.press", {
          tabId: args.tabId,
          key: args.key,
        });
      case "evaluate":
        return await this.req("tabs.evaluate", {
          tabId: args.tabId,
          function: args.function,
        });
      case "page_info":
        return await this.req("tabs.pageInfo", { tabId: args.tabId });
      case "fetch_json":
        return await this.req("tabs.fetchJson", {
          tabId: args.tabId,
          url: args.url,
          method: args.method,
          headers: args.headers,
          body: args.body,
        });
      case "screenshot":
        return await this.saveScreenshot(args.tabId, args.fileName, args.wait);
      case "run_parallel":
        return await this.runParallel(args.ops || []);
      case "audit_log": {
        const ext = await this.req("audit.get").catch(() => ({ entries: [] }));
        return { broker: this.broker.audit, extension: ext.entries || [] };
      }
      case "console":
        return await this.req("diagnostics.console", {
          tabId: args.tabId,
          level: args.level,
          limit: args.limit,
        });
      case "network":
        return await this.req("diagnostics.network", {
          tabId: args.tabId,
          failedOnly: args.failedOnly,
          limit: args.limit,
          resourceTypes: args.resourceTypes,
          includePreserved: args.includePreserved,
        });
      case "get_console_message":
        return await this.req("diagnostics.consoleGet", {
          tabId: args.tabId,
          msgid: args.msgid,
        });
      case "get_network_request":
        return await this.req("diagnostics.networkGet", {
          tabId: args.tabId,
          reqid: args.reqid,
        });
      case "wait_for":
        return await this.req("tabs.wait", args);
      case "performance":
        return await this.req("tabs.performance", { tabId: args.tabId });
      case "css_styles":
        return await this.req("tabs.css", {
          tabId: args.tabId,
          uid: args.uid,
        });
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  async saveScreenshot(tabId, fileName, wait) {
    const shot = await this.req("tabs.screenshot", { tabId, wait });
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
  const stdio = new McpStdio();
  let starting = null;

  const write = (msg) => {
    process.stdout.write(stdio.encode(msg));
  };

  const ensureBrowser = () => {
    if (!starting) {
      starting = server.startBrowser().catch((err) => {
        process.stderr.write(`browser start failed: ${err}\n`);
      });
    }
    return starting;
  };

  const handle = async (msg) => {
    if (!msg || (msg.method == null && msg.id == null)) return;
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        write({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: (params && params.protocolVersion) || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "grok-browser-use", version: "0.6.7" },
          },
        });
        return;
      }
      if (method === "notifications/initialized") {
        ensureBrowser();
        return;
      }
      if (method === "tools/list") {
        write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        return;
      }
      if (method === "tools/call") {
        await ensureBrowser();
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

  process.stderr.write(`gbu-mcp pid=${process.pid} stdin ready\n`);
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    try {
      stdio.feed(chunk, (msg) => {
        handle(msg);
      });
    } catch (err) {
      process.stderr.write(`gbu-mcp decode: ${err}\n`);
    }
  });
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
}

main();
