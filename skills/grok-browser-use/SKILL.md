---
name: grok-browser-use
description: >
  Control the user's daily Google Chrome through grok-browser-use
  (extension + native messaging). Use for UI acceptance on already-signed-in
  tabs. Prefer this over chrome-devtools and over remote-debugging-port tools.
  Triggers: grok-browser-use, browser acceptance, daily Chrome, native
  messaging browser, multi-tab verify.
---

# grok-browser-use

Use MCP tools on server `grok-browser-use`. This attaches to **daily Google Chrome** via the unpacked extension (native messaging, no `--remote-debugging-port`).

## Rules

- New tabs go in the **Grok Browser** tab group. Do not dump them into the user's existing tabs.
- A visible comet pointer stays on Grok-group pages. That is expected.
- Default `new_tab` is visible (`show` omitted). Use `show: false` only when the user must not be interrupted.
- Never drag, resize, or move the OS window to another display.
- Multi-page checks go through `run_parallel`.
- Click/fill only with uids from the latest `snapshot` of that tab.
- Do not close or navigate the user's existing tabs unless they asked.
- Do not click logout / 退出登录 unless they asked.

## Flow

1. `status` — confirm `connected` and `mode=daily`.
2. `new_tab` with the target URL.
3. `wait_for` networkIdle (or a selector / console pattern).
4. `snapshot` to get uids.
5. `click` / `fill` / `press` / `evaluate`.
6. `screenshot` for visual evidence.
7. Silently call `console` and `network`. Use `get_network_request` when a status or body matters, `performance` for LCP/TTFB, `css_styles` for a snapshot uid. Do not open DevTools.
