import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Broker } from "../lib/broker.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";
import { startMcpServer } from "../lib/mcp-client.mjs";
import { installDailyChromeHost } from "../lib/attach-daily-chrome.mjs";
import { writeRuntimeConfig, MODE_PATH, ARTIFACTS_DIR, ensureRunDir } from "../lib/paths.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function chromeTabs() {
  return execFileSync(
    "osascript",
    [
      "-e",
      `tell application "Google Chrome"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      set out to out & (id of t as text) & "\\t" & (title of t) & "\\t" & (URL of t) & linefeed
    end repeat
  end repeat
  return out
end tell`,
    ],
    { encoding: "utf8" }
  ).trim();
}

async function main() {
  ensureRunDir();
  installDailyChromeHost();
  writeRuntimeConfig({ mode: "daily", target: "daily" });
  const report = { before: chromeTabs() };

  // Close leftover extensions tab from the previous attach attempt.
  execFileSync("osascript", [
    "-e",
    `tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          if (URL of t) starts with "chrome://extensions" then close t
        end repeat
      end repeat
    end tell`,
  ]);

  const broker = new Broker();
  let scratchTabId = null;
  let fixture;
  try {
    await broker.start();
    const ready = await broker.waitReady(20000);
    report.ready = ready;
    const ping = await broker.request("ping");
    report.ping = ping;
    const tabs = await broker.request("tabs.list");
    report.listed = tabs;
    assert.ok(Array.isArray(tabs), "tabs.list should return an array");
    assert.ok(tabs.length >= 1, "expected at least one daily Chrome tab");

    fixture = await startFixtureServer();
    const created = await broker.request("tabs.create", {
      url: `${fixture.origin}/form`,
      show: false,
    });
    scratchTabId = created.tabId;
    const snap = await broker.request("tabs.snapshot", { tabId: scratchTabId });
    const nameUid = snap.nodes.find((n) => n.id === "name" || n.name === "name")?.uid;
    const submitUid = snap.nodes.find((n) => n.id === "submit")?.uid;
    assert.ok(nameUid && submitUid, JSON.stringify(snap.nodes));
    await broker.request("tabs.fill", {
      tabId: scratchTabId,
      uid: nameUid,
      value: "Daily Attach",
    });
    await broker.request("tabs.click", { tabId: scratchTabId, uid: submitUid });
    await sleep(700);
    const text = await broker.request("tabs.evaluate", {
      tabId: scratchTabId,
      function: "() => document.body.innerText",
    });
    assert.match(String(text.value), /Daily Attach/);
    const shot = await broker.request("tabs.screenshot", { tabId: scratchTabId });
    const shotPath = path.join(ARTIFACTS_DIR, "daily-attach-form.png");
    fs.writeFileSync(shotPath, Buffer.from(shot.pngBase64, "base64"));
    report.screenshot = shotPath;
    await broker.request("tabs.close", { tabId: scratchTabId });
    scratchTabId = null;
  } finally {
    if (scratchTabId) {
      try {
        await broker.request("tabs.close", { tabId: scratchTabId });
      } catch {
        // ignore
      }
    }
    try {
      broker.close();
    } catch {
      // ignore
    }
    if (fixture) await fixture.close();
  }

  await sleep(1200);
  const mcp = startMcpServer();
  try {
    await mcp.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "prove-daily", version: "0.1.0" },
    });
    mcp.notify("notifications/initialized");
    const status = await mcp.callTool("status");
    report.mcpStatus = status;
    assert.equal(status.connected, true);
    assert.equal(status.mode, "daily");
    const listed = await mcp.callTool("list_tabs");
    report.mcpTabs = listed;
  } finally {
    await mcp.close();
  }

  report.after = chromeTabs();
  fs.writeFileSync(MODE_PATH, JSON.stringify({ mode: "daily", at: new Date().toISOString() }, null, 2));
  fs.writeFileSync(path.join(ARTIFACTS_DIR, "daily-attach-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, ping: report.ping, mcpStatus: report.mcpStatus, screenshot: report.screenshot }, null, 2));
}

main().catch((err) => {
  console.error("PROVE FAILED");
  console.error(err);
  process.exit(1);
});
