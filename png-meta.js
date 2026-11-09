/**
 * Board state carried inside the PNG, so an image pasted on its own can be
 * read (or turned back into a board) without its diagram-state.json.
 *
 * The payload is an iTXt chunk (PNG spec §11.3.3) with the private keyword
 * `agent-diagrams`: iTXt rather than tEXt because labels carry non-Latin-1
 * text such as `→`, and iTXt is UTF-8 with optional zlib compression. Nothing
 * nondeterministic goes in, so the same state always yields the same bytes
 * (see issue #10 on PNG determinism).
 */

import { deflateSync, inflateSync } from "node:zlib";

export const PNG_META_KEYWORD = "agent-diagrams";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** A chunk was found but cannot be trusted (bad CRC, truncated, bad payload). */
export class PngMetaError extends Error {}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function isPng(buf) {
  return buf.length >= 8 && SIGNATURE.every((b, i) => buf[i] === b);
}

// Yields { type, start, dataStart, length, end } for each chunk; `end` is one
// past the CRC. Throws on a chunk running past the end of the buffer.
function* chunks(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 8;
  while (p + 8 <= buf.length) {
    const length = view.getUint32(p);
    const type = String.fromCharCode(...buf.subarray(p + 4, p + 8));
    const end = p + 12 + length;
    if (end > buf.length) {
      throw new PngMetaError(`PNG chunk ${type} at byte ${p} is truncated`);
    }
    yield { type, start: p, dataStart: p + 8, length, end };
    if (type === "IEND") return;
    p = end;
  }
}

function keywordOf(buf, c) {
  const data = buf.subarray(c.dataStart, c.dataStart + c.length);
  const nul = data.indexOf(0);
  return nul < 0 ? null : String.fromCharCode(...data.subarray(0, nul));
}

function isOurs(buf, c) {
  return c.type === "iTXt" && keywordOf(buf, c) === PNG_META_KEYWORD;
}

function buildChunk(obj) {
  const enc = new TextEncoder();
  const text = deflateSync(enc.encode(JSON.stringify(obj)), { level: 9 });
  // keyword \0, compression flag 1, method 0 (zlib), empty language tag \0,
  // empty translated keyword \0, then the compressed text.
  const head = enc.encode(PNG_META_KEYWORD);
  const data = new Uint8Array(head.length + 5 + text.length);
  data.set(head, 0);
  data.set([0, 1, 0, 0, 0], head.length);
  data.set(text, head.length + 5);

  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(enc.encode("iTXt"), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/**
 * Return a copy of `png` with `obj` embedded as our iTXt chunk just before
 * IEND, replacing any chunk of ours already there.
 */
export function embedPngMeta(png, obj) {
  if (!isPng(png)) throw new PngMetaError("not a PNG");
  const keep = [];
  let iend = null;
  for (const c of chunks(png)) {
    if (c.type === "IEND") iend = c;
    else if (!isOurs(png, c)) keep.push(png.subarray(c.start, c.end));
  }
  if (!iend) throw new PngMetaError("PNG has no IEND chunk");
  const parts = [
    png.subarray(0, 8),
    ...keep,
    buildChunk(obj),
    png.subarray(iend.start, iend.end),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The object embedded by embedPngMeta, or null when the PNG has no chunk of
 * ours. Throws PngMetaError when the input is not a PNG, or when our chunk is
 * there but damaged: a bad CRC must not be read as some other board.
 */
export function readPngMeta(png) {
  if (!isPng(png)) throw new PngMetaError("not a PNG");
  for (const c of chunks(png)) {
    if (!isOurs(png, c)) continue;
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const stored = view.getUint32(c.dataStart + c.length);
    if (crc32(png.subarray(c.start + 4, c.dataStart + c.length)) !== stored) {
      throw new PngMetaError(
        `${PNG_META_KEYWORD} chunk fails its CRC check — the PNG is damaged`,
      );
    }
    const data = png.subarray(c.dataStart, c.dataStart + c.length);
    let p = PNG_META_KEYWORD.length + 1;
    const compressed = data[p] === 1;
    p += 2; // compression flag, method
    for (let field = 0; field < 2 && p > 0; field++) {
      p = data.indexOf(0, p) + 1; // language tag, then translated keyword
    }
    if (p <= 0) throw new PngMetaError(`malformed ${PNG_META_KEYWORD} chunk`);
    try {
      const body = compressed
        ? inflateSync(data.subarray(p))
        : data.subarray(p);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch (e) {
      throw new PngMetaError(
        `${PNG_META_KEYWORD} chunk has an unreadable payload: ${e.message}`,
      );
    }
  }
  return null;
}
