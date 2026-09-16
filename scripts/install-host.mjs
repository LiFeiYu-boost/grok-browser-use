#!/usr/bin/env node
import { installNativeHostManifest } from "../lib/install-host-manifest.mjs";
import { HOST_NAME, EXTENSION_ID, HOST_WRAPPER } from "../lib/paths.mjs";

const written = installNativeHostManifest(null, { dailyChrome: true });
console.log("native host:", HOST_NAME);
console.log("extension id:", EXTENSION_ID);
console.log("host wrapper:", HOST_WRAPPER);
console.log("wrote:");
for (const file of written) console.log(" ", file);
console.log("\nNext: Chrome → chrome://extensions → Developer mode → Load unpacked → extension/");
