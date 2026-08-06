// Pure-Deno half of the parity story: the *invariant*, with no browser.
//
// The cross-engine harness (parity_deno.js + parity-page.html) answers the
// empirical question "do the two real canvases measure the same?". These tests
// codify *why* that single question is sufficient: computeLayout depends on the
// canvas ONLY through measureText, so identical measured widths force identical
// geometry — and conversely a 1px disagreement can change the grid. That is the
// claim "editor==renderer iff dims.w agrees per box", made executable.

import { assert } from "@std/assert";
import { computeLayout } from "../diagram-core.js";
import { STATES } from "./parity-corpus.js";

// A canvas-2d stub whose text metrics are fully determined by widthOf(text,font).
function stubCtx(widthOf) {
  return {
    font: "",
    measureText(t) {
      return { width: widthOf(String(t), this.font) };
    },
  };
}

// Proportional-to-length, bold a touch wider — mirrors the fixture in
// diagram-core.test.js. Stands in for a real font's metrics.
const lenWidth = (t, font) => {
  const px = Number(font.match(/(\d+)px/)?.[1] ?? 13);
  return t.length * px * (font.includes("bold") ? 0.64 : 0.55);
};

const geom = (boxes) =>
  boxes.map((b) => ({ id: b.id, col: b.col, row: b.row, w: b.w, h: b.h }));

Deno.test("computeLayout is a pure function of measured width (identical widths → identical layout)", () => {
  for (const s of STATES) {
    const a = geom(computeLayout(stubCtx(lenWidth), s.state, s.state.width));
    const b = geom(computeLayout(stubCtx(lenWidth), s.state, s.state.width));
    assert(
      JSON.stringify(a) === JSON.stringify(b),
      `layout diverged for ${s.name} despite identical widths`,
    );
  }
});

Deno.test("computeLayout is deterministic across repeated runs on one ctx", () => {
  const ctx = stubCtx(lenWidth);
  for (const s of STATES) {
    const a = geom(computeLayout(ctx, s.state, s.state.width));
    const b = geom(computeLayout(ctx, s.state, s.state.width));
    assert(
      JSON.stringify(a) === JSON.stringify(b),
      `nondeterministic for ${s.name}`,
    );
  }
});

Deno.test("a 1px width disagreement can flip a box's cell width (why 'close' isn't enough)", () => {
  const state = {
    width: 800,
    nodes: [{ id: "x", label: "X", row: 0, col: 0 }],
    edges: [],
  };
  // measureNodeWidth => max(MIN_BOX_W=100, ceil(maxW + padX*2)); padX*2 = 40 at
  // scale 1. So 65px text → ceil(105) → 7 cells; 66px → 106 → 8 cells.
  const w65 = computeLayout(stubCtx(() => 65), state, 800)[0].w;
  const w66 = computeLayout(stubCtx(() => 66), state, 800)[0].w;
  assert(w65 === 7, `expected 7 cells at 65px, got ${w65}`);
  assert(w66 === 8, `expected 8 cells at 66px, got ${w66}`);
  assert(
    w65 !== w66,
    "a 1px measurement difference must be able to change grid topology",
  );
});
