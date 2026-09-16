(() => {
  if (window.__gbcProbeMain) return;
  window.__gbcProbeMain = true;
  const CHANNEL = "__gbc_probe__";

  function serialize(value) {
    try {
      if (value instanceof Error) {
        return { error: value.message, stack: value.stack };
      }
      if (typeof value === "string") return value.slice(0, 2000);
      return JSON.parse(JSON.stringify(value, (_, v) => {
        if (typeof v === "bigint") return String(v);
        if (typeof v === "function") return `[fn ${v.name || "anonymous"}]`;
        return v;
      }));
    } catch {
      try {
        return String(value).slice(0, 2000);
      } catch {
        return "[unserializable]";
      }
    }
  }

  function emit(kind, payload) {
    window.postMessage(
      { source: CHANNEL, kind, href: location.href, ts: Date.now(), ...payload },
      "*"
    );
  }

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level] && console[level].bind(console);
    if (!orig) continue;
    console[level] = (...args) => {
      emit("console", { level, args: args.map(serialize) });
      return orig(...args);
    };
  }

  window.addEventListener("error", (event) => {
    emit("console", {
      level: "error",
      args: [event.message, event.filename, event.lineno, event.colno],
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    emit("console", {
      level: "error",
      args: ["unhandledrejection", serialize(event.reason)],
    });
  });

  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const started = Date.now();
    const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
    try {
      const res = await origFetch(...args);
      emit("fetch", {
        url: String(url || ""),
        status: res.status,
        ok: res.ok,
        ms: Date.now() - started,
      });
      return res;
    } catch (err) {
      emit("fetch", {
        url: String(url || ""),
        error: String(err && err.message ? err.message : err),
        ms: Date.now() - started,
      });
      throw err;
    }
  };

  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    window.XMLHttpRequest = function WrappedXHR() {
      const xhr = new OrigXHR();
      let url = "";
      const open = xhr.open;
      xhr.open = function (method, u, ...rest) {
        url = String(u || "");
        return open.call(xhr, method, u, ...rest);
      };
      xhr.addEventListener("loadend", () => {
        emit("fetch", {
          url,
          status: xhr.status,
          ok: xhr.status >= 200 && xhr.status < 400,
          ms: 0,
          via: "xhr",
        });
      });
      return xhr;
    };
  }
})();
