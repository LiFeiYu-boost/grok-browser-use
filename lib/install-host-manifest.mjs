import fs from "node:fs";
import path from "node:path";
import {
  HOST_NAME,
  HOST_WRAPPER,
  EXTENSION_ID,
  cftNativeHostDirs,
  dailyChromeNativeHostDirs,
} from "./paths.mjs";

export function nativeHostManifest() {
  return {
    name: HOST_NAME,
    description: "Grok browser control native host",
    path: HOST_WRAPPER,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
}

export function installNativeHostManifest(userDataDir, { dailyChrome = true } = {}) {
  const dirs = [...cftNativeHostDirs()];
  if (dailyChrome) {
    dirs.push(...dailyChromeNativeHostDirs());
  }
  if (userDataDir) {
    dirs.push(path.join(userDataDir, "NativeMessagingHosts"));
  }
  const manifest = nativeHostManifest();
  const body = JSON.stringify(manifest, null, 2);
  const written = [];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${HOST_NAME}.json`);
    fs.writeFileSync(file, body);
    written.push(file);
  }
  fs.chmodSync(HOST_WRAPPER, 0o755);
  return written;
}
