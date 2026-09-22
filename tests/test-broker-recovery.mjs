import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Broker, canConnect } from "../lib/broker.mjs";
import { BrokerClient } from "../lib/broker-client.mjs";
import { startMcpServer } from "../lib/mcp-client.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail("condition did not become true");
}
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbu-recover-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "daily.sock");
}
async function extension(socketPath, handler = (m) => ({ id: m.id, result: [] })) {
  const sock = net.connect(socketPath);
  await new Promise((resolve, reject) => { sock.once("connect", resolve); sock.once("error", reject); });
  sock.setEncoding("utf8");
  let buffer = "";
  sock.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      const result = handler(msg);
      if (result) sock.write(JSON.stringify(result) + "\n");
    }
  });
  sock.write(JSON.stringify({ type: "ready", extensionId: "isolated-test" }) + "\n");
  return sock;
}

test("concurrent stale-socket recovery elects one reachable broker; losers cannot remove it", async (t) => {
  const socketPath = sandbox(t);
  fs.writeFileSync(socketPath, "stale");
  const brokers = Array.from({ length: 8 }, () => new Broker({ socketPath }));
  t.after(() => brokers.forEach((broker) => broker.close()));
  const results = await Promise.allSettled(brokers.map((b) => b.start({ reuse: true })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (let i = 0; i < results.length; i++) {
    if (results[i].status !== "rejected") continue;
    assert.equal(results[i].reason.code, "BROKER_RUNNING");
    brokers[i].close();
    assert.equal(await canConnect(socketPath), true);
  }
});

test("ready is invalidated on socket close; timed-out requests release pending entries", async (t) => {
  const socketPath = sandbox(t);
  const hub = new Broker({ socketPath });
  await hub.start();
  const ext = await extension(socketPath, () => null);
  const client = new BrokerClient({ socketPath });
  t.after(() => { client.close(); ext.destroy(); hub.close(); });
  await client.connect();
  await client.waitReady(500);
  await assert.rejects(client.request("tabs.list", {}, 30), /timeout/);
  assert.equal(client.pending.size, 0);
  client.sock.destroy();
  await assert.rejects(client.waitReady(30), /socket closed|native port did not connect/);
  await until(() => client.sock === null);
  await assert.rejects(client.waitReady(30), /native port did not connect/);
  assert.equal(client.hubPid, null);
  await client.connect();
  await client.waitReady(500);
  assert.ok(client.active);
});

test("MCP reconnect merges concurrent callers and never replays a dispatched action", async (t) => {
  const socketPath = sandbox(t);
  const hub = new Broker({ socketPath });
  await hub.start();
  let creates = 0;
  const ext = await extension(socketPath, (msg) => {
    if (msg.method === "tabs.create") {
      creates++;
      // The action completed but its reply was lost. Repeating it is unsafe.
      for (const sock of hub.mcpClients) sock.destroy();
      setTimeout(() => ext.write(JSON.stringify({ id: msg.id, result: { tabId: 1 } }) + "\n"), 50);
      return null;
    }
    return { id: msg.id, result: [] };
  });
  const mcp = startMcpServer({ GROK_BROWSER_TARGET: "daily", GROK_BROWSER_DAILY_SOCKET: socketPath });
  t.after(async () => { await mcp.close(); ext.destroy(); hub.close(); });
  const started = Date.now();
  const init = await mcp.request("initialize", { capabilities: {} });
  assert.ok(Date.now() - started < 3000);
  assert.equal(init.capabilities.tools.listChanged, true);
  const listed = await mcp.request("tools/list", {});
  assert.ok(listed.tools.some((tool) => tool.name === "emulate"));
  mcp.notify("notifications/initialized");
  assert.equal((await mcp.callTool("status")).connected, true);
  await assert.rejects(mcp.callTool("new_tab", { url: "https://example.test" }), /socket closed/);
  assert.equal(creates, 1);
  const results = await Promise.all(Array.from({ length: 6 }, () => mcp.callTool("list_tabs")));
  assert.equal(results.length, 6);
  await until(() => hub.mcpClients.size === 1);
  assert.equal(hub.mcpClients.size, 1);
  await until(() => hub.pending.size === 0);
});

test("departed clients do not release in-flight tab actions or execute queued actions", async (t) => {
  const socketPath = sandbox(t);
  const hub = new Broker({ socketPath });
  await hub.start();
  const received = [];
  const ext = await extension(socketPath, (msg) => { received.push(msg); return null; });
  const a = new BrokerClient({ socketPath }), b = new BrokerClient({ socketPath });
  t.after(() => { a.close(); b.close(); ext.destroy(); hub.close(); });
  await a.connect(); await b.connect();
  await a.waitReady(500);
  const first = a.request("tabs.click", { tabId: 7, uid: "a-first" }).catch((err) => err);
  await until(() => received.length === 1);
  const abandoned = a.request("tabs.click", { tabId: 7, uid: "a-queued" }).catch((err) => err);
  const second = b.request("tabs.click", { tabId: 7, uid: "b" });
  await sleep(20);
  a.close();
  await sleep(30);
  assert.equal(received.length, 1, "in-flight click must retain its queue slot");
  ext.write(JSON.stringify({ id: received[0].id, result: { ok: true } }) + "\n");
  await until(() => received.length === 2);
  assert.equal(received[1].params.uid, "b");
  ext.write(JSON.stringify({ id: received[1].id, result: { ok: true } }) + "\n");
  await second; await first; await abandoned;
  await until(() => hub.tabTails.size === 0);
});
