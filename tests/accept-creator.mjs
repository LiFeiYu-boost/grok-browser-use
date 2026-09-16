import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Broker } from "../lib/broker.mjs";
import { installDailyChromeHost } from "../lib/attach-daily-chrome.mjs";
import { writeRuntimeConfig, ARTIFACTS_DIR, ensureRunDir } from "../lib/paths.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function captureWindow(name) {
  const raw = execFileSync(
    "osascript",
    ["-e", 'tell application "Google Chrome" to get bounds of window 1'],
    { encoding: "utf8" }
  ).trim();
  const [l, t, r, b] = raw.split(",").map((s) => Number(s.trim()));
  const file = path.join(ARTIFACTS_DIR, name);
  try {
    execFileSync("screencapture", [
      "-x",
      "-R",
      `${l},${t},${Math.max(r - l, 100)},${Math.max(b - t, 100)}`,
      file,
    ]);
  } catch {
    execFileSync("screencapture", ["-x", file]);
  }
  return file;
}

async function main() {
  ensureRunDir();
  installDailyChromeHost();
  writeRuntimeConfig({ mode: "daily" });
  const broker = new Broker();
  await broker.start();
  const ready = await broker.waitReady(20000);
  const created = await broker.request("tabs.create", {
    url: "https://creator.operax.ai/",
    show: true,
  });
  const tabId = created.tabId;
  try {
    await broker.request("tabs.wait", {
      tabId,
      networkIdle: true,
      idleMs: 800,
      timeoutMs: 20000,
    }).catch((err) => ({ waitError: String(err.message) }));
    await sleep(800);
    const listed = await broker.request("tabs.list");
    const mine = listed.find((t) => t.tabId === tabId);
    const title = await broker.request("tabs.evaluate", {
      tabId,
      function: "() => ({ title: document.title, href: location.href, ready: document.readyState, text: (document.body&&document.body.innerText||'').slice(0,1200) })",
    });
    const snap = await broker.request("tabs.snapshot", { tabId });
    const ptr = await broker.request("tabs.hasPointer", { tabId });
    const cons = await broker.request("diagnostics.console", { tabId, limit: 40 });
    const net = await broker.request("diagnostics.network", { tabId, limit: 60 });
    const failed = await broker.request("diagnostics.network", {
      tabId,
      failedOnly: true,
      limit: 30,
    });
    const perf = await broker.request("tabs.performance", { tabId }).catch((e) => ({
      error: String(e.message),
    }));

    const clickable = (snap.nodes || []).filter(
      (n) => n.tag === "a" || n.tag === "button" || n.type === "button"
    );
    let clicked = null;
    const target =
      clickable.find((n) => /showcase|作品|登录|login|sign|进入|开始|dashboard/i.test(n.label || "")) ||
      clickable.find((n) => n.tag === "a" && n.label);
    if (target) {
      clicked = { uid: target.uid, label: target.label, tag: target.tag };
      await broker.request("tabs.click", { tabId, uid: target.uid }).catch((e) => {
        clicked.error = String(e.message);
      });
      await sleep(1200);
      await broker.request("tabs.wait", {
        tabId,
        networkIdle: true,
        idleMs: 500,
        timeoutMs: 12000,
      }).catch(() => {});
    }

    const after = await broker.request("tabs.evaluate", {
      tabId,
      function: "() => ({ title: document.title, href: location.href, text: (document.body&&document.body.innerText||'').slice(0,800) })",
    });
    const shot = await broker.request("tabs.screenshot", { tabId });
    const pagePath = path.join(ARTIFACTS_DIR, "accept-creator-page.png");
    fs.writeFileSync(pagePath, Buffer.from(shot.pngBase64, "base64"));
    const windowPath = captureWindow("accept-creator-window.png");

    const report = {
      ok: true,
      ready,
      created,
      tabGroup: mine && mine.tabGroup,
      pointer: ptr,
      before: title.value,
      after: after.value,
      clicked,
      snapshotCount: (snap.nodes || []).length,
      snapshotSample: (snap.nodes || []).slice(0, 20).map((n) => ({
        uid: n.uid,
        tag: n.tag,
        label: n.label,
      })),
      consoleErrors: (cons.entries || []).filter((e) => e.level === "error" || e.type === "error"),
      networkCount: net.count,
      failedCount: failed.count,
      failedSample: (failed.entries || []).slice(0, 8),
      topRequests: (net.entries || []).slice(-12),
      perf: perf.page || perf,
      pagePath,
      windowPath,
    };
    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, "accept-creator-report.json"),
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    broker.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
