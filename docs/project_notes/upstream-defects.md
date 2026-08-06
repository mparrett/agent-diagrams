# @gfx/canvas defects and the workarounds carrying them

Every entry here is a bug in `jsr:@gfx/canvas` (native Skia, from
[DjDeveloperr/skia_canvas](https://github.com/DjDeveloperr/skia_canvas)) that
this repo works around. None has been filed upstream, because none has a
standalone reproduction — see the "reported upstream" column before assuming
someone is waiting on a fix.

This file exists because a workaround for an unreported bug is invisible debt.
Nothing about a new release announces that the thing you worked around is
fixed, so without a written list and a way to retest, these outlive their cause
indefinitely. The `{ shadow: false }` workaround carried a "re-enable if the lib
fixes it" comment from June to the end of July, and nobody re-checked it once.

**To retest: `just upstream-check`.** It resolves the latest release from JSR,
pins a throwaway worktree to it, and re-runs the glyph-drop and shadow probes
there. It never touches your working tree and always exits 0 — it's a report.
The one fault it cannot automate is called out in its output and below. Note the
worktree is built from `HEAD`, so uncommitted probe changes aren't included.

Currently pinned: **0.5.6** (`deno.json`). Latest release: **0.5.8**.

| # | Fault | Workaround | Canary | Reported | Last checked |
|---|---|---|---|---|---|
| 1 | Glyph drop — `fillText` silently draws nothing | measurement font aliases | yes, automated | no — no standalone repro | 0.5.8, 2026-07-31 |
| 2 | `shadowBlur` displaced under `ctx.scale(DPR)` | shadows off in the PNG renderer | yes, automated | no | 0.5.8, 2026-07-31 |
| 3 | `getImageData` doesn't reflect what was drawn | decode the encoded PNG instead | no | no | 0.5.8, 2026-07-30 |

---

## 1. Glyph drop — text measured on one canvas won't draw on another

**Symptom.** A box is laid out at exactly the right size and then rendered
without its `details` lines: correct geometry, no text, exit code 0, nothing on
stderr. It cost entire boards their detail text.

**Trigger.** A string measured with font descriptor `D` on the throwaway layout
canvas cannot afterwards be *drawn* with descriptor `D` on the render canvas.
Breaking any leg of the `(canvas, descriptor, string)` triple cures it — drawing
at 9px or 11px, drawing in bold, appending a space to the string, or not
measuring on the scratch at all. It is **not** a small-text threshold: 8px and
9px draw fine, and only the exact descriptor the scratch measured with fails.

**Two properties that make this expensive to rediscover:**

- It is *intermittent* — roughly 1 render in 40 draws the text anyway. Any
  single-run experiment is noise. Use trial counts.
- It only bites the **first render in a process**. Loop renders in one process
  and every iteration after the first draws happily, which makes the bug look
  fixed. This is why the canary spawns a process per render.

**Workaround.** `MEASURE_SUFFIX` in `diagram-api.js`: the bundled faces are
registered a second time under `DiagramMonoMeasure` / `DiagramSansMeasure`, and
the layout pass measures through those (`state.measureFamily`, honoured by
`computeLayout`). Same font files, so metrics are identical — box geometry is
bit-identical to before the fix and editor parity is unaffected — but the
measure and draw passes no longer share a cache key.

**Canary.** `tests/raster-parity.test.js` renders the fixture with the aliases
*off* and asserts the text is still lost. It fails when the fault disappears,
and its message names everything to delete. A sibling test asserts the
production path still draws.

**Not a complete cure.** Some run-to-run variation in rendered PNGs remains on
dense boards (detail ink varying a few percent, text present either way).

**Retiring it.** When `just upstream-check` reports the fault fixed: bump the
pin, then delete `MEASURE_SUFFIX` and its four `reg(...)` calls, the
`measureFamily` branch in `computeLayout`, the `measureAliases` option on
`renderToCanvas`/`_computeGridBoxes`/`checkRaster`, `tests/canary-render.js`,
`tests/fixtures/glyph-drop-canary.json`, both canary tests, and the README's
"Notes & limitations" entry.

**Investigation.** Four standalone reproduction attempts all failed to
isolate the fault; it appears only in full renders.

## 2. `shadowBlur` displaced under `ctx.scale(DPR)`

**Symptom.** The decorative drop shadow renders as a phantom fill offset from
its box, overdrawing neighbouring labels. The browser editor renders the same
call correctly; only native Skia under `ctx.scale(DPR)` misplaces it.

**Measured displacement.** The shadow is drawn at roughly DPR times the box's
*device* position, not around the box. A box at board `(150,110)` renders at
device `(300,220)` under DPR 2, and its shadow lands at about `(600,440)` —
hundreds of pixels away, growing with distance from the origin. At DPR 1 the
same call is correct: the shadow hugs the box within its blur radius.

**Two things that hide it**, both of which cost time before the canary existed:

- **Boxes far from the origin lose their phantom off-canvas.** Scaling the
  position by DPR again pushes it past the bitmap edge, so a board whose boxes
  sit right or low renders *identically* with shadows on and off. The fixture
  pins its box near the origin for this reason.
- **Alpha used to be concatenated onto the colour string, which killed it.**
  `drawBoxes` built its shadow and outline colours as `border + "44"` /
  `border + "bb"`. That assumed 6-digit hex, so the default palette's 3-digit
  borders became `"#68f44"` — not a colour — and even from 6-digit input the
  resulting 8-digit form is rejected by `@gfx/canvas` for `strokeStyle`. Both
  assignments were ignored, so no shadow was drawn *and every box border
  rendered black on every board*. Fixed 2026-07-31 by `withAlpha()`, which
  emits `rgba()`. If you are reading a PNG committed before that date, its
  black borders are this bug, not a theme choice.

**Workaround.** The PNG renderer passes `{ shadow: false }` to `drawBoxes`
(`diagram-api.js`, via the `shadows` option on `renderToCanvas`); the guard and
its reasoning are at the `ctx.save()` in `drawBoxes` in `diagram-core.js`. The
editor still draws shadows.

**Canary.** `tests/shadow-canary.test.js` renders one board with shadows off and
on, diffs the two, and asserts that shadow ink still lands beyond three blur
radii from its box. Working on the difference means no other content can be
mistaken for shadow ink. A second test renders the same board at DPR 1 and
asserts the shadow *does* hug its box — without it the canary would be
unfalsifiable, passing forever whatever the library did. The measurement is in
`tests/shadow-probe.js`, which `just upstream-check` also runs against newer
releases.

**Retiring it.** When the canary fails (or `just upstream-check` reports it
fixed): drop `{ shadow: false }` from the `drawBoxes` call in `diagram-api.js`,
the `shadows` option on `renderToCanvas`, the note in `drawBoxes`,
`tests/shadow-probe.js`, and `tests/shadow-canary.test.js`.

## 3. `getImageData` doesn't reflect what was drawn

**Symptom.** Reading back a region of a canvas that visibly contains a filled
box returns background pixels. Dimensions are correct; contents are not.

**Discovered** while building `raster-check`, whose first implementation used
`getImageData` and reported every box as blank — a measurement harness with its
own bug, which produced several wrong conclusions before it was caught.

**Workaround.** `raster-check.js` decodes the *encoded PNG bytes* instead, with
a ~50-line reader over `DecompressionStream` (no new dependency). This is also
the more honest test, since the PNG is the artifact people receive, so this one
is worth keeping even if the underlying bug is fixed.

**No canary.** Nothing in the codebase depends on `getImageData` working, so
there is nothing to retire. Recorded here so the next person doesn't reach for
it and lose an afternoon.
