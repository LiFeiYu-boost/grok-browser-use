import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Broker } from "../lib/broker.mjs";
import { installDailyChromeHost } from "../lib/attach-daily-chrome.mjs";
import { writeRuntimeConfig, ARTIFACTS_DIR, ensureRunDir } from "../lib/paths.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function captureChrome(name) {
  const raw = execFileSync(
    "osascript",
    ["-e", 'tell application "Google Chrome" to get bounds of window 1'],
    { encoding: "utf8" }
  ).trim();
  const parts = raw.split(",").map((s) => Number(s.trim()));
  const [l, t, r, b] = parts;
  const file = path.join(ARTIFACTS_DIR, name);
  try {
    execFileSync("screencapture", ["-x", "-R", `${l},${t},${r - l},${b - t}`, file]);
    return file;
  } catch (err) {
    execFileSync("screencapture", ["-x", file]);
    return file;
  }
}

async function main() {
  ensureRunDir();
  installDailyChromeHost();
  writeRuntimeConfig({ mode: "daily", target: "daily" });
  const broker = new Broker();
  await broker.start();
  const ready = await broker.waitReady(20000);
  const created = await broker.request("tabs.create", {
    url: "https://example.com/",
    show: true,
  });
  await sleep(800);
  const snap = await broker.request("tabs.snapshot", { tabId: created.tabId });
  const more = snap.nodes.find(
    (n) => /more information|learn more|iana/i.test(`${n.label || ""} ${n.uid}`)
  );
  if (more) {
    await broker.request("tabs.click", { tabId: created.tabId, uid: more.uid });
    await sleep(1200);
  } else if (snap.nodes[0]) {
    await broker.request("tabs.hasPointer", { tabId: created.tabId }).catch(() => {});
    await broker.request("tabs.click", { tabId: created.tabId, uid: snap.nodes[0].uid });
    await sleep(800);
  }
  const ptr = await broker.request("tabs.hasPointer", { tabId: created.tabId });
  const pageShot = await broker.request("tabs.screenshot", { tabId: created.tabId });
  const pagePath = path.join(ARTIFACTS_DIR, "demo-pointer.png");
  fs.writeFileSync(pagePath, Buffer.from(pageShot.pngBase64, "base64"));
  const windowPath = captureChrome("demo-tabgroup.png");
  const listed = await broker.request("tabs.list");
  const grokTabs = listed.filter((t) => t.tabGroup === "Grok Browser");
  broker.close();
  console.log(
    JSON.stringify(
      {
        ok: true,
        ready,
        created,
        pointer: ptr,
        grokTabs: grokTabs.map((t) => ({
          tabId: t.tabId,
          title: t.title,
          url: t.url,
          tabGroup: t.tabGroup,
          active: t.active,
        })),
        pagePath,
        windowPath,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
