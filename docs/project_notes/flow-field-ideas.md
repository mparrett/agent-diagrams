# Flow fields: ideas for the next spike

Builds on `flow-fields.md`.

- **Box fields.** Each box carries a short-range field pointing out of its
  sides (radially out at the corners), fading over a few cells and added to the
  global field. For a wire's source it pushes the wire out square to the side;
  flipped for its target, it draws the wire in square; for every other box it
  pushes wires away. That one mechanism could replace three that exist now: the
  near-box cost halo, the forced perpendicular exit, and the forced
  perpendicular entry.
- **Growing connectors.** Animate each wire drawing itself from source to
  target. The cheap version reveals the routed path over time with a dash
  offset. The field version traces a streamline from the source, steered
  between the field and the direction to the target, so the drawing shows the
  field at work. Either could export as an animated SVG or GIF.

## From play-testing, 2026-10-25

- **Radial out / radial in.** `norm([u - 0.5, v - 0.5])` and its negative.
  Useful for wire sides on hub-and-spoke boards. Weak for placement, because a
  streamline is a straight ray from the centre to an edge, so the spine is
  short; `radial-in` at least ends the spine on the hub. A swirl with a
  tunable drift (inward to outward) would cover the range between.
- **Mirrors and rotations as modifiers.** Not more presets (`snake-tr`), but
  `flipx`, `flipy` and `transpose` applying to any field: `snake@flipx` starts
  top-right, `snake@transpose` gives vertical bands. Together they give all 8
  orientations. The modifier must transform the `fieldSeed` point too, and
  should compose with `>`.
- **Sinusoidal.** `right` with `dy = A·sin(2πk·u)`. Placement gets a wavy
  spine. Routing gains little, since the orthogonal router draws the wave as
  a staircase.
- **User-drawn curve.** The user sketches a polyline in the editor, and it is
  fitted to a centripetal Catmull-Rom spline (centripetal so it doesn't loop
  on itself). The field is the tangent of the nearest point on the curve,
  blended toward the curve with distance so streamlines converge on it.
  `flow-place` seeds at the start of the curve. The cost: `flow` stops being
  a string (`fieldFn` and `fieldSeed` both assume a preset name or `a>b`), so
  it needs an object form such as `{curve: [[u, v], …]}`, stored in the
  state file, plus a drawing tool in the editor.

## Grow: adding to a board without disturbing it

Not flow-specific, but `flow-place` raises the question, since its output is
frozen pins and any new box has nowhere to go.

- **Grow in a cardinal direction.** Built on 2026-10-25: `grow <from>
  <n|e|s|w> <id>[,…] [--chain]`, the box menu's **Grow ▸**, and with
  **Lanes** on, a dropped box going into the lane under it instead of being
  pinned. A taken cell gets a row or column inserted (`insert-row` /
  `insert-col`), pushing what was there along. Still open: under a field,
  defaulting the direction to the field at `<from>`; and a drop rarely pushes,
  because the editor won't let a dragged box overlap another.
- **Opt-in "keep what's placed".** A board flag that pins everything placed
  so far, so a new box is the only thing that reflows. Most of the mechanism
  exists: this is pin-all followed by **Re-flow unpinned**. What's new is
  doing it automatically on add, and being able to switch it off.
