(() => {
  const ROOT_ID = "gbc-pointer-root";
  const VERSION = "comet-1";
  const MARKUP = `
    <style>
      @keyframes gbc-halo {
        0%, 100% { opacity: .22; transform: scale(1); }
        50% { opacity: .38; transform: scale(1.08); }
      }
      #gbc-pointer-root { position: fixed; width: 48px; height: 48px; z-index: 2147483647;
        pointer-events: none; left: 40px; top: 40px; display: block !important; visibility: visible !important;
        opacity: 1; transition: left 220ms cubic-bezier(.22,.9,.28,1), top 220ms cubic-bezier(.22,.9,.28,1),
                    transform 90ms ease-out; }
      #gbc-pointer-root svg { display: block; overflow: visible; }
      #gbc-halo { animation: gbc-halo 1.8s ease-in-out infinite; transform-origin: 14px 12px; }
      #gbc-pointer-ring {
        position: absolute; left: 4px; top: 2px; width: 20px; height: 20px;
        border: 1.5px solid rgba(110, 232, 255, .95); border-radius: 999px;
        opacity: 0; transform: scale(.35); box-shadow: 0 0 10px rgba(90, 220, 255, .55);
        transition: opacity 220ms ease-out, transform 220ms ease-out;
      }
    </style>
    <div id="gbc-pointer-ring"></div>
    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
      <defs>
        <filter id="gbcGlow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.6" result="blur"/>
          <feColorMatrix in="blur" type="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1.15 0" result="glow"/>
          <feMerge>
            <feMergeNode in="glow"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
        <linearGradient id="gbcCore" x1="12%" y1="0%" x2="90%" y2="100%">
          <stop offset="0%" stop-color="#ffffff"/>
          <stop offset="38%" stop-color="#c9f7ff"/>
          <stop offset="100%" stop-color="#12b8d6"/>
        </linearGradient>
        <linearGradient id="gbcTail" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#7ee7ff" stop-opacity="0"/>
          <stop offset="55%" stop-color="#5ad4f0" stop-opacity=".55"/>
          <stop offset="100%" stop-color="#e7fcff" stop-opacity=".95"/>
        </linearGradient>
      </defs>
      <circle id="gbc-halo" cx="14" cy="12" r="11" fill="#5ce1ff"/>
      <path d="M22 30 C18 24, 16 20, 14.5 16 C20 18.5, 26 22, 31 28 C27 27, 24 28, 22 30 Z"
        fill="url(#gbcTail)" opacity=".9"/>
      <path d="M9.2 5.4
               C12.8 5.2, 24.5 15.8, 27.2 24.6
               C21.8 21.8, 16.6 19.6, 13.4 26.8
               C12.2 20.4, 8.6 13.2, 9.2 5.4 Z"
        fill="url(#gbcCore)" stroke="rgba(255,255,255,.92)" stroke-width="1.15"
        filter="url(#gbcGlow)"/>
      <circle cx="11.2" cy="8.4" r="2.35" fill="#fff"/>
      <circle cx="11.2" cy="8.4" r="1.05" fill="#7ee7ff"/>
    </svg>
  `;

  const POS_KEY = "gbc-pointer-pos";

  function readPos() {
    try {
      const raw = sessionStorage.getItem(POS_KEY);
      if (raw) {
        const pos = JSON.parse(raw);
        if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) return pos;
      }
    } catch {
      // ignore
    }
    return {
      x: Math.max(48, Math.round(window.innerWidth * 0.3)),
      y: Math.max(64, Math.round(window.innerHeight * 0.28)),
    };
  }

  function writePos(x, y) {
    try {
      sessionStorage.setItem(POS_KEY, JSON.stringify({ x, y }));
    } catch {
      // ignore
    }
  }

  function ensure() {
    let root = document.getElementById(ROOT_ID);
    if (root && root.dataset.gbcVersion === VERSION) {
      root.style.display = "block";
      root.style.visibility = "visible";
      return root;
    }
    if (root) root.remove();
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.dataset.gbcPointer = "1";
    root.dataset.gbcVersion = VERSION;
    root.innerHTML = MARKUP;
    root.style.display = "block";
    root.style.visibility = "visible";
    (document.documentElement || document.body).appendChild(root);
    const pos = readPos();
    root.style.left = Math.round(pos.x) + "px";
    root.style.top = Math.round(pos.y) + "px";
    root.style.transform = "translate(-11px,-8px)";
    return root;
  }

  function move(x, y) {
    const root = ensure();
    root.style.left = Math.round(x) + "px";
    root.style.top = Math.round(y) + "px";
    root.style.display = "block";
    root.style.visibility = "visible";
    root.style.transform = "translate(-11px,-8px)";
    writePos(x, y);
  }

  function show() {
    const pos = readPos();
    move(pos.x, pos.y);
    const root = ensure();
    return { has: true, left: root.style.left, top: root.style.top };
  }

  function pulse() {
    const ring = document.getElementById("gbc-pointer-ring");
    const root = ensure();
    root.style.transform = "translate(-11px,-8px) scale(.9)";
    if (ring) {
      ring.style.opacity = "1";
      ring.style.transform = "scale(2.4)";
    }
    setTimeout(() => {
      root.style.transform = "translate(-11px,-8px) scale(1)";
      if (ring) {
        ring.style.opacity = "0";
        ring.style.transform = "scale(.35)";
      }
    }, 180);
  }

  async function moveToUid(uid) {
    const el = document.querySelector(`[data-gbc-uid="${uid}"]`);
    if (!el) return { ok: false, error: "uid not found: " + uid };
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(Math.max(r.width / 2, 8), 28);
    const y = r.top + Math.min(Math.max(r.height / 2, 8), 20);
    move(x, y);
    await new Promise((res) => setTimeout(res, 240));
    return { ok: true, x, y };
  }

  window.__gbcPointer = { ensure, move, pulse, moveToUid, show };

  let allowed = false;
  const boot = () => {
    if (!allowed) return;
    show();
  };
  try {
    chrome.runtime.sendMessage({ type: "gbc-should-paint" }, (res) => {
      allowed = Boolean(res && res.paint);
      if (allowed) boot();
    });
  } catch {
    // ignore
  }
  if (document.documentElement) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });
  setInterval(() => {
    if (allowed && !document.getElementById(ROOT_ID)) boot();
  }, 1000);
})();
