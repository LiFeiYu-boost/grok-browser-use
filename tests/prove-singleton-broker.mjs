import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Broker } from "../lib/broker.mjs";
import { BrokerClient, ensureDailyBroker } from "../lib/broker-client.mjs";
import { startMcpServer } from "../lib/mcp-client.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withFakeExtension(socketPath, handler) {
  const sock = await new Promise((resolve, reject) => {
    const c = net.connect(socketPath);
    c.once("connect", () => resolve(c));
    c.once("error", reject);
  });
  sock.setEncoding("utf8");
  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const reply = handler(msg);
      if (reply) sock.write(JSON.stringify(reply) + "\n");
    }
  });
  sock.write(JSON.stringify({ type: "ready", extensionId: "test", ts: Date.now() }) + "\n");
  return sock;
}

async function proveHubMultiplex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbu-hub-"));
  const socketPath = path.join(dir, "daily.sock");
  const hub = new Broker({ socketPath });
  await hub.start({ reuse: true });
  const ext = await withFakeExtension(socketPath, (msg) => {
    if (msg.method === "tabs.list") {
      return { id: msg.id, result: { tabs: [{ id: 1, title: "A" }] } };
    }
    return { id: msg.id, result: { ok: true, method: msg.method } };
  });
  await sleep(50);

  const a = new BrokerClient({ socketPath });
  const b = new BrokerClient({ socketPath });
  const helloA = await a.connect({ timeoutMs: 1000 });
  const helloB = await b.connect({ timeoutMs: 1000 });
  assert.equal(helloA.extensionReady, true);
  assert.equal(helloB.extensionReady, true);
  assert.equal(a.extensionReady, true);
  assert.equal(b.extensionReady, true);

  const [listA, listB] = await Promise.all([
    a.request("tabs.list", {}, 3000),
    b.request("tabs.list", {}, 3000),
  ]);
  assert.deepEqual(listA, { tabs: [{ id: 1, title: "A" }] });
  assert.deepEqual(listB, { tabs: [{ id: 1, title: "A" }] });

  a.close();
  const listB2 = await b.request("tabs.list", {}, 3000);
  assert.deepEqual(listB2.tabs[0].id, 1);

  b.close();
  ext.destroy();
  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, mode: "in-process-hub" };
}

async function proveDaemonAndMcp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbu-daemon-"));
  const socketPath = path.join(dir, "daily.sock");
  const prev = process.env.GROK_BROWSER_DAILY_SOCKET;
  process.env.GROK_BROWSER_DAILY_SOCKET = socketPath;
  const env = { GROK_BROWSER_DAILY_SOCKET: socketPath, GROK_BROWSER_TARGET: "daily" };
  let mcp1;
  let mcp2;
  let ext;
  let client0HubPid = 0;
  try {
    const client0 = await ensureDailyBroker({
      socketPath,
      installHost: false,
      nudgeNativeHost: false,
    });
    client0HubPid = client0.hubPid || 0;
    ext = await withFakeExtension(socketPath, (msg) => {
      if (msg.method === "tabs.list") {
        return { id: msg.id, result: { tabs: [{ id: 7, title: "shared" }] } };
      }
      return { id: msg.id, result: { ok: true } };
    });
    await client0.waitReady(3000);
    client0.close();

    mcp1 = startMcpServer(env);
    mcp2 = startMcpServer(env);
    const init = {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "prove-singleton", version: "0.6.7" },
    };
    const i1 = await mcp1.request("initialize", init);
    const i2 = await mcp2.request("initialize", init);
    assert.equal(i1.serverInfo.version, "0.6.11");
    assert.equal(i2.serverInfo.version, "0.6.11");
    mcp1.notify("notifications/initialized");
    mcp2.notify("notifications/initialized");
    await sleep(400);
    const s1 = await mcp1.callTool("status");
    const s2 = await mcp2.callTool("status");
    assert.equal(s1.sharedBroker, true);
    assert.equal(s2.sharedBroker, true);
    assert.equal(s1.connectionState, "connected");
    assert.equal(s2.connectionState, "connected");
    const t1 = await mcp1.callTool("list_tabs");
    const t2 = await mcp2.callTool("list_tabs");
    assert.equal(t1.tabs[0].id, 7);
    assert.equal(t2.tabs[0].id, 7);
    await mcp1.close();
    const t2b = await mcp2.callTool("list_tabs");
    assert.equal(t2b.tabs[0].id, 7);
    return { ok: true, mode: "daemon+two-mcp", hubPid: s1.hubPid };
  } finally {
    try {
      ext?.destroy();
    } catch {
      // ignore
    }
    try {
      await mcp1?.close();
    } catch {
      // ignore
    }
    try {
      await mcp2?.close();
    } catch {
      // ignore
    }
    if (prev == null) delete process.env.GROK_BROWSER_DAILY_SOCKET;
    else process.env.GROK_BROWSER_DAILY_SOCKET = prev;
    try {
      if (client0HubPid) process.kill(client0HubPid, "SIGTERM");
    } catch {
      // ignore
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const hub = await proveHubMultiplex();
  const daemon = await proveDaemonAndMcp();
  console.log(JSON.stringify({ ok: true, hub, daemon }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
