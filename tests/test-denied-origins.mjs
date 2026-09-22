import test from "node:test";
import assert from "node:assert/strict";

test("anti-bot origins refuse CDP before attaching a debugger", async () => {
  let url, attachments = 0;
  const previous = globalThis.chrome;
  globalThis.chrome = {
    tabs: { get: async () => ({ url }) },
    debugger: {
      attach: async () => { attachments++; },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
  };
  try {
    const { attachCdp, cdpDeniedUrl } = await import("../extension/cdp-collector.js");
    for (const host of ["tiktok.com", "partner-sso.tiktok.com", "partner.us.tiktokshop.com", "bytedance.com"]) {
      url = `https://${host}/`;
      assert.equal(cdpDeniedUrl(url), true);
      await assert.rejects(attachCdp(1), (err) => err.code === "CDP_DENIED");
    }
    assert.equal(attachments, 0);
    assert.equal(cdpDeniedUrl("https://example.test/?next=tiktok.com"), false);
    assert.equal(cdpDeniedUrl("https://tiktok.com.example.test/"), false);
  } finally {
    globalThis.chrome = previous;
  }
});
