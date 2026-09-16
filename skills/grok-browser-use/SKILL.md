---
name: grok-browser-use
description: >
  Control the user's daily Google Chrome through grok-browser-use
  (extension + native messaging). This is the primary UI acceptance path;
  chrome-devtools MCP is fallback only. Never drag windows or steal focus.
  Triggers: grok-browser-use, browser acceptance, daily Chrome, native
  messaging browser, multi-tab verify.
---

# grok-browser-use

Use MCP tools on server `grok-browser-use`. This attaches to **daily Google Chrome** via the unpacked extension (native messaging, no `--remote-debugging-port`). It is the primary UI acceptance path; use chrome-devtools MCP only if this stack cannot attach after a Broker retry.

## Rules

- New tabs go in the **Grok Browser** tab group, like Codex's agent group. Do not dump them into the user's existing tabs.
- A visible pointer overlay moves to the element before click/fill. That is expected.
- Default `new_tab` is visible (`show` omitted). Use `show: false` only when the user must not be interrupted.
- Never drag, resize, or bring the OS window to another display.
- Multi-page checks go through `run_parallel`.
- Click/fill only with uids from the latest `snapshot` of that tab.
- Do not click logout / 退出登录 / delete unless the user asked. Snapshot marks these `destructive`; click refuses them without `confirmDestructive: true`.
- Do not close or navigate the user's existing tabs unless they asked.
- Prefer a new background tab for scratch verification, then close that tab.

## Flow

1. `status` — confirm `connected` (or `connectionState`) and `mode=daily`. If disconnected, retry; do not skip acceptance.
2. `new_tab` with the target URL (CDP is attached before navigate; network idle is waited by default).
3. `snapshot` to get uids (role / name / destructive / iframe frames).
4. `click` / `fill` / `hover` / `scroll` / `select_option` / `press` / `evaluate`.
5. `screenshot` for visual evidence; include the saved PNG in the reply.
6. Silently call `console` and `network` for that tab. `click`/`screenshot` already wait for network idle. Use `get_network_request` when a status or body matters. Do not open DevTools.
7. `audit_log` must stay empty of focus/activate/bounds events.

## Parallel

```
run_parallel ops=[{tabId, op:"snapshot"}, {tabId, op:"click", uid}, ...]
```
