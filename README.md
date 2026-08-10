# agent-diagrams

A small, dependency-light system for generating clean **architecture / flow diagrams as data**. A diagram is described in a single `diagram-state.json` file; a headless [Deno](https://deno.com/) renderer turns it into a PNG with automatic orthogonal edge routing (A\*), force-directed layout, and styled nodes/edges. An optional browser editor lets a human drag boxes and tune routing.

It's designed for **agents and humans working the same file**: an agent edits the JSON (directly or via the CLI), runs one command, and gets a `diagram.png`; a human opens the live editor and drags boxes. No layout fiddling required — the engine routes the wires.

> Generalized from an ad-hoc system.

## Why

Mermaid/Graphviz are great but their auto-layout is hard to nudge and the output is generic. This engine gives you:

- **Data-first** — the whole diagram is one JSON file an agent can read, diff, and edit.
- **Real orthogonal routing** — A\* on a cost grid, so wires avoid boxes and each other, with tunable turn/clearance/overlap penalties.
- **Deterministic, reviewable** — same JSON → same PNG, byte for byte; the JSON lives in git. (Set `"timestamp": true` to stamp the render time into the image — that trades the byte-stability away, so `diagram.png` then changes on every render.)
- **A human escape hatch** — open the live editor, drag things, click *Save positions*, paste back into the JSON.

## Requirements

[Deno](https://deno.com/) (tested on 2.x) — the only runtime. Third-party deps (`@gfx/canvas` (native Skia) for rendering, `@std/http` for the dev server) are vendored in `vendor/`; `@gfx/canvas` downloads its native binary on first run. No Node/npm needed.

## Quick start

```bash
# scaffold a starter diagram in the current directory
deno run --allow-read --allow-write diagram-cli.js init

# edit diagram-state.json, then render
deno run --allow-read --allow-write render-diagram.js
# → writes diagram.png
```

Or use the `deno task` shortcuts defined in `deno.json`:

```bash
deno task cli init
deno task render
deno task cli add-node cache "Redis" gray 1 2 "session store"
```

**Which state file?** Every command resolves `diagram-state.json` relative to the **current working directory** — so you can `init`/`render`/CLI from any project, not just the tool repo. To point somewhere else, pass `--state <path>` (works on every command, including `render-diagram.js` and the dev server) or set the `DIAGRAM_STATE` env var. Precedence: `--state` > `DIAGRAM_STATE` > a `./diagram-state.json` in the cwd > the bundled example board. The PNG is always written next to the state file.

The repo ships with an example board at `diagrams/example/` (a request flow, `diagram-state.json` + rendered `diagram.png`). It's the zero-config default for `render`/`serve` when the cwd has no `diagram-state.json`, and the dev server's `default` board.

## Driving it live (humans & agents)

Start the server once; then a human (in the browser) and any number of agents (file/CLI) can work the **same `diagram-state.json` at the same time**. The file stays the source of truth — there's no server-as-authority.

```bash
just serve        # start it (tmux session 'agent-diagrams', http://localhost:8000)
just serve path/to/diagram-state.json   # …or drive an out-of-repo diagram
just status       # is it up? prints the editor URL
just logs         # tail recent server output
just restart      # stop + start fresh        just stop   # stop
# without `just`:  deno task dev -- --state=path/to/diagram-state.json
```

Open in a browser:

- **Editor** → <http://localhost:8000/whiteboard-live.html> — drag, edit, tune.
- **Viewer** → <http://localhost:8000/whiteboard.html> — read-only PNG that live-reloads.

**Multiple whiteboards.** One server hosts many boards: the `--state` file is the
`default` board, and every `diagram-state.json` under the repo's `diagrams/` tree is a
board named by its subpath (`letgo-io`, `letgo-io-phases/1-current`, …). The editor
sidebar has a **Board** picker (or open `whiteboard-live.html?d=<name>` /
`whiteboard.html?d=<name>` directly); agents target a board with
`--state diagrams/<name>/diagram-state.json` as usual. `GET /diagrams` lists boards;
board-scoped endpoints live under `/d/<name>/…`; unprefixed endpoints keep operating
on the default board. New boards appear live — `init` a state file under `diagrams/`
and it's in the picker. Board names map to paths server-side only.

**As a human (in the editor):**

- **Drag** a box to move it — auto-saves (debounced) and re-renders.
- **+ Node** adds one; **double-click** a node to edit label / color / details; **Delete** removes it.
- **Connect** mode draws an edge between two nodes.
- **Align** / **Expand** / **Contract** tidy the layout; **Auto Layout** drops all manual positions (and pins) back to auto-layout — *persisted*, so a reload won't bring the old drags back.
- The **theme** dropdown and the four **A\* routing sliders** (⚙, right side) apply live **and persist to the file** (so the CLI/PNG render reproduces what you tuned).
- **Save positions** copies the full state — including the authoritative `layout` map — to your clipboard for paste-back into the JSON.

**As an agent (file or CLI, while the server runs):**

- **Read** is just the file: `cat diagram-state.json` is always fresh.
- **Write** via the CLI (`deno task cli …`) or the `Diagram` API — both CAS-guarded. The server watches the file, re-renders `diagram.png` in-process, and pushes a live-reload to any open editor/viewer.
- Hand-editing the JSON is fine for single-writer work; save it and the server picks it up.
- Content edits (nodes/edges) and a human's drags live in **disjoint keys**, so they merge without clobbering — only a genuine same-node conflict prompts a reconcile.

See [Collaboration & concurrency](#collaboration--concurrency) for the safety model and the live `POST` endpoints.

## The state file

`diagram-state.json` is the single source of truth.

```jsonc
{
  "title":   "Example — Request Flow",   // optional; drawn top-left
  "timestamp": false,                      // optional; true adds a "Generated: <utc>" line
                                           //   under the title — makes the PNG differ on
                                           //   every render, so it's off by default
  "width":   1100,                         // optional canvas size (default 1500x900)
  "height":  760,
  "footer":  "Solid = sync  |  Dashed = async",  // optional caption line
  "background": "#16162a",                 // optional
  "legend":  null,                         // optional: omit/null = auto from colors used (preferred);
                                           //   [] or false = no legend;
                                           //   [{ "color": "#68f", "label": "service" }] = explicit
                                           //   (prefer omitting — a hand-written legend risks
                                           //    drifting from the palette. See Colors below.)
  "output":  "diagram.png",                // optional output filename
  "connectorAnchor": "align",              // optional: "align" (default — straight runs) or
                                           //   "center" (fan connectors symmetric about each side's center)

  "nodes": [
    { "id": "api", "label": "API Gateway", "color": "blue",
      "details": ["auth, routing"], "row": 1, "col": 1,
      "w": 14, "h": 6 }   // optional explicit size in grid cells (drag a box's SE corner in the editor);
                          //   omit for auto-fit. Clamped up to content so text never clips.
  ],
  "edges": [
    { "from": "client", "to": "api", "style": "solid", "label": "HTTPS",
      "id": "client~api",          // optional stable identity; backfilled on load (from~to, then ~2…)
      "fromEdge": "E", "toEdge": "W",   // optional: pin which box side each end leaves/enters (N|S|E|W)
      "fromConn": 0, "toConn": 2 }      //   and which connector slot on that side (0-based, or "C" for center)
  ],

  "layout":  {},                           // per-node absolute overrides { id: {x,y} } (see below)
  "noteLayout": {},                        // per-note absolute overrides { noteId: {x,y} } — set by GUI drags
  "pinned":  [],                           // optional: ids the human manually placed (editor markers; subset of layout)
  "rowY":    { "0": 60, "1": 220 },        // optional: row index → Y pixel (else auto-spaced)
  "rev":     0,                            // optimistic-concurrency counter (managed; see below)

  "font": "mono",                          // optional: "mono" (default) | "sans" (Instrument Sans)
  "fontSize": 13,                          // optional: base box-label px (default 13); scales the whole diagram
  "uniformWidth": false,                   // optional: homogenize box widths (see below)
  "maxNodeW": 340,                         // optional: px a box grows to before its text wraps (0 = never wrap)
  "dividers": [                            // optional: dotted boundary lines across the canvas
    { "orient": "h", "at": 240, "label": "host boundary" }
  ],
  "notes": [                               // optional: free-floating text annotations
    { "id": "n1", "x": 950, "y": 320, "title": "why", "text": ["line one", "line two"] },
    { "id": "n2", "anchor": { "to": "api", "side": "E", "dx": 12, "dy": 0 }, "text": ["rides the api box"] }
  ],

  "costs": {}                              // optional A* overrides: { step, turn, near, overlap }
}
```

Per-edge routing bias: any edge may carry its own `"costs": { step?, turn?, near?, overlap? }` that compose over the global `costs` (`update-edge <from> <to> --cost-overlap=120`). Handy for the **request/response** pattern — give the `B → A` response edge a higher `overlap`/`turn` so it doesn't sit on top of the `A → B` request wire (no special "reverse" concept needed; it's two ordinary edges).

**Layout model — content vs. layout.** There are two ways a node gets placed, and they map cleanly onto *who edits what*:

- **`row`/`col` (+ optional `rowY`) — the authoring hints.** Cheap, approximate placement: rows map to Y bands (`rowY`, or auto-spaced), columns spread horizontally and relax via a spring/repulsion pass. This is how **agents** place nodes — no pixel math, just "row 2, col 1."
- **`layout[id] = {x,y}` — per-node absolute overrides.** When present, the node is pinned at those pixels and skips the auto-layout pass. This is how the **GUI** records a human's drags and the output of `spread`/`snap`. Overrides win over `row`/`col`/`rowY`.

Because content (`nodes`/`edges`) and layout (`layout`) are disjoint keys, an agent restructuring and a human dragging don't collide.

### Boundaries, notes & emphasis

Three light annotation primitives keep diagrams grokkable without boxes-inside-boxes:

- **Dividers** — full-width/-height dotted lines that partition the canvas into regions (`"dividers"`, or `add-divider h 240 "host boundary"`). Annotation only: wires route straight through them.
- **Notes** — free-floating info-panel text outside any box (`"notes"`, or `add-note 950 320 --title="why" "line one" "line two"`): captions beside connectors, region callouts. Notes mirror the node placement model: an absolute `x,y` **or** an `anchor` to a node that rides the box through re-layout (`add-note --anchor=api:E:12:0 "…"` → 12px right of `api`'s east edge). In the editor, drag a note to pin it (writes a `noteLayout[id]` override), right-click for **Edit / Re-anchor to nearest box / Free / Delete**, double-click to edit text, or right-click empty canvas to drop one. `free-note <id>` drops the drag override so the note returns to its anchor/`x,y`.
- **Uniform widths** — `"uniformWidth": true` (or `uniform-width on`) sizes every box to the widest one, so size variation reads as *deliberate*. To emphasize a node, give it `"minW": <px>` (or `update-node <id> --minW=320`) — it keeps its own size while the rest stay homogenized.
- **Box size** — boxes auto-fit their content, floored to a 4:3 card minimum so short labels aren't thin strips. Set an explicit size in grid cells with `"w"`/`"h"` (or `update-node <id> --w=14 --h=6`, or drag a box's bottom-right corner in the editor). Explicit size is clamped up to the content/card minimum, so a box can never shrink small enough to clip its text; `--w=0`/`--h=0` clears it back to auto. Explicitly-sized boxes opt out of `uniformWidth`. When you give a box an explicit width, a long **title** wraps to fit it (so you can make a wide box narrower).
- **Text wrapping and box width** — an auto-sized box doesn't take whatever its longest string measures. It picks a width from a small ladder of whole-cell sizes and wraps its text to fit, choosing the rung that gives the **smallest area** while staying in a sane aspect band and without cutting any text. Titles wrap to two lines, each `details` line to three.

  Three things follow. Box edges line up, because every width comes off the same ladder — on a real board, free-growing boxes took 19 distinct widths where the ladder takes 3. Boards get smaller, since a tall narrow box usually beats a wide flat one. And nothing silently vanishes: a rung that would ellipsize is rejected while a wider one still holds the text, so the box grows rather than truncating.

  Without a ceiling, one long string sets the column width for its whole row, so a single node stretches the board — and a wide enough board hits the 4096px raster cap and is downscaled until nothing reads. `maxNodeW` (default 340px, scaled by `fontSize`) caps the top of the ladder. A word too long to break is never split: it overflows and widens the box, so module paths and ids stay readable. To opt out, set `"maxNodeW": 0` for the board, or give one box an explicit `"w"` — an explicit width always wins.
- **Typeface** — `"font": "sans"` (or `set-font sans`) switches the whole diagram from the default monospace to bundled Instrument Sans (with DejaVu's symbol glyphs merged in, so `✗ ✓ → ●` still render). The editor ships a matching `@font-face`, so it stays WYSIWYG.
- **Font size** — `"fontSize": 16` (or `set-font-size 16`, or the editor sidebar) scales every text size *and* the box geometry from a base of 13px, so boxes grow to fit. Unset renders identically to before. `set-font-size reset` returns to the default.

### Colors and edge styles

Built-in node colors: `blue`, `green`, `amber`, `purple`, `teal`, `red`, `pink`, `gray`.
Built-in edge styles: `default`, `solid`, `dashed`, `dotted`, `thin`, `alert`.

**Reference colors by name, not hex.** Nodes take a color *name* (`"color": "blue"`), and the legend auto-derives its swatches from the names actually used — so hand-writing legend hex (or inventing a swatch color) only creates drift. Leave `"legend"` null and let it build itself; set `false` to hide it.

**Edge label placement.** Labels auto-place on the wire's longest segment and, by default, relocate only when two label chips would collide (otherwise byte-identical to before). Pin one with `"labelPos": { "side": "above"|"below"|"left"|"right", "offset": <px>, "seg": <segmentIndex> }` — or `update-edge <from> <to> --labelSide=below --labelOffset=24`, also in the editor's edge popover. `--labelReset` returns it to auto.

Add your own (or override the defaults) right in the state file:

```json
{
  "colors":     { "warn": { "bg": "#2a2a1a", "border": "#fc0" } },
  "edgeStyles": { "rpc":  { "color": "#6cf", "dash": [] } }
}
```

### Themes

A `"theme": "<name>"` field recolors the whole diagram from a terminal color
scheme. Each scheme in `themes.js` is just a raw palette (background, foreground,
16 ANSI colors, sourced from [iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes));
`deriveTheme()` maps it onto diagram entities:

- canvas background ← `bg`, all text ← `fg` (dimmed for details/legend),
- node border ← an ANSI accent, node fill ← that accent blended ~86% toward `bg`
  (so it adapts to **light or dark** schemes automatically),
- edge colors ← magenta/yellow/cyan/red.

Built-in: `afterglow` (dark), `dawnfox` (light), `monolight` (grayscale light — node categories read as distinct gray shades; edge styles stay distinguishable by dash pattern). Pick one live from the editor's
dropdown (persists), or set `theme` in the file. **To add a scheme**, paste its
18 hex values into `SCHEMES` in `themes.js` — nothing else changes. Any
`colors`/`edgeStyles` overrides above still win over the theme.

## CLI

```
diagram-cli.js [--state <path>] <command> [args...]

  init                       Write a starter diagram-state.json
  add-node <id> <label> <color> <row> <col> [details...]
  add-edge <from> <to> <style> [label]    (parallel edges allowed — repeat to add a 2nd a→b)
  remove-node <id>           (also removes connected edges)
  remove-edge <from> <to>    (or remove-edge --id=ID to target one of several parallel edges)
  move-node <id> <row> <col>
  free-node <id>             Drop the node's layout override + unpin → back to auto-layout
                             (a frozen override otherwise shadows row/col, so move-node no-ops)
  update-node <id> [--label=] [--color=] [--row=] [--col=] [--details=a,b,c] [--minW=px|0] [--w=cells|0] [--h=cells|0]
  update-edge <from> <to> [--style=] [--label=] [--fromEdge=N|S|E|W] [--toEdge=] [--fromConn=] [--toConn=]
  reverse-edge <from> <to>   Flip direction in place (keeps style/label, swaps per-end pins)
  retarget-edge <from> <to> [--newFrom=ID] [--newTo=ID]   Rewire an endpoint to another node (keeps style/label/costs)
                             (edge commands also accept --id=ID — list-edges prints each id — to pick
                              one of several parallel a→b edges; from/to else matches the first)
  add-divider <h|v> <at-px> [label] / remove-divider <h|v> <at-px>
  add-note <x> <y> [--title=] [--color=] <line> [line...] / remove-note <x> <y>
  uniform-width <on|off>
  set-title [text...] / set-footer [text...]   (no argument clears)
  render
  spread                     Force-directed spread (bakes positions into layout)
  snap-h / snap-v            Align nearly-aligned box centers (bakes into layout)
  capture [label]            Snapshot diagram.png + state → artifacts/<ts>[-label]
  status [--positions|--json]  rev + counts; --positions/--json dumps the solved
                               {x,y,w,h} per node plus canvas + content bounding box
  list-nodes / list-edges
```

`status --positions` is the headless read-back of the solved layout: place notes and dividers against real pixels instead of guessing, without rendering a PNG. The dev server exposes the same data at `GET /positions` (board-scoped under `/d/<name>/positions`).

Per node it reports `{x, y, w, h, pixW, pixH, col, row, pinned}`. **`w`/`h` are the drawn size** — a box is painted `ceil(pixW / CELL)` cells wide, up to a cell more than its text measures, so this is the rectangle the PNG actually contains. `pixW`/`pixH` are the content size underneath it. Aim annotations at `w`/`h`.

Mutating commands save the JSON (with a `rev` compare-and-swap) and re-render in one step, printing the new `rev`.

## Importing real graphs

Two importers in `bin/` build a board from a graph you already have, so you don't hand-author one:

```bash
just import-deps dev-server.js "--out=diagrams/deps"      # Deno module graph
just import-tree . "--out=diagrams/tree --depth=2 --files" # directory tree
# without `just`:  deno task import:deps <entrypoint> [flags]
```

`import-depgraph` takes an entrypoint (or a saved `deno info --json` dump) and draws the import DAG — packages by default, raw modules with `--granularity=module`. Node color is the ecosystem (local, `std/`, jsr, other), edge style is how many imports the dependency carries, and depth is BFS distance from the entrypoint. `import-filetree` does the same for a directory tree, coloring files by extension.

Both write `diagram-state.json` into `--out=<dir>` (default: cwd) and refuse to clobber an existing board without `--force`. Run `deno task cli --state <path> render` afterwards, or drop the output under `diagrams/` and pick it from the dev server's board list. Each script's header comment lists its flags.

**Wrapping.** The layout spreads a row horizontally without bound and never reclaims vertical space, so a level with 30 nodes becomes a 5500px strip that hits the renderer's 4096px raster cap. Both importers wrap each depth level into bands of `--per-row=<n>` (default 8) to keep the canvas in a sane aspect ratio. Raise it for wide boards, lower it for tall ones.

**Scale.** A package-granularity view of a mid-size project lands around 20 nodes and reads well. Module granularity on the same project is ~320 nodes — it renders (in about 35s, with every box's text intact), but the result is for spotting shape, not reading detail. Use `--max=<n>` to keep only the largest packages.

## Programmatic API

```js
import { Diagram } from "./diagram-api.js";

const d = Diagram.load();                 // ./diagram-state.json (cwd) — or load(path)
d.addNode("cache", { label: "Redis", color: "gray", details: ["sessions"], row: 1, col: 2 });
d.addEdge("api", "cache", "dotted", "GET/SET");
d.addDivider("h", 240, { label: "host boundary" });
d.addNote(950, 320, ["floating caption"], { title: "why" });
d.setTitle("Request flow");                // setFooter/setTheme/setCanvasSize likewise
d.save();
d.render();                               // writes diagram.png next to the state file
```

(For concurrent-safe mutations use `Diagram.withRetry(path, d => …)` — the CLI's path.)

## Interactive editor

`whiteboard-live.html` is a browser editor that loads `diagram-state.json` and lets you:

- **drag boxes** to position them (auto-saves, debounced, syncs live),
- **add a node** (`+ Node`) and **edit one** (double-click it) — label, color, details — via a small popover (Save creates/updates, Delete removes, Cancel discards),
- **right-click for a context menu** — on a box: *Connect from here*, *Edit…*, color swatches, *Connector layout* (per-side spread/collapse), *Pin/Unpin*, *Delete*; on an edge (its **label** counts too): *Edit…*, *Reverse direction*, *Delete*,
- **hover affordances** — the box/edge under the cursor is highlighted and the cursor telegraphs the target (grab / pointer / crosshair),
- **pin manually-placed nodes** — dragging a box pins it (corner marker); *Unpin* (box menu) frees one node back to auto-layout; **Auto Layout** clears all pins and re-solves the whole board, while **Auto Layout (keep pins)** re-flows only the *unpinned* nodes (from their `row`/`col` hints) around the pinned ones — place a few anchors by hand, then re-solve everything else. Pins are a subset of the always-full layout snapshot, so the editor stays WYSIWYG with the PNG,
- **switch boards** via the sidebar **Board** picker (multi-whiteboard; see above),
- pick a **color scheme**, run **align/spread**, **reset** to auto-layout, and live-tune the four A\* routing knobs (collapsible *Routing parameters* section in the sidebar).

Dividers render in the editor but are still edited via CLI/JSON. Notes are now fully GUI-editable: drag to move/pin, right-click to edit/re-anchor/delete, or drop a new one from the empty-canvas menu.

State changes persist to the file (all CAS-guarded): drags/passes via `POST /layout`, content edits via `POST /node` and `POST /edge`, theme via `POST /theme`, routing-slider tuning via `POST /costs`. The theme, the routing sliders, and the layout passes all persist, so a reload — and the CLI/PNG render — reproduce what you set. It needs the files served over HTTP — use the dev server below.

`whiteboard.html` is a minimal static viewer for the rendered PNG, with **live reload**.

## Dev server & live reload

`dev-server.js` is a small Deno server (SSE pattern borrowed from `misc-tools/mdfeed`) that:

- serves the repo over HTTP,
- watches `diagram-state.json` and **re-renders `diagram.png` in-process** when it changes,
- pushes a `reload` event to connected pages over `/events` (Server-Sent Events),
- exposes the GUI's write endpoints — `POST /layout` (drags), `/node`, `/edge`, `/theme`, `/costs` — plus `POST /capture`, all CAS-guarded (also available board-scoped under `/d/<name>/…`; SSE reload events carry the board name),
- accepts `--state=<path>` (or `DIAGRAM_STATE`) to drive a diagram **outside the repo**: static assets still come from the repo, but each board's state/PNG are served from — and watched in — that board's directory.

> The dev server binds to **`127.0.0.1`** by default (the write endpoints are unauthenticated). For LAN access on a trusted network use `just serve-lan` / `just host=0.0.0.0 serve` (or `--host=0.0.0.0` directly) — anyone on the network can then edit the diagram.

```bash
deno task dev           # or: just serve   (runs it in a dedicated tmux session)
```

With `just serve`, the server runs in the `agent-diagrams` tmux session — `just restart` / `just stop` / `just status` / `just logs` manage it.

## Collaboration & concurrency

The tool supports a human (in the GUI) and one or more agents (file/CLI) editing **one diagram, locally, at the same time**. The model is deliberately simple — the **file stays the source of truth**, no server-as-authority, no op protocol:

- **Reads** are always just the file (`cat diagram-state.json`) — always fresh.
- **Content writes** (nodes/edges) go through the **CLI** (or `Diagram.withRetry`), which is CAS-safe. In single-writer Mode A you can also just hand-edit the file.
- **Layout writes** (positions) come from the **GUI** via `POST /layout`.

Safety rests on two cheap primitives:

- **`rev` compare-and-swap** — every save checks the on-disk `rev` matches what it loaded; a stale write is rejected and the op is re-applied on fresh state (`withRetry`). So an agent never clobbers, or acts blind to, an edit made since it last looked.
- **A short-lived lockfile** (`diagram-state.json.lock`) serializes the two writers (CLI + dev-server) so writes can't tear; the write itself is atomic (temp file + rename).

Because content and layout are disjoint regions, an agent's edit and a human's drag **merge silently** — the editor live-updates without losing your in-progress drag. Only a genuine *same-region* conflict (both moved the same node) surfaces a reconcile prompt. **Three modes** are supported: **A** human watches an agent (read-only viewer); **B** human + agent take turns; **C** multiple agents + human.

Git history of `diagram-state.json` is your version timeline; `capture` pins shareable PNG + JSON snapshots into `artifacts/`.

## Files

| File | Role |
|------|------|
| `diagram-state.json` | The diagram, as data (single source of truth) |
| `diagram-core.js` | Pure ES engine: A\* router, layout, drawing primitives (no platform deps) |
| `diagram-api.js` | Deno `Diagram` class: CRUD + load/save/render to PNG |
| `diagram-cli.js` | Agent-facing CLI |
| `render-diagram.js` | One-liner: load + render |
| `raster-check.js` | Verifies the rendered PNG actually contains its text (`just raster-check`) |
| `bin/upstream-check.js` | Asks whether any `@gfx/canvas` workaround can be deleted yet (`just upstream-check`) |
| `bin/import-depgraph.js` | Builds a board from a Deno module graph (`just import-deps`) |
| `bin/import-filetree.js` | Builds a board from a directory tree (`just import-tree`) |
| `bin/import-util.js` | Shared importer helpers: flag parsing, row-band wrapping, board seeding |
| `dev-server.js` | Static server + SSE live-reload + in-process re-render |
| `whiteboard-live.html` | Interactive browser editor — markup + styles |
| `whiteboard-live.js` | …and its logic (browser module; under the same lint/fmt/check gate as the rest) |
| `whiteboard.html` | Static PNG viewer (live-reloading) |

`diagram-core.js` is platform-agnostic and shared verbatim between the Deno renderer and the browser editor — port the renderer to Node/`canvas` or the browser without touching the engine.

## Notes & limitations

- **`details` text silently failing to render — worked around, not fixed.** The
  PNG renderer could draw a box at exactly the right size and then omit its
  `details` lines entirely: a correctly-shaped box with only its label, exit code
  0, nothing on stderr. It is a rasterization failure in `@gfx/canvas` (geometry
  is provably correct, and 0.5.8 does not fix it), not a layout bug here.

  The trigger: a string measured with a given font descriptor on the throwaway
  layout canvas cannot afterwards be *drawn* with that descriptor on the render
  canvas. The renderer now measures through parallel font families backed by the
  same files (`MEASURE_SUFFIX` in `diagram-api.js`), so the two passes never
  share a cache key. Metrics are identical, so layout and editor parity are
  unchanged.

  Treat this as mitigation, not a cure — the underlying fault has no standalone
  reproduction and was never filed upstream. Run `just raster-check [state]` on
  boards that matter; `deno task test` runs it over a corpus and also runs a
  canary that fails when the upstream fault disappears, so the workaround gets
  removed rather than forgotten. Some run-to-run variation in the rendered PNG
  remains on dense boards.

  This is one of three `@gfx/canvas` faults this repo carries workarounds for.
  They are catalogued in `docs/project_notes/upstream-defects.md`; run
  `just upstream-check` to ask whether any can be deleted yet.

- Auto row spacing accounts for real node heights (tallest box per row + a routing gap), so plain `row`/`col` authoring shouldn't produce route failures. Skipped row indices add extra vertical air. Explicit `rowY` still overrides per row.
- If a connector cell is unavailable (covered by an adjacent box), the router falls back to the nearest open connector on that side, then to the next-best side — a tight layout degrades to a less-ideal wire instead of a red ✕. A red ✕ now only appears when a box is fully walled in.
- Connector placement is optimized automatically: each box side's connectors are ordered by where their counterpart sits (barycentric port assignment), so wires leave a box already pointing toward their destination — fewer crossings, shorter runs. It recomputes from the current layout on every render; explicit `--fromConn`/`--toConn` pins always win.
- `connectorAnchor` (state field, editor "Center connectors" toggle, or `set-connector-anchor <align|center>`) chooses how auto connectors anchor on a side. `align` (default) anchors on the overlap band between the two boxes so a lone edge between offset-but-aligned boxes runs perfectly straight (the de-kinker). `center` instead fans every side's connectors symmetrically about its center — a lone edge lands dead-center, multiple straddle it evenly — at the cost of a jog on edges into/out of offset boxes.
- Auto edge-side selection is heuristic; pin specific sides/connectors with `--fromEdge`/`--toEdge`/`--fromConn`/`--toConn` (or the live editor) when you need exact control. In the editor, hovering a box reveals one nub per connector slot on each side; drag from a slot (pins `fromEdge`+`fromConn`) onto a target slot (pins `toEdge`+`toConn`).
- **Parallel edges** between the same node pair are allowed — they land on distinct connector slots. Each edge has a stable `id` (`from~to`, suffixed `~2`, `~3`…) that is its identity for edits/reverse/retarget; the `id` stays put even as endpoints move. Legacy diagrams without ids are backfilled deterministically on load and materialized on the next save. The editor addresses edges by `id` internally; the CLI accepts `--id=` (see `list-edges`).
- Both bundled faces (`assets/fonts/`, free licenses) carry full symbol coverage, so `→ ✓ ✗ ◀ ·` and other arrows/dingbats render correctly in labels and details — in mono and sans alike.
