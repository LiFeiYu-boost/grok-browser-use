import { Buffer } from "node:buffer";

export function encodeNativeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function createNativeDecoder(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > 8 * 1024 * 1024) {
        throw new Error(`native message too large: ${len}`);
      }
      if (buf.length < 4 + len) break;
      const json = buf.subarray(4, 4 + len).toString("utf8");
      buf = buf.subarray(4 + len);
      onMessage(JSON.parse(json));
    }
  };
}

export function encodeLspMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}

export function createLspDecoder(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const header = buf.subarray(0, sep).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        throw new Error(`missing Content-Length: ${header}`);
      }
      const len = Number(match[1]);
      const start = sep + 4;
      if (buf.length < start + len) return;
      const json = buf.subarray(start, start + len).toString("utf8");
      buf = buf.subarray(start + len);
      onMessage(JSON.parse(json));
    }
  };
}
