import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { Broker } from "../lib/broker.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";
import { installDailyChromeHost } from "../lib/attach-daily-chrome.mjs";
import { writeRuntimeConfig, ARTIFACTS_DIR, ensureRunDir } from "../lib/paths.mjs";
import { execFileSync } from "node:child_process";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function osa(script) {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
}

async function main() {
  ensureRunDir();
  installDailyChromeHost();
  writeRuntimeConfig({ mode: "daily", target: "daily" });

  const broker = new Broker();
  let fixture;
  let tabId;
  try {
    await broker.start();
    const ready = await broker.waitReady(20000);
    assert.equal(ready.extensionId, "eljkchjmlpfpbobncnnimgfijfcehdja");

    fixture = await startFixtureServer();
    const created = await broker.request("tabs.create", {
      url: `${fixture.origin}/form`,
      show: true,
    });
    tabId = created.tabId;
    assert.equal(created.tabGroup, "Grok Browser");
    const listed = await broker.request("tabs.list");
    const mine = listed.find((t) => t.tabId === tabId);
    assert.ok(mine, "created tab missing from list");
    assert.equal(mine.tabGroup, "Grok Browser");

    const snap = await broker.request("tabs.snapshot", { tabId });
    const nameUid = snap.nodes.find((n) => n.id === "name" || n.name === "name")?.uid;
    const submitUid = snap.nodes.find((n) => n.id === "submit")?.uid;
    assert.ok(nameUid && submitUid, JSON.stringify(snap.nodes));
    await broker.request("tabs.fill", { tabId, uid: nameUid, value: "Pointer Check" });
    const ptr = await broker.request("tabs.hasPointer", { tabId });
    assert.equal(ptr.has, true, "pointer overlay missing: " + JSON.stringify(ptr));
    const shot = await broker.request("tabs.screenshot", { tabId });
    const shotPath = path.join(ARTIFACTS_DIR, "group-pointer.png");
    fs.writeFileSync(shotPath, Buffer.from(shot.pngBase64, "base64"));
    await broker.request("tabs.click", { tabId, uid: submitUid });
    await sleep(500);
    const text = await broker.request("tabs.evaluate", {
      tabId,
      function: "() => document.body.innerText.slice(0,400)",
    });
    assert.match(String(text.value), /Pointer Check/);

    console.log(
      JSON.stringify(
        {
          ok: true,
          tabId,
          tabGroup: mine.tabGroup,
          hasPointer: text.value.hasPointer,
          screenshot: shotPath,
        },
        null,
        2
      )
    );
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
    if (fixture) await fixture.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
