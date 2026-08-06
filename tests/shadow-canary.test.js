import { assert } from "@std/assert";
import { HALO_RADII, shadowInkOutsideHalo } from "./shadow-probe.js";

// Canary for the second @gfx/canvas fault on the ledger — like the glyph-drop
// canary, this asserts the bug is STILL THERE and is meant to fail one day.
//
// Under ctx.scale(DPR), native Skia draws a box's drop shadow at roughly DPR
// times the box's *device* position instead of around the box: a phantom fill
// far from its source, overdrawing whatever it lands on. The PNG renderer
// therefore passes { shadow: false } (see drawBoxes in diagram-core.js) while
// the browser editor, which renders the same call correctly, keeps its shadows.
//
// That workaround carried a bare "re-enable if the lib fixes it" comment from
// June 2026 and was never re-checked, which is exactly the failure mode these
// canaries exist to prevent. When this test fails, drop { shadow: false } and
// the `shadows` option that feeds it.
//
// The measurement lives in shadow-probe.js, which `just upstream-check` also
// runs against newer releases.

Deno.test("canary: @gfx/canvas shadowBlur is still displaced under ctx.scale", async () => {
  const { changed, beyond } = await shadowInkOutsideHalo();

  // Distinct failure: the shadow drew nothing at all, so there is nothing to
  // judge. Most likely the board's colours stopped being 6-digit hex — fix the
  // fixture rather than concluding anything about the library.
  assert(
    changed > 0,
    "enabling shadows changed no pixels, so this canary is measuring nothing " +
      "— check that the fixture's palette yields 6-digit hex border colours",
  );

  assert(
    beyond > 500,
    `Shadow ink now stays within ${HALO_RADII} blur radii of its box ` +
      `(${beyond} px beyond, ${changed} changed), so the @gfx/canvas ` +
      `shadowBlur displacement under ctx.scale looks FIXED.\n` +
      `If so: drop { shadow: false } in diagram-api.js's drawBoxes call, the ` +
      `\`shadows\` option on renderToCanvas, the note in drawBoxes, and this ` +
      `test. Then update docs/project_notes/upstream-defects.md.`,
  );
});

Deno.test("the shadow canary can actually fail — DPR 1 draws the shadow correctly", async () => {
  // Without this, the canary above is unfalsifiable: a detector that reported
  // "displaced" no matter what would pass forever and never announce a fix.
  // The fault is specific to ctx.scale(DPR), so DPR 1 is a live sample of what
  // a fixed library looks like — same code path, same board, shadow drawn
  // around its box. If this ever fails, the detector is broken, not the library.
  const { changed, beyond } = await shadowInkOutsideHalo({ dpr: 1 });
  assert(changed > 0, "DPR 1 should still draw a shadow");
  assert(
    beyond === 0,
    `at DPR 1 the shadow should hug its box, but ${beyond} px landed beyond ` +
      `${HALO_RADII} blur radii — the displacement detector is unsound`,
  );
});
