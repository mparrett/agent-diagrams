# Group layout: Stage 0 spec

Status: agreed 2026-10-14, not started. Build after the remaining experience-report fixes.

## Problem

Groups (`"groups"`, `add-group`) are annotation-only: layout ignores them, and a frame is drawn wherever its members land. Rows are spaced for boxes alone (tallest box plus `ROW_GAP_PX`, 45px), and columns sit `LAYOUT_MIN_GAP` (30px) apart. A frame reaches `GROUP_PAD` (12px) past its members, and its label straddles the top border. So:

- Groups in consecutive rows leave about 6px between frames, with the lower group's label sitting on that gap.
- A box in the row directly above a group sits tight against the label.
- The README tells authors to skip a row index between stacked groups. That is a workaround for the engine, not an authoring choice.

## Goal

When groups are present, row and column spacing leaves room for their frames and labels, so stacked or side-by-side groups never crowd each other or a neighbouring box. Boards without groups lay out exactly as before.

## Non-goals

- Non-members inside a frame (intruders). Stage 0 spaces rows and columns; it does not move boxes between them. Intruders are still reported by `render` and `status --positions`.
- Layout inside a group. That is Stage 1.
- Any change to the data model or the CLI.

## Design

`computeLayout` reads `state.groups`. For each group, take its members' authored `row` and `col` indices (pinned members included, matching how a pinned box still reserves its row). The group spans rows `rmin..rmax` and columns `cmin..cmax`.

For each pair of consecutive authored rows `a < b`, the gap becomes:

```
gap(a, b) = max(ROW_GAP_PX, below(a) + above(b) + FRAME_GAP)
```

- `below(a)`: how far frames reach past the bottom of row `a`. It is `GROUP_PAD × depth`, where `depth` counts the nested groups ending at row `a` (an enclosing group adds one pad, as `groupFrames` draws it). Zero when no group ends there.
- `above(b)`: the same for groups starting at row `b`, plus half the label band for a labeled group, since the label straddles the top border.
- `FRAME_GAP`: the clear space kept between two frames, or between a frame and a box. Proposed 15px (one grid cell).

Skipped row indices still add their extra `ROW_GAP_PX` on top. An explicit `rowY` still wins outright: no adjustment is made for a row whose Y is set by hand.

Columns get the same rule, in `col` units, applied to the column pitch. The horizontal case is less pressing on current boards, since column gaps already run about 75px. Do it in the same change so both axes follow one rule.

The first row's top margin and the canvas extent need no change: `boardExtent` already keeps a 40px margin, and `fit-canvas` measures group frames since 2930b98.

### Why this is safe

- No groups means `below` and `above` are zero, so the gap is `max(ROW_GAP_PX, FRAME_GAP)`, which equals `ROW_GAP_PX` as long as `FRAME_GAP ≤ 45`. Layout is unchanged.
- The rule only ever adds space. Nothing that fits today stops fitting.
- `computeLayout` is shared with the editor, so editor↔renderer parity follows. Run `just parity` to confirm.

## Tests

- No groups: the solved layout is identical to before (positions deep-equal on an existing fixture).
- Two groups in consecutive rows: frames are at least `FRAME_GAP` apart vertically, and the lower label clears the upper frame.
- A box directly above a labeled group clears the label by `FRAME_GAP`.
- Nested groups: the outer frame's extra pad is accounted for.
- `rowY` set on the row below a group: that Y is used unchanged.
- The same set for columns.

## Docs

Remove the "skip a row index between stacked groups" advice from the README and the `add-group` help text.

## Open question

`FRAME_GAP` = 15px is a guess. Check it on the context board, which has three stacked group rows, before settling it.

## Later stages, for context

- **Stage 1:** opt-in groups with layout inside (`layout: "inner"`). The group is sized from its members' local layout, the innermost groups first, then placed as a box on the parent board. Routing stays global, with a cost for crossing a frame border. Columns become per-group. CLI and PNG first; the editor renders these groups but cannot edit them. Edges between members of different groups do not move the groups, the same as for boxes today.
- **Stage 2:** nesting, plus editor drag and pinning with positions relative to the group.
