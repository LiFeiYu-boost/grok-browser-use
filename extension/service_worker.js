import {
  attachCdp,
  listConsole as cdpListConsole,
  getConsole as cdpGetConsole,
  listNetwork as cdpListNetwork,
  getNetwork as cdpGetNetwork,
  waitNetworkIdle,
  waitConsole,
  performanceSummary,
  cssForUid,
} from "./cdp-collector.js";

const HOST_NAME = "com.xai.grok.browser";
const GROUP_TITLE = "Grok Browser";
const GROUP_COLOR = "cyan";
const FORBIDDEN = [];
const grokTabIds = new Set();
const consoleBuf = [];
const networkBuf = [];
const BUF_MAX = 400;

function pushBuf(buf, item) {
  buf.push(item);
  if (buf.length > BUF_MAX) buf.splice(0, buf.length - BUF_MAX);
}

let port = null;
let reconnectTimer = null;
let connecting = false;

function audit(kind, detail) {
  FORBIDDEN.push({ ts: Date.now(), kind, detail });
}

function connect() {
  if (port || connecting) return;
  connecting = true;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    connecting = false;
    scheduleReconnect(String(err));
    return;
  }
  connecting = false;
  port.onMessage.addListener((msg) => {
    handleCommand(msg).catch((err) => {
      if (msg && msg.id != null) {
        send({ id: msg.id, error: String(err && err.message ? err.message : err) });
      }
    });
  });
  port.onDisconnect.addListener(() => {
    const last = chrome.runtime.lastError && chrome.runtime.lastError.message;
    port = null;
    connecting = false;
    scheduleReconnect(last || "disconnected");
  });
  reconnectDelayMs = 1000;
  send({
    type: "ready",
    extensionId: chrome.runtime.id,
    ts: Date.now(),
  });
}

let reconnectDelayMs = 1000;
function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
  sendFallback(reason);
}

function sendFallback(_reason) {
  // Native port is down; nothing we can send.
}

function send(obj) {
  if (!port) return;
  try {
    port.postMessage(obj);
  } catch {
    port = null;
  }
}

async function handleCommand(msg) {
  if (!msg || msg.type === "pong") return;
  if (msg.method == null) return;
  const { id, method, params = {} } = msg;
  try {
    const result = await dispatch(method, params);
    send({ id, result });
  } catch (err) {
    send({ id, error: String(err && err.message ? err.message : err) });
  }
}

async function dispatch(method, params) {
  switch (method) {
    case "ping":
      return { ok: true, extensionId: chrome.runtime.id };
    case "audit.get":
      return { entries: FORBIDDEN.slice() };
    case "tabs.list":
      return await listTabs();
    case "tabs.create":
      return await createTab(params);
    case "tabs.close":
      await chrome.tabs.remove(params.tabId);
      return { ok: true };
    case "tabs.snapshot":
      return await snapshot(params.tabId);
    case "tabs.click":
      return await click(params.tabId, params.uid);
    case "tabs.fill":
      return await fill(params.tabId, params.uid, params.value);
    case "tabs.press":
      return await press(params.tabId, params.key);
    case "tabs.evaluate":
      return await evaluate(params.tabId, params.function);
    case "tabs.screenshot":
      return await screenshot(params.tabId);
    case "tabs.hasPointer":
      return await hasPointer(params.tabId);
    case "diagnostics.console":
      return cdpListConsole(params.tabId, params);
    case "diagnostics.network":
      return cdpListNetwork(params.tabId, params);
    case "diagnostics.consoleGet":
      return cdpGetConsole(params.tabId, params.msgid);
    case "diagnostics.networkGet":
      return await cdpGetNetwork(params.tabId, params.reqid);
    case "tabs.wait":
      return await waitFor(params);
    case "tabs.performance":
      return await performanceSummary(params.tabId);
    case "tabs.css":
      return await cssForUid(params.tabId, params.uid);
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  const groups = await chrome.tabGroups.query({});
  const gmap = Object.fromEntries(groups.map((g) => [g.id, g]));
  return tabs.map((t) => ({
    tabId: t.id,
    windowId: t.windowId,
    url: t.url || "",
    title: t.title || "",
    active: Boolean(t.active),
    groupId: t.groupId,
    tabGroup:
      t.groupId >= 0 && gmap[t.groupId] ? gmap[t.groupId].title || "" : null,
  }));
}

async function findGrokGroup(windowId) {
  const groups = await chrome.tabGroups.query({ windowId });
  return groups.find((g) => g.title === GROUP_TITLE) || null;
}

async function addToGrokGroup(tab) {
  const existing = await findGrokGroup(tab.windowId);
  let groupId;
  if (existing) {
    groupId = existing.id;
    await chrome.tabs.group({ tabIds: [tab.id], groupId });
  } else {
    groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, {
      title: GROUP_TITLE,
      color: GROUP_COLOR,
      collapsed: false,
    });
  }
  return groupId;
}

async function registerProbes() {
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ids = new Set(existing.map((s) => s.id));
  const scripts = [];
  if (!ids.has("gbc-probe-main")) {
    scripts.push({
      id: "gbc-probe-main",
      js: ["probe-main.js"],
      matches: ["http://*/*", "https://*/*"],
      runAt: "document_start",
      world: "MAIN",
      persistAcrossSessions: true,
    });
  }
  if (!ids.has("gbc-probe-bridge")) {
    scripts.push({
      id: "gbc-probe-bridge",
      js: ["probe-bridge.js"],
      matches: ["http://*/*", "https://*/*"],
      runAt: "document_start",
      persistAcrossSessions: true,
    });
  }
  if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
}

async function createTab(params) {
  const active = params.show !== false;
  if (active) {
    audit("tabs.create.active", { url: params.url, grouped: true });
  }
  await registerProbes().catch(() => {});
  const tab = await chrome.tabs.create({
    url: "about:blank",
    active,
  });
  grokTabIds.add(tab.id);
  const groupId = await addToGrokGroup(tab);
  await attachCdp(tab.id).catch(() => {});
  await chrome.tabs.update(tab.id, { url: params.url });
  await waitComplete(tab.id);
  await ensurePointer(tab.id);
  return {
    tabId: tab.id,
    url: tab.url || params.url,
    title: tab.title || "",
    groupId,
    tabGroup: GROUP_TITLE,
  };
}

function waitComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          clearInterval(timer);
          resolve(tab);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`tab ${tabId} load timeout`));
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, 100);
  });
}

async function snapshot(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const sel =
        'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]';
      const nodes = [...document.querySelectorAll(sel)].filter((el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          st.visibility !== "hidden" &&
          st.display !== "none"
        );
      });
      return {
        title: document.title,
        url: location.href,
        bodyText: (document.body && document.body.innerText
          ? document.body.innerText
          : ""
        ).slice(0, 4000),
        nodes: nodes.map((el, i) => {
          const uid = "e" + (i + 1);
          el.setAttribute("data-gbc-uid", uid);
          const label =
            (el.labels && el.labels[0] && el.labels[0].innerText) ||
            el.getAttribute("aria-label") ||
            el.getAttribute("placeholder") ||
            (el.innerText || "").trim().slice(0, 80) ||
            el.getAttribute("name") ||
            "";
          return {
            uid,
            tag: el.tagName.toLowerCase(),
            type: el.type || undefined,
            name: el.getAttribute("name") || undefined,
            id: el.id || undefined,
            label,
            value: "value" in el ? el.value : undefined,
          };
        }),
      };
    },
  });
  return result;
}

async function refreshGrokTabs() {
  grokTabIds.clear();
  const groups = await chrome.tabGroups.query({});
  const grok = groups.find((g) => g.title === GROUP_TITLE);
  if (!grok) return;
  const tabs = await chrome.tabs.query({ groupId: grok.id });
  for (const tab of tabs) {
    if (tab.id) grokTabIds.add(tab.id);
  }
}

function readConsole(params = {}) {
  const tabId = params.tabId;
  const level = params.level;
  const limit = Math.min(Number(params.limit) || 80, BUF_MAX);
  let rows = consoleBuf.slice();
  if (tabId != null) rows = rows.filter((r) => r.tabId === tabId);
  if (level && level !== "all") {
    rows = rows.filter((r) => r.level === level);
  }
  return { count: rows.length, entries: rows.slice(-limit) };
}

function readNetwork(params = {}) {
  const tabId = params.tabId;
  const limit = Math.min(Number(params.limit) || 80, BUF_MAX);
  let rows = networkBuf.slice();
  if (tabId != null) rows = rows.filter((r) => r.tabId === tabId);
  if (params.failedOnly) {
    rows = rows.filter(
      (r) => r.error || (typeof r.status === "number" && (r.status >= 400 || r.ok === false))
    );
  }
  return { count: rows.length, entries: rows.slice(-limit) };
}

async function ensurePointer(tabId) {
  grokTabIds.add(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["pointer.js"],
  }).catch(() => {});
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["probe-main.js"],
  }).catch(() => {});
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["probe-bridge.js"],
  }).catch(() => {});
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__gbcPointer && window.__gbcPointer.show(),
  }).catch(() => {});
  await attachCdp(tabId).catch(() => {});
}

async function paintGrokPointers() {
  await refreshGrokTabs();
  for (const tabId of grokTabIds) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !tab.url || !/^https?:/.test(tab.url)) continue;
    await ensurePointer(tab.id).catch(() => {});
  }
}

async function hasPointer(tabId) {
  await ensurePointer(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const shown = window.__gbcPointer ? window.__gbcPointer.show() : { has: false };
      const el = document.getElementById("gbc-pointer-root");
      return {
        has: Boolean(el),
        left: el ? el.style.left : shown.left || null,
        top: el ? el.style.top : shown.top || null,
      };
    },
  });
  return result;
}

async function click(tabId, uid) {
  await ensurePointer(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (targetUid) => {
      const el = document.querySelector(`[data-gbc-uid="${targetUid}"]`);
      if (!el) return { ok: false, error: "uid not found: " + targetUid };
      if (window.__gbcPointer) {
        const moved = await window.__gbcPointer.moveToUid(targetUid);
        if (!moved.ok) return moved;
        window.__gbcPointer.pulse();
      }
      el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      if (typeof el.click === "function") el.click();
      return { ok: true, tag: el.tagName.toLowerCase() };
    },
    args: [uid],
  });
  if (!result || !result.ok) throw new Error(result && result.error ? result.error : "click failed");
  return result;
}

async function fill(tabId, uid, value) {
  await ensurePointer(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (targetUid, nextValue) => {
      const el = document.querySelector(`[data-gbc-uid="${targetUid}"]`);
      if (!el) return { ok: false, error: "uid not found: " + targetUid };
      if (window.__gbcPointer) {
        await window.__gbcPointer.moveToUid(targetUid);
        window.__gbcPointer.pulse();
      }
      el.focus();
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, nextValue);
      else el.value = nextValue;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: el.value };
    },
    args: [uid, value],
  });
  if (!result || !result.ok) throw new Error(result && result.error ? result.error : "fill failed");
  return result;
}

async function press(tabId, key) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (k) => {
      const el = document.activeElement || document.body;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: k, bubbles: true }));
      if (k === "Enter" && el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
        const form = el.form;
        if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
      }
      return { ok: true };
    },
    args: [key],
  });
  return result;
}

async function waitFor(params) {
  const tabId = params.tabId;
  const timeoutMs = Number(params.timeoutMs) || 15000;
  if (params.networkIdle) {
    return await waitNetworkIdle(tabId, {
      idleMs: Number(params.idleMs) || 500,
      timeoutMs,
    });
  }
  if (params.consolePattern) {
    return await waitConsole(tabId, {
      pattern: params.consolePattern,
      timeoutMs,
    });
  }
  if (params.selector || params.uid) {
    const selector = params.selector || `[data-gbc-uid="${params.uid}"]`;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => Boolean(document.querySelector(sel)),
        args: [selector],
      });
      if (result) return { ok: true, waitedMs: Date.now() - start, selector };
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`wait_for selector timeout: ${selector}`);
  }
  throw new Error("wait_for needs networkIdle, consolePattern, selector, or uid");
}

async function evaluate(tabId, fnSource) {
  const target = await attachCdp(tabId);
  const expression = `(${fnSource})()`;
  const out = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (out.exceptionDetails) {
    const text =
      (out.exceptionDetails.exception && out.exceptionDetails.exception.description) ||
      out.exceptionDetails.text ||
      "evaluate failed";
    throw new Error(text);
  }
  return { value: out.result ? out.result.value : null };
}

async function screenshot(tabId) {
  const target = await attachCdp(tabId);
  const out = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  return { pngBase64: out.data };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "gbc-should-paint") {
    const tabId = sender.tab && sender.tab.id;
    refreshGrokTabs()
      .then(() => sendResponse({ paint: Boolean(tabId && grokTabIds.has(tabId)) }))
      .catch(() => sendResponse({ paint: false }));
    return true;
  }
  if (msg && msg.type === "gbc-probe" && msg.data) {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId || !grokTabIds.has(tabId)) return;
    if (msg.data.kind === "console") {
      pushBuf(consoleBuf, {
        tabId,
        level: msg.data.level,
        args: msg.data.args,
        href: msg.data.href,
        ts: msg.data.ts,
      });
    } else if (msg.data.kind === "fetch") {
      pushBuf(networkBuf, {
        tabId,
        source: "page",
        url: msg.data.url,
        status: msg.data.status,
        ok: msg.data.ok,
        error: msg.data.error,
        ms: msg.data.ms,
        href: msg.data.href,
        ts: msg.data.ts,
      });
    }
  }
});

if (chrome.webRequest) {
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (!grokTabIds.has(details.tabId)) return;
      pushBuf(networkBuf, {
        tabId: details.tabId,
        source: "webRequest",
        url: details.url,
        method: details.method,
        status: details.statusCode,
        type: details.type,
        fromCache: details.fromCache,
        ip: details.ip,
        ts: Date.now(),
      });
    },
    { urls: ["<all_urls>"] }
  );
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      if (!grokTabIds.has(details.tabId)) return;
      pushBuf(networkBuf, {
        tabId: details.tabId,
        source: "webRequest",
        url: details.url,
        method: details.method,
        error: details.error,
        type: details.type,
        ts: Date.now(),
      });
    },
    { urls: ["<all_urls>"] }
  );
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;
  if (!tab.url || !/^https?:/.test(tab.url)) return;
  paintGrokPointers().catch(() => {});
});
chrome.tabGroups.onUpdated.addListener(() => {
  paintGrokPointers().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  connect();
  paintGrokPointers().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  connect();
  paintGrokPointers().catch(() => {});
});
chrome.alarms.create("gbc-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "gbc-keepalive") {
    connect();
    paintGrokPointers().catch(() => {});
  }
});
connect();
registerProbes().catch(() => {});
paintGrokPointers().catch(() => {});
