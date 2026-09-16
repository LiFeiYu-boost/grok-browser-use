import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { startFixtureServer } from "./fixtures/server.mjs";
import { startMcpServer } from "../lib/mcp-client.mjs";
import { snapshotDesktop, assertDesktopUnchanged } from "../lib/desktop-guard.mjs";
import { ARTIFACTS_DIR, PLUGIN_ROOT, ensureRunDir } from "../lib/paths.mjs";
import { killLaunchedCft } from "../lib/launch-cft.mjs";

function uidFor(snapshot, pred) {
  const node = snapshot.nodes.find(pred);
  if (!node) {
    throw new Error(
      `uid not found. nodes=${JSON.stringify(snapshot.nodes, null, 2)}`
    );
  }
  return node.uid;
}

async function main() {
  ensureRunDir();
  const before = snapshotDesktop();
  const report = { before, steps: [] };
  let mcp;
  let fixture;
  try {
    fixture = await startFixtureServer();
    report.fixture = fixture.origin;
    mcp = startMcpServer();
    await mcp.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "acceptance", version: "0.1.0" },
    });
    mcp.notify("notifications/initialized");
    const tools = await mcp.request("tools/list");
    const names = tools.tools.map((t) => t.name);
    for (const forbidden of ["resize_page", "drag", "bringToFront", "select_page"]) {
      assert.ok(!names.includes(forbidden), `tool surface leaked ${forbidden}`);
    }

    const status = await mcp.callTool("status");
    report.status = status;
    assert.equal(status.connected, true);
    assert.equal(status.mode, "headless");

    const formTab = await mcp.callTool("new_tab", { url: `${fixture.origin}/form` });
    const listTab = await mcp.callTool("new_tab", { url: `${fixture.origin}/list` });
    const detailTab = await mcp.callTool("new_tab", {
      url: `${fixture.origin}/detail?id=7`,
    });
    report.tabs = { formTab, listTab, detailTab };

    const snaps = await mcp.callTool("run_parallel", {
      ops: [
        { op: "snapshot", tabId: formTab.tabId },
        { op: "snapshot", tabId: listTab.tabId },
        { op: "snapshot", tabId: detailTab.tabId },
      ],
    });
    assert.ok(snaps.results.every((r) => r.ok), JSON.stringify(snaps, null, 2));
    const formSnap = snaps.results[0].value;
    const listSnap = snaps.results[1].value;
    const detailSnap = snaps.results[2].value;
    report.snapshots = {
      form: formSnap.title,
      list: listSnap.title,
      detail: detailSnap.title,
    };

    const nameUid = uidFor(
      formSnap,
      (n) => n.id === "name" || n.name === "name" || /name/i.test(n.label || "")
    );
    const submitUid = uidFor(
      formSnap,
      (n) => n.id === "submit" || /save/i.test(n.label || "")
    );
    const itemUid = uidFor(
      listSnap,
      (n) => /widget one/i.test(n.label || "")
    );

    const parallelActs = await mcp.callTool("run_parallel", {
      ops: [
        { op: "fill", tabId: formTab.tabId, uid: nameUid, value: "Ada Lovelace" },
        { op: "click", tabId: listTab.tabId, uid: itemUid },
        {
          op: "evaluate",
          tabId: detailTab.tabId,
          function: "() => document.getElementById('body').textContent",
        },
      ],
    });
    assert.ok(
      parallelActs.results.every((r) => r.ok),
      JSON.stringify(parallelActs, null, 2)
    );
    assert.match(String(detailSnap.bodyText || ""), /item 7/);
    const detailText = parallelActs.results[2].value && parallelActs.results[2].value.value;
    assert.match(String(detailText), /item 7/);

    await mcp.callTool("click", { tabId: formTab.tabId, uid: submitUid });
    await new Promise((r) => setTimeout(r, 500));
    const formAfter = await mcp.callTool("evaluate", {
      tabId: formTab.tabId,
      function: "() => document.getElementById('status')?.textContent || document.body.innerText",
    });
    assert.match(String(formAfter.value), /Ada Lovelace/);

    const listAfter = await mcp.callTool("evaluate", {
      tabId: listTab.tabId,
      function: "() => document.title + ' ' + document.body.innerText",
    });
    assert.match(String(listAfter.value), /Detail 1/);

    const shots = await mcp.callTool("run_parallel", {
      ops: [
        { op: "screenshot", tabId: formTab.tabId, fileName: "accept-form.png" },
        { op: "screenshot", tabId: listTab.tabId, fileName: "accept-list.png" },
        { op: "screenshot", tabId: detailTab.tabId, fileName: "accept-detail.png" },
      ],
    });
    assert.ok(shots.results.every((r) => r.ok), JSON.stringify(shots, null, 2));
    for (const name of ["accept-form.png", "accept-list.png", "accept-detail.png"]) {
      const p = path.join(ARTIFACTS_DIR, name);
      assert.ok(fs.existsSync(p), `missing ${p}`);
      assert.ok(fs.statSync(p).size > 100, `${name} too small`);
    }

    const audit = await mcp.callTool("audit_log");
    report.audit = audit;
    const banned = [...(audit.broker || []), ...(audit.extension || [])].filter(
      (e) =>
        /focus|activate|bounds|show|windows\.update|tabs\.update/i.test(
          JSON.stringify(e)
        )
    );
    assert.equal(banned.length, 0, JSON.stringify(banned, null, 2));

    const src = fs.readFileSync(path.join(PLUGIN_ROOT, "mcp", "server.mjs"), "utf8");
    assert.doesNotMatch(src, /com\.openai\.codexextension/);
    assert.doesNotMatch(src, /node_repl/);
    assert.doesNotMatch(src, /hehggadaopoacecdllhhajmbjkdcmajg/);

    const after = snapshotDesktop();
    report.after = after;
    assertDesktopUnchanged(before, after, "acceptance");
    report.ok = true;
    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, "acceptance-report.json"),
      JSON.stringify(report, null, 2)
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          fixture: fixture.origin,
          screenshots: [
            "tests/artifacts/accept-form.png",
            "tests/artifacts/accept-list.png",
            "tests/artifacts/accept-list.png".replace("list", "detail"),
          ],
          frontmost: after.frontmost,
          chromePids: after.chromePids,
        },
        null,
        2
      )
    );
  } catch (err) {
    report.ok = false;
    report.error = String(err && err.stack ? err.stack : err);
    try {
      report.after = snapshotDesktop();
    } catch {
      // ignore
    }
    if (mcp) report.stderr = mcp.stderr.join("").slice(-4000);
    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, "acceptance-report.json"),
      JSON.stringify(report, null, 2)
    );
    console.error("ACCEPTANCE FAILED");
    console.error(report.error);
    if (report.stderr) console.error(report.stderr);
    process.exitCode = 1;
  } finally {
    if (mcp) {
      try {
        await mcp.close();
      } catch {
        // ignore
      }
    }
    if (fixture) {
      try {
        await fixture.close();
      } catch {
        // ignore
      }
    }
    try {
      killLaunchedCft();
    } catch {
      // ignore
    }
  }
}

main();
