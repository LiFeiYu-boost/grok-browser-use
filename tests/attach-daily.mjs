import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { Broker } from "../lib/broker.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";
import { startMcpServer } from "../lib/mcp-client.mjs";
import {
  installDailyChromeHost,
  openExtensionsTab,
  closeChromeTabById,
  dumpChromeUi,
  enableDeveloperModeAndLoadUnpacked,
  completeOpenPanel,
  writeUiDump,
  chromeTabCount,
  extensionDir,
  ourExtensionId,
} from "../lib/attach-daily-chrome.mjs";
import { writeRuntimeConfig, MODE_PATH, ARTIFACTS_DIR, ensureRunDir } from "../lib/paths.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  ensureRunDir();
  const report = { steps: [] };
  const beforeTabs = chromeTabCount();
  report.beforeTabs = beforeTabs;
  const written = installDailyChromeHost();
  report.nativeHost = written;
  assert.ok(
    written.some((p) => p.includes("Google/Chrome/NativeMessagingHosts")),
    "daily Chrome native host not written"
  );
  assert.ok(
    written.every((p) => !p.endsWith("com.openai.codexextension.json")),
    "must not write Codex host"
  );
  writeRuntimeConfig({ mode: "daily", target: "daily" });

  const broker = new Broker();
  let extensionsTabId = null;
  let scratchTabId = null;
  let fixture;
  try {
    await broker.start();
    extensionsTabId = openExtensionsTab();
    report.extensionsTabId = extensionsTabId;
    await sleep(1500);
    let ui = "";
    try {
      ui = dumpChromeUi();
      report.uiDumpPath = writeUiDump(ui);
    } catch (err) {
      report.uiDumpError = String(err);
    }
    const clickResult = enableDeveloperModeAndLoadUnpacked();
    report.clickResult = clickResult;
    await sleep(400);
    const panel = completeOpenPanel(extensionDir());
    report.panel = panel;
    const ready = await broker.waitReady(25000);
    report.ready = ready;
    assert.equal(ready.extensionId, ourExtensionId());
    const ping = await broker.request("ping");
    report.ping = ping;
    const tabs = await broker.request("tabs.list");
    report.tabCount = tabs.length;
    report.tabTitles = tabs.map((t) => t.title).slice(0, 20);
    assert.ok(tabs.length >= beforeTabs, "expected existing Chrome tabs to remain");

    fixture = await startFixtureServer();
    const created = await broker.request("tabs.create", {
      url: `${fixture.origin}/form`,
      show: false,
    });
    scratchTabId = created.tabId;
    report.scratchTabId = scratchTabId;
    const snap = await broker.request("tabs.snapshot", { tabId: scratchTabId });
    const nameUid = snap.nodes.find((n) => n.id === "name" || n.name === "name")?.uid;
    const submitUid = snap.nodes.find((n) => n.id === "submit")?.uid;
    assert.ok(nameUid && submitUid, JSON.stringify(snap.nodes, null, 2));
    await broker.request("tabs.fill", {
      tabId: scratchTabId,
      uid: nameUid,
      value: "Daily Attach",
    });
    await broker.request("tabs.click", { tabId: scratchTabId, uid: submitUid });
    await sleep(600);
    const after = await broker.request("tabs.evaluate", {
      tabId: scratchTabId,
      function: "() => document.body.innerText",
    });
    assert.match(String(after.value), /Daily Attach/);
    const shot = await broker.request("tabs.screenshot", { tabId: scratchTabId });
    const shotPath = path.join(ARTIFACTS_DIR, "daily-attach-form.png");
    fs.writeFileSync(shotPath, Buffer.from(shot.pngBase64, "base64"));
    report.screenshot = shotPath;
    await broker.request("tabs.close", { tabId: scratchTabId });
    scratchTabId = null;
  } finally {
    try {
      broker.close();
    } catch {
      // ignore
    }
    if (scratchTabId) {
      try {
        await new Broker();
      } catch {
        // ignore
      }
    }
    if (extensionsTabId) {
      try {
        closeChromeTabById(extensionsTabId);
      } catch (err) {
        report.closeExtensionsError = String(err);
      }
    }
    if (fixture) {
      try {
        await fixture.close();
      } catch {
        // ignore
      }
    }
  }

  await sleep(800);
  const mcp = startMcpServer();
  try {
    await mcp.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "attach-daily", version: "0.1.0" },
    });
    mcp.notify("notifications/initialized");
    const status = await mcp.callTool("status");
    report.mcpStatus = status;
    assert.equal(status.connected, true);
    assert.equal(status.mode, "daily");
    const listed = await mcp.callTool("list_tabs");
    report.mcpTabCount = Array.isArray(listed) ? listed.length : listed;
  } finally {
    await mcp.close();
  }

  const afterTabs = chromeTabCount();
  report.afterTabs = afterTabs;
  fs.writeFileSync(MODE_PATH, JSON.stringify({ mode: "daily", at: new Date().toISOString() }, null, 2));
  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, "daily-attach-report.json"),
    JSON.stringify(report, null, 2)
  );
  console.log(JSON.stringify({ ok: true, ...report, beforeTabs, afterTabs }, null, 2));
}

main().catch((err) => {
  console.error("ATTACH FAILED");
  console.error(err);
  process.exit(1);
});
