# Group layout: Stage 1 design (draft)

Status: draft for review, 2026-10-14. Stage 0 (spacing for frames) is in `group-layout.md`.

## Goal

A group can lay out its own members. It is sized from that inner layout and placed on the parent board as a single box. Intruders become an authoring error instead of a layout accident: a non-member lands inside the frame only if it is given the group's own parent row and column, the same mistake as giving two boxes one cell today.

## Prerequisite: the editor stops freezing whole boards

`persistLayout` in `whiteboard-live.js` sends a position for **every** box on any drag, so one accidental move turns a whole board into fixed positions. That happened to the tree board and the context board on 2026-10-14. Fixed positions override rows and columns, so a frozen board would also ignore any layout inside a group.

The full snapshot exists because the old spring pass re-solved positions differently on each render. #14 removed that pass, and layout is now deterministic from `row`/`col`. So the editor can send only the boxes a person moved or pinned.

`fit-canvas` freezes every box the same way, through `_resizeCanvas`. Shifting the content can instead adjust a stored board offset and leave the boxes on automatic placement.

Done 2026-10-14: the editor saves only placed boxes (986d5ab), and canvas resizes move auto-placed boxes through `state.offset` (the commit after it).

This lands first, as its own change: it is useful without Stage 1 and lowers the risk of everything after it.

## Data model

```jsonc
{ "id": "agents", "label": "Consuming agents",
  "nodes": ["help", "summary", "helpkb"],
  "layout": "inner",          // new; absent = today's annotation group
  "row": 2, "col": 3 }        // the group's place on the parent board
```

- Members of an inner group read `row`/`col` as positions inside the group.
- A node belongs to at most one inner group in Stage 1. Annotation groups can still wrap inner groups and other nodes.
- An inner group cannot contain another inner group until Stage 2. Validation rejects it.
- CLI: `add-group --inner --row=N --col=N`, and `update-group --inner|--annotation --row= --col=`.

## Layout

1. **Size boxes** for the whole board, as today: the width ladder, `wrapSlack`, and the uniformity pass run once over all boxes, so inner and outer boxes share widths.
2. **Lay out each inner group's members** with the same row and column rules, relative to (0, 0), with no centering and no canvas margin. This needs the placement half of `computeLayout` split into a function that lays out a set of boxes and returns positions plus extent.
3. **Turn each group into a pseudo-box:** the inner extent plus `GROUP_PAD` on every side, plus the label band on top, rounded up to whole cells.
4. **Lay out the parent board** with those pseudo-boxes in place of their members. Stage 0's spacing still applies, at the group's parent row and column.
5. **Offset each member** by its group's position, snapped to the grid.

Members never take part in the parent's columns. That is the cost of this stage: a box in one inner group no longer lines up with a box outside it.

## Routing

Routing stays global and unchanged: every box is an obstacle wherever it ends up. A cost for crossing a frame border is a likely follow-up, but it needs boards to tune against first.

## Positions and pins

- `layout[groupId] = {x, y}` pins a whole group. Its members move with it.
- A member's pin is stored relative to its group, in a new `innerLayout: { groupId: { nodeId: {x, y} } }` map. Absolute positions would break as soon as the group moved. This is the part that touches `mergeLayout` and its conflict handling, and the editor.
- Stage 1 ships with member pins rejected for inner groups. The editor draws inner groups and can drag a group as a whole; dragging a member snaps it back with a status message. Member pins come in Stage 2 with nesting, since both need the same relative-position model.

## Read-back

`status --positions` reports each inner group's rect and its members' absolute positions, as today. Members gain a `group` field.

## Tests

- An inner group with members in rows 0–1 and columns 0–1 sizes to its contents plus padding.
- A non-member in a neighbouring parent cell stays outside the frame, however large the group grows.
- A non-member given the group's own parent cell is reported, the same as two boxes in one cell.
- Inner groups and plain boxes in one parent row line up by the group's box.
- Pinning a group moves its members with it.
- An annotation group around an inner group still draws around it.
- Editor↔renderer parity on a board with inner groups.

## Decisions needed

1. **Editor change first, as its own PR?** Recommended. It is also the fix for this morning's frozen boards.
2. **Box widths shared across inner groups?** Recommended: one pass for the whole board keeps widths consistent. The alternative lets each group pick its own widths.
3. **Member pins:** reject in Stage 1 (recommended), or build the relative-position model now?
4. **Edges to a group itself** (`add-edge api agents`), as D2 allows: not in Stage 1.
