import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Broker } from "../lib/broker.mjs";
import { ensureDailyBroker } from "../lib/broker-client.mjs";
import { startMcpServer } from "../lib/mcp-client.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbu-stale-"));
  const socketPath = path.join(dir, "daily.sock");
  const prev = process.env.GROK_BROWSER_DAILY_SOCKET;
  process.env.GROK_BROWSER_DAILY_SOCKET = socketPath;
  let hubPid;
  let recovered;
  let mcp;
  try {
    fs.writeFileSync(socketPath, "stale-not-a-listener");
    recovered = new Broker({ socketPath });
    await recovered.start({ reuse: true });
    recovered.close();
    recovered = null;

    const client = await ensureDailyBroker({
      socketPath,
      installHost: false,
      nudgeNativeHost: false,
    });
    assert.ok(client.hubPid);
    hubPid = client.hubPid;
    client.close();

    mcp = startMcpServer({
      GROK_BROWSER_DAILY_SOCKET: socketPath,
      GROK_BROWSER_TARGET: "daily",
    });
    const init = await mcp.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "prove-stale", version: "0.6.11" },
    });
    assert.equal(init.serverInfo.version, "0.6.11");
    const listed = await mcp.request("tools/list", {});
    assert.ok((listed.tools || []).some((t) => t.name === "emulate"));
    mcp.notify("notifications/initialized");
    await sleep(400);
    const status = await mcp.callTool("status");
    assert.notEqual(status, null);
    assert.equal(status.sharedBroker, true);
    console.log(
      JSON.stringify(
        {
          ok: true,
          emulateListed: true,
          sharedBroker: status.sharedBroker,
          connectionState: status.connectionState,
          hubPid: status.hubPid,
        },
        null,
        2
      )
    );
  } finally {
    try {
      await mcp?.close();
    } catch {
      // ignore
    }
    try {
      recovered?.close();
    } catch {
      // ignore
    }
    try {
      if (hubPid) process.kill(hubPid, "SIGTERM");
    } catch {
      // ignore
    }
    if (prev == null) delete process.env.GROK_BROWSER_DAILY_SOCKET;
    else process.env.GROK_BROWSER_DAILY_SOCKET = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
