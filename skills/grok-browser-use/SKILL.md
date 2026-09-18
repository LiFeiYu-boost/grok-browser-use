---
name: grok-browser-use
description: >
  Drive the user's daily Google Chrome through grok-browser-use
  (MV3 extension + native messaging, no --remote-debugging-port).
  Primary UI acceptance path; chrome-devtools MCP is fallback only.
  File GitHub issues on LiFeiYu-boost/grok-browser-use when this plugin
  is awkward or broken. Never drag windows or steal focus.
  Triggers: grok-browser-use, gbu, browser acceptance, daily Chrome,
  native messaging browser, multi-tab verify, Grok Browser tab group.
---

# grok-browser-use

Use MCP tools on server `grok-browser-use` (some installs still expose `grok-browser-control`; same binary). This attaches to **daily Google Chrome** via the unpacked extension. It is the primary UI acceptance path; use chrome-devtools MCP only if this stack cannot attach after a Broker retry.

## Rules

- New tabs go in this session's `Grok Browser · <short-id>` tab group (from `GROK_SESSION_ID`). Do not dump them into the user's existing tabs or another Grok session's group.
- Phone UX: `emulate({ tabId, viewport: "iphone" })`. Daily Chrome ignores CDP device metrics, so this may open a ~390px popup (`focused: false`) instead of resizing the user's window. `emulate({ tabId, viewport: "reset" })` moves the tab back. Never `window.resizeTo` / drag windows.
- `snapshot` is capped (~250 interactive nodes). `wait_for` returns `{ timedOut: true }` instead of hanging on chatty pages.
- A visible comet pointer on agent pages is expected.
- Default `new_tab` is visible (`show` omitted). Use `show: false` only when the user must not be interrupted.
- Never drag, resize, or steal OS-window focus.
- Click/fill only with uids from the latest `snapshot` of that tab. For compose dialogs (X/Twitter `发帖`), prefer the uid with `inDialog: true` / `testId: tweetButton`, not the sidebar button.
- Do not click logout / 退出登录 / delete / 解除连接 unless the user asked. Snapshot marks these `destructive`; click refuses them without `confirmDestructive: true`.
- Do not close or navigate the user's existing tabs unless they asked. Do not click/close tabs in another Grok session's group.
- Prefer a scratch tab, then close it.
- Never attach `chrome.debugger` or inject MAIN-world `fetch`/`XHR` hooks on `tiktok.com` / `tiktokshop.com` / `bytedance.com` (Partner Center and SSO detect them and go white or swallow Log in). Click/fill/screenshot stay on `chrome.scripting`. Do not call `evaluate` there (extension CSP blocks `new Function`); use `page_info` and `fetch_json`. If a Partner tab is already blank, `debugger_detach_all` then let the **user** refresh. Do not `location.href` the user's logged-in Partner tab.

## Flow

1. `status` — confirm `connected` (or `connectionState`), `mode=daily`, and `tabGroup` for this session. Daily Chrome uses one shared broker; each session has its own tab group. `list_tabs` defaults to this group (`scope: "all"` to see other Grok groups, never the user's own tabs). If disconnected, retry; do not skip acceptance.
2. `new_tab` with the target URL (CDP is attached before navigate; network idle is waited by default).
3. `snapshot` to get uids (role / name / destructive / iframe frames).
4. `click` / `fill` / `hover` / `scroll` / `select_option` / `press` / `evaluate`.
5. `screenshot` for visual evidence; include the saved PNG in the reply.
6. Silently call `console` and `network`. Do not open DevTools.
7. `audit_log` must stay empty of focus/activate/bounds events.

## File issues

This plugin is used by Grok agents. If grok-browser-use is awkward, broken, or unsafe **in this session**, open an issue on https://github.com/LiFeiYu-boost/grok-browser-use **the same turn**. Do not wait for the user to ask.

What counts: handshake / native-host / MCP dies; Chrome freeze or 100% CPU; wrong click; snapshot miss; fill/click fail on contenteditable; focus steal or touching non-Grok tabs; tests colliding with daily Chrome; having to tell the user to Reload the extension; `status` stuck disconnected because another Grok session stole `broker.sock` / `daily.sock`.

How:

1. `gh issue list --repo LiFeiYu-boost/grok-browser-use --state open --search "<short symptom>"`
2. Duplicate → comment with this session's evidence. Otherwise:

```
gh issue create --repo LiFeiYu-boost/grok-browser-use --title "<short symptom>" --body "..."
```

Body: what you were doing, what happened, expected, evidence (logs, screenshot, version/SHA), workaround. Say if a local fix is already in-tree.
3. Put the issue URL in the user-facing reply. If `gh` is missing or unauthenticated, still paste a ready-to-file title and body.

Do not file user mistakes (wrong URL, logged-out site) as product bugs. Do not open a second issue for the same open symptom.

## Parallel

```
run_parallel ops=[{tabId, op:"snapshot"}, {tabId, op:"click", uid}, ...]
```
