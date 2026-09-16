import assert from "node:assert/strict";
import { startMcpServer } from "../lib/mcp-client.mjs";

async function main() {
  const mcp = startMcpServer({ GROK_BROWSER_TARGET: "daily" });
  try {
    const t0 = Date.now();
    const init = await mcp.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "prove-lazy", version: "0.6.0" },
    });
    const ms = Date.now() - t0;
    assert.ok(init && init.serverInfo, JSON.stringify(init));
    assert.equal(init.serverInfo.name, "grok-browser-use");
    assert.ok(ms < 3000, `initialize blocked ${ms}ms`);
    mcp.notify("notifications/initialized");
    await new Promise((r) => setTimeout(r, 200));
    const tools = await mcp.request("tools/list");
    const names = tools.tools.map((t) => t.name);
    for (const need of ["status", "hover", "scroll", "select_option", "click"]) {
      assert.ok(names.includes(need), `missing tool ${need}`);
    }
    const status = await mcp.callTool("status");
    assert.ok(
      ["connected", "connecting", "disconnected"].includes(status.connectionState),
      JSON.stringify(status)
    );
    assert.equal(status.mode, "daily");
    console.log(
      JSON.stringify(
        { ok: true, initializeMs: ms, connectionState: status.connectionState, mode: status.mode },
        null,
        2
      )
    );
  } finally {
    await mcp.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
