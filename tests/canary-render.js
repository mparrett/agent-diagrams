/**
 * One render, one process — the probe the glyph-drop canary spawns.
 *
 * It has to be a separate process: the @gfx/canvas fault only bites the FIRST
 * render in a process, so a loop inside the test runner draws fine from the
 * second iteration onward and would report the bug as fixed every time.
 *
 * Prints "drew" or "lost". Not a test itself — see raster-parity.test.js.
 */
import { Diagram } from "../diagram-api.js";
import { checkRaster } from "../raster-check.js";

const path = new URL("./fixtures/glyph-drop-canary.json", import.meta.url)
  .pathname;
const aliases = Deno.args[0] === "--aliases";
const r = await checkRaster(Diagram.load(path), { measureAliases: aliases });
console.log(r.boxes.every((b) => b.detailOk) ? "drew" : "lost");
