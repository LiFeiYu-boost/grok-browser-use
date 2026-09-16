import assert from "node:assert/strict";
import { Broker } from "../lib/broker.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";
import { installDailyChromeHost } from "../lib/attach-daily-chrome.mjs";
import { writeRuntimeConfig, ensureRunDir } from "../lib/paths.mjs";

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
    await broker.request("tabs.wait", {
      tabId,
      consolePattern: "gbc-diag-error",
      timeoutMs: 8000,
    });
    await broker.request("tabs.wait", {
      tabId,
      networkIdle: true,
      idleMs: 400,
      timeoutMs: 8000,
    });
    const net = await broker.request("diagnostics.network", { tabId, limit: 50 });
    const fetches = await broker.request("diagnostics.network", {
      tabId,
      resourceTypes: ["fetch", "xhr"],
      limit: 50,
    });
    const failed = await broker.request("diagnostics.network", {
      tabId,
      failedOnly: true,
      limit: 50,
    });
    assert.ok(fetches.entries.some((r) => /\/form$/.test(r.url)), JSON.stringify(fetches));
    assert.ok(
      failed.entries.some((r) => r.status >= 400 || r.failed),
      JSON.stringify(failed)
    );
    const echo = net.entries.find((r) => /\/echo$/.test(r.url) && r.method === "POST");
    assert.ok(echo, "POST /echo missing: " + JSON.stringify(net.entries));
    const echoDetail = await broker.request("diagnostics.networkGet", {
      tabId,
      reqid: echo.reqid,
    });
    assert.match(String(echoDetail.requestBody || echoDetail.responseBody || ""), /hello-gbc/);
    const perf = await broker.request("tabs.performance", { tabId });
    assert.ok(perf.page, JSON.stringify(perf));
    const snap = await broker.request("tabs.snapshot", { tabId });
    const btn = snap.nodes.find((n) => n.id === "ok" || /ok/i.test(n.label || ""));
    assert.ok(btn, JSON.stringify(snap.nodes));
    const css = await broker.request("tabs.css", { tabId, uid: btn.uid });
    assert.ok(css.style && css.style.display, JSON.stringify(css));
    console.log(
      JSON.stringify(
        {
          ok: true,
          tabId,
          fetchCount: fetches.count,
          failedCount: failed.count,
          echo: {
            reqid: echo.reqid,
            status: echo.status,
            requestBody: echoDetail.requestBody,
            responseBody: String(echoDetail.responseBody || "").slice(0, 80),
          },
          perf: perf.page,
          css: css.style,
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
