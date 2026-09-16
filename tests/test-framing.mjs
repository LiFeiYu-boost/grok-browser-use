import assert from "node:assert/strict";
import {
  encodeNativeMessage,
  createNativeDecoder,
  encodeLspMessage,
  createLspDecoder,
} from "../lib/native-framing.mjs";

const nativeMsgs = [];
const nativeDecode = createNativeDecoder((m) => nativeMsgs.push(m));
const payload = { hello: "world", n: 42 };
nativeDecode(encodeNativeMessage(payload));
assert.deepEqual(nativeMsgs, [payload]);

const split = encodeNativeMessage({ a: 1 });
nativeMsgs.length = 0;
nativeDecode(split.subarray(0, 3));
nativeDecode(split.subarray(3));
assert.deepEqual(nativeMsgs, [{ a: 1 }]);

const lspMsgs = [];
const lspDecode = createLspDecoder((m) => lspMsgs.push(m));
lspDecode(encodeLspMessage({ jsonrpc: "2.0", id: 1, method: "ping" }));
assert.equal(lspMsgs[0].method, "ping");

console.log("test-framing ok");
