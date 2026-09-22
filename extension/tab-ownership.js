import { isGrokGroupTitle, sessionGroupTitle } from "./session-id.js";

const PREFIX = "gbu.tab-owner.";

// Session storage survives MV3 worker suspension, but not a browser restart
// (where Chrome can reuse tab IDs). Never persist these IDs in local storage.
export class TabOwnership {
  constructor(api) {
    this.api = api;
  }

  async claim(tabId, sessionId = "local") {
    await this.api.storage.session.set({ [PREFIX + tabId]: sessionId || "local" });
  }

  async forget(tabId) {
    await this.api.storage.session.remove(PREFIX + tabId);
  }

  async assert(tabId, sessionId = "local") {
    sessionId ||= "local";
    const tab = await this.api.tabs.get(tabId);
    const saved = await this.api.storage.session.get(PREFIX + tabId);
    const owner = saved[PREFIX + tabId];
    const group = tab.groupId >= 0 ? await this.api.tabGroups.get(tab.groupId) : null;
    const expected = sessionGroupTitle(sessionId);
    if (owner && owner !== sessionId) {
      throw new Error(`tab ${tabId} belongs to another session`);
    }
    // A user moving a tab to a different named group takes it out of our scope.
    if (group && group.title !== expected) {
      throw new Error(`tab ${tabId} belongs to "${group.title}", not this session's "${expected}"`);
    }
    if (!owner && (!group || !isGrokGroupTitle(group.title))) {
      throw new Error(`tab ${tabId} is not owned by this Grok Browser session`);
    }
    // Adopt grouped tabs from a pre-upgrade worker only after checking the group.
    if (!owner) await this.claim(tabId, sessionId);
    return tab;
  }

  async list({ sessionId = "local", scope = "session" } = {}) {
    sessionId ||= "local";
    const [tabs, groups, owners] = await Promise.all([
      this.api.tabs.query({}),
      this.api.tabGroups.query({}),
      this.api.storage.session.get(null),
    ]);
    const byGroup = new Map(groups.map((g) => [g.id, g]));
    return tabs.flatMap((tab) => {
      const owner = owners[PREFIX + tab.id];
      const group = tab.groupId >= 0 ? byGroup.get(tab.groupId) : null;
      const title = group?.title || "";
      if (tab.groupId >= 0 && !group) return [];
      if (owner) {
        if (group && title !== sessionGroupTitle(owner)) return [];
        if (scope !== "all" && owner !== sessionId) return [];
      } else {
        if (!isGrokGroupTitle(title)) return [];
        if (scope !== "all" && title !== sessionGroupTitle(sessionId)) return [];
      }
      return [{
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url || "",
        title: tab.title || "",
        active: Boolean(tab.active),
        groupId: tab.groupId,
        tabGroup: title || null,
        sessionId: owner || (title === sessionGroupTitle(sessionId) ? sessionId : undefined),
      }];
    });
  }
}
