import fs from "node:fs";
import path from "node:path";
import { Broker } from "../lib/broker.mjs";
import { snapshotDesktop, assertDesktopUnchanged } from "../lib/desktop-guard.mjs";
import { launchCft, killLaunchedCft, killCftTree } from "../lib/launch-cft.mjs";
import {
  MODE_PATH,
  ARTIFACTS_DIR,
  HOST_LOG_PATH,
  writeRuntimeConfig,
  ensureRunDir,
} from "../lib/paths.mjs";

const SPIKE_TIMEOUT_MS = 25000;

async function tryMode(mode, before) {
  ensureRunDir();
  writeRuntimeConfig({ mode });
  try {
    fs.writeFileSync(HOST_LOG_PATH, "");
  } catch {
    // ignore
  }
  const broker = new Broker();
  let launched;
  try {
    await broker.start();
    launched = launchCft({
      mode,
      userDataDir: path.join(
        ARTIFACTS_DIR,
        `cft-profile-${mode}-${Date.now()}`
      ),
    });
    const ready = await broker.waitReady(SPIKE_TIMEOUT_MS);
    await sleep(300);
    const ping = await broker.request("ping", {}, 8000);
    const after = snapshotDesktop();
    assertDesktopUnchanged(before, after, `spike:${mode}`);
    return {
      ok: true,
      mode,
      ready,
      ping,
      after,
      pid: launched.pid,
      stderrTail: launched.logs.stderr.slice(-2000),
    };
  } catch (err) {
    const after = snapshotDesktop();
    return {
      ok: false,
      mode,
      error: String(err && err.message ? err.message : err),
      after,
      before,
      hostLog: fs.existsSync(HOST_LOG_PATH)
        ? fs.readFileSync(HOST_LOG_PATH, "utf8").slice(-4000)
        : "",
      stderrTail: launched ? launched.logs.stderr.slice(-4000) : "",
      stdoutTail: launched ? launched.logs.stdout.slice(-2000) : "",
    };
  } finally {
    try {
      broker.close();
    } catch {
      // ignore
    }
    if (launched) {
      killCftTree(launched.pid);
    }
    try {
      killLaunchedCft();
    } catch {
      // ignore
    }
    await sleep(500);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  ensureRunDir();
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const before = snapshotDesktop();
  const report = { before, attempts: [] };

  const headless = await tryMode("headless", before);
  report.attempts.push(headless);
  let chosen = headless.ok ? headless : null;

  // Headed Chrome for Testing activates itself on macOS and steals focus.
  // Only try it if headless never even reached the extension.
  if (!chosen && !headless.error?.includes("frontmost")) {
    const reachedExtension =
      /ready|pong|extension/i.test(JSON.stringify(headless)) ||
      (headless.hostLog && headless.hostLog.includes("from-extension"));
    if (!reachedExtension) {
      const headed = await tryMode("headed-offscreen", before);
      report.attempts.push(headed);
      if (headed.ok) chosen = headed;
    }
  }

  const after = snapshotDesktop();
  report.after = after;
  try {
    assertDesktopUnchanged(before, after, "spike:final");
    report.desktopOk = true;
  } catch (err) {
    report.desktopOk = false;
    report.desktopError = String(err.message);
  }

  if (!chosen) {
    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, "spike-report.json"),
      JSON.stringify(report, null, 2)
    );
    console.error("SPIKE FAILED");
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const modeJson = {
    mode: chosen.mode,
    extensionId: chosen.ping.extensionId,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(MODE_PATH, JSON.stringify(modeJson, null, 2));
  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, "spike-report.json"),
    JSON.stringify({ ...report, chosen: modeJson }, null, 2)
  );
  console.log(JSON.stringify({ ok: true, ...modeJson, desktopOk: report.desktopOk }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
