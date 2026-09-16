import fs from "node:fs";
import path from "node:path";
import { Broker } from "../lib/broker.mjs";
import { installDailyChromeHost } from "../lib/attach-daily-chrome.mjs";
import { writeRuntimeConfig, ensureRunDir, ARTIFACTS_DIR } from "../lib/paths.mjs";

function findNode(snap, pred) {
  return (snap.nodes || []).find(pred);
}

async function main() {
  ensureRunDir();
  installDailyChromeHost();
  writeRuntimeConfig({ mode: "daily", target: "daily" });
  const broker = new Broker();
  let tabId;
  const report = { steps: [] };
  try {
    await broker.start();
    const ready = await broker.waitReady(20000);
    report.ready = ready;
    const created = await broker.request("tabs.create", {
      url: "https://creator.operax.ai/",
      show: true,
    });
    tabId = created.tabId;
    report.created = created;
    const snap = await broker.request("tabs.snapshot", { tabId });
    report.url = snap.url;
    report.title = snap.title;
    report.nodeCount = snap.nodes.length;
    const logout = findNode(
      snap,
      (n) => n.destructive || /退出登录|log\s*out|sign\s*out/i.test(n.name || n.label || "")
    );
    report.logout = logout
      ? { uid: logout.uid, name: logout.name, destructive: logout.destructive }
      : null;
    if (logout && !logout.destructive) {
      throw new Error("logout control is not marked destructive");
    }
    if (logout) {
      let refused = false;
      try {
        await broker.request("tabs.click", { tabId, uid: logout.uid });
      } catch (err) {
        refused = /destructive/i.test(String(err && err.message ? err.message : err));
        report.logoutRefused = String(err && err.message ? err.message : err);
      }
      if (!refused) throw new Error("logout click was not refused");
    }

    const nav = findNode(
      snap,
      (n) => /TikTok 连接|商品机会|橱窗管理|Hall of Fame/.test(n.name || n.label || "")
    );
    if (!nav) throw new Error("no safe nav link in snapshot: " + JSON.stringify(snap.nodes.slice(0, 20)));
    report.nav = { uid: nav.uid, name: nav.name, role: nav.role };
    const clicked = await broker.request("tabs.click", { tabId, uid: nav.uid });
    report.clicked = clicked;
    const net = await broker.request("diagnostics.network", { tabId, limit: 40 });
    const cons = await broker.request("diagnostics.console", { tabId, limit: 20 });
    report.networkCount = net.count;
    report.consoleCount = cons.count;
    report.networkSample = (net.entries || []).slice(0, 8).map((r) => ({
      method: r.method,
      status: r.status,
      url: r.url,
      resourceType: r.resourceType,
    }));
    const shot = await broker.request("tabs.screenshot", { tabId });
    const png = path.join(ARTIFACTS_DIR, "hands-0.6.png");
    fs.writeFileSync(png, Buffer.from(shot.pngBase64, "base64"));
    report.screenshot = { file: png, bytes: fs.statSync(png).size };
    const after = await broker.request("tabs.evaluate", {
      tabId,
      function: "() => ({ href: location.href, title: document.title })",
    });
    report.after = after.value;
    report.ok = true;
    fs.writeFileSync(path.join(ARTIFACTS_DIR, "hands-0.6.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    // Leave the Grok Browser tab open so the user can see the pointer/group.
    try {
      broker.close();
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
