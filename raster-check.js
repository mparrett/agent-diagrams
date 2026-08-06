#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-ffi --unstable-ffi
/**
 * raster-check.js — did the text actually get drawn?
 *
 * The existing parity harness (`just parity`) compares *measurement*: that
 * measureNodeWidth/computeLayout agree between the browser and the renderer, so
 * a box lands on the same {col,row,w,h} in both. That is geometry, and it is the
 * right guard for the class of bug it was built for.
 *
 * It says nothing about rasterization. A render can solve perfect geometry and
 * then silently fail to draw the glyphs — which is exactly the open `details`
 * bug: boxes correctly sized to hold three lines of text, every one of those
 * lines absent from the PNG, exit code 0, nothing on stderr. A green parity run
 * does not notice. This closes that gap.
 *
 * It works on the *encoded PNG bytes*, not on the live canvas. `ctx.getImageData`
 * in @gfx/canvas does not reflect what was drawn (it reports background where a
 * filled box plainly is), which would make every reading a false alarm. The PNG
 * is also the artifact people actually receive, so checking it is the honest
 * test. That's a third defect on this library's ledger, after the shadowBlur
 * displacement and the glyph drop itself.
 *
 * Usage:
 *   deno task raster-check [--state <path>] [--json] [--quiet]
 *   just raster-check [state]
 *
 * Exits 1 if any expected text is missing, so it composes into a pipeline.
 */

import { Diagram, resolveStatePath } from "./diagram-api.js";
import { CELL, DEFAULT_SIZES, fontSizes } from "./diagram-core.js";

// A band counts as inked above this many differing pixels per text line. One
// 10px glyph is tens of device pixels at DPR 2, so this sits far below any real
// line and far above antialiasing noise on an empty band.
const MIN_INK_PER_LINE = 12;
// Manhattan RGB distance at which a pixel is ink rather than fill.
const INK_THRESHOLD = 40;

// ─── Minimal PNG reader ───────────────────────────────────────────
// Only the shape canvas.encode("png") produces: 8-bit RGBA, non-interlaced.
// Anything else throws rather than silently mis-reading.
export async function decodePng(bytes) {
  if (
    bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e || bytes[3] !== 0x47
  ) throw new Error("not a PNG");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8, w = 0, h = 0;
  const idat = [];
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    if (type === "IHDR") {
      w = dv.getUint32(off + 8);
      h = dv.getUint32(off + 12);
      const depth = bytes[off + 16],
        color = bytes[off + 17],
        interlace = bytes[off + 20];
      if (depth !== 8 || color !== 6 || interlace !== 0) {
        throw new Error(
          `unsupported PNG (depth ${depth}, colorType ${color}, interlace ${interlace})`,
        );
      }
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(off + 8, off + 8 + len));
    }
    off += 12 + len;
    if (type === "IEND") break;
  }
  const total = idat.reduce((n, c) => n + c.length, 0);
  const z = new Uint8Array(total);
  let at = 0;
  for (const c of idat) {
    z.set(c, at);
    at += c.length;
  }
  // IDAT is zlib-wrapped; "deflate" is the zlib format in Compression Streams.
  const raw = new Uint8Array(
    await new Response(
      new Blob([z]).stream().pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer(),
  );

  const bpp = 4, stride = w * bpp;
  const out = new Uint8Array(w * h * bpp);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const row = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= bpp) ? prev[i - bpp] : 0;
      let v = row[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (ft !== 0) throw new Error(`bad PNG row filter ${ft}`);
      cur[i] = v & 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Count pixels in a rect that differ from the rect's modal colour. The mode is
 * the box fill (it dominates the band), so this asks "how much of this band
 * isn't background" without needing to know the palette or the theme.
 */
function inkIn(img, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(img.width, Math.ceil(x1));
  y1 = Math.min(img.height, Math.ceil(y1));
  if (x1 <= x0 || y1 <= y0) return 0;
  const counts = new Map();
  const keys = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      const k = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
      counts.set(k, (counts.get(k) ?? 0) + 1);
      keys.push(k);
    }
  }
  let mode = 0, best = -1;
  for (const [k, n] of counts) if (n > best) [best, mode] = [n, k];
  const mr = (mode >> 16) & 255, mg = (mode >> 8) & 255, mb = mode & 255;
  let ink = 0;
  for (const k of keys) {
    if (
      Math.abs(((k >> 16) & 255) - mr) + Math.abs(((k >> 8) & 255) - mg) +
          Math.abs((k & 255) - mb) > INK_THRESHOLD
    ) ink++;
  }
  return ink;
}

/**
 * Render `diagram` and report, per box, whether its label and detail lines were
 * actually rasterized. Returns { boxes, missing, checked }.
 *
 * Band geometry mirrors drawBoxes: the text block is vertically centred in the
 * box, the label takes the first `labelLines` slots, details follow after a gap.
 * The detail block is checked as one band — a partial drop still registers, and
 * it stays robust to baseline rounding.
 */
export async function checkRaster(diagram, opts = {}) {
  const { canvas, gridBoxes, scale } = diagram.renderToCanvas(opts);
  const S = fontSizes(diagram._state) ?? DEFAULT_SIZES;
  const img = await decodePng(canvas.encode("png"));

  const boxes = [];
  for (const b of gridBoxes) {
    const x = b.col * CELL, y = b.row * CELL;
    const w = b.w * CELL, h = b.h * CELL;
    const labelLines = b.labelLines?.length ?? 1;
    const details = b.details ?? [];

    const contentH = S.box.padTop + labelLines * S.box.labelH +
      (details.length ? S.box.gap + details.length * S.box.detailH : 0) +
      S.box.padBottom;
    const slackY = Math.max(0, h - contentH) / 2;
    const labelTop = y + slackY + S.box.padTop;
    const labelBot = labelTop + labelLines * S.box.labelH;

    const inset = 3; // stay off the rounded border
    const band = (top, bot) =>
      inkIn(
        img,
        (x + inset) * scale,
        top * scale,
        (x + w - inset) * scale,
        bot * scale,
      );

    const labelInk = band(labelTop, labelBot);
    const entry = {
      id: b.id,
      labelInk,
      labelOk: labelInk >= MIN_INK_PER_LINE * labelLines,
      detailLines: details.length,
      detailInk: 0,
      detailOk: true,
    };
    if (details.length) {
      entry.detailInk = band(
        labelBot + S.box.gap,
        labelBot + S.box.gap + details.length * S.box.detailH,
      );
      entry.detailOk = entry.detailInk >= MIN_INK_PER_LINE * details.length;
    }
    boxes.push(entry);
  }

  return {
    boxes,
    missing: boxes.filter((b) => !b.labelOk || !b.detailOk).length,
    checked: boxes.length,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────
if (import.meta.main) {
  const args = [...Deno.args];
  const flag = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? (args.splice(i, 1), true) : false;
  };
  const asJson = flag("--json");
  const quiet = flag("--quiet");
  let stateArg = args.find((a) => a.startsWith("--state="))?.slice(8);
  if (!stateArg) {
    const i = args.indexOf("--state");
    if (i >= 0) stateArg = args[i + 1];
    else if (args[0] && !args[0].startsWith("-")) stateArg = args[0];
  }

  const path = resolveStatePath(stateArg);
  const result = await checkRaster(Diagram.load(path));

  if (asJson) {
    console.log(JSON.stringify({ state: path, ...result }, null, 2));
  } else if (!quiet) {
    console.log(`raster-check ${path}`);
    console.log(
      "node".padEnd(16) + "label".padStart(8) + "details".padStart(9) +
        "lines".padStart(7) + "   verdict",
    );
    for (const b of result.boxes) {
      const what = !b.labelOk && !b.detailOk
        ? "MISSING label+details"
        : !b.labelOk
        ? "MISSING label"
        : !b.detailOk
        ? "MISSING details"
        : "ok";
      console.log(
        b.id.slice(0, 15).padEnd(16) + String(b.labelInk).padStart(8) +
          String(b.detailInk).padStart(9) +
          String(b.detailLines).padStart(7) + "   " + what,
      );
    }
  }
  if (result.missing > 0) {
    console.error(
      `\n${result.missing} of ${result.checked} box(es) lost text that layout allotted space for.\n` +
        `Geometry is fine — this is a rasterization failure, not a layout one.\n` +
        `Workaround: carry the text in "label" (with an explicit w) instead of "details".`,
    );
    Deno.exit(1);
  }
  if (!quiet) console.log(`\nall ${result.checked} box(es) drew their text`);
}
