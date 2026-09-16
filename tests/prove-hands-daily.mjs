import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { Broker } from "../lib/broker.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";
import { installDailyChromeHost } from "../lib/attach-daily-chrome.mjs";
import { writeRuntimeConfig, ensureRunDir, ARTIFACTS_DIR } from "../lib/paths.mjs";

function uidFor(snapshot, pred) {
  const node = snapshot.nodes.find(pred);
  if (!node) {
    throw new Error(`uid not found. nodes=${JSON.stringify(snapshot.nodes, null, 2)}`);
  }
  return node;
}

async function main() {
  ensureRunDir();
  installDailyChromeHost();
  writeRuntimeConfig({ mode: "daily", target: "daily" });
  const fixture = await startFixtureServer();
  const broker = new Broker();
  let tabId;
  try {
    await broker.start();
    await broker.waitReady(20000);
    const created = await broker.request("tabs.create", {
      url: `${fixture.origin}/kitchen`,
      show: true,
    });
    tabId = created.tabId;
    const snap = await broker.request("tabs.snapshot", { tabId });
    const logout = uidFor(
      snap,
      (n) => n.destructive || n.id === "logout" || /退出登录/.test(n.name || n.label || "")
    );
    assert.equal(Boolean(logout.destructive), true, JSON.stringify(logout));
    let refused = false;
    try {
      await broker.request("tabs.click", { tabId, uid: logout.uid });
    } catch (err) {
      refused = /destructive/i.test(String(err && err.message ? err.message : err));
    }
    assert.ok(refused, "logout should be refused");

    const okBtn = uidFor(snap, (n) => n.id === "ok");
    const clickRes = await broker.request("tabs.click", { tabId, uid: okBtn.uid });
    const afterOk = await broker.request("tabs.evaluate", {
      tabId,
      function: "() => document.getElementById('status')?.textContent",
    });
    assert.match(String(afterOk.value), /ok/);

    const card = uidFor(snap, (n) => n.id === "card");
    await broker.request("tabs.click", { tabId, uid: card.uid });
    const afterCard = await broker.request("tabs.evaluate", {
      tabId,
      function: "() => document.getElementById('status')?.textContent",
    });
    assert.match(String(afterCard.value), /card/);

    const color = uidFor(snap, (n) => n.id === "color");
    await broker.request("tabs.selectOption", { tabId, uid: color.uid, value: "blue" });
    const afterSelect = await broker.request("tabs.evaluate", {
      tabId,
      function: "() => document.getElementById('status')?.textContent",
    });
    assert.match(String(afterSelect.value), /color:blue/);

    const menu = uidFor(snap, (n) => n.id === "menu");
    await broker.request("tabs.hover", { tabId, uid: menu.uid });
    const afterHover = await broker.request("tabs.evaluate", {
      tabId,
      function: "() => document.getElementById('status')?.textContent",
    });
    assert.match(String(afterHover.value), /hovered/);

    const inner = uidFor(snap, (n) => n.id === "inner" || /inside iframe/i.test(n.name || n.label || ""));
    await broker.request("tabs.click", { tabId, uid: inner.uid });
    const afterIframe = await broker.request("tabs.evaluate", {
      tabId,
      function: "() => document.getElementById('status')?.textContent",
    });
    assert.match(String(afterIframe.value), /iframe/);

    const bottom = uidFor(snap, (n) => n.id === "bottom");
    await broker.request("tabs.scroll", { tabId, uid: bottom.uid });
    await broker.request("tabs.click", { tabId, uid: bottom.uid });
    const afterBottom = await broker.request("tabs.evaluate", {
      tabId,
      function: "() => document.getElementById('status')?.textContent",
    });
    assert.match(String(afterBottom.value), /bottom/);

    const shot = await broker.request("tabs.screenshot", { tabId });
    const png = path.join(ARTIFACTS_DIR, "prove-hands-daily.png");
    fs.writeFileSync(png, Buffer.from(shot.pngBase64, "base64"));
    const report = {
      ok: true,
      tabId,
      via: clickRes.via,
      destructive: logout,
      nodeCount: snap.nodes.length,
      frames: snap.frames,
    };
    fs.writeFileSync(path.join(ARTIFACTS_DIR, "prove-hands-daily.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (tabId) {
      try {
        await broker.request("tabs.close", { tabId });
      } catch {
        // ignore
      }
    }
    try {
      broker.close();
    } catch {
      // ignore
    }
    await fixture.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
