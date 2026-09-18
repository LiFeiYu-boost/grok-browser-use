import assert from "node:assert/strict";
import { startFixtureServer } from "./fixtures/server.mjs";
import { startMcpServer } from "../lib/mcp-client.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const fx = await startFixtureServer();
  const mcp = startMcpServer({
    GROK_BROWSER_TARGET: "daily",
    GROK_SESSION_ID: process.env.GROK_SESSION_ID || "prove-viewport",
  });
  const tabs = [];
  try {
    await mcp.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "prove-viewport", version: "0.6.9" },
    });
    mcp.notify("notifications/initialized");
    await sleep(600);
    const status = await mcp.callTool("status");
    assert.equal(status.connectionState, "connected");

    const phone = await mcp.callTool("new_tab", {
      url: `${fx.origin}/kitchen`,
      show: false,
      wait: true,
    });
    tabs.push(phone.tabId);
    const before = await mcp.callTool("evaluate", {
      tabId: phone.tabId,
      function: '() => window.matchMedia("(max-width: 1023px)").matches',
    });
    const emu = await mcp.callTool("emulate", { tabId: phone.tabId, viewport: "iphone" });
    assert.equal(emu.ok, true);
    assert.equal(emu.width, 390);
    const after = await mcp.callTool("evaluate", {
      tabId: phone.tabId,
      function: '() => ({ mq500: window.matchMedia("(max-width: 500px)").matches, inner: window.innerWidth })',
    });
    const afterVal = after.value || after;
    assert.ok(
      afterVal.mq500 === true || (afterVal.inner && afterVal.inner <= 430) || (emu.innerWidth && emu.innerWidth <= 430),
      JSON.stringify({ before: before.value, after: afterVal, emu })
    );
    await mcp.callTool("emulate", { tabId: phone.tabId, viewport: "reset" });

    const heavy = await mcp.callTool("new_tab", {
      url: `${fx.origin}/heavy?n=400`,
      show: false,
      wait: true,
    });
    tabs.push(heavy.tabId);
    const t0 = Date.now();
    const snap = await mcp.callTool("snapshot", { tabId: heavy.tabId });
    const snapMs = Date.now() - t0;
    assert.ok(snapMs < 8000, "snapshot too slow: " + snapMs);
    assert.ok(snap.nodes.length <= 250, "node cap: " + snap.nodes.length);
    assert.equal(snap.truncated, true);

    const busy = await mcp.callTool("new_tab", {
      url: `${fx.origin}/busy`,
      show: false,
      wait: false,
    });
    tabs.push(busy.tabId);
    await sleep(400);
    const w0 = Date.now();
    const waited = await mcp.callTool("wait_for", {
      tabId: busy.tabId,
      networkIdle: true,
      timeoutMs: 8000,
    });
    const waitMs = Date.now() - w0;
    assert.ok(waitMs < 12000, "wait_for hung: " + waitMs);
    assert.ok(waited.ok === true || waited.timedOut === true, JSON.stringify(waited));

    console.log(
      JSON.stringify(
        {
          ok: true,
          emulate: { width: emu.width, mq: afterVal.mq, inner: afterVal.inner },
          snapshot: { nodes: snap.nodes.length, truncated: snap.truncated, ms: snapMs },
          waitFor: { ...waited, ms: waitMs },
        },
        null,
        2
      )
    );
  } finally {
    for (const tabId of tabs) {
      try {
        await mcp.callTool("close_tab", { tabId });
      } catch {
        // ignore
      }
    }
    await mcp.close();
    await fx.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
