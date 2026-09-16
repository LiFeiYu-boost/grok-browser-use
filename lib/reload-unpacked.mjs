import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { EXTENSION_ID, ensureRunDir, RUN_DIR } from "./paths.mjs";

export function reloadUnpackedExtension() {
  ensureRunDir();
  const js =
    '(()=>{const id=' +
    JSON.stringify(EXTENSION_ID) +
    ';const mgr=document.querySelector("extensions-manager");if(!mgr||!mgr.shadowRoot)return "no-mgr";const list=mgr.shadowRoot.querySelector("extensions-item-list");if(!list||!list.shadowRoot)return "no-list";const items=list.shadowRoot.querySelectorAll("extensions-item");for(const item of items){if(item.id!==id)continue;const btn=item.shadowRoot&&item.shadowRoot.querySelector("#dev-reload-button");if(!btn)return "no-btn";btn.click();return "reloaded";}return "not-found:"+items.length;})()';
  const file = `${RUN_DIR}/reload-extension.applescript`;
  fs.writeFileSync(
    file,
    `tell application "Google Chrome"
  if (count of windows) is 0 then make new window
  set extTab to missing value
  tell window 1
    set extTab to make new tab with properties {URL:"chrome://extensions/"}
  end tell
  delay 1.2
  set jsResult to "no-js"
  try
    set jsResult to execute extTab javascript ${JSON.stringify(js)}
  end try
  try
    close extTab
  end try
  return jsResult
end tell
`
  );
  return execFileSync("osascript", [file], { encoding: "utf8" }).trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(reloadUnpackedExtension());
}
