# Backlog

Open work, roughly in priority order within each section. Remove an item when its commit lands.

## Next


## From the layout study

Rebuilding five D2 diagrams headless (layout study) left these open:

- **Narrow channels between rows.** Several long wires and a fan-out share the one horizontal track under a box; skipping a row is the workaround.
- **Title block.** No title size, rule, centering or subtitle; the subtitle goes in the footer.
- **Legend edge entries.** The legend lists colors only; dashed and colored edge styles can't be keyed.
- **Page shape** for callout cards; a note has no card behind it.

## Routing and groups

- **Labels wider than their frame** overhang it; frames and group boxes are not sized by measured text.
- **Edges to a group** (`add-edge api agents`). `remove-group` will need a rule for edges that end at the removed group.
- **Align with multi-select.** Align acts on board-level boxes only; the editor has no multi-select.

## Smaller

- **Edge label style:** an italic or dim option.
- **Wrapped detail lines** in minimum-height boxes need `"wrapSlack": 1.75` per board.
- **Off-board edges:** an edge cannot run off the canvas to something outside it.
- **Duplicate "Expand":** the editor has an Expand under Layout (box spread) and one under Canvas.
