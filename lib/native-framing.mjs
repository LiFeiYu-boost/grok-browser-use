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

export function encodeNdjsonMessage(obj) {
  return Buffer.from(JSON.stringify(obj) + "\n", "utf8");
}

export function createLspDecoder(onMessage) {
  const stdio = new McpStdio();
  return (chunk) => stdio.feed(chunk, onMessage);
}

export class McpStdio {
  constructor() {
    this.mode = null;
    this.buf = Buffer.alloc(0);
  }

  encode(obj) {
    if (this.mode === "ndjson") return encodeNdjsonMessage(obj);
    return encodeLspMessage(obj);
  }

  feed(chunk, onMessage) {
    this.buf = Buffer.concat([this.buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (this.buf.length) {
      if (!this.mode) {
        const peek = this.buf.toString("utf8", 0, Math.min(this.buf.length, 48)).replace(/^\uFEFF/, "");
        const trimmed = peek.trimStart();
        if (/^content-length:/i.test(trimmed) || /^content-type:/i.test(trimmed)) {
          this.mode = "lsp";
        } else if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          this.mode = "ndjson";
        } else if (this.buf.length > 64) {
          this.mode = "ndjson";
        } else {
          return;
        }
      }
      if (this.mode === "lsp") {
        const sep = this.buf.indexOf("\r\n\r\n");
        if (sep === -1) return;
        const header = this.buf.subarray(0, sep).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) throw new Error(`missing Content-Length: ${header}`);
        const len = Number(match[1]);
        const start = sep + 4;
        if (this.buf.length < start + len) return;
        const json = this.buf.subarray(start, start + len).toString("utf8");
        this.buf = this.buf.subarray(start + len);
        onMessage(JSON.parse(json));
        continue;
      }
      const nl = this.buf.indexOf(0x0a);
      if (nl === -1) return;
      const line = this.buf.subarray(0, nl).toString("utf8").replace(/\r$/, "").trim();
      this.buf = this.buf.subarray(nl + 1);
      if (!line) continue;
      onMessage(JSON.parse(line));
    }
  }
}
