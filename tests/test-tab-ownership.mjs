import test from "node:test";
import assert from "node:assert/strict";
import { TabOwnership } from "../extension/tab-ownership.js";
import { sessionGroupTitle } from "../extension/session-id.js";

function fixture() {
  const saved = {};
  const tabs = new Map();
  const groups = new Map();
  const api = {
    storage: { session: {
      async set(values) { Object.assign(saved, values); },
      async get(key) { return key === null ? { ...saved } : { [key]: saved[key] }; },
      async remove(key) { delete saved[key]; },
    } },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error("No tab with id"); return tabs.get(id); },
      async query() { return [...tabs.values()]; },
    },
    tabGroups: {
      async get(id) { if (!groups.has(id)) throw new Error("No group"); return groups.get(id); },
      async query() { return [...groups.values()]; },
    },
  };
  return { api, tabs, groups, owner: new TabOwnership(api) };
}

test("an ungrouped created tab remains discoverable and owned after worker restart", async () => {
  const { api, tabs, groups, owner } = fixture();
  groups.set(1, { id: 1, title: sessionGroupTitle("session-a") });
  tabs.set(7, { id: 7, groupId: 1 });
  await owner.claim(7, "session-a");
  tabs.get(7).groupId = -1;
  const restarted = new TabOwnership(api);
  assert.equal((await restarted.list({ sessionId: "session-a" }))[0].tabId, 7);
  await restarted.assert(7, "session-a");
  await assert.rejects(restarted.assert(7, "session-b"), /another session/);
  assert.deepEqual(await restarted.list({ sessionId: "session-b" }), []);
  assert.equal((await restarted.list({ sessionId: "session-b", scope: "all" })).length, 1);
});

test("never adopt unknown ungrouped tabs or tabs moved into a user's group", async () => {
  const { owner, tabs, groups } = fixture();
  tabs.set(1, { id: 1, groupId: -1 });
  await assert.rejects(owner.assert(1, "a"), /not owned/);
  await owner.claim(1, "a");
  groups.set(3, { id: 3, title: "User review" });
  tabs.get(1).groupId = 3;
  await assert.rejects(owner.assert(1, "a"), /belongs to/);
  assert.deepEqual(await owner.list({ sessionId: "a", scope: "all" }), []);
});

test("full session identity blocks short-title collisions and emulated-tab cross-session access", async () => {
  const { owner, tabs, groups } = fixture();
  const a = "alpha-123456", b = "beta-123456";
  assert.equal(sessionGroupTitle(a), sessionGroupTitle(b));
  groups.set(1, { id: 1, title: sessionGroupTitle(a) });
  tabs.set(1, { id: 1, groupId: 1 });
  await owner.claim(1, a);
  await assert.rejects(owner.assert(1, b), /another session/);
  tabs.get(1).groupId = -1; // popup emulation removes the group
  await assert.rejects(owner.assert(1, b), /another session/);
  await owner.assert(1, a);
  await owner.forget(1);
  await assert.rejects(owner.assert(1, a), /not owned/);
});

test("pre-upgrade grouped tabs can be adopted only by their matching session", async () => {
  const { owner, tabs, groups } = fixture();
  groups.set(1, { id: 1, title: sessionGroupTitle("a") });
  tabs.set(1, { id: 1, groupId: 1 });
  await assert.rejects(owner.assert(1, "b"), /belongs to/);
  await owner.assert(1, "a");
  tabs.get(1).groupId = -1;
  await owner.assert(1, "a");
});
