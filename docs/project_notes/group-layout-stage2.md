# Group layout: Stage 2 design (draft)

Status: draft, 2026-10-14. Stage 0 (spacing for frames) is in `group-layout.md`, Stage 1 (inner groups) in `group-layout-stage1.md`. Group label placement (`labelPos`, `labelAlign`, `labelWeight`, `labelSize`) lands before this stage.

## Goal

An inner group can contain other inner groups, to any depth. Members of an inner group can be pinned relative to their group, and a whole group can be dragged in the editor.

Stage 2 ships in two changes:

- **2a, nesting:** nested inner groups in the CLI, the renderer, and `status`. The editor draws them and adds no new editing.
- **2b, pins and editor:** group pins, member pins relative to their group, and the editor gestures for both.

2a ships first.

Out of Stage 2: edges to a group itself, a routing cost for crossing a frame border, and node shapes.

## Example

The board this is for: an "Agent Reference" group holding three groups and a few loose nodes.

```jsonc
"groups": [
  { "id": "ar", "label": "Agent Reference", "layout": "inner", "row": 1, "col": 2,
    "nodes": ["knowledge", "style", "topicmap", "ar-api", "ar-cache"] },
  { "id": "knowledge", "label": "Knowledge", "layout": "inner", "row": 0, "col": 0,
    "nodes": ["kb-docs", "kb-index"] },
  { "id": "style", "label": "Style Guide", "layout": "inner", "row": 0, "col": 1,
    "nodes": ["style-guide", "style-examples"] },
  { "id": "topicmap", "label": "Topic Map", "layout": "inner", "row": 0, "col": 2,
    "nodes": ["tm-entities"] }
]
// ar-api and ar-cache carry row 1 in ar's grid; kb-docs and kb-index
// carry rows in knowledge's grid, and so on.
```

`ar` places `knowledge`, `style`, and `topicmap` in its row 0 and the two loose nodes in its row 1. `ar` itself sits at row 1, col 2 on the board.

## Data model

- **Child by id.** A parent inner group lists a child group by putting the child's group id in its `nodes` array. One array can mix node ids and group ids.
- **One id namespace.** Group ids and node ids share one namespace. `add-node`, `add-group`, and any rename reject an id already used by the other kind, naming both. Loading a board with a collision is an error. No board under `diagrams/` has one today.
- **Child row and col.** A child group's `row`/`col` are read in its parent's local grid, the same way a member node's are. A group with no inner parent reads them on the board, as in Stage 1.
- **Direct membership.** A node listed by an inner group is a member of that group only. It is inside every ancestor transitively and is not listed again in them.
- **Annotation groups.** An annotation group may list node ids and inner group ids. An inner group id in an annotation group means "wrap this group's frame". It does not make the annotation group a parent: annotation groups take no part in layout nesting. Listing an annotation group id in any group's `nodes` is an error.
- **CLI.** `add-group --inner` and `update-group --nodes/--add/--remove` accept group ids. `_groupNodes` currently rejects anything that is not a node; it learns to accept existing group ids.

## Validation

Runs in `_groupStyle` on every add or update, and when a board loads. Every message names the ids involved.

- **Unknown id:** `group "ar": no such node or group: topicmpa`.
- **Self or cycle:** `inner groups form a cycle: ar -> knowledge -> ar`. Found by a depth-first walk over child group ids.
- **One parent per group:** `group "style" is listed by inner groups "ar" and "marketing"; a group can have only one inner parent`. Annotation groups that list it do not count.
- **One inner group per node:** `node "kb-docs" is in inner groups "knowledge" and "ar"; list it in its innermost group only`. This replaces the Stage 1 "shares … with inner group" check.
- **Annotation id in `nodes`:** `group "ar" lists annotation group "notes"; only inner groups can be listed`.
- **Kind change:** `update-group --annotation` on a group that a parent lists, or that lists child groups, is rejected: `group "style" is listed by inner group "ar"; remove it there first`.
- **Depth:** no limit. Cycles are the only structural failure.

`remove-group` on a nested inner group moves its direct members (nodes and child groups) into its parent's `nodes`, and prints that their `row`/`col` are now read in the parent's grid. `remove-node` keeps dropping the id from every group, as now.

## Layout

The Stage 1 shape stays: box sizes are computed once for the whole board, each inner group is laid out locally by `place()`, and each becomes a pseudo-box (`PSEUDO_PREFIX + id`) in the layout one level up.

1. **Build the tree.** `innerGroups` returns, per inner group, its direct node members, its child group ids, and its parent. Roots are groups with no inner parent.
2. **Innermost first.** Process groups in post-order: children before parents, siblings in authoring order. The order depends only on the tree, so layout is deterministic and independent of the order of the `groups` array.
3. **Local layout.** For each group, call `place()` on its direct node members plus one pseudo-box per child group, at the child's `row`/`col`. The child's pseudo-box size comes from step 4, already run for the child.
4. **Pseudo-box size.** The local extent plus the group's insets on each side, rounded up to whole cells.
5. **Board.** Call `place()` on loose nodes plus root pseudo-boxes, as Stage 1 does.
6. **Offset, top down.** A member's absolute cell is its parent pseudo-box's cell, plus the parent's left/top insets, plus its local cell minus the local minimum. Child pseudo-boxes are offset the same way, and their members are then offset from them.

### Insets per group

With `labelPos`, the padding on the label side is per group:

- `*-border`: `GROUP_PAD` plus half the label band, as today.
- `*-inside`: `GROUP_PAD` plus the full band; the frame grows to hold the label.
- `*-outside`: `GROUP_PAD` on the frame, and the label a full band beyond it. The pseudo-box includes the label.

The other three sides take `GROUP_PAD`. The band depends on the group's `labelSize`.

Recommendation: one function, `groupInsets(group, board)`, returns `{top, right, bottom, left}` in pixels, and `groupReach`, `groupFrames`, and the pseudo-box sizing all call it. Today all three read the label term from `groupLabelStyle(...).reach` (7fbca0a), but each adds `GROUP_PAD` and picks the side itself. With nesting, any mismatch between the three puts an inner frame's label outside its pseudo-box, where it overlaps a sibling.

The pseudo-box must contain the group's frame and label as `groupFrames` draws them, for every `labelPos`.

### Frames and annotation groups at each level

- **Frames.** `groupFrames` already wraps a smaller group's labelled frame in a larger one when the members of one are a subset of the other's. It resolves each inner group's `nodes` to its transitive node members first, so a parent wraps its children.
- **Stage 0 spacing.** Applies inside every local layout, between the boxes and pseudo-boxes at that level.
- **Annotation groups.** Each annotation group is placed at the level of the innermost inner group that contains all of its members (the board, if none does). At that level its ids are mapped to the box or pseudo-box that holds them, and it is passed to `place()` as `groups`. Stage 1 always maps to the board, which gives no spacing to an annotation group whose members all sit inside one inner group. This changes the render of Stage 1 boards that use that pattern. No board under `diagrams/` does.

Routing is unchanged: every box is an obstacle wherever it ends up.

## Editor (2a)

- **Draws:** nested frames and labels, from the shared `computeLayout` and `groupFrames`.
- **Refuses:** dragging or pinning a member at any depth, with the Stage 1 message naming its innermost group. `innerGroupOf` returns the innermost group. Align and Expand skip members at any depth, as Stage 1 does for direct members.
- **No new gestures.** A group is still moved with `update-group --row/--col`.

## Read-back

`status --positions`:

- **Members:** `group` is the innermost inner group, the same meaning as in Stage 1. No `path` field: a caller that needs the chain walks `parent` on the group entries.
- **Groups:** each entry in `groups` gains `parent` (the inner parent's id, or absent) and `layout`. The rect is the frame as drawn; a child's rect lies inside its parent's.

## 2b: pins

### Storage

- **Root groups:** `layout[groupId] = {x, y}`, absolute, the pseudo-box's top-left. It replaces the group's `row`/`col` the way a node pin does.
- **Members and child groups:** `innerLayout: { groupId: { id: {x, y} } }`, keyed by the direct parent. Coordinates are pixels from the parent's content origin: the local grid's (0, 0), inside the insets. Changing a group's `labelPos` or `labelSize` then moves no pinned member.
- **Clamp:** relative pins are clamped to `x, y >= 0` on write. A group grows right and down to hold a pinned member, so pinning a member never shifts the group's origin.
- **`pinned`:** holds node ids and group ids. Ids are unique across both kinds, so one list stays unambiguous.

### Merge, free, and conflicts

- `POST /layout` takes `innerLayout` alongside `layout`. `mergeLayout` accepts root inner group ids in `layout`, and drops any node id that is a member of an inner group, since its group places it. A new `mergeInnerLayout` checks that each id is a direct member of the group it is filed under.
- `free` releases an id from `layout` and from its parent's `innerLayout` entry. Each id has one parent, so this needs no group key.
- `mergeReload` in `whiteboard-live.js` flags a conflict when disk changed `innerLayout[g][id]` under a pending drag of the same id, as it does for `layout[id]` today.
- Auto Layout clears `layout`, `innerLayout`, and `pinned`.

### Stale pins

A relative pin only means something inside the group it was filed under.

- `update-group` that removes an id from a group drops `innerLayout[group][id]` and the id from `pinned`.
- Adding an id to a group, or moving it between groups, drops any pin it had in its old group and any absolute `layout[id]`, as Stage 1 does with `releaseLayout` today.
- `remove-group` drops `layout[group]`, `innerLayout[group]`, and the group's own entry in its parent's map. Its promoted members lose their relative pins.
- On load, an entry filed under a group that does not list that id is ignored, reported by validation as a warning, and dropped on the next write.

### Editor gestures

- **Drag a group:** grab its label chip or its frame border (a band a few pixels wide). The interior stays free for member drags and box selection. A root group records `layout[groupId]`; a child group records `innerLayout[parent][groupId]`. Members move with it.
- **Drag a member:** records its relative position. The group grows to hold it. Dragging past the frame leaves membership unchanged; membership stays a CLI operation.
- **Pin/Unpin** work on members and groups, filed by the same rules.
- **Align** acts on selected boxes that share one parent and skips the rest with a status message. **Expand** moves root positions through `state.offset`; relative pins need no change.

## Tests

### 2a

- Every board under `diagrams/` without nested groups renders byte-identical PNGs before and after, `scratch/inner1` included.
- The example above: the three child frames sit inside `ar`'s frame, sibling frames are at least `FRAME_GAP` apart, and `ar-api` lines up with the child pseudo-boxes in `ar`'s grid.
- For each `labelPos`, a child's drawn frame and label lie inside its pseudo-box, and the parent's frame clears the child's label.
- A three-level nest lays out, and its rects nest in `status --positions`.
- Reordering the `groups` array does not change the solved positions.
- Validation, one test per rule, each checking the ids in the message: unknown id, self, cycle of two, two parents, node in parent and child, annotation id in `nodes`, kind change on a listed group, and node/group id collision from `add-node` and from `add-group`.
- `remove-group` on a child moves its members into the parent.
- An annotation group listing a nested inner group id draws around that group's frame and gets Stage 0 spacing at the parent's level. An annotation group whose members all sit in one inner group gets spacing inside it.
- `status --positions`: `group` is the innermost group; `groups` entries carry `parent`.
- `just editor-check`: dragging a member two levels down is refused, Pin on it is refused, and editor↔renderer parity holds on the example board. `just parity`: 0 mismatches.

### 2b

- Pinning a root group moves all its descendants with it; pinning a child group moves its members and leaves its siblings in place.
- A member pin survives a change to its group's `row`/`col`, its parent's pin, and its group's `labelPos`.
- A pin with negative coordinates is clamped to 0.
- `update-group --remove` and `remove-group` leave no stale `innerLayout` entries; a hand-edited stale entry is ignored with a warning.
- `free` releases a member pin. Auto Layout clears all three maps.
- `mergeLayout` drops an absolute pin sent for a member.
- `just editor-check`: dragging a group by its label and by its border persists one entry; dragging a member persists a relative entry; a concurrent CLI change to the same `innerLayout` entry is flagged as a conflict; parity holds after each.

## Decisions needed

1. **Annotation groups listing inner group ids.** Recommended: allowed, meaning "wrap this group's frame". The alternative is node ids only, with authors listing members.
2. **`remove-group` on a nested group.** Recommended: its members move into the parent. The alternative drops them out of every inner group onto the board.
3. **Annotation groups inside an inner group.** Recommended: laid out at the innermost level that holds all their members. This changes Stage 1 renders that use the pattern; none under `diagrams/` do.
4. **Depth limit.** Recommended: none. A cap (say three levels) would only enforce readability; the engine needs none.
5. **Group drag hit area in 2b.** Recommended: label chip and frame border only. The alternative, the whole interior, conflicts with member drags and box selection.
