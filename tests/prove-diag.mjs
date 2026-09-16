import assert from "node:assert/strict";
import { Broker } from "../lib/broker.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";
import { installDailyChromeHost } from "../lib/attach-daily-chrome.mjs";
import { writeRuntimeConfig, ensureRunDir } from "../lib/paths.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  ensureRunDir();
  installDailyChromeHost();
  writeRuntimeConfig({ mode: "daily" });
  const fixture = await startFixtureServer();
  const broker = new Broker();
  let tabId;
  try {
    await broker.start();
    await broker.waitReady(20000);
    const created = await broker.request("tabs.create", {
      url: `${fixture.origin}/diag`,
      show: true,
    });
    tabId = created.tabId;
    await sleep(1500);
    const cons = await broker.request("diagnostics.console", { tabId, limit: 50 });
    const net = await broker.request("diagnostics.network", { tabId, limit: 80 });
    const consText = JSON.stringify(cons);
    const netText = JSON.stringify(net);
    assert.match(consText, /gbc-diag-error/);
    assert.ok(
      /missing-resource|404|ERR_|net::/i.test(netText) || /gbc-diag-fetch-fail/.test(consText),
      "expected a failed request in network or console: " + netText.slice(0, 800)
    );
    const formReq = (net.entries || []).find((r) => /\/form$/.test(r.url || ""));
    let detail = null;
    if (formReq) {
      detail = await broker.request("diagnostics.networkGet", {
        tabId,
        reqid: formReq.reqid,
      });
      assert.ok(detail.status === 200 || detail.responseBody, JSON.stringify(detail).slice(0, 400));
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          tabId,
          consoleCount: cons.count,
          networkCount: net.count,
          consoleSample: (cons.entries || []).slice(-6),
          networkSample: (net.entries || []).slice(-8),
          formDetail: detail && {
            reqid: detail.reqid,
            status: detail.status,
            mimeType: detail.mimeType,
            hasBody: Boolean(detail.responseBody),
            bodyPreview: String(detail.responseBody || "").slice(0, 80),
          },
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
    await fixture.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
