# Backlog

Open work, roughly in priority order within each section. Remove an item when its commit lands.

## Next

- **Intermittent raster test failure.** `raster-parity.test.js`, "the checker tells drawn text from blank space", fails in about half of full-suite runs and passes alone. The font-buffer fix holds under the GC test; the cause is unknown and may mean text can drop in long-running processes. Blocks a clean PR.

## From the layout study

Rebuilding five D2 diagrams headless (layout study) left these open:

- **Span for inner groups.** `span` stretches boxes only. In a stack, a group narrower than its column (Consumers over a wider Build pipelines) stays narrow; stretching it means spreading the extra width over the group's own columns.
- **Flow direction.** A left-to-right board needs `--fromEdge=E --toEdge=W` on every edge whose boxes don't overlap vertically; a board-level `direction` would set the default sides.
- **Narrow channels between rows.** Several long wires and a fan-out share the one horizontal track under a box; skipping a row is the workaround.
- **Title block.** No title size, rule, centering or subtitle; the subtitle goes in the footer.
- **Legend edge entries.** The legend lists colors only; dashed and colored edge styles can't be keyed.
- **Page shape** for callout cards; a note has no card behind it.
- **The second raster flake.** "the shipped example board keeps its labels" also failed once in a full-suite run and passes alone, like the item under Next.

## Routing and groups

- **Labels wider than their frame** overhang it; frames and group boxes are not sized by measured text.
- **Edges to a group** (`add-edge api agents`). `remove-group` will need a rule for edges that end at the removed group.
- **Align with multi-select.** Align acts on board-level boxes only; the editor has no multi-select.

## Smaller

- **Edge label style:** an italic or dim option.
- **Wrapped detail lines** in minimum-height boxes need `"wrapSlack": 1.75` per board.
- **Off-board edges:** an edge cannot run off the canvas to something outside it.
- **Duplicate "Expand":** the editor has an Expand under Layout (box spread) and one under Canvas.
