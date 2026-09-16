# grok-browser-use

Drive **your daily Google Chrome** from [Grok](https://grok.com) (or any MCP client) without `--remote-debugging-port`.

Chrome 136+ no longer honors remote debugging on the default profile. This project uses the same idea as Codex’s Chrome plugin: an unpacked MV3 extension plus a native-messaging host. Agent tabs land in a **Grok Browser** tab group, a comet pointer stays on those pages, and console/network are read in the background via CDP (`chrome.debugger`).

Not affiliated with xAI or OpenAI.

## What you get

- Native messaging attach to the Chrome you already logged into
- Isolated **Grok Browser** tab group
- Always-on pointer on agent tabs
- Background `console` / `network` / `get_network_request` (headers + truncated body)
- `wait_for` (network idle, console pattern, selector)
- `performance` (TTFB / FCP / LCP) and `css_styles` for a snapshot uid

## Requirements

- macOS (native host paths are written for Chrome-on-Mac)
- Node.js 20+
- Google Chrome
- [Grok Build](https://grok.com) or another MCP client (optional)

## Install

```bash
git clone https://github.com/LiFeiYu-boost/grok-browser-use.git
cd grok-browser-use
chmod +x host/native-host.sh scripts/*.sh
node -e "import('./lib/install-host-manifest.mjs').then(m => console.log(m.installNativeHostManifest(null, { dailyChrome: true }).join('\n')))"
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder in this repo

Confirm the extension id is `eljkchjmlpfpbobncnnimgfijfcehdja` (from `extension/key.pem`). The native host allowlist is bound to that id.

### Grok plugin

Copy or symlink this repo to `~/.grok/plugins/grok-browser-use` (Grok auto-trusts that directory), then restart the Grok session. MCP entry is `.mcp.json` → `scripts/run-mcp.sh`.

## MCP tools

`status`, `list_tabs`, `new_tab`, `close_tab`, `snapshot`, `click`, `fill`, `press`, `evaluate`, `screenshot`, `run_parallel`, `wait_for`, `console`, `get_console_message`, `network`, `get_network_request`, `performance`, `css_styles`, `audit_log`

Agent-created tabs default into the Grok Browser group. Diagnostics only collect for that group.

## Tests

```bash
node tests/test-framing.mjs
# isolated Chrome for Testing (does not touch daily Chrome):
node tests/spike-native-messaging.mjs
node tests/acceptance.mjs
```

Daily-Chrome proofs (`tests/prove-*.mjs`) talk to the unpacked extension already loaded in your profile.

## Layout

```
extension/     MV3 service worker, pointer, CDP collector, probes
host/          Chrome native messaging host
lib/           broker, paths, install
mcp/           MCP stdio server
skills/        Grok skill
tests/         unit + fixture + live proofs
```

## License

MIT. The Chrome extension private key in `extension/key.pem` only pins the unpacked extension id for native messaging. Generate your own key if you fork and need a different id.
