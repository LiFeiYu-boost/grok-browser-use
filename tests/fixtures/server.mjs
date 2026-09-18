import http from "node:http";

const pages = {
  "/form": `<!doctype html>
<meta charset="utf-8">
<title>Form</title>
<h1>Sample form</h1>
<form id="f" method="get" action="/form">
  <label>Name <input id="name" name="name"></label>
  <button id="submit" type="submit">Save</button>
</form>
<p id="status">${""}</p>
<script>
const params = new URLSearchParams(location.search);
if (params.get("name")) {
  document.getElementById("status").textContent = "Saved " + params.get("name");
}
</script>`,
  "/list": `<!doctype html>
<meta charset="utf-8">
<title>List</title>
<h1>Items</h1>
<ul>
  <li><a id="item-1" href="/detail?id=1">Widget One</a></li>
  <li><a id="item-2" href="/detail?id=2">Widget Two</a></li>
</ul>`,
  "/detail": null,
};

function detailPage(id) {
  return `<!doctype html>
<meta charset="utf-8">
<title>Detail ${id}</title>
<h1>Detail ${id}</h1>
<p id="body">This is the detail page for item ${id}.</p>
<p><a href="/list">Back</a></p>`;
}

export function startFixtureServer() {
  return new Promise((resolve) => {
    const frameServer = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (url.pathname === "/xframe") {
        res.end(`<!doctype html>
<meta charset="utf-8">
<title>ChatKit fake</title>
<button id="xsend">Send message</button>
<p id="xstatus">draft</p>
<script>
document.getElementById("xsend").onclick = () => {
  document.getElementById("xstatus").textContent = "sent";
  parent.postMessage({ gbc: "sent" }, "*");
};
</script>`);
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    frameServer.listen(0, "127.0.0.1", () => {
      const frameOrigin = `http://127.0.0.1:${frameServer.address().port}`;
      const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.pathname === "/form") {
      const name = url.searchParams.get("name");
      const html = pages["/form"].replace(
        `<p id="status"></p>`,
        name ? `<p id="status">Saved ${name}</p>` : `<p id="status"></p>`
      );
      res.end(html);
      return;
    }
    if (url.pathname === "/list") {
      res.end(pages["/list"]);
      return;
    }
    if (url.pathname === "/detail") {
      res.end(detailPage(url.searchParams.get("id") || "unknown"));
      return;
    }
    if (url.pathname === "/slow") {
      const ms = Number(url.searchParams.get("ms") || 400);
      await new Promise((r) => setTimeout(r, ms));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, delayedMs: ms }));
      return;
    }
    if (url.pathname === "/echo" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ echoed: Buffer.concat(chunks).toString("utf8") })
      );
      return;
    }
    if (url.pathname === "/kitchen-frame") {
      res.end(`<!doctype html>
<meta charset="utf-8">
<title>Kitchen frame</title>
<button id="inner">Inside iframe</button>
<script>
document.getElementById("inner").onclick = () => {
  try { parent.document.getElementById("status").textContent = "iframe"; } catch (e) {}
};
</script>`);
      return;
    }
    if (url.pathname === "/kitchen") {
      res.end(`<!doctype html>
<meta charset="utf-8">
<title>Kitchen</title>
<h1>Kitchen</h1>
<p id="mq">desktop</p>
<button id="logout">退出登录</button>
<button id="ok">Continue</button>
<div id="card" role="button" tabindex="0">Open card</div>
<label>Color
  <select id="color">
    <option value="red">Red</option>
    <option value="blue">Blue</option>
  </select>
</label>
<div id="menu-wrap">
  <button id="menu">Menu</button>
  <div id="menu-pop" hidden>Hovered</div>
</div>
<iframe id="kid" src="/kitchen-frame" style="width:240px;height:80px;border:1px solid #ccc"></iframe>
<iframe id="xkit" src="${frameOrigin}/xframe" style="width:400px;height:120px;border:1px solid #ccc"></iframe>
<label class="arco-checkbox" id="row-check-wrap" style="display:flex;align-items:center;gap:8px;margin:12px 0">
  <input id="row-check" type="checkbox" style="display:none">
  <span class="arco-checkbox-mask" style="display:inline-block;width:16px;height:16px;border:1px solid #333"></span>
  Select row
</label>
<div id="editor" role="textbox" contenteditable="true" style="border:1px solid #ccc;min-height:4em;padding:8px"></div>
<p id="status">idle</p>
<p id="pad" style="height:1200px">scroll pad</p>
<button id="bottom">Bottom</button>
<script>
const status = document.getElementById("status");
document.getElementById("logout").onclick = () => { status.textContent = "logged-out"; };
document.getElementById("ok").onclick = () => {
  status.textContent = "ok";
  fetch("/slow?ms=200").catch(() => {});
};
document.getElementById("card").onclick = () => { status.textContent = "card"; };
document.getElementById("color").onchange = () => {
  status.textContent = "color:" + document.getElementById("color").value;
};
const menu = document.getElementById("menu");
const pop = document.getElementById("menu-pop");
menu.addEventListener("mouseenter", () => {
  pop.hidden = false;
  status.textContent = "hovered";
});
document.getElementById("bottom").onclick = () => { status.textContent = "bottom"; };
document.getElementById("row-check").onchange = () => {
  status.textContent = document.getElementById("row-check").checked ? "checked" : "unchecked";
};
window.addEventListener("message", (e) => {
  if (e.data && e.data.gbc === "sent") status.textContent = "iframe-sent";
});
const mq = document.getElementById("mq");
const syncMq = () => {
  mq.textContent = window.matchMedia("(max-width: 1023px)").matches ? "phone" : "desktop";
};
syncMq();
window.addEventListener("resize", syncMq);
</script>`);
      return;
    }
    if (url.pathname === "/heavy") {
      const n = Math.min(Number(url.searchParams.get("n") || 400), 2000);
      const buttons = Array.from({ length: n }, (_, i) => `<button class="row">Row ${i}</button>`).join("");
      res.end(`<!doctype html>
<meta charset="utf-8">
<title>Heavy</title>
<p id="count">${n}</p>
<div>${buttons}</div>`);
      return;
    }
    if (url.pathname === "/busy") {
      res.end(`<!doctype html>
<meta charset="utf-8">
<title>Busy</title>
<p id="status">polling</p>
<script>
setInterval(() => fetch("/slow?ms=8000").catch(() => {}), 200);
</script>`);
      return;
    }
    if (url.pathname === "/diag") {
      res.end(`<!doctype html>
<meta charset="utf-8">
<title>Diag</title>
<h1>Diag</h1>
<button id="ok">ok</button>
<p id="out">booting</p>
<script>
console.info("gbc-diag-info");
console.warn("gbc-diag-warn");
console.error("gbc-diag-error");
fetch("/missing-resource-" + Date.now()).catch((err) => {
  console.error("gbc-diag-fetch-fail", String(err));
});
fetch("/slow?ms=350");
fetch("/echo", { method: "POST", body: "hello-gbc" });
fetch("/form").then(() => {
  document.getElementById("out").textContent = "ready";
});
</script>`);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        resolve({
          server,
          frameServer,
          port,
          origin: `http://127.0.0.1:${port}`,
          frameOrigin,
          close: () =>
            Promise.all([
              new Promise((r) => server.close(() => r())),
              new Promise((r) => frameServer.close(() => r())),
            ]),
        });
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fx = await startFixtureServer();
  console.log(fx.origin);
}
