# Using agent-diagrams from an agent

This page shows how to build a board from the command line. The
[README](../README.md) is the full reference. [CLAUDE.md](../CLAUDE.md) is for
working on the tool itself.

## Setup

```bash
ln -s "$PWD/bin/agent-diagrams" ~/.local/bin/agent-diagrams   # once, from the repo
```

`agent-diagrams` runs `diagram-cli.js` with the Deno permissions the renderer
needs, so a permission allowlist only needs one rule: `agent-diagrams *`.
Without the link, run `deno task cli …` from the repo.

The dev server is optional. Run `just status` to see whether one is up (it
checks the port itself), and `just serve` to start one on
<http://localhost:7787>. Both exit non-zero when something is wrong. You don't
need a server to build or render a board.

## Build a board

Boards live in the boards directory, outside the repo (`AGENT_DIAGRAMS_DIR`,
default `~/.local/share/agent-diagrams`), and are named with `--board <name>`.

```bash
agent-diagrams --board flow init --empty     # creates <boards dir>/flow/
agent-diagrams --board flow batch flow.batch # add every box and wire, render once
agent-diagrams --board flow issues           # exits 1 if it finds layout defects
```

A batch file has one CLI command per line, with `#` comments:

```
add-node api "API" blue 0 1 "FastAPI"
add-node db "db.py" gray 1 0
add-node sqlite "app.sqlite" gray 1 1
add-edge api db solid
add-edge db sqlite dashed
```

`row` and `col` are grid lanes, not pixels. To add a box next to an existing
one and wire it up in one step, use `grow <from> <n|e|s|w> <id>`. It inserts a
row or column when the target cell is taken.

## Fix the layout

- `untangle` rearranges unpinned boxes to cut crossings. Wire length counts
  too, but by default one crossing outweighs 1000 cells of wire, so it can
  push two boxes that belong together to opposite sides of the board. Two
  ways to stop that:
  - `--length-weight=N` makes length count N times as much. Try 10 to 20.
    Much higher and it starts accepting label clashes to shorten wires; check
    with `issues`.
  - Pin the boxes whose position matters first; `untangle` leaves pinned
    boxes where they are. A box gets pinned when it is dragged in the editor
    or moved by `spread` or `snap-h`/`snap-v`.
- `place <id> <row> <col>` puts a box in a cell and unpins it. `free-node <id>`
  only unpins it, handing it back to auto-layout. To lay out by hand, use
  `free-node` on the boxes you want to move, `place` each one, then run
  `issues`.
- `fit-canvas` trims the board to its content.

## Check the result

- `issues [--json]` names what's wrong (wires sharing a track, label clashes,
  failed routes), so you often don't need to open the PNG.
- `status --positions` prints each box's solved `{x, y, w, h}` without
  rendering.
- The PNG is written as `diagram.png` next to the board's
  `diagram-state.json`. It's drawn at 2x, so looking at it costs more than
  reading `issues` does. To look between steps, run `render --preview`: it
  writes `diagram.preview.png` at 1x, a quarter of the pixels, and leaves
  `diagram.png` alone.

Add `--no-render` to a call, or set `DIAGRAM_NO_RENDER=1`, to save without
drawing; finish with `render`. A batch already renders only once; a
`render --preview` line in it makes that render a preview.

## Generate a board instead

`just import-deps <entry>` (a Deno module graph), `just import-tree <dir>`
(a directory tree) and `just import-python <dir>` (a Python package's imports,
CLI commands and routes) build a board from code you already have. See
[Importing real graphs](../README.md#importing-real-graphs).

## Don'ts

- Don't edit boards under the repo's `diagrams/` from the editor; they are
  shipped examples, read-only as `examples/<name>`. Copy one to your boards
  first.
- Don't open the PNG after every call; run `issues` and look once at the end.
