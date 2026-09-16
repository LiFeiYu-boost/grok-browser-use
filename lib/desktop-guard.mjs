import { execFileSync } from "node:child_process";

function osa(script) {
  return execFileSync("osascript", ["-e", script], {
    encoding: "utf8",
  }).trim();
}

export function frontmostApp() {
  return osa(
    'tell application "System Events" to get name of first application process whose frontmost is true'
  );
}

export function googleChromeWindowCount() {
  const script = `
tell application "System Events"
  if exists process "Google Chrome" then
    return count of windows of process "Google Chrome"
  else
    return 0
  end if
end tell`;
  return Number(osa(script));
}

export function googleChromePids() {
  try {
    const out = execFileSync("pgrep", ["-x", "Google Chrome"], {
      encoding: "utf8",
    });
    return out
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((n) => Number(n));
  } catch {
    return [];
  }
}

export function snapshotDesktop() {
  return {
    frontmost: frontmostApp(),
    chromeWindows: googleChromeWindowCount(),
    chromePids: googleChromePids(),
  };
}

export function assertDesktopUnchanged(before, after, label) {
  const problems = [];
  if (before.frontmost !== after.frontmost) {
    problems.push(
      `${label}: frontmost changed ${before.frontmost} -> ${after.frontmost}`
    );
  }
  if (before.chromeWindows !== after.chromeWindows) {
    problems.push(
      `${label}: Google Chrome window count ${before.chromeWindows} -> ${after.chromeWindows}`
    );
  }
  const beforePids = [...before.chromePids].sort().join(",");
  const afterPids = [...after.chromePids].sort().join(",");
  if (beforePids !== afterPids) {
    problems.push(
      `${label}: Google Chrome PIDs changed ${beforePids} -> ${afterPids}`
    );
  }
  if (problems.length) {
    const err = new Error(problems.join("\n"));
    err.before = before;
    err.after = after;
    throw err;
  }
}
