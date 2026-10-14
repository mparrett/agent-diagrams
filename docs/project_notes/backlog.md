# Backlog

Open work, roughly in priority order within each section. Remove an item when its commit lands.

## Next

- **Intermittent raster test failure.** `raster-parity.test.js`, "the checker tells drawn text from blank space", fails in about half of full-suite runs and passes alone. The font-buffer fix holds under the GC test; the cause is unknown and may mean text can drop in long-running processes. Blocks a clean PR.
- **Node shapes:** `cylinder` for stores and `person` for actors. Connector anchors must follow the outline.

## Routing and groups

- **Wires cross group labels.** Routing does not avoid group labels, and labels inside or outside a frame have no background chip.
- **Frame-crossing cost.** Routing does not penalize crossing a frame border, so wires cross frames freely and run along them.
- **Labels wider than their frame** overhang it; frames and group boxes are not sized by measured text.
- **Edges to a group** (`add-edge api agents`). `remove-group` will need a rule for edges that end at the removed group.
- **Align with multi-select.** Align acts on board-level boxes only; the editor has no multi-select.

## Smaller

- **Edge label style:** an italic or dim option.
- **Wrapped detail lines** in minimum-height boxes need `"wrapSlack": 1.75` per board.
- **Off-board edges:** an edge cannot run off the canvas to something outside it.
- **Duplicate "Expand":** the editor has an Expand under Layout (box spread) and one under Canvas.
