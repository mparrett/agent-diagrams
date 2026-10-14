/**
 * One render after forced garbage collection: the probe raster-parity.test.js
 * spawns (with --v8-flags=--expose-gc) to guard the font-buffer fix.
 *
 * Skia reads glyphs from the font buffers handed to Fonts.register for the
 * life of the process. When nothing kept them alive, a collection freed them
 * and renders lost text. Collecting under allocation pressure right after the
 * fonts load reproduces that every time, where waiting for it to happen
 * naturally took many renders.
 *
 * Prints "drew" or "lost". Not a test itself.
 */
import { Diagram } from "../diagram-api.js";
import { checkRaster } from "../raster-check.js";

const path = new URL("./fixtures/glyph-drop-canary.json", import.meta.url)
  .pathname;
const d = Diagram.load(path);
d.solvePositions(); // registers the fonts
for (let i = 0; i < 20; i++) {
  const junk = [];
  for (let j = 0; j < 2000; j++) junk.push(new Uint8Array(64).fill(i));
  globalThis.gc();
}
const r = await checkRaster(d);
console.log(
  r.boxes.every((b) => b.labelOk && b.detailOk !== false) ? "drew" : "lost",
);
