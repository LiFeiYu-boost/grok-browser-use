// Isolated real-extension acceptance. Requires playwright-core (or set
// PLAYWRIGHT_MODULE to its index.mjs). Never attaches to daily Chrome.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Broker } from "../lib/broker.mjs";
import { launchCft, killCftTree } from "../lib/launch-cft.mjs";
import { ARTIFACTS_DIR, EXTENSION_ID, HOST_NAME, dailyChromeNativeHostDirs } from "../lib/paths.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright-core");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(50);
  }
  throw new Error("acceptance condition timed out");
}
const manifestFiles = dailyChromeNativeHostDirs().map((dir) => path.join(dir, `${HOST_NAME}.json`));
const before = manifestFiles.map((p) => fs.existsSync(p) ? fs.readFileSync(p) : null);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbu-tabs-"));
const profile = path.join(dir, "profile");
const socketPath = path.join(dir, "cft.sock");
const broker = new Broker({ socketPath });
const fixture = await startFixtureServer();
let launched, browser;
const request = (method, params = {}, sessionId = "acceptance-a") =>
  broker.request(method, { ...params, sessionId });
try {
  await broker.start();
  launched = launchCft({ mode: "headless", userDataDir: profile, socketPath, extraArgs: ["--remote-debugging-port=0"] });
  await broker.waitReady(15000);
  const portFile = path.join(profile, "DevToolsActivePort");
  await until(() => fs.existsSync(portFile));
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  let worker = await until(() => context.serviceWorkers().find((w) => w.url().includes(EXTENSION_ID)));
  const a = await request("tabs.create", { url: `${fixture.origin}/form`, show: false });
  const b = await request("tabs.create", { url: `${fixture.origin}/kitchen`, show: false }, "acceptance-b");

  // Use the real browser API to reproduce #18 without navigating another page.
  await worker.evaluate((id) => chrome.tabs.ungroup(id), a.tabId);
  assert.ok((await request("tabs.list")).some((tab) => tab.tabId === a.tabId));
  await assert.rejects(request("tabs.close", { tabId: a.tabId }, "acceptance-b"), /another session/);

  const snap = await request("tabs.snapshot", { tabId: a.tabId });
  const name = snap.nodes.find((n) => n.id === "name");
  const save = snap.nodes.find((n) => n.id === "submit");
  assert.ok(name && save);
  await request("tabs.fill", { tabId: a.tabId, uid: name.uid, value: "Ownership recovery" });
  await request("tabs.click", { tabId: a.tabId, uid: save.uid });
  const saved = await request("tabs.evaluate", { tabId: a.tabId, function: "() => document.body.innerText" });
  assert.match(saved.value, /Ownership recovery/);
  const shot = await request("tabs.screenshot", { tabId: a.tabId, wait: false });
  fs.writeFileSync(path.join(ARTIFACTS_DIR, "tab-recovery.png"), Buffer.from(shot.pngBase64, "base64"));

  // Stop/start the actual MV3 worker. Its JS heap is discarded, session storage stays.
  const cdp = await context.newCDPSession(context.pages()[0]);
  let versionId;
  cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
    for (const v of versions) if (v.scriptURL.includes(EXTENSION_ID) && v.runningStatus === "running") versionId = v.versionId;
  });
  await cdp.send("ServiceWorker.enable");
  await until(() => versionId);
  await cdp.send("ServiceWorker.stopWorker", { versionId });
  await until(() => !broker.active);
  await cdp.send("ServiceWorker.startWorker", { scopeURL: `chrome-extension://${EXTENSION_ID}/` });
  await broker.waitReady(10000);
  worker = await until(() => context.serviceWorkers().find((w) => w.url().includes(EXTENSION_ID)));
  assert.ok((await request("tabs.list")).some((tab) => tab.tabId === a.tabId));
  await assert.rejects(request("tabs.close", { tabId: a.tabId }, "acceptance-b"), /another session/);
  await request("tabs.close", { tabId: a.tabId });
  assert.ok(!(await request("tabs.list")).some((tab) => tab.tabId === a.tabId));

  // Closed issue regressions: custom checkboxes, cross-origin iframe clicks,
  // phone viewport, bounded large-page snapshots and busy-page waits.
  const kitchen = await request("tabs.snapshot", { tabId: b.tabId }, "acceptance-b");
  const checkbox = kitchen.nodes.find((node) => node.id === "row-check" || node.id === "row-check-wrap");
  const send = kitchen.nodes.find((node) => node.id === "xsend");
  assert.ok(checkbox && send);
  await request("tabs.click", { tabId: b.tabId, uid: checkbox.uid }, "acceptance-b");
  assert.equal((await request("tabs.evaluate", { tabId: b.tabId, function: "() => document.getElementById('row-check').checked" }, "acceptance-b")).value, true);
  await request("tabs.click", { tabId: b.tabId, uid: send.uid }, "acceptance-b");
  assert.equal((await request("tabs.evaluate", { tabId: b.tabId, function: "() => document.getElementById('status').textContent" }, "acceptance-b")).value, "iframe-sent");
  const activeBefore = await worker.evaluate(() => chrome.tabs.query({ active: true }).then((tabs) => tabs.map((t) => t.id)));
  const phone = await request("tabs.emulate", { tabId: b.tabId, viewport: "iphone" }, "acceptance-b");
  assert.ok(phone.innerWidth <= 430, JSON.stringify(phone));
  await assert.rejects(request("tabs.close", { tabId: b.tabId }), /another session/);
  await request("tabs.emulate", { tabId: b.tabId, viewport: "reset" }, "acceptance-b");
  const activeAfter = await worker.evaluate(() => chrome.tabs.query({ active: true }).then((tabs) => tabs.map((t) => t.id)));
  assert.deepEqual(activeAfter, activeBefore, "emulate must not activate a background tab");
  const heavy = await request("tabs.create", { url: `${fixture.origin}/heavy?n=400`, show: false });
  const largeSnap = await request("tabs.snapshot", { tabId: heavy.tabId });
  assert.ok(largeSnap.nodes.length <= 250 && largeSnap.truncated);
  await request("tabs.close", { tabId: heavy.tabId });
  const busy = await request("tabs.create", { url: `${fixture.origin}/busy`, show: false, wait: false });
  const waitStarted = Date.now();
  const waited = await request("tabs.wait", { tabId: busy.tabId, networkIdle: true, timeoutMs: 3000 });
  assert.ok(Date.now() - waitStarted < 6000);
  assert.ok(waited.ok === true || waited.timedOut === true);
  await request("tabs.close", { tabId: busy.tabId });

  // An explicit user group is protected, even for a tab this session created.
  await worker.evaluate(async (id) => {
    await chrome.tabs.ungroup(id);
    const groupId = await chrome.tabs.group({ tabIds: [id] });
    await chrome.tabGroups.update(groupId, { title: "User review" });
  }, b.tabId);
  await assert.rejects(request("tabs.close", { tabId: b.tabId }, "acceptance-b"), /belongs to/);
  assert.equal(await worker.evaluate((id) => chrome.tabs.get(id).then(() => true), b.tabId), true);

  // A failed create must not leave a tab whose ID the caller never received.
  const countBefore = await worker.evaluate(() => chrome.tabs.query({}).then((tabs) => tabs.length));
  await worker.evaluate(() => {
    globalThis.originalGroupForTest = chrome.tabs.group;
    chrome.tabs.group = async () => { throw new Error("injected group failure"); };
  });
  try {
    await assert.rejects(request("tabs.create", { url: `${fixture.origin}/form`, show: false }), /injected group failure/);
  } finally {
    await worker.evaluate(() => { chrome.tabs.group = globalThis.originalGroupForTest; delete globalThis.originalGroupForTest; });
  }
  assert.equal(await worker.evaluate(() => chrome.tabs.query({}).then((tabs) => tabs.length)), countBefore);
  console.log(JSON.stringify({ ok: true, ungroupedTabCleanup: true, workerRestart: true, crossSessionDenied: true, userGroupProtected: true, failedCreateCleaned: true, customCheckbox: true, crossOriginClick: true, phoneViewport: true, boundedSnapshotAndWait: true, screenshot: "tests/artifacts/tab-recovery.png" }, null, 2));
} finally {
  await browser?.close();
  if (launched) killCftTree(launched.pid);
  broker.close();
  await fixture.close();
  for (let i = 0; i < manifestFiles.length; i++) {
    const current = fs.existsSync(manifestFiles[i]) ? fs.readFileSync(manifestFiles[i]) : null;
    assert.deepEqual(current, before[i], "daily Chrome native-host manifest changed");
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
