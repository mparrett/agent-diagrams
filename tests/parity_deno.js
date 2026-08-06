// Deno-side half of the editor↔renderer measurement-parity harness.
//
// Replicates the renderer's font setup (see ensureFonts in diagram-api.js) on
// the same canvas library the PNG path uses, runs the shared corpus through the
// real measureNodeWidth / computeLayout, and writes tests/parity-deno.json.
// The browser page (tests/parity-page.html) fetches that file and compares its
// own canvas's numbers against it.
//
// Run:  deno run --allow-read --allow-write --allow-net --allow-env \
//         --allow-ffi --unstable-ffi tests/parity_deno.js   (or: deno task parity:gen)
// then open /tests/parity-page.html on the dev server.

import { createCanvas, Fonts } from "@gfx/canvas";
import {
  CELL,
  computeLayout,
  fontFamily,
  fontSizes,
  measureNodeWidth,
} from "../diagram-core.js";
import { probes, STATES } from "./parity-corpus.js";

const CANVAS_LIB = "@gfx/canvas@0.5.6 (native skia)";
const fontsDir = new URL("../assets/fonts/", import.meta.url);

// Mirror diagram-api.js ensureFonts: native Skia picks the weight from each
// file's own metadata, so regular + bold register under one family alias.
for (
  const [file, family] of [
    ["DejaVuSansMono.ttf", "DiagramMono"],
    ["DejaVuSansMono-Bold.ttf", "DiagramMono"],
    ["InstrumentSans-Regular.ttf", "DiagramSans"],
    ["InstrumentSans-SemiBold.ttf", "DiagramSans"],
  ]
) {
  Fonts.register(Deno.readFileSync(new URL(file, fontsDir)), family);
}
const ctx = createCanvas(10, 10).getContext("2d");

const probeW = {};
for (const p of probes()) {
  probeW[p.key] = measureNodeWidth(
    ctx,
    p.node,
    fontFamily({ font: p.fontMode }),
    fontSizes({ fontSize: p.fontSize }),
  );
}

const states = {};
for (const s of STATES) {
  states[s.name] = computeLayout(ctx, s.state, s.state.width || 1500).map((
    b,
  ) => ({
    id: b.id,
    col: b.col,
    row: b.row,
    w: b.w,
    h: b.h,
    pixW: b.pixW,
  }));
}

const out = { canvasLib: CANVAS_LIB, CELL, probeW, states };
const outPath = new URL("./parity-deno.json", import.meta.url);
Deno.writeTextFileSync(outPath, JSON.stringify(out, null, 2));

console.log(
  `parity_deno: wrote ${Object.keys(probeW).length} probes, ${
    Object.keys(states).length
  } states → tests/parity-deno.json (canvas: ${CANVAS_LIB}, CELL=${CELL})`,
);
