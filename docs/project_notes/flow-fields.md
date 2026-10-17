# Flow fields

Status: experimental. Built as a spike on 2026-10-16 and merged as is; see
"If it graduates" for what a full version needs. Ideas for the next round are
in `flow-field-ideas.md`.

A flow field gives the board a direction at every point. One field drives three
things:

- **Wire sides.** A wire between diagonal boxes leaves by the side the field
  points out of at the source and enters by the side it points into at the
  target. Boxes that overlap on one axis still get a straight wire.
- **Routing cost.** A* pays `weight` (6, against a step of 10) per unit of a
  step against the field and half that across it. Wires drift with the field.
- **Placement.** `flow-place` lays the longest edge chain along one
  streamline and puts every other node beside its neighbour, across the field.

## Commands

```bash
set-flow snake                  # right, left, down, up, swirl, snake, snake2, snake4
set-flow 'right>down'           # first field for 55% of the board, then the second
set-flow none
flow-place                      # pins every node; frame sized from the boxes
flow-place --frame=1300x900     # or give the area the field spans
```

In the editor, the field picker is under Board, the **Flow** toggle in the
canvas toolbar draws the field as arrows, and **Lay out along flow** (Layout)
runs `flow-place`.

`set-flow` alone changes only sides and routing. `flow-place` writes `layout`
pins, so the result is a frozen arrangement: edit the board and run it again.

## Demo boards

`diagrams/scratch/flow-*` (gitignored): one 12-step pipeline with two side
inputs, placed under `right`, `snake`, `snake2`, `swirl` and `right>down`; and a
fixed 3x3 board routed under no field, `swirl` and `right`.

## Findings

- **Placement** is the useful part. `snake` and `right>down` give layouts that
  row/col can express only by hand-numbering every node, and they come from a
  single ordering rule. `swirl` makes a readable outward spiral for a cycle of
  stages.
- **Routing under `swirl`** sends wires clockwise round the board: on the 3x3
  board the perimeter edges run outside the boxes and the middle clears. A
  uniform field such as `right` does little for routing: leftward edges still
  have to run left, and the board looks much like the one with no field.
- **Fractional costs exposed a router bug.** A* stored g in a Float32Array and
  compared it with the float64 sum, so a fractional step was skipped as stale.
  Fixed in 2b293f4; it also affected an edge's own `costs`.

## Limits

- The field spans a fixed frame, not the content; the snake's turn zone is the
  outer 12% of the frame.
- Only board-level placement; pins on inner-group members are ignored.
- A side node sits beside its first placed neighbour only; a node joining two
  spine nodes is not placed between them.

## If it graduates

Make the field a layout mode (`"layout": "flow"`) computed on every render, so
the arrangement reflows like row/col does instead of being pinned once. Fit the
frame to the content's total area (flow-place does this once today).
