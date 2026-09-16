import {
  attachCdp,
  detachCdp,
  detachAllCdp,
  cdpDeniedUrl,
  tabCdpDenied,
  listConsole as cdpListConsole,
  getConsole as cdpGetConsole,
  listNetwork as cdpListNetwork,
  getNetwork as cdpGetNetwork,
  waitNetworkIdle,
  waitConsole,
  performanceSummary,
  cssForUid,
  cdpClick,
  cdpHover,
} from "./cdp-collector.js";

const HOST_NAME = "com.xai.grok.browser";
const GROUP_TITLE = "Grok Browser";
const GROUP_COLOR = "cyan";
const FORBIDDEN = [];
const grokTabIds = new Set();
const lastSnap = new Map();
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
    reconnectDelayMs = 2000;
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
  send({
    type: "ready",
    extensionId: chrome.runtime.id,
    ts: Date.now(),
  });
}

let reconnectDelayMs = 2000;
function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(Math.max(reconnectDelayMs, 2000) * 2, 60000);
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
      return await click(params.tabId, params.uid, params);
    case "tabs.domClick":
      return await domClick(params.tabId, params.uid, params);
    case "debugger.detachAll":
      return await detachAllCdp();
    case "probes.unregister":
      await chrome.scripting
        .unregisterContentScripts({ ids: ["gbc-probe-main", "gbc-probe-bridge"] })
        .catch(() => {});
      return { ok: true };
    case "tabs.fill":
      return await fill(params.tabId, params.uid, params.value, params);
    case "tabs.press":
      return await press(params.tabId, params.key);
    case "tabs.hover":
      return await hover(params.tabId, params.uid);
    case "tabs.scroll":
      return await scroll(params.tabId, params);
    case "tabs.selectOption":
      return await selectOption(params.tabId, params.uid, params.value || params.label);
    case "tabs.evaluate":
      return await evaluate(params.tabId, params.function);
    case "tabs.screenshot":
      return await screenshot(params.tabId, params);
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

const PROBE_EXCLUDE = [
  "*://*.tiktok.com/*",
  "*://tiktok.com/*",
  "*://*.tiktokshop.com/*",
  "*://tiktokshop.com/*",
  "*://*.bytedance.com/*",
  "*://bytedance.com/*",
];

async function registerProbes() {
  await chrome.scripting
    .unregisterContentScripts({ ids: ["gbc-probe-main", "gbc-probe-bridge"] })
    .catch(() => {});
  await chrome.scripting.registerContentScripts([
    {
      id: "gbc-probe-main",
      js: ["probe-main.js"],
      matches: ["http://*/*", "https://*/*"],
      excludeMatches: PROBE_EXCLUDE,
      runAt: "document_start",
      world: "MAIN",
      persistAcrossSessions: false,
    },
    {
      id: "gbc-probe-bridge",
      js: ["probe-bridge.js"],
      matches: ["http://*/*", "https://*/*"],
      excludeMatches: PROBE_EXCLUDE,
      runAt: "document_start",
      persistAcrossSessions: false,
    },
  ]);
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
  const dest = String(params.url || "");
  const skipDebugger = cdpDeniedUrl(dest);
  if (!skipDebugger) await attachCdp(tab.id).catch(() => {});
  await chrome.tabs.update(tab.id, { url: params.url });
  await waitComplete(tab.id);
  const loadedUrl = (await chrome.tabs.get(tab.id).catch(() => tab)).url || dest;
  if (cdpDeniedUrl(loadedUrl)) detachCdp(tab.id);
  if (params.wait !== false && !cdpDeniedUrl(loadedUrl)) {
    await waitNetworkIdle(tab.id, {
      idleMs: Number(params.idleMs) || 300,
      timeoutMs: Number(params.timeoutMs) || 2500,
    }).catch(() => {});
  }
  await ensurePointer(tab.id);
  const loaded = await chrome.tabs.get(tab.id).catch(() => tab);
  return {
    tabId: tab.id,
    url: loaded.url || params.url,
    title: loaded.title || "",
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

function snapshotInFrame() {
  const DESTRUCTIVE =
    /(log\s*out|sign\s*out|signout|退出登录|注销|delete account|删除账号|删除账户|断开连接|解除连接|解除绑定|\bdisconnect\b)/i;
  const sel =
    'a, button, input, textarea, select, option, summary, [role], [onclick], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  const implicitRole = (el) => {
    const role = el.getAttribute("role");
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "option") return "option";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return tag;
  };
  const accessibleName = (el) => {
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const t = labelled
        .split(/\s+/)
        .map((id) => {
          const n = document.getElementById(id);
          return n ? (n.innerText || "").trim() : "";
        })
        .filter(Boolean)
        .join(" ");
      if (t) return t.slice(0, 80);
    }
    return (
      el.getAttribute("aria-label") ||
      (el.labels && el.labels[0] && el.labels[0].innerText) ||
      el.getAttribute("placeholder") ||
      el.getAttribute("alt") ||
      el.getAttribute("title") ||
      (el.innerText || "").trim().slice(0, 80) ||
      el.getAttribute("name") ||
      ""
    );
  };
  const nodes = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(sel)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (el.closest("script, style, noscript")) continue;
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const isOption = tag === "option";
    const st = getComputedStyle(el);
    if (!isOption && (r.width <= 0 || r.height <= 0)) continue;
    if (st.visibility === "hidden" || st.display === "none") continue;
    if (el.getAttribute("aria-hidden") === "true") continue;
    const name = String(accessibleName(el) || "").trim();
    const href = el.href || el.getAttribute("href") || "";
    const destructive =
      DESTRUCTIVE.test(`${name} ${href}`) || /^(删除|delete)$/i.test(name);
    const uid = "e" + (nodes.length + 1);
    el.setAttribute("data-gbc-uid", uid);
    if (destructive) el.setAttribute("data-gbc-destructive", "1");
    else el.removeAttribute("data-gbc-destructive");
    let x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    try {
      let win = window;
      while (win !== win.top) {
        const frame = win.frameElement;
        if (!frame) break;
        const fr = frame.getBoundingClientRect();
        x += fr.left;
        y += fr.top;
        win = win.parent;
      }
    } catch {
      // cross-origin parent
    }
    nodes.push({
      uid,
      tag,
      role: implicitRole(el),
      name,
      label: name,
      type: el.type || undefined,
      id: el.id || undefined,
      disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
      destructive,
      inDialog: Boolean(
        el.closest('[role="dialog"], [aria-modal="true"], [data-testid="twc-dialog"]')
      ),
      testId: el.getAttribute("data-testid") || undefined,
      inViewport:
        r.bottom > 0 &&
        r.right > 0 &&
        r.top < (window.innerHeight || 0) &&
        r.left < (window.innerWidth || 0),
      value: "value" in el ? String(el.value || "").slice(0, 80) : undefined,
      href: href ? String(href).slice(0, 200) : undefined,
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }
  let crossOrigin = false;
  try {
    void window.top.document;
  } catch {
    crossOrigin = true;
  }
  return {
    href: location.href,
    title: document.title,
    excerpt: (document.body && document.body.innerText
      ? document.body.innerText
      : ""
    ).slice(0, 800),
    crossOrigin,
    nodes,
  };
}

async function snapshot(tabId) {
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: snapshotInFrame,
  });
  const frames = [];
  const nodes = [];
  let title = "";
  let url = "";
  let excerpt = "";
  for (const inj of injections || []) {
    const res = inj.result;
    if (!res) {
      frames.push({ frameId: inj.frameId, crossOrigin: true });
      continue;
    }
    const prefix = `f${inj.frameId}-`;
    const pairs = (res.nodes || []).map((n) => [n.uid, prefix + n.uid]);
    if (pairs.length) {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [inj.frameId] },
        func: (list) => {
          for (const [from, to] of list) {
            const el = document.querySelector(`[data-gbc-uid="${from}"]`);
            if (el) el.setAttribute("data-gbc-uid", to);
          }
        },
        args: [pairs],
      }).catch(() => {});
    }
    if (!url && res.href) url = res.href;
    if (!title && res.title) title = res.title;
    if (!excerpt && res.excerpt) excerpt = res.excerpt;
    frames.push({
      frameId: inj.frameId,
      href: res.href,
      crossOrigin: Boolean(res.crossOrigin),
      nodeCount: (res.nodes || []).length,
    });
    for (const n of res.nodes || []) {
      nodes.push({ ...n, uid: prefix + n.uid, frameId: inj.frameId });
    }
  }
  const out = {
    title,
    url,
    excerpt,
    bodyText: excerpt,
    frames,
    nodes,
  };
  lastSnap.set(tabId, out);
  return out;
}

async function locateUid(tabId, uid) {
  const cached = lastSnap.get(tabId);
  const cachedNode = cached && cached.nodes && cached.nodes.find((n) => n.uid === uid);
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (targetUid) => {
      const el = document.querySelector(`[data-gbc-uid="${targetUid}"]`);
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = el.getBoundingClientRect();
      let x = r.left + r.width / 2;
      let y = r.top + r.height / 2;
      try {
        let win = window;
        while (win !== win.top) {
          const frame = win.frameElement;
          if (!frame) break;
          const fr = frame.getBoundingClientRect();
          x += fr.left;
          y += fr.top;
          win = win.parent;
        }
      } catch {
        // cross-origin parent
      }
      const name =
        el.getAttribute("aria-label") ||
        (el.innerText || "").trim().slice(0, 80) ||
        el.getAttribute("name") ||
        "";
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        name,
        destructive: el.getAttribute("data-gbc-destructive") === "1",
        disabled: Boolean(el.disabled),
        x,
        y,
        w: r.width,
        h: r.height,
      };
    },
    args: [uid],
  });
  const hit = (injections || []).find((inj) => inj.result && inj.result.ok);
  if (!hit) {
    return { ok: false, error: "uid not found: " + uid };
  }
  return {
    ...hit.result,
    frameId: hit.frameId,
    uid,
    destructive: Boolean(
      (hit.result && hit.result.destructive) ||
        (cachedNode && cachedNode.destructive)
    ),
    name: (hit.result && hit.result.name) || (cachedNode && cachedNode.name) || "",
  };
}

function refuseDestructive(loc, confirmDestructive) {
  if (loc.destructive && !confirmDestructive) {
    throw new Error(
      `Refusing destructive click on ${loc.uid} (${loc.name || loc.tag}). Pass confirmDestructive: true if you really mean it.`
    );
  }
}

async function movePointerTo(tabId, x, y, pulse) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (px, py, doPulse) => {
      if (!window.__gbcPointer) return;
      window.__gbcPointer.move(px, py);
      if (doPulse) window.__gbcPointer.pulse();
    },
    args: [x, y, Boolean(pulse)],
  }).catch(() => {});
}

async function maybeWait(tabId, params) {
  if (params && params.wait === false) return;
  await waitNetworkIdle(tabId, {
    idleMs: Number(params && params.idleMs) || 300,
    timeoutMs: Number(params && params.timeoutMs) || 2500,
  }).catch(() => {});
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
  if (!(await tabCdpDenied(tabId))) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["probe-main.js"],
    }).catch(() => {});
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["probe-bridge.js"],
    }).catch(() => {});
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__gbcPointer && window.__gbcPointer.show(),
  }).catch(() => {});
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

async function click(tabId, uid, params = {}) {
  await ensurePointer(tabId);
  const loc = await locateUid(tabId, uid);
  if (!loc.ok) throw new Error(loc.error || "uid not found");
  refuseDestructive(loc, params.confirmDestructive);
  await movePointerTo(tabId, loc.x, loc.y, true);
  const deny = await tabCdpDenied(tabId);
  let via = deny ? "dom" : "cdp";
  try {
    if (deny) throw new Error("cdp denied");
    await cdpClick(tabId, loc.x, loc.y);
  } catch {
    via = "dom";
    const injections = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (targetUid) => {
        const el = document.querySelector(`[data-gbc-uid="${targetUid}"]`);
        if (!el) return null;
        el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        if (typeof el.click === "function") el.click();
        return { ok: true, tag: el.tagName.toLowerCase() };
      },
      args: [uid],
    });
    const hit = (injections || []).find((inj) => inj.result && inj.result.ok);
    if (!hit) throw new Error("click failed");
  }
  await maybeWait(tabId, params);
  return { ok: true, uid, tag: loc.tag, name: loc.name, via };
}

async function domClick(tabId, uid, params = {}) {
  const loc = await locateUid(tabId, uid);
  if (!loc.ok) throw new Error(loc.error || "uid not found");
  refuseDestructive(loc, params.confirmDestructive);
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (targetUid) => {
      const el = document.querySelector(`[data-gbc-uid="${targetUid}"]`);
      if (!el) return null;
      el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      if (typeof el.click === "function") el.click();
      return { ok: true, tag: el.tagName.toLowerCase() };
    },
    args: [uid],
  });
  const hit = (injections || []).find((inj) => inj.result && inj.result.ok);
  if (!hit) throw new Error("domClick failed");
  return { ok: true, uid, tag: loc.tag, name: loc.name, via: "dom" };
}

async function fill(tabId, uid, value, params = {}) {
  await ensurePointer(tabId);
  const loc = await locateUid(tabId, uid);
  if (!loc.ok) throw new Error(loc.error || "uid not found");
  refuseDestructive(loc, params.confirmDestructive);
  await movePointerTo(tabId, loc.x, loc.y, true);
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (targetUid, nextValue) => {
      const el = document.querySelector(`[data-gbc-uid="${targetUid}"]`);
      if (!el) return null;
      el.focus();
      const editable =
        el.isContentEditable || el.getAttribute("contenteditable") === "true";
      if (editable) {
        document.execCommand("selectAll");
        document.execCommand("delete");
        const lines = String(nextValue).split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (i > 0) document.execCommand("insertLineBreak");
          if (lines[i]) document.execCommand("insertText", false, lines[i]);
        }
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        return { ok: true, via: "contenteditable", text: (el.innerText || "").slice(0, 500) };
      }
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value") &&
        Object.getOwnPropertyDescriptor(proto, "value").set;
      if (setter) setter.call(el, nextValue);
      else el.value = nextValue;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, via: "value", value: el.value };
    },
    args: [uid, value],
  });
  const hit = (injections || []).find((inj) => inj.result && inj.result.ok);
  if (!hit) throw new Error("fill failed");
  await maybeWait(tabId, params);
  return hit.result;
}

async function hover(tabId, uid) {
  await ensurePointer(tabId);
  const loc = await locateUid(tabId, uid);
  if (!loc.ok) throw new Error(loc.error || "uid not found");
  await movePointerTo(tabId, loc.x, loc.y, false);
  try {
    if (await tabCdpDenied(tabId)) throw new Error("cdp denied");
    await cdpHover(tabId, loc.x, loc.y);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: loc.frameId != null ? [loc.frameId] : undefined },
      func: (targetUid) => {
        const el = document.querySelector(`[data-gbc-uid="${targetUid}"]`);
        if (!el) return;
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      },
      args: [uid],
    });
  }
  return { ok: true, uid, x: loc.x, y: loc.y };
}

async function scroll(tabId, params = {}) {
  if (params.uid) {
    const loc = await locateUid(tabId, params.uid);
    if (!loc.ok) throw new Error(loc.error || "uid not found");
    return { ok: true, uid: params.uid, x: loc.x, y: loc.y };
  }
  const dy = Number(params.dy) || 0;
  const dx = Number(params.dx) || 0;
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (x, y) => window.scrollBy(x, y),
    args: [dx, dy],
  });
  return { ok: true, dx, dy };
}

async function selectOption(tabId, uid, value) {
  if (value == null || value === "") throw new Error("select_option needs value or label");
  const loc = await locateUid(tabId, uid);
  if (!loc.ok) throw new Error(loc.error || "uid not found");
  await movePointerTo(tabId, loc.x, loc.y, true);
  const injections = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (targetUid, want) => {
      let el = document.querySelector(`[data-gbc-uid="${targetUid}"]`);
      if (!el) return null;
      if (el.tagName.toLowerCase() === "option") {
        el = el.closest("select") || el;
      }
      if (el.tagName.toLowerCase() !== "select") {
        return { ok: false, error: "not a select" };
      }
      const wantStr = String(want);
      let matched = false;
      for (const opt of el.options) {
        if (opt.value === wantStr || (opt.textContent || "").trim() === wantStr) {
          el.value = opt.value;
          matched = true;
          break;
        }
      }
      if (!matched) return { ok: false, error: "option not found: " + wantStr };
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: el.value };
    },
    args: [uid, value],
  });
  const hit = (injections || []).find((inj) => inj.result);
  if (!hit || !hit.result.ok) {
    throw new Error((hit && hit.result && hit.result.error) || "select_option failed");
  }
  return hit.result;
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
  if (await tabCdpDenied(tabId)) {
    const injections = await chrome.scripting.executeScript({
      target: { tabId },
      func: (src) => new Function(`return (${src})()`)(),
      args: [fnSource],
    });
    return {
      value: injections && injections[0] ? injections[0].result : null,
      via: "scripting",
      cdpDenied: true,
    };
  }
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

async function screenshot(tabId, params = {}) {
  if (await tabCdpDenied(tabId)) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active) {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return {
        pngBase64: String(dataUrl || "").replace(/^data:image\/png;base64,/, ""),
        via: "captureVisibleTab",
        cdpDenied: true,
      };
    }
    return {
      pngBase64: null,
      skipped: true,
      cdpDenied: true,
      reason: "cdp denied on this origin; tab is not visible so no screenshot",
    };
  }
  await maybeWait(tabId, params);
  const target = await attachCdp(tabId);
  const out = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  return { pngBase64: out.data };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  grokTabIds.delete(tabId);
  lastSnap.delete(tabId);
  try {
    detachCdp(tabId);
  } catch {
    // ignore
  }
});

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
  refreshGrokTabs()
    .then(() => {
      if (grokTabIds.has(tabId)) return ensurePointer(tabId);
    })
    .catch(() => {});
});
chrome.tabGroups.onUpdated.addListener(() => {
  paintGrokPointers().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  connect();
  registerProbes().catch(() => {});
  paintGrokPointers().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  connect();
  registerProbes().catch(() => {});
  paintGrokPointers().catch(() => {});
});
chrome.alarms.create("gbc-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "gbc-keepalive") connect();
});
connect();
registerProbes().catch(() => {});
paintGrokPointers().catch(() => {});
