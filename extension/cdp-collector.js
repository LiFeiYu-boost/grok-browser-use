const attached = new Set();
const stores = new Map();
const MAX_NAV = 3;
const MAX_PER_NAV = 1000;
const BODY_LIMIT = 10000;

function storeFor(tabId) {
  if (!stores.has(tabId)) {
    stores.set(tabId, {
      nextId: 1,
      navs: [emptyNav()],
      byRequestId: new Map(),
      inFlight: new Set(),
      inFlightAt: new Map(),
    });
  }
  return stores.get(tabId);
}

function emptyNav() {
  return { console: [], network: [] };
}

function current(store) {
  return store.navs[0];
}

function splitNav(store) {
  store.navs.unshift(emptyNav());
  store.navs.splice(MAX_NAV);
  store.byRequestId.clear();
}

function allNavs(store, includePreserved) {
  return includePreserved ? store.navs : [store.navs[0]];
}

function previewArg(arg) {
  if (!arg) return null;
  if (arg.value !== undefined) return arg.value;
  if (arg.description) return arg.description;
  if (arg.unserializableValue) return arg.unserializableValue;
  if (arg.type) return `[${arg.type}]`;
  return null;
}

function pushLimited(arr, item) {
  arr.push(item);
  if (arr.length > MAX_PER_NAV) arr.splice(0, arr.length - MAX_PER_NAV);
}

export function cdpDeniedUrl(url) {
  const s = String(url || "");
  try {
    const host = new URL(s).hostname.toLowerCase();
    return (
      /(^|\.)tiktok\.com$/.test(host) ||
      /(^|\.)tiktokshop\.com$/.test(host) ||
      /(^|\.)bytedance\.com$/.test(host)
    );
  } catch {
    return /tiktok|tiktokshop|bytedance/i.test(s);
  }
}

export async function tabCdpDenied(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return cdpDeniedUrl(tab && tab.url);
}

export async function attachCdp(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (cdpDeniedUrl(tab && tab.url)) {
    const err = new Error("cdp denied for origin: " + ((tab && tab.url) || tabId));
    err.code = "CDP_DENIED";
    throw err;
  }
  const target = { tabId };
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach(target, "1.3");
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (!/already attached/i.test(msg)) throw err;
    }
    attached.add(tabId);
    storeFor(tabId);
    await chrome.debugger.sendCommand(target, "Network.enable", {
      maxPostDataSize: 65536,
    });
    await chrome.debugger.sendCommand(target, "Runtime.enable", {});
    await chrome.debugger.sendCommand(target, "Page.enable", {});
    await chrome.debugger.sendCommand(target, "Log.enable", {});
    await chrome.debugger.sendCommand(target, "Performance.enable", {}).catch(() => {});
    await chrome.debugger.sendCommand(target, "DOM.enable", {}).catch(() => {});
    await chrome.debugger.sendCommand(target, "CSS.enable", {}).catch(() => {});
  }
  return target;
}

export function detachCdp(tabId) {
  attached.delete(tabId);
  stores.delete(tabId);
  chrome.debugger.detach({ tabId }).catch(() => {});
}

export async function detachAllCdp() {
  const ids = [...attached];
  for (const tabId of ids) detachCdp(tabId);
  const targets = await chrome.debugger.getTargets().catch(() => []);
  for (const target of targets) {
    if (target.tabId == null || !target.attached) continue;
    try {
      await chrome.debugger.detach({ tabId: target.tabId });
    } catch {
      // already detached
    }
    attached.delete(target.tabId);
    stores.delete(target.tabId);
  }
  return { detached: ids.length };
}

export function listConsole(tabId, params = {}) {
  const store = storeFor(tabId);
  const limit = Math.min(Number(params.limit) || 100, MAX_PER_NAV);
  let rows = [];
  for (const nav of allNavs(store, params.includePreserved)) {
    rows = rows.concat(nav.console);
  }
  if (params.level && params.level !== "all") {
    rows = rows.filter((r) => r.type === params.level || r.level === params.level);
  }
  if (Array.isArray(params.types) && params.types.length) {
    rows = rows.filter((r) => params.types.includes(r.type));
  }
  return { count: rows.length, entries: rows.slice(-limit) };
}

export function getConsole(tabId, msgid) {
  const store = storeFor(tabId);
  for (const nav of store.navs) {
    const hit = nav.console.find((r) => r.msgid === msgid);
    if (hit) return hit;
  }
  throw new Error(`console message not found: ${msgid}`);
}

export function listNetwork(tabId, params = {}) {
  const store = storeFor(tabId);
  const limit = Math.min(Number(params.limit) || 100, MAX_PER_NAV);
  let rows = [];
  for (const nav of allNavs(store, params.includePreserved)) {
    rows = rows.concat(nav.network);
  }
  if (params.failedOnly) {
    rows = rows.filter(
      (r) => r.failed || (typeof r.status === "number" && r.status >= 400)
    );
  }
  if (Array.isArray(params.resourceTypes) && params.resourceTypes.length) {
    const want = new Set(params.resourceTypes.map((t) => String(t).toLowerCase()));
    rows = rows.filter((r) => want.has(String(r.resourceType || "").toLowerCase()));
  }
  const slim = rows.slice(-limit).map((r) => ({
    reqid: r.reqid,
    method: r.method,
    url: r.url,
    status: r.status,
    mimeType: r.mimeType,
    resourceType: r.resourceType,
    failed: r.failed,
    errorText: r.errorText,
    encodedDataLength: r.encodedDataLength,
    durationMs: r.durationMs,
  }));
  return { count: rows.length, entries: slim };
}

export async function getNetwork(tabId, reqid) {
  const store = storeFor(tabId);
  let entry;
  for (const nav of store.navs) {
    entry = nav.network.find((r) => r.reqid === reqid);
    if (entry) break;
  }
  if (!entry) throw new Error(`network request not found: ${reqid}`);
  const detail = {
    reqid: entry.reqid,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    statusText: entry.statusText,
    mimeType: entry.mimeType,
    resourceType: entry.resourceType,
    failed: entry.failed,
    errorText: entry.errorText,
    requestHeaders: entry.requestHeaders,
    responseHeaders: entry.responseHeaders,
    encodedDataLength: entry.encodedDataLength,
    durationMs: entry.durationMs,
    requestBody: entry.postData,
  };
  if (entry.cdpRequestId && attached.has(tabId)) {
    try {
      const body = await chrome.debugger.sendCommand(
        { tabId },
        "Network.getResponseBody",
        { requestId: entry.cdpRequestId }
      );
      if (body && body.body != null) {
        const text = body.base64Encoded
          ? BufferLike(body.body)
          : String(body.body);
        detail.responseBody = text.length > BODY_LIMIT
          ? text.slice(0, BODY_LIMIT) + `\n<truncated ${text.length} bytes>`
          : text;
      }
    } catch {
      detail.responseBody = "<Response body not available anymore>";
    }
    try {
      const post = await chrome.debugger.sendCommand(
        { tabId },
        "Network.getRequestPostData",
        { requestId: entry.cdpRequestId }
      );
      if (post && post.postData && !detail.requestBody) {
        detail.requestBody =
          post.postData.length > BODY_LIMIT
            ? post.postData.slice(0, BODY_LIMIT) + "\n<truncated>"
            : post.postData;
      }
    } catch {
      // no post data
    }
  }
  return detail;
}

function BufferLike(b64) {
  try {
    return atob(b64).slice(0, BODY_LIMIT);
  } catch {
    return "<binary>";
  }
}

function onEvent(source, method, params) {
  const tabId = source.tabId;
  if (tabId == null || !stores.has(tabId)) return;
  const store = storeFor(tabId);
  const nav = current(store);

  if (method === "Page.frameNavigated" && params.frame && !params.frame.parentId) {
    if (nav.network.length || nav.console.length) splitNav(store);
    return;
  }

  if (method === "Runtime.consoleAPICalled") {
    const msgid = store.nextId++;
    pushLimited(nav.console, {
      msgid,
      type: params.type,
      level: params.type,
      args: (params.args || []).map(previewArg),
      timestamp: params.timestamp,
      stack: params.stackTrace
        ? (params.stackTrace.callFrames || []).slice(0, 8).map((f) => ({
            functionName: f.functionName,
            url: f.url,
            line: f.lineNumber,
            column: f.columnNumber,
          }))
        : undefined,
    });
    return;
  }

  if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails || {};
    const msgid = store.nextId++;
    pushLimited(nav.console, {
      msgid,
      type: "error",
      level: "error",
      args: [
        d.text || (d.exception && d.exception.description) || "uncaught",
      ],
      timestamp: params.timestamp,
      stack: d.stackTrace
        ? (d.stackTrace.callFrames || []).slice(0, 8)
        : undefined,
    });
    return;
  }

  if (method === "Log.entryAdded" && params.entry) {
    const msgid = store.nextId++;
    pushLimited(nav.console, {
      msgid,
      type: params.entry.level || "log",
      level: params.entry.level,
      args: [params.entry.text],
      url: params.entry.url,
      timestamp: params.entry.timestamp,
    });
    return;
  }

  if (method === "Network.requestWillBeSent") {
    const reqid = store.nextId++;
    const entry = {
      reqid,
      cdpRequestId: params.requestId,
      method: params.request && params.request.method,
      url: params.request && params.request.url,
      resourceType: String(params.type || "Other").toLowerCase(),
      requestHeaders: params.request && params.request.headers,
      postData: params.request && params.request.postData,
      startTime: params.timestamp,
      failed: false,
    };
    store.byRequestId.set(params.requestId, entry);
    store.inFlight.add(params.requestId);
    if (!store.inFlightAt) store.inFlightAt = new Map();
    store.inFlightAt.set(params.requestId, Date.now());
    pushLimited(nav.network, entry);
    return;
  }

  if (method === "Network.responseReceived") {
    const entry = store.byRequestId.get(params.requestId);
    if (!entry) return;
    const res = params.response || {};
    entry.status = res.status;
    entry.statusText = res.statusText;
    entry.mimeType = res.mimeType;
    entry.responseHeaders = res.headers;
    entry.remoteIPAddress = res.remoteIPAddress;
    if (res.timing) {
      entry.durationMs = Math.round(
        (res.timing.receiveHeadersEnd || 0) - (res.timing.sendStart || 0)
      );
    }
    return;
  }

  if (method === "Network.loadingFinished") {
    const entry = store.byRequestId.get(params.requestId);
    store.inFlight.delete(params.requestId);
    store.inFlightAt && store.inFlightAt.delete(params.requestId);
    if (!entry) return;
    entry.encodedDataLength = params.encodedDataLength;
    if (entry.startTime != null && params.timestamp != null) {
      entry.durationMs = Math.round((params.timestamp - entry.startTime) * 1000);
    }
    return;
  }

  if (method === "Network.loadingFailed") {
    const entry = store.byRequestId.get(params.requestId);
    store.inFlight.delete(params.requestId);
    store.inFlightAt && store.inFlightAt.delete(params.requestId);
    if (!entry) return;
    entry.failed = true;
    entry.errorText = params.errorText;
    entry.canceled = params.canceled;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function inFlightCount(tabId) {
  const store = stores.get(tabId);
  return store ? store.inFlight.size : 0;
}

function blockingInFlight(tabId, staleMs) {
  const store = stores.get(tabId);
  if (!store) return 0;
  const now = Date.now();
  let n = 0;
  for (const id of store.inFlight) {
    const started = store.inFlightAt && store.inFlightAt.get(id);
    if (started == null || now - started < staleMs) n += 1;
  }
  return n;
}

export async function waitNetworkIdle(tabId, params = {}) {
  const idleMs = Number(params.idleMs) || 500;
  const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 8000, 500), 15000);
  const staleMs = Number(params.staleMs) || 2500;
  const start = Date.now();
  let idleSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (blockingInFlight(tabId, staleMs) === 0) {
      if (Date.now() - idleSince >= idleMs) {
        return {
          ok: true,
          waitedMs: Date.now() - start,
          inFlight: inFlightCount(tabId),
        };
      }
    } else {
      idleSince = Date.now();
    }
    await sleep(50);
  }
  return {
    ok: false,
    timedOut: true,
    waitedMs: Date.now() - start,
    inFlight: inFlightCount(tabId),
  };
}

export async function waitConsole(tabId, params = {}) {
  const timeoutMs = Number(params.timeoutMs) || 10000;
  const pattern = params.pattern;
  if (!pattern) throw new Error("wait_for console requires pattern");
  const re = new RegExp(pattern);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { entries } = listConsole(tabId, { includePreserved: true, limit: MAX_PER_NAV });
    const hit = entries.find((e) => re.test(JSON.stringify(e.args || [])));
    if (hit) return { ok: true, waitedMs: Date.now() - start, message: hit };
    await sleep(50);
  }
  throw new Error(`wait_for console timeout: ${pattern}`);
}

export async function performanceSummary(tabId) {
  await attachCdp(tabId);
  let metrics = [];
  try {
    const out = await chrome.debugger.sendCommand({ tabId }, "Performance.getMetrics", {});
    metrics = out.metrics || [];
  } catch {
    // ignore
  }
  const evaled = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: `(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      const paints = performance.getEntriesByType("paint");
      const lcp = performance.getEntriesByType("largest-contentful-paint").slice(-1)[0];
      let longTasks = [];
      try {
        longTasks = performance.getEntriesByType("longtask").map((e) => ({
          duration: e.duration,
          startTime: e.startTime,
        }));
      } catch (e) {}
      return {
        ttfbMs: nav ? Math.round(nav.responseStart) : null,
        dclMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        loadMs: nav ? Math.round(nav.loadEventEnd) : null,
        fpMs: (paints.find((p) => p.name === "first-paint") || {}).startTime || null,
        fcpMs: (paints.find((p) => p.name === "first-contentful-paint") || {}).startTime || null,
        lcpMs: lcp ? Math.round(lcp.startTime) : null,
        lcpSize: lcp ? lcp.size : null,
        longTaskCount: longTasks.length,
        longTasks: longTasks.slice(0, 12),
      };
    })()`,
    returnByValue: true,
  });
  return {
    page: evaled.result && evaled.result.value,
    metrics: metrics.slice(0, 40),
  };
}

export async function cssForUid(tabId, uid) {
  await attachCdp(tabId);
  await chrome.debugger.sendCommand({ tabId }, "DOM.enable", {});
  await chrome.debugger.sendCommand({ tabId }, "CSS.enable", {});
  const doc = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", {
    depth: 0,
  });
  const { nodeId } = await chrome.debugger.sendCommand(
    { tabId },
    "DOM.querySelector",
    {
      nodeId: doc.root.nodeId,
      selector: `[data-gbc-uid="${uid}"]`,
    }
  );
  if (!nodeId) throw new Error("uid not in DOM; snapshot first");
  const { computedStyle } = await chrome.debugger.sendCommand(
    { tabId },
    "CSS.getComputedStyleForNode",
    { nodeId }
  );
  const wanted = [
    "display",
    "visibility",
    "opacity",
    "color",
    "background-color",
    "font-size",
    "font-weight",
    "width",
    "height",
    "position",
    "z-index",
  ];
  const map = Object.fromEntries((computedStyle || []).map((s) => [s.name, s.value]));
  return {
    uid,
    nodeId,
    style: Object.fromEntries(wanted.map((k) => [k, map[k]])),
  };
}

export async function dispatchMouse(tabId, { type, x, y, button = "left", clickCount = 1 }) {
  const target = await attachCdp(tabId);
  const params = {
    type,
    x: Number(x),
    y: Number(y),
    pointerType: "mouse",
  };
  if (type === "mousePressed" || type === "mouseReleased") {
    params.button = button;
    params.clickCount = clickCount;
  }
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", params);
}

export async function cdpHover(tabId, x, y) {
  await dispatchMouse(tabId, { type: "mouseMoved", x, y });
}

export async function cdpClick(tabId, x, y) {
  await dispatchMouse(tabId, { type: "mouseMoved", x, y });
  await dispatchMouse(tabId, { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await dispatchMouse(tabId, { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const emulateOrigins = new Map();

export function isEmulatedTab(tabId) {
  return emulateOrigins.has(tabId);
}

export function parseViewport(spec) {
  if (spec == null || spec === "") return { clear: true };
  if (typeof spec === "object") return spec;
  const raw = String(spec).trim().toLowerCase();
  if (raw === "reset" || raw === "off" || raw === "desktop") return { clear: true };
  const presets = {
    iphone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true },
    "iphone-se": { width: 375, height: 667, deviceScaleFactor: 2, mobile: true, touch: true },
    pixel: { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true },
  };
  if (presets[raw]) return presets[raw];
  const parts = raw.split(",");
  const m = String(parts[0] || "").match(/^(\d+)\s*x\s*(\d+)(?:\s*x\s*([\d.]+))?$/);
  if (!m) throw new Error('viewport must look like "390x844x3,mobile,touch" or "iphone" or "reset"');
  const flags = new Set(parts.slice(1).map((s) => s.trim()).filter(Boolean));
  return {
    width: Number(m[1]),
    height: Number(m[2]),
    deviceScaleFactor: m[3] ? Number(m[3]) : 3,
    mobile: flags.has("mobile") || flags.has("phone"),
    touch: flags.has("touch") || flags.has("mobile") || flags.has("phone"),
    userAgent: flags.has("ua") || flags.has("useragent") ? IPHONE_UA : undefined,
  };
}

export async function emulateDevice(tabId, spec) {
  const parsed = parseViewport(spec && spec.viewport != null ? spec.viewport : spec);
  const target = await attachCdp(tabId);
  if (parsed.clear) {
    await chrome.debugger.sendCommand(target, "Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
    await chrome.debugger
      .sendCommand(target, "Emulation.setTouchEmulationEnabled", { enabled: false })
      .catch(() => {});
    await restoreEmulateWindow(tabId);
    return { ok: true, cleared: true, tabId };
  }
  const width = Number(parsed.width);
  const height = Number(parsed.height);
  if (!width || !height) throw new Error("emulate needs width and height");
  const deviceScaleFactor = Number(parsed.deviceScaleFactor) || 1;
  const mobile = parsed.mobile !== false;
  let metricsError = null;
  try {
    await chrome.debugger.sendCommand(target, "Emulation.setVisibleSize", { width, height });
  } catch (err) {
    metricsError = "setVisibleSize: " + String(err && err.message ? err.message : err);
  }
  try {
    await chrome.debugger.sendCommand(target, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile,
      screenWidth: width,
      screenHeight: height,
      positionX: 0,
      positionY: 0,
      dontSetVisibleSize: false,
      screenOrientation: { type: "portraitPrimary", angle: 0 },
    });
  } catch (err) {
    metricsError = (metricsError ? metricsError + "; " : "") + String(err && err.message ? err.message : err);
  }
  if (parsed.touch !== false) {
    await chrome.debugger
      .sendCommand(target, "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 })
      .catch(() => {});
  }
  if (parsed.userAgent || mobile) {
    await chrome.debugger
      .sendCommand(target, "Network.setUserAgentOverride", {
        userAgent: parsed.userAgent || IPHONE_UA,
      })
      .catch(() => {});
  }
  const shouldReload = spec && spec.reload === false ? false : true;
  if (shouldReload) {
    await chrome.tabs.reload(tabId).catch(() => {});
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(async () => {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab && tab.status === "complete") {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > 15000) {
          clearInterval(timer);
          reject(new Error("emulate reload timeout"));
        }
      }, 100);
    }).catch(() => {});
    await attachCdp(tabId).catch(() => {});
  }
  await sleep(150);
  const measure = async () => {
    try {
      const dim = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "({ innerWidth: window.innerWidth, innerHeight: window.innerHeight })",
        returnByValue: true,
      });
      return (dim && dim.result && dim.result.value) || {};
    } catch {
      return {};
    }
  };
  let { innerWidth, innerHeight } = await measure();
  let shell = "cdp";
  let windowId = null;
  if (!(innerWidth && Math.abs(innerWidth - width) <= 80)) {
    await chrome.debugger
      .sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride", {})
      .catch(() => {});
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const originWindowId = tab && tab.windowId;
    let groupTitle = "";
    if (tab && tab.groupId >= 0) {
      const g = await chrome.tabGroups.get(tab.groupId).catch(() => null);
      groupTitle = (g && g.title) || "";
    }
    await chrome.tabs.ungroup(tabId).catch(() => {});
    const popup = await chrome.windows.create({
      tabId,
      type: "popup",
      focused: false,
      width: width + 16,
      height: height + 88,
    }).catch(() => null);
    if (popup && popup.id) {
      windowId = popup.id;
      shell = "popup";
      await chrome.windows
        .update(popup.id, { width: width + 16, height: height + 88, focused: false })
        .catch(() => {});
      await attachCdp(tabId).catch(() => {});
      await sleep(200);
      const again = await measure();
      innerWidth = again.innerWidth;
      innerHeight = again.innerHeight;
      try {
        const bounds = await chrome.windows.get(popup.id);
        const placed = await chrome.tabs.get(tabId);
        const vis = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            outerWidth: window.outerWidth,
          }),
        });
        const v = vis && vis[0] && vis[0].result;
        if (v && v.innerWidth) {
          innerWidth = v.innerWidth;
          innerHeight = v.innerHeight;
        }
        metricsError =
          (metricsError ? metricsError + "; " : "") +
          `popup ${bounds.width}x${bounds.height} tabWin=${placed.windowId} outer=${v && v.outerWidth}`;
      } catch (err) {
        metricsError = (metricsError ? metricsError + "; " : "") + String(err && err.message ? err.message : err);
      }
      emulateOrigins.set(tabId, { originWindowId, groupTitle });
    }
  }
  return {
    ok: true,
    tabId,
    width,
    height,
    deviceScaleFactor,
    mobile,
    touch: parsed.touch !== false,
    userAgent: Boolean(parsed.userAgent || mobile),
    reloaded: shouldReload,
    innerWidth,
    innerHeight,
    shell,
    windowId,
    metricsError,
  };
}

async function restoreEmulateWindow(tabId) {
  const rec = emulateOrigins.get(tabId);
  emulateOrigins.delete(tabId);
  if (!rec || !rec.originWindowId) return;
  try {
    await chrome.tabs.move(tabId, { windowId: rec.originWindowId, index: -1 });
    if (rec.groupTitle) {
      const groups = await chrome.tabGroups.query({ windowId: rec.originWindowId });
      const g = groups.find((x) => x.title === rec.groupTitle);
      if (g) await chrome.tabs.group({ tabIds: [tabId], groupId: g.id });
    }
  } catch {
    // ignore
  }
}

chrome.debugger.onEvent.addListener(onEvent);
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) detachCdp(source.tabId);
});
