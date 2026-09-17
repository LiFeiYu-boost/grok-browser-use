import assert from "node:assert/strict";
import fs from "node:fs";
import {
  CONFIG_PATH,
  DEFAULT_DAILY_SOCKET_PATH,
  RUN_DIR,
  writeRuntimeConfig,
  linkDailyBrokerAlias,
} from "../lib/paths.mjs";

writeRuntimeConfig({ mode: "daily", target: "daily" });
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
assert.equal(cfg.socketPath, DEFAULT_DAILY_SOCKET_PATH);

const alias = linkDailyBrokerAlias();
assert.equal(fs.readlinkSync(alias), "daily.sock");
assert.equal(alias, `${RUN_DIR}/broker.sock`);

console.log(JSON.stringify({ ok: true, socketPath: cfg.socketPath, alias: "broker.sock -> daily.sock" }));
