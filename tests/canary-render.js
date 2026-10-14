/**
 * One render, one process: the probe raster-parity.test.js spawns.
 *
 * Font data is registered once per process, so a fault in how it is held
 * shows up across processes, not across renders in one. The glyph drop this
 * guards against (font buffers freed under Skia, see
 * docs/project_notes/upstream-defects.md) let most renders in a long-lived
 * process draw fine.
 *
 * Prints "drew" or "lost". Not a test itself.
 */
import { Diagram } from "../diagram-api.js";
import { checkRaster } from "../raster-check.js";

const path = new URL("./fixtures/glyph-drop-canary.json", import.meta.url)
  .pathname;
const r = await checkRaster(Diagram.load(path));
console.log(r.boxes.every((b) => b.detailOk) ? "drew" : "lost");
