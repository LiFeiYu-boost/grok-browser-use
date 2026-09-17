import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(here, "..");
export const EXTENSION_DIR = path.join(PLUGIN_ROOT, "extension");
export const HOST_WRAPPER = path.join(PLUGIN_ROOT, "host", "native-host.sh");
export const HOST_SCRIPT = path.join(PLUGIN_ROOT, "host", "native-host.mjs");
export const RUN_DIR = path.join(PLUGIN_ROOT, "run");
export const CONFIG_PATH = path.join(RUN_DIR, "config.json");
export const SOCKET_PATH = path.join(RUN_DIR, "broker.sock");
export const DEFAULT_DAILY_SOCKET_PATH = path.join(RUN_DIR, "daily.sock");
export const DAILY_SOCKET_PATH =
  process.env.GROK_BROWSER_DAILY_SOCKET || DEFAULT_DAILY_SOCKET_PATH;
export const DAEMON_PID_PATH = path.join(RUN_DIR, "daily-broker.pid");
export const DAEMON_LOG_PATH = path.join(RUN_DIR, "daily-broker.log");
export const HOST_LOG_PATH = path.join(RUN_DIR, "native-host.log");
export const AUDIT_LOG_PATH = path.join(RUN_DIR, "audit.jsonl");
export const PID_PATH = path.join(RUN_DIR, "cft.pid");
export const MODE_PATH = path.join(PLUGIN_ROOT, "tests", "artifacts", "mode.json");
export const ARTIFACTS_DIR = path.join(PLUGIN_ROOT, "tests", "artifacts");
export const HOST_NAME = "com.xai.grok.browser";
export const EXTENSION_ID = fs
  .readFileSync(path.join(EXTENSION_DIR, "extension-id.txt"), "utf8")
  .trim();

export const NODE_BIN = process.execPath || "node";

export const CFT_CANDIDATES = [
  ...globChromeForTesting(),
  path.join(
    os.homedir(),
    ".cache/cft/chrome/mac-151.0.7922.34/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
  ),
  path.join(
    os.homedir(),
    ".cache/cft/chrome/mac-151.0.7922.34/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
  ),
];

function globChromeForTesting() {
  const root = path.join(os.homedir(), ".cache/cft/chrome");
  const hits = [];
  try {
    for (const ver of fs.readdirSync(root)) {
      for (const arch of ["chrome-mac-arm64", "chrome-mac-x64"]) {
        const p = path.join(
          root,
          ver,
          arch,
          "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        );
        if (fs.existsSync(p)) hits.push(p);
      }
    }
  } catch {
    // ignore
  }
  return hits;
}

export function cftBinary() {
  if (process.env.GROK_CFT_PATH && fs.existsSync(process.env.GROK_CFT_PATH)) {
    return process.env.GROK_CFT_PATH;
  }
  const found = CFT_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error("Chrome for Testing binary not found");
  }
  return found;
}

export function ensureRunDir() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

export function writeRuntimeConfig(extra = {}) {
  ensureRunDir();
  const config = {
    socketPath: SOCKET_PATH,
    hostLogPath: HOST_LOG_PATH,
    pluginRoot: PLUGIN_ROOT,
    ...extra,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
}

export function cftNativeHostDirs() {
  const home = os.homedir();
  return [
    path.join(home, "Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts"),
    path.join(home, "Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts"),
  ];
}

export function dailyChromeNativeHostDirs() {
  const home = os.homedir();
  return [
    path.join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
  ];
}

export const DAILY_CHROME_BIN =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
