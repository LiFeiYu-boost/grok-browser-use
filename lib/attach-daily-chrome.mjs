import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { EXTENSION_DIR, EXTENSION_ID, ARTIFACTS_DIR, ensureRunDir } from "./paths.mjs";
import { installNativeHostManifest } from "./install-host-manifest.mjs";

function osa(script) {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
}

function osaFile(script) {
  ensureRunDir();
  const file = `/tmp/grok-browser-osa-${process.pid}.applescript`;
  fs.writeFileSync(file, script);
  try {
    return execFileSync("osascript", [file], { encoding: "utf8" }).trim();
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
}

export function installDailyChromeHost() {
  return installNativeHostManifest(null, { dailyChrome: true });
}

export function chromeTabCount() {
  return Number(
    osa(`
tell application "Google Chrome"
  set t to 0
  repeat with w in windows
    set t to t + (count of tabs of w)
  end repeat
  return t
end tell`)
  );
}

export function openExtensionsTab() {
  return Number(
    osa(`
tell application "Google Chrome"
  activate
  if (count of windows) is 0 then make new window
  tell window 1
    set newTab to make new tab with properties {URL:"chrome://extensions/"}
    set active tab index to (count of tabs)
    return id of newTab
  end tell
end tell`)
  );
}

export function closeChromeTabById(tabId) {
  osa(`
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if id of t is ${Number(tabId)} then
        close t
        return
      end if
    end repeat
  end repeat
end tell`);
}

export function dumpChromeUi() {
  return osaFile(`
tell application "System Events"
  tell process "Google Chrome"
    set out to ""
    set out to out & "windows=" & (count of windows) & linefeed
    repeat with w in windows
      try
        set out to out & "window:" & (name of w as text) & linefeed
      end try
      try
        repeat with e in (entire contents of w)
          try
            set out to out & (role of e as text) & "|" & (name of e as text) & linefeed
          end try
        end repeat
      end try
    end repeat
    return out
  end tell
end tell`);
}

export function enableDeveloperModeAndLoadUnpacked() {
  const script = `
tell application "Google Chrome" to activate
delay 0.8
tell application "System Events"
  tell process "Google Chrome"
    set frontmost to true
    -- Developer mode checkbox/toggle
    set toggled to false
    try
      set boxes to checkboxes of window 1
      repeat with c in boxes
        set n to name of c
        if n contains "Developer" or n contains "开发者" then
          if value of c is 0 then click c
          set toggled to true
        end if
      end repeat
    end try
    try
      repeat with c in (checkboxes of groups of window 1)
        set n to name of c
        if n contains "Developer" or n contains "开发者" then
          if value of c is 0 then click c
          set toggled to true
        end if
      end repeat
    end try
    delay 0.5
    set loaded to false
    try
      repeat with b in (buttons of window 1)
        set n to name of b
        if n contains "Load unpacked" or n contains "加载已解压" or n contains "Load Unpacked" then
          click b
          set loaded to true
          exit repeat
        end if
      end repeat
    end try
    if not loaded then
      try
        repeat with b in (buttons of groups of window 1)
          set n to name of b
          if n contains "Load unpacked" or n contains "加载已解压" then
            click b
            set loaded to true
            exit repeat
          end if
        end repeat
      end try
    end if
    return "toggled=" & toggled & " loaded=" & loaded
  end tell
end tell
`;
  return osaFile(script);
}

export function completeOpenPanel(folderPath) {
  const escaped = folderPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
tell application "System Events"
  delay 0.6
  set frontmost of process "Google Chrome" to true
  delay 0.2
  keystroke "g" using {command down, shift down}
  delay 0.5
  keystroke "${escaped}"
  delay 0.2
  keystroke return
  delay 0.8
  keystroke return
end tell
return "ok"
`;
  return osaFile(script);
}

export function extensionDir() {
  return EXTENSION_DIR;
}

export function ourExtensionId() {
  return EXTENSION_ID;
}

export function writeUiDump(text) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const p = `${ARTIFACTS_DIR}/chrome-extensions-ui.txt`;
  fs.writeFileSync(p, text);
  return p;
}
