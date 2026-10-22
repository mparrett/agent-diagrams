// Draws a line of DiagramMono and prints how many pixels it inked. With
// "worker", a Worker renders first, so it registers the fonts, and is
// terminated before this isolate draws. See tests/font-lifetime.test.js.
import { createCanvas } from "@gfx/canvas";
import { Diagram } from "../diagram-api.js";
import { decodePng } from "../raster-check.js";

if (Deno.args[0] === "worker") {
  const w = new Worker(
    new URL("./font-lifetime-worker.js", import.meta.url),
    { type: "module" },
  );
  await new Promise((r) => {
    w.onmessage = r;
    w.postMessage("go");
  });
  w.terminate();
  await new Promise((r) => setTimeout(r, 300));
  // Reuse what the Worker freed, so a dangling font reads junk.
  let junk = [];
  for (let i = 0; i < 200; i++) {
    junk.push(new Uint8Array(1 << 20).fill(0x41 + (i % 20)));
  }
  junk = null;
}
Diagram.load(
  new URL("../diagrams/basic/diagram-state.json", import.meta.url).pathname,
)
  .renderToCanvas({ pixels: false }); // this isolate's own ensureFonts
const c = createCanvas(400, 60);
const ctx = c.getContext("2d");
ctx.fillStyle = "#fff";
ctx.fillRect(0, 0, 400, 60);
ctx.fillStyle = "#000";
ctx.font = "32px DiagramMono";
ctx.fillText("Hello glyphs", 10, 42);
const img = await decodePng(c.encode("png"));
let ink = 0;
for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 128) ink++;
console.log(ink);
