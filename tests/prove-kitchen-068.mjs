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
    GROK_SESSION_ID: process.env.GROK_SESSION_ID || "prove-kitchen-068",
  });
  let tabId;
  try {
    await mcp.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "prove-kitchen-068", version: "0.6.8" },
    });
    mcp.notify("notifications/initialized");
    await sleep(600);
    const status = await mcp.callTool("status");
    assert.equal(status.connectionState, "connected");
    const created = await mcp.callTool("new_tab", {
      url: `${fx.origin}/kitchen`,
      show: false,
      wait: true,
    });
    tabId = created.tabId;
    const snap = await mcp.callTool("snapshot", { tabId });
    const check = snap.nodes.find(
      (n) => n.role === "checkbox" || /select row/i.test(n.name || "")
    );
    assert.ok(check, "checkbox missing: " + JSON.stringify(snap.nodes.map((n) => n.role + ":" + n.name)));
    const clicked = await mcp.callTool("click", { tabId, uid: check.uid, wait: false });
    assert.equal(clicked.ok, true);
    const after = await mcp.callTool("evaluate", {
      tabId,
      function:
        "() => ({ status: document.getElementById('status').textContent, checked: document.getElementById('row-check').checked })",
    });
    const afterVal = after.value || after;
    const statusText = typeof afterVal === "string" ? afterVal : afterVal.status;
    const checked = typeof afterVal === "object" && afterVal && afterVal.checked;
    assert.ok(
      checked === true && statusText === "checked",
      JSON.stringify({ check, clicked, after })
    );

    const snap2 = await mcp.callTool("snapshot", { tabId });
    const send = snap2.nodes.find((n) => /send message/i.test(n.name || ""));
    assert.ok(send, "Send message missing from cross-origin iframe");
    const sent = await mcp.callTool("click", { tabId, uid: send.uid, wait: false });
    assert.equal(sent.ok, true);
    await sleep(300);
    const afterIframe = await mcp.callTool("evaluate", {
      tabId,
      function: "() => document.getElementById('status').textContent",
    });
    assert.match(String(afterIframe.value), /iframe-sent/);
    console.log(
      JSON.stringify(
        {
          ok: true,
          checkbox: { uid: check.uid, role: check.role, via: clicked.via },
          send: { uid: send.uid, via: sent.via, crossOrigin: send.frameId != null },
        },
        null,
        2
      )
    );
  } finally {
    if (tabId) {
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
