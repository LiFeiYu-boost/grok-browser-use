import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { startFixtureServer } from "./fixtures/server.mjs";
import { startMcpServer } from "../lib/mcp-client.mjs";
import { snapshotDesktop, assertDesktopUnchanged } from "../lib/desktop-guard.mjs";
import { ARTIFACTS_DIR, ensureRunDir } from "../lib/paths.mjs";

function uidFor(snapshot, pred) {
  const node = snapshot.nodes.find(pred);
  if (!node) {
    throw new Error(`uid not found. nodes=${JSON.stringify(snapshot.nodes, null, 2)}`);
  }
  return node;
}

async function main() {
  ensureRunDir();
  const before = snapshotDesktop();
  const report = { before, steps: [] };
  let mcp;
  let fixture;
  let tabId;
  try {
    fixture = await startFixtureServer();
    mcp = startMcpServer({ GROK_BROWSER_TARGET: "cft" });
    await mcp.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "prove-hands", version: "0.6.0" },
    });
    mcp.notify("notifications/initialized");
    const status = await mcp.callTool("status");
    report.status = status;
    assert.equal(status.connected, true);
    assert.equal(status.mode, "headless");

    const created = await mcp.callTool("new_tab", { url: `${fixture.origin}/kitchen` });
    tabId = created.tabId;
    report.created = created;

    const net = await mcp.callTool("network", { tabId, limit: 50 });
    assert.ok(
      net.entries.some((r) => /\/kitchen/.test(r.url)),
      "new_tab did not capture document request: " + JSON.stringify(net.entries)
    );
    report.networkAfterOpen = net.count;

    const snap = await mcp.callTool("snapshot", { tabId });
    report.snapshotCount = snap.nodes.length;
    const logout = uidFor(
      snap,
      (n) => n.destructive && (/退出登录/.test(n.name || n.label || "") || n.id === "logout")
    );
    const okBtn = uidFor(snap, (n) => n.id === "ok" || /continue/i.test(n.name || n.label || ""));
    const card = uidFor(snap, (n) => n.id === "card" || /open card/i.test(n.name || n.label || ""));
    const color = uidFor(snap, (n) => n.id === "color" || n.role === "combobox");
    const menu = uidFor(snap, (n) => n.id === "menu" || /^menu$/i.test(n.name || n.label || ""));
    const inner = uidFor(snap, (n) => n.id === "inner" || /inside iframe/i.test(n.name || n.label || ""));
    const bottom = uidFor(snap, (n) => n.id === "bottom");
    assert.equal(logout.destructive, true);

    let refused = false;
    try {
      await mcp.callTool("click", { tabId, uid: logout.uid });
    } catch (err) {
      refused = /destructive/i.test(String(err && err.message ? err.message : err));
    }
    assert.ok(refused, "logout click should be refused");
    report.destructiveRefused = true;

    const clicked = await mcp.callTool("click", { tabId, uid: okBtn.uid });
    report.clickedOk = clicked;
    const afterOk = await mcp.callTool("evaluate", {
      tabId,
      function: "() => document.getElementById('status')?.textContent",
    });
    assert.match(String(afterOk.value), /ok/);

    await mcp.callTool("click", { tabId, uid: card.uid });
    const afterCard = await mcp.callTool("evaluate", {
      tabId,
      function: "() => document.getElementById('status')?.textContent",
    });
    assert.match(String(afterCard.value), /card/);

    const selected = await mcp.callTool("select_option", {
      tabId,
      uid: color.uid,
      value: "blue",
    });
    report.selected = selected;
    const afterSelect = await mcp.callTool("evaluate", {
      tabId,
      function: "() => document.getElementById('status')?.textContent",
    });
    assert.match(String(afterSelect.value), /color:blue/);

    await mcp.callTool("hover", { tabId, uid: menu.uid });
    const afterHover = await mcp.callTool("evaluate", {
      tabId,
      function: "() => document.getElementById('status')?.textContent",
    });
    assert.match(String(afterHover.value), /hovered/);

    await mcp.callTool("click", { tabId, uid: inner.uid });
    const afterIframe = await mcp.callTool("evaluate", {
      tabId,
      function: "() => document.getElementById('status')?.textContent",
    });
    assert.match(String(afterIframe.value), /iframe/);

    await mcp.callTool("scroll", { tabId, uid: bottom.uid });
    await mcp.callTool("click", { tabId, uid: bottom.uid });
    const afterBottom = await mcp.callTool("evaluate", {
      tabId,
      function: "() => document.getElementById('status')?.textContent",
    });
    assert.match(String(afterBottom.value), /bottom/);

    const shot = await mcp.callTool("screenshot", {
      tabId,
      fileName: "prove-hands.png",
    });
    report.screenshot = shot;
    const png = path.join(ARTIFACTS_DIR, "prove-hands.png");
    assert.ok(fs.existsSync(png) && fs.statSync(png).size > 100);

    const after = snapshotDesktop();
    report.after = after;
    assertDesktopUnchanged(before, after, "prove-hands");
    report.ok = true;
    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, "prove-hands.json"),
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify({ ok: true, tabId, via: clicked.via, nodes: snap.nodes.length }, null, 2));
  } finally {
    if (mcp && tabId) {
      try {
        await mcp.callTool("close_tab", { tabId });
      } catch {
        // ignore
      }
    }
    if (mcp) await mcp.close();
    if (fixture) await fixture.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
