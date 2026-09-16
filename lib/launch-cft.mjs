import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cftBinary,
  EXTENSION_DIR,
  HOST_WRAPPER,
  PID_PATH,
  RUN_DIR,
  ensureRunDir,
} from "./paths.mjs";
import { installNativeHostManifest } from "./install-host-manifest.mjs";

export function writeCftHostWrapper(socketPath) {
  ensureRunDir();
  const wrapper = path.join(RUN_DIR, `cft-native-host-${process.pid}.sh`);
  fs.writeFileSync(
    wrapper,
    `#!/bin/bash\nset -euo pipefail\nexport GROK_BROWSER_SOCKET=${JSON.stringify(socketPath)}\nexec ${JSON.stringify(HOST_WRAPPER)}\n`
  );
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

export function defaultUserDataDir() {
  return path.join(os.tmpdir(), "grok-browser-use-cft");
}

export function launchCft({ mode, userDataDir, extraArgs = [], hostPath, socketPath } = {}) {
  ensureRunDir();
  const binary = cftBinary();
  const udd = userDataDir || defaultUserDataDir();
  fs.mkdirSync(udd, { recursive: true });
  const host = hostPath || (socketPath ? writeCftHostWrapper(socketPath) : HOST_WRAPPER);
  const written = installNativeHostManifest(udd, {
    dailyChrome: false,
    globalCft: false,
    hostPath: host,
  });

  const args = [
    `--user-data-dir=${udd}`,
    `--load-extension=${EXTENSION_DIR}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-popup-blocking",
    "--disable-session-crashed-bubble",
    "--disable-infobars",
    "--noerrdialogs",
    "about:blank",
    ...extraArgs,
  ];

  if (mode === "headless") {
    args.unshift("--headless=new", "--disable-gpu");
  } else if (mode === "headed-offscreen") {
    args.unshift("--window-position=8000,8000", "--window-size=800,600");
  } else {
    throw new Error(`unknown cft mode: ${mode}`);
  }

  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      // Do not leak a display activation hint if any.
    },
  });
  child.unref();
  fs.writeFileSync(
    PID_PATH,
    JSON.stringify(
      {
        pid: child.pid,
        binary,
        mode,
        userDataDir: udd,
        startedAt: new Date().toISOString(),
        nativeHostManifests: written,
      },
      null,
      2
    )
  );

  const logs = { stdout: "", stderr: "" };
  child.stdout.on("data", (d) => {
    logs.stdout += d.toString();
    if (logs.stdout.length > 80_000) logs.stdout = logs.stdout.slice(-40_000);
  });
  child.stderr.on("data", (d) => {
    logs.stderr += d.toString();
    if (logs.stderr.length > 80_000) logs.stderr = logs.stderr.slice(-40_000);
  });

  return { child, binary, userDataDir: udd, logs, pid: child.pid, mode };
}

export function killCftTree(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  const started = Date.now();
  while (Date.now() - started < 2000) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
}

export function killLaunchedCft() {
  if (!fs.existsSync(PID_PATH)) return null;
  const info = JSON.parse(fs.readFileSync(PID_PATH, "utf8"));
  if (info.binary && !String(info.binary).includes("Chrome for Testing")) {
    throw new Error(`refusing to kill non-CfT pid file: ${info.binary}`);
  }
  killCftTree(info.pid);
  try {
    fs.unlinkSync(PID_PATH);
  } catch {
    // ignore
  }
  return info;
}
