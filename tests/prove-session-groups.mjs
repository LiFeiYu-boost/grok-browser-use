import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ensureDailyBroker } from "../lib/broker-client.mjs";
import { startMcpServer } from "../lib/mcp-client.mjs";
import { sessionGroupTitle } from "../lib/session-id.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withFakeExtension(socketPath) {
  let nextId = 1;
  const tabs = [];
  const sock = await new Promise((resolve, reject) => {
    const c = net.connect(socketPath);
    c.once("connect", () => resolve(c));
    c.once("error", reject);
  });
  sock.setEncoding("utf8");
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const sessionId = (msg.params && msg.params.sessionId) || "local";
      const own = sessionGroupTitle(sessionId);
      if (msg.method === "tabs.create") {
        const tab = {
          tabId: nextId++,
          sessionId,
          tabGroup: own,
          url: msg.params.url,
        };
        tabs.push(tab);
        sock.write(JSON.stringify({ id: msg.id, result: tab }) + "\n");
        continue;
      }
      if (msg.method === "tabs.list") {
        const scope = msg.params && msg.params.scope;
        const rows = tabs.filter((t) => scope === "all" || t.tabGroup === own);
        sock.write(JSON.stringify({ id: msg.id, result: rows }) + "\n");
        continue;
      }
      if (msg.method === "tabs.click" || msg.method === "tabs.close") {
        const tab = tabs.find((t) => t.tabId === (msg.params && msg.params.tabId));
        if (!tab) {
          sock.write(JSON.stringify({ id: msg.id, error: "missing tab" }) + "\n");
          continue;
        }
        if (tab.tabGroup !== own) {
          sock.write(
            JSON.stringify({
              id: msg.id,
              error: `tab ${tab.tabId} belongs to "${tab.tabGroup}", not this session's "${own}"`,
            }) + "\n"
          );
          continue;
        }
        sock.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\n");
        continue;
      }
      sock.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\n");
    }
  });
  sock.write(JSON.stringify({ type: "ready", extensionId: "test", ts: Date.now() }) + "\n");
  return sock;
}

async function startSession(env) {
  const mcp = startMcpServer(env);
  await mcp.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "prove-session-groups", version: "0.6.7" },
  });
  mcp.notify("notifications/initialized");
  await sleep(400);
  return mcp;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbu-session-"));
  const socketPath = path.join(dir, "daily.sock");
  const prev = process.env.GROK_BROWSER_DAILY_SOCKET;
  process.env.GROK_BROWSER_DAILY_SOCKET = socketPath;
  let ext;
  let a;
  let b;
  let hubPid = 0;
  try {
    const client0 = await ensureDailyBroker({
      socketPath,
      installHost: false,
      nudgeNativeHost: false,
    });
    hubPid = client0.hubPid || 0;
    ext = await withFakeExtension(socketPath);
    await client0.waitReady(3000);
    client0.close();

    const base = {
      GROK_BROWSER_DAILY_SOCKET: socketPath,
      GROK_BROWSER_TARGET: "daily",
    };
    a = await startSession({ ...base, GROK_SESSION_ID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1" });
    b = await startSession({ ...base, GROK_SESSION_ID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2" });

    const sa = await a.callTool("status");
    const sb = await b.callTool("status");
    assert.equal(sa.tabGroup, sessionGroupTitle("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"));
    assert.equal(sb.tabGroup, sessionGroupTitle("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2"));
    assert.notEqual(sa.tabGroup, sb.tabGroup);

    const ta = await a.callTool("new_tab", { url: "https://example.com/a", wait: false });
    const tb = await b.callTool("new_tab", { url: "https://example.com/b", wait: false });
    assert.equal(ta.tabGroup, sa.tabGroup);
    assert.equal(tb.tabGroup, sb.tabGroup);

    const listA = await a.callTool("list_tabs");
    const listB = await b.callTool("list_tabs");
    assert.equal(listA.scope, "session");
    assert.ok(listA.tabs.some((t) => t.tabId === ta.tabId));
    assert.ok(!listA.tabs.some((t) => t.tabId === tb.tabId));
    assert.ok(listB.tabs.some((t) => t.tabId === tb.tabId));
    assert.ok(!listB.tabs.some((t) => t.tabId === ta.tabId));

    const allA = await a.callTool("list_tabs", { scope: "all" });
    assert.ok(allA.tabs.some((t) => t.tabId === tb.tabId));

    await assert.rejects(
      () => a.callTool("click", { tabId: tb.tabId, uid: "x" }),
      /belongs to/
    );

    await a.close();
    a = null;
    const listB2 = await b.callTool("list_tabs");
    assert.ok(listB2.tabs.some((t) => t.tabId === tb.tabId));

    console.log(
      JSON.stringify(
        {
          ok: true,
          groupA: sa.tabGroup,
          groupB: sb.tabGroup,
          tabA: ta.tabId,
          tabB: tb.tabId,
        },
        null,
        2
      )
    );
  } finally {
    try {
      ext?.destroy();
    } catch {
      // ignore
    }
    try {
      await a?.close();
    } catch {
      // ignore
    }
    try {
      await b?.close();
    } catch {
      // ignore
    }
    if (prev == null) delete process.env.GROK_BROWSER_DAILY_SOCKET;
    else process.env.GROK_BROWSER_DAILY_SOCKET = prev;
    try {
      if (hubPid) process.kill(hubPid, "SIGTERM");
    } catch {
      // ignore
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
