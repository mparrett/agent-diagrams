#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi
/**
 * CLI tool for manipulating diagram state and rendering.
 *
 * State file resolution (all commands): --state <path> (or --state=<path>) >
 * --board <name> > DIAGRAM_STATE env > a ./diagram-state.json in the cwd > the
 * bundled diagrams/basic board. (`init` always scaffolds in the cwd.)
 * --board names a board as the dev server lists it: one in the boards
 * directory (--diagrams-dir=<dir> > AGENT_DIAGRAMS_DIR > $XDG_DATA_HOME/
 * agent-diagrams), or examples/<name> for the repo's own.
 *
 * Usage: `deno task cli <command>`, or from any directory
 *   deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi \
 *     --unstable-ffi /path/to/diagram-cli.js <command>
 * The renderer (@gfx/canvas) needs env, FFI and, on first run, net to fetch
 * its native library. `usage()` below lists the commands.
 */

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import {
  boardsDir,
  boardStatePath,
  captureArtifacts,
  Diagram,
  LockBusy,
  resolveStatePath,
  RevConflict,
} from "./diagram-api.js";
import { DEFAULT_COLORS, DEFAULT_EDGE_STYLES } from "./diagram-core.js";
import { SCHEMES } from "./themes.js";

const BUILTIN_COLORS = Object.keys(DEFAULT_COLORS);
const BUILTIN_STYLES = Object.keys(DEFAULT_EDGE_STYLES);

// ─── Global --state / --board flags (strip before command parsing) ──
const rawArgs = [...Deno.args];
let stateArg, boardArg, dirArg;
let noRenderFlag = false;
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a.startsWith("--state=")) {
    stateArg = a.slice(8);
    rawArgs.splice(i--, 1);
  } else if (a.startsWith("--board=")) {
    boardArg = a.slice(8);
    rawArgs.splice(i--, 1);
  } else if (a === "--board") {
    boardArg = rawArgs[i + 1];
    if (!boardArg) {
      console.error("Error: --board requires a name");
      Deno.exit(1);
    }
    rawArgs.splice(i--, 2);
  } else if (a.startsWith("--diagrams-dir=")) {
    dirArg = a.slice(15);
    rawArgs.splice(i--, 1);
  } else if (a === "--no-render") {
    noRenderFlag = true;
    rawArgs.splice(i--, 1);
  } else if (a === "--state" || a === "-s") {
    stateArg = rawArgs[i + 1];
    if (!stateArg) {
      console.error("Error: --state requires a path");
      Deno.exit(1);
    }
    rawArgs.splice(i--, 2);
  }
}
let boardPath;
try {
  boardPath = boardArg && boardStatePath(boardArg, boardsDir(dirArg));
} catch (e) {
  console.error(`Error: ${e.message}`);
  Deno.exit(1);
}
const STATE = resolveStatePath(stateArg ?? boardPath);

// A scripted build (many calls, then one `render`) skips the PNG on every
// mutating call: --no-render on the call, or DIAGRAM_NO_RENDER=1 for a whole
// script. `render` itself always renders.
let deferRender = noRenderFlag ||
  ["1", "true", "yes"].includes(
    (Deno.env.get("DIAGRAM_NO_RENDER") ?? "").toLowerCase(),
  );
const renderUnlessDeferred = (d) => {
  if (!deferRender) d.render();
};

const args = rawArgs;
const cmd = args[0];

// ─── Argument validation ───────────────────────────────────────────
// Parse an integer argument, failing loudly instead of writing NaN into the
// state file. `what` names the flag/positional so a bad agent call self-corrects
// from the error alone. Uses Number(), not parseInt(): parseInt("3px") silently
// yields 3, and parseInt("two") yields NaN, which JSON.stringify writes as null —
// the node is then persisted with row/col null and placed arbitrarily, with a
// successful exit code. Both are silent corruption; this rejects them.
function int(what, raw, { min } = {}) {
  if (raw === undefined || String(raw).trim() === "") {
    console.error(`Error: ${what} requires an integer value`);
    Deno.exit(1);
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    console.error(`Error: ${what} must be an integer, got "${raw}"`);
    Deno.exit(1);
  }
  if (min !== undefined && n < min) {
    console.error(`Error: ${what} must be ${min} or greater, got ${n}`);
    Deno.exit(1);
  }
  return n;
}

// --flag=on|off|default as true / false / null (null clears the field, so the
// board default applies).
function onOffDefault(flag, at) {
  const v = flag.slice(at);
  if (v === "on") return true;
  if (v === "off") return false;
  if (v === "default") return null;
  console.error(`Error: ${flag.split("=")[0]} must be on, off or default`);
  Deno.exit(1);
}

// "row" for a horizontal divider's gap, "col" for a vertical one's.
const axisName = (d) => d.orient === "h" ? "row" : "col";

// Reject unrecognized --flags so a typo (--lable=) errors instead of silently
// applying nothing and reporting success.
// --labelPos= --labelAlign= --labelWeight= --labelSize= into opts; a value of
// "none" clears the field.
const LABEL_FLAGS = [
  "--labelPos",
  "--labelAlign",
  "--labelWeight",
  "--labelSize",
];
function labelFlags(flags, opts) {
  for (const f of flags) {
    const m = f.match(/^--label(Pos|Align|Weight|Size)=(.*)$/);
    if (!m) continue;
    const key = "label" + m[1];
    if (m[2] === "none") opts[key] = null;
    else if (m[1] === "Size") opts[key] = Number(m[2]);
    else opts[key] = m[2];
  }
  return opts;
}

function rejectUnknownFlags(command, flags, known) {
  for (const f of flags) {
    const name = f.split("=")[0];
    if (!known.includes(name)) {
      console.error(
        `Error: ${command}: unknown flag "${name}". Known: ${known.join(", ")}`,
      );
      Deno.exit(1);
    }
  }
}

// What render-diagram.js needs; matches the `render` task in deno.json.
const RUN_FLAGS =
  "--allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi";

const STARTER_STATE = {
  title: "Untitled Diagram",
  width: 1500,
  height: 900,
  nodes: [
    {
      id: "a",
      label: "Service A",
      color: "blue",
      details: ["does a thing"],
      row: 0,
      col: 0,
    },
    {
      id: "b",
      label: "Service B",
      color: "green",
      details: ["does another"],
      row: 1,
      col: 0,
    },
  ],
  edges: [
    { from: "a", to: "b", style: "solid", label: "calls" },
  ],
  layout: {},
  rowY: {},
  rev: 0,
};

function usage() {
  console.error(
    `Usage: diagram-cli.js [--state <path> | --board <name>] [--no-render] <command> [args...]

State file: --state <path> (any command) > --board <name> > DIAGRAM_STATE env >
./diagram-state.json in the cwd (so the CLI works from any project) > the bundled
diagrams/basic board. --board takes a name as the dev server lists it: a board
in the boards directory (--diagrams-dir=<dir> > AGENT_DIAGRAMS_DIR >
~/.local/share/agent-diagrams), or examples/<name> for the repo's own.

Commands:
  init [--empty]             Write a starter diagram-state.json in the current dir
                             (--empty: no sample nodes, for building a board from scratch)
  add-node <id> <label> <color> <row> <col> [details...]
  add-edge <from> <to> <style> [label]
  grow <from> <n|e|s|w> <id>[,<id>...] [--label=] [--color=] [--style=] [--chain]
                             Add boxes one step from <from> on its grid, wired from it. Several ids
                             fan out side by side; --chain grows each from the one before. A taken
                             cell gets a row or column inserted, pushing what was there along.
                             Colour and inner group come from <from>; --label only with one id
  insert-row <at> [--in=<group>] / insert-col <at> [--in=<group>]
                             Shift every row (column) at or past <at> along one, on the board or
                             inside inner group <group>; rowY and band dividers follow
  place <id> <row> <col>     Put a box in a cell and release its pin; a taken cell pushes its
                             occupant one column along
  remove-node <id>
  remove-edge <from> <to>
  reverse-edge <from> <to>             Flip direction in place (keeps style/label, swaps per-end pins)
  retarget-edge <from> <to> [--newFrom=ID] [--newTo=ID]   Move an endpoint to another node (keeps style/label/costs)
  move-node <id> <row> <col>
  free-node <id>                       Drop a node's or group's layout override, or its pin inside its
                                       group, + unpin → returns it to auto-layout
  update-node <id> [--label=...] [--color=NAME|SEMANTIC] [--row=N] [--col=N] [--details=a,b,c] [--minW=px|0] [--w=cells|0] [--h=cells|0]
                          [--outlineWidth=thin|medium|thick] [--outlineDash=solid|dashed|dotted] [--corners=round|square]
                          [--outlineReset]   box outline; --outlineReset clears all three back to the board default
                          [--shape=box|cylinder|person]   cylinder for a store, person for an actor (also add-node --shape=)
                          [--icon=none|cylinder|person]   small icon above the label (also add-node --icon=)
                          [--frame=box|none]   none draws no border or fill; the box still holds its place (also add-node --frame=)
                          [--span=N|0]   fill N columns from this node's col, gaps included (1 = as wide as its
                                         column's widest box); spanning boxes don't widen columns. 0 clears
                          [--band=off|default]   off puts the box in no divider band, so it may sit across a
                                         band line (see set-divider-bands); default puts it back in its row's band
  update-edge <from> <to> [--style=...] [--label=...] [--fromEdge=N|S|E|W] [--toEdge=...] [--fromConn=C|C-1|...] [--toConn=...]
                          [--width=thin|medium|thick] [--dash=solid|dashed|dotted] [--color=NAME|SEMANTIC] [--styleReset]   style axes
                          [--cost-step=N] [--cost-turn=N] [--cost-near=N] [--cost-overlap=N] [--cost-reset]   per-edge routing bias
                          [--labelSide=above|below|left|right] [--labelOffset=px] [--labelSeg=N] [--labelReset]   label placement
        Style axes (--width/--dash/--color) override the named --style preset one axis at a time.
        --color takes a named palette color (red, green, ...) or a semantic token (error, success, info, warn, neutral, accent).
  add-divider <h|v> <at-px> [--band] [label]
                                       Dotted boundary line across the canvas (h at a Y, v at an X).
                                       --band makes it a band edge in the row (column) gap nearest at-px
  update-divider <id> [--at=px] [--orient=h|v] [--label=...] [--color=...] [--dash=solid|dashed|dotted]
                    [--band=on|off|default] [--after=N]
                                       Move, rotate or restyle; an empty value clears label/color/dash.
                                       Rotating keeps --at unless you pass a new one. On a band divider
                                       --at snaps to the nearest row gap; --after=N puts it after row N
  remove-divider <id> | <h|v> <at-px>
  list-dividers                        Dividers with their ids, drawn positions and bands
  set-divider-bands on|off|default     Board default for dividers without their own --band. A band
                                       divider sits between two rows and keeps layout from putting
                                       boxes across it; a box's band is its row (column for v)
  add-note <x> <y> [--title=...] [--color=...] [--anchor=node:side:dx:dy] <line>...  Floating text annotation
                                       (--anchor puts the note just outside that side of the box: E/W centered
                                        vertically, N/S horizontally; dx/dy shift it from there,
                                        in screen terms: a gap left of a W box is dx < 0)
  remove-note <id> | <x> <y>           Remove a note
  free-note <id>                       Drop a note's drag override → back to its anchor/position
  add-group <id> <label> <node>... [--color=NAME] [--dash=dashed|dotted]
                                       Labeled frame around nodes, drawn under the wires. Row/column spacing
                                       makes room for frames, but boxes are not moved: keep a group's nodes in
                                       their own rows/cols, or non-members land inside (render and
                                       status --positions name them). --color tints the frame.
  add-group ... --inner --row=N --col=N
                                       Inner group: its members' row/col are positions inside the group,
                                       which is laid out as one box at row N, col N of the board. A node can
                                       be in one inner group; boxes inside are pinned relative to it. An inner
                                       group's nodes may list other inner group ids, nesting them; node and
                                       group ids share one namespace.
  update-group <id> [--label=] [--nodes=a,b] [--add=a,b] [--remove=a,b] [--color=NAME|none] [--dash=...|none]
                    [--inner|--annotation] [--row=N] [--col=N] [--rowGap=px|none] [--span=N|0]
                                       --span stretches an inner group's frame across N board columns;
                                       its content keeps its size and centres. 0 clears
  add-group / update-group ... [--labelPos=top-border|top-inside|top-outside|bottom-border|bottom-inside|bottom-outside]
                    [--labelAlign=left|center|right] [--labelWeight=bold|normal] [--labelSize=px]
                                       Where the group's label sits; "none" clears a field back to the board default
  set-group-style [--labelPos=] [--labelAlign=] [--labelWeight=] [--labelSize=] [--reset]
                                       Board-wide group label defaults; a group's own value wins. Default:
                                       top-border, left, bold, the board's divider size
  remove-group <id> / list-groups
  uniform-width <on|off>     Homogenize box widths (minW'd boxes keep emphasis)
  set-title [text...]        Caption drawn top-left; no argument clears it
  set-footer [text...]       Caption drawn under the legend; no argument clears it
  set-theme <name|reset>     Color scheme (${
      Object.keys(SCHEMES).join(", ")
    }); reset = built-in palette
  set-legend auto|off|<color>[:<dash>]=<label>...
                             auto = one swatch per color in use, labeled with its name; off hides it;
                             entries take palette names, so they follow the theme
                             (e.g. amber="Ops builds" pink:dashed="owner TBD")
  set-box-style [--outlineWidth=thin|medium|thick] [--outlineDash=solid|dashed|dotted] [--corners=round|square] [--reset]
                             Board-wide box defaults; a box's own update-node value wins. --reset clears all
                             three (back to medium, solid, round); it runs first, so flags after it still apply
  set-edge-style [--width=thin|medium|thick] [--reset]
                             Board-wide connector width; an edge's own update-edge --width wins. --reset = medium
  set-font <mono|sans>       Typeface: monospace (default) or Instrument Sans
  set-font-size <px|reset>   Base font size (box-label px, default 13); scales the whole diagram
  set-color <name> <bg-hex> <border-hex> | <name> reset
                             Define a node color (or override a built-in); wins over the theme, and
                             works in add-node, --color and set-legend
  set-edge-preset <name> <hex> [solid|dashed|dotted] | <name> reset
                             Define an edge style (or override solid, dashed, ...) for add-edge <style>
  set-background <hex|reset> Canvas background; reset = the theme's
  set-row-gap <px|reset>     Space between rows (default 45, room for wires); frames still get their
                             clearance. update-group <id> --rowGap=<px|none> sets one inner group's
  set-wrap-slack <n|reset>   Extra box area (x smallest) a box may take to keep text unwrapped (default 1.5)
  set-flow <field|none>      Flow field steering wires: right, left, down, up, swirl, snake,
                             snake2, snake4, or two joined with > (right>down)
  untangle [--unpin] [--budget=N] [--seed=N]
                                       Rearrange unpinned boxes to cut wire crossings and label clashes,
                                       scored on the routed wires. Boxes keep their divider band (or their
                                       row, without bands); pinned boxes stay put, --unpin releases them
                                       first. --budget caps candidate layouts tried (default 1500)
  flow-place [--gap=px] [--frame=WxH]
                             Pin the longest edge chain along the flow field's streamline and
                             the other nodes beside their neighbours; the field spans the frame
                             (default: sized from the boxes' area at 16:10). Fits the canvas after
  set-direction <down|right|reset>
                             Which way the board reads. Boxes diagonally apart get wires top-to-bottom
                             (down, default) or side-to-side (right); fromEdge/toEdge still win
  set-connector-anchor <align|center>   Connector anchoring: align (de-kink straight runs, default) or center (fan symmetric about each side's center)
  set-start-markers <on|off>   Start marker (a dot) where each wire leaves its box (default on); off draws wires from the box edge
  set-canvas <W>x<H> [--anchor=nw|n|ne|e|se|s|sw|w|c] [--grow]
                             Set board bounds B; <W> <H> also works. The anchor works as in Photoshop: it is
                             where content sticks (nw grows right/down, c grows evenly). --grow never shrinks
                             a side, so set-canvas 1920x1080 --grow is "at least 1920×1080"
  expand-canvas --by=<W>x<H> [--anchor=]   Grow B by W×H, split by the anchor as above (negative trims)
  expand-canvas [--left=px] [--right=px] [--up=px] [--down=px]   Grow/shrink B per side (negative trims; left/up slide content)
  fit-canvas                 Trim board bounds B to hug boxes, notes and group frames (slides the diagram to a
                             uniform margin; auto-placed boxes stay auto)
  render
  batch [file|-]             Run CLI lines from a file (or stdin) in one process and render once at the
                             end: shell quoting, # comments, trailing \\ continues a line. A failing line
                             stops the batch and is named
  --no-render (any command)  Save without rendering the PNG; DIAGRAM_NO_RENDER=1 does it for a whole
                             script. Finish with \`render\`
  spread                     Force-directed box spreading (bakes positions into layout)
  snap-h                     Snap-align box centers horizontally
  snap-v                     Snap-align box centers vertically
  capture [label]            Snapshot diagram.png + state into artifacts/<ts>[-label]
  issues [--json]            List layout defects without opening the PNG: wires sharing a track, wires
                             bunched on a side with room to spread, labels on boxes, on each other or off
                             the board, group labels wider than their frame, frame intruders, failed
                             routes. Each names its ids. Exits 1 if there are any
  status [--positions|--json]  rev + counts; --positions dumps solved {x,y,w,h} per node + canvas/content bbox
  list-nodes
  list-edges

Built-in colors: ${BUILTIN_COLORS.join(", ")}
Built-in styles: ${BUILTIN_STYLES.join(", ")}
(Extend either via the "colors" / "edgeStyles" keys in diagram-state.json —
 custom names become valid for that diagram.)`,
  );
  Deno.exit(1);
}

if (!cmd) usage();

if (cmd === "init") {
  // init scaffolds in the cwd (or --state path) — it never targets the bundled
  // example board the way other commands' zero-arg default can.
  const flags = args.slice(1);
  rejectUnknownFlags("init", flags, ["--empty"]);
  const target = resolve(Deno.cwd(), stateArg ?? "diagram-state.json");
  try {
    Deno.statSync(target);
    console.error(`Error: ${target} already exists — refusing to overwrite`);
    Deno.exit(1);
  } catch { /* not found — proceed */ }
  const starter = flags.includes("--empty")
    ? { ...STARTER_STATE, nodes: [], edges: [] }
    : STARTER_STATE;
  Deno.writeTextFileSync(target, JSON.stringify(starter, null, 2) + "\n");
  // Print a render command that actually works from where the user is standing:
  // in the tool repo the `deno task` alias exists; from a foreign cwd it doesn't.
  const toolDir = dirname(fromFileUrl(import.meta.url));
  const inRepo = Deno.cwd() === toolDir;
  const needsStateFlag = target !== resolve(Deno.cwd(), "diagram-state.json");
  const renderCmd = (inRepo
    ? "deno task render"
    : `deno run ${RUN_FLAGS} ${join(toolDir, "render-diagram.js")}`) +
    (needsStateFlag ? ` --state=${target}` : "");
  console.log(`Wrote starter ${target}\nEdit it, then render:\n  ${renderCmd}`);
  Deno.exit(0);
}

// Split a batch script into commands: one per line, words split as a POSIX
// shell would for the simple cases a build script uses ("double", 'single',
// backslash escapes), # comments, and a trailing backslash joining lines.
function parseBatch(text) {
  const out = [];
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const first = i + 1;
    let line = raw[i];
    while (/(^|[^\\])\\$/.test(line) && i + 1 < raw.length) {
      line = line.slice(0, -1) + " " + raw[++i];
    }
    const argv = [];
    let word = null, q = null;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (q === "'") {
        if (ch === "'") q = null;
        else word += ch;
      } else if (q === '"') {
        if (ch === '"') q = null;
        else if (
          ch === "\\" && j + 1 < line.length && '"\\$`'.includes(line[j + 1])
        ) {
          word += line[++j];
        } else word += ch;
      } else if (ch === "'" || ch === '"') {
        q = ch;
        word ??= "";
      } else if (ch === "\\" && j + 1 < line.length) {
        word = (word ?? "") + line[++j];
      } else if (/\s/.test(ch)) {
        if (word !== null) argv.push(word);
        word = null;
      } else if (ch === "#" && word === null) {
        break;
      } else word = (word ?? "") + ch;
    }
    if (q) throw new Error(`batch line ${first}: unclosed ${q} quote`);
    if (word !== null) argv.push(word);
    if (argv.length) out.push({ line: first, text: line.trim(), argv });
  }
  return out;
}

function run(args) {
  const cmd = args[0];
  // Mutate through CAS-retry: loads fresh, applies the op, saves with rev guard,
  // retrying (reload + re-apply) on a concurrent write. Returns the saved Diagram.
  const mutate = (opFn) => Diagram.withRetry(STATE, opFn);

  switch (cmd) {
    case "add-node": {
      const [, id, label, color, rowStr, colStr, ...rest] = args;
      const look = {};
      const details = rest.filter((a) => {
        const m = a.match(/^--(shape|icon|frame|span)=(.*)$/);
        if (m) {
          look[m[1]] = m[1] === "span" ? int("--span", m[2], { min: 0 }) : m[2];
        }
        return !m;
      });
      if (!id || !label || !color || !rowStr || !colStr) {
        console.error(
          "Error: add-node requires <id> <label> <color> <row> <col> [details...]",
        );
        Deno.exit(1);
      }
      // A flag add-node doesn't take would otherwise land in the box as a
      // detail line ("--w=28" drawn as text).
      const stray = details.find((a) => /^--[A-Za-z][\w-]*=/.test(a));
      if (stray) {
        console.error(
          `Error: add-node: unknown flag "${
            stray.split("=")[0]
          }". add-node takes --shape= --icon= --frame= --span=; set the rest with update-node`,
        );
        Deno.exit(1);
      }
      const row = int("add-node <row>", rowStr);
      const col = int("add-node <col>", colStr);
      const d = mutate((d) =>
        d.addNode(id, {
          label,
          color,
          details,
          row,
          col,
          ...look,
        })
      );
      renderUnlessDeferred(d);
      console.log(`Added node "${id}" (rev ${d.rev})`);
      break;
    }

    case "add-edge": {
      const [, from, to, style, ...rest] = args;
      if (!from || !to || !style) {
        console.error("Error: add-edge requires <from> <to> <style> [label]");
        Deno.exit(1);
      }
      const label = rest.length > 0 ? rest.join(" ") : undefined;
      const d = mutate((d) => d.addEdge(from, to, style, label));
      renderUnlessDeferred(d);
      console.log(`Added edge "${from}" -> "${to}" (rev ${d.rev})`);
      break;
    }

    case "remove-node": {
      const id = args[1];
      if (!id) {
        console.error("Error: remove-node requires <id>");
        Deno.exit(1);
      }
      let existed;
      const d = mutate((d) => {
        existed = d.removeNode(id);
      });
      renderUnlessDeferred(d);
      console.log(
        existed
          ? `Removed node "${id}" and connected edges (rev ${d.rev})`
          : `Node "${id}" not found — nothing removed (rev ${d.rev})`,
      );
      break;
    }

    case "remove-edge": {
      const [, from, to] = args;
      const id = args.find((a) => a.startsWith("--id="))?.slice(5);
      if (!id && (!from || !to)) {
        console.error("Error: remove-edge requires <from> <to> (or --id=ID)");
        Deno.exit(1);
      }
      let existed;
      const d = mutate((d) => {
        existed = d.removeEdge(from, to, id);
      });
      renderUnlessDeferred(d);
      const what = id ? `id "${id}"` : `"${from}" -> "${to}"`;
      console.log(
        existed
          ? `Removed edge ${what} (rev ${d.rev})`
          : `Edge ${what} not found — nothing removed (rev ${d.rev})`,
      );
      break;
    }

    case "move-node": {
      const [, id, rowStr, colStr] = args;
      if (!id || !rowStr || !colStr) {
        console.error("Error: move-node requires <id> <row> <col>");
        Deno.exit(1);
      }
      const row = int("move-node <row>", rowStr);
      const col = int("move-node <col>", colStr);
      const d = mutate((d) => d.moveNode(id, row, col));
      renderUnlessDeferred(d);
      console.log(
        `Moved node "${id}" to row=${rowStr} col=${colStr} (rev ${d.rev})`,
      );
      break;
    }

    case "grow": {
      const pos = args.slice(1).filter((a) => !a.startsWith("--"));
      const flags = args.slice(1).filter((a) => a.startsWith("--"));
      const [from, dir, idList] = pos;
      if (!from || !dir || !idList || pos.length > 3) {
        console.error(
          "Error: grow requires <from> <n|e|s|w> <id>[,<id>...] [--label=] [--color=] [--style=] [--chain]",
        );
        Deno.exit(1);
      }
      rejectUnknownFlags("grow", flags, [
        "--label",
        "--color",
        "--style",
        "--chain",
      ]);
      const val = (name) =>
        flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
      const ids = idList.split(",").filter(Boolean);
      const label = val("label");
      if (label !== undefined && ids.length > 1) {
        console.error("Error: grow --label takes one id");
        Deno.exit(1);
      }
      let placed;
      const d = mutate((d) => {
        placed = d.grow(from, dir, ids, {
          label,
          color: val("color"),
          style: val("style"),
          chain: flags.includes("--chain"),
        });
      });
      renderUnlessDeferred(d);
      const where = placed.map((p) => `${p.id} (row ${p.row}, col ${p.col})`);
      console.log(`Grew ${where.join(", ")} from "${from}" (rev ${d.rev})`);
      break;
    }

    case "insert-row":
    case "insert-col": {
      const axis = cmd === "insert-row" ? "row" : "col";
      const pos = args.slice(1).filter((a) => !a.startsWith("--"));
      const flags = args.slice(1).filter((a) => a.startsWith("--"));
      rejectUnknownFlags(cmd, flags, ["--in"]);
      const at = int(`${cmd} <at>`, pos[0]);
      const within = flags.find((f) => f.startsWith("--in="))?.slice(5) ??
        null;
      const d = mutate((d) => d.insertLine(axis, at, within));
      renderUnlessDeferred(d);
      console.log(
        `Inserted ${axis} ${at}${
          within ? ` in "${within}"` : ""
        } (rev ${d.rev})`,
      );
      break;
    }

    case "place": {
      const [, id, rowStr, colStr] = args;
      if (!id || !rowStr || !colStr) {
        console.error("Error: place requires <id> <row> <col>");
        Deno.exit(1);
      }
      const row = int("place <row>", rowStr);
      const col = int("place <col>", colStr);
      const d = mutate((d) => d.placeInCell(id, row, col));
      renderUnlessDeferred(d);
      const n = d.getNode(id) ?? d._state.groups.find((g) => g.id === id);
      console.log(
        `Placed "${id}" at row ${n.row}, col ${n.col} (rev ${d.rev})`,
      );
      break;
    }

    case "free-node": {
      const id = args[1];
      if (!id) {
        console.error("Error: free-node requires <id>");
        Deno.exit(1);
      }
      let freed;
      const d = mutate((d) => {
        freed = d.freeNode(id);
      });
      renderUnlessDeferred(d);
      console.log(
        freed
          ? `Freed "${id}" to auto-layout (rev ${d.rev})`
          : `"${id}" had no layout override — nothing to free (rev ${d.rev})`,
      );
      break;
    }

    case "add-divider": {
      const [, orient, atStr, ...rest] = args;
      if (!orient || !atStr) {
        console.error(
          "Error: add-divider requires <h|v> <at-px> [--band] [label]",
        );
        Deno.exit(1);
      }
      const band = rest.includes("--band");
      const labelParts = rest.filter((a) => a !== "--band");
      const label = labelParts.length ? labelParts.join(" ") : undefined;
      const at = int("add-divider <at-px>", atStr);
      let id;
      const d = mutate((d) => {
        id = d.addDivider(orient, at, { label, ...(band && { band: true }) });
      });
      renderUnlessDeferred(d);
      const v = d.listDividers().find((x) => x.id === id);
      console.log(
        `Added ${orient} divider "${id}" ${
          v.isBand ? `after ${axisName(v)} ${v.after}` : `at ${atStr}px`
        } (rev ${d.rev})`,
      );
      break;
    }

    case "remove-divider": {
      // remove-divider <id>  |  remove-divider <h|v> <at-px>
      const [, a, atStr] = args;
      if (!a) {
        console.error("Error: remove-divider requires <id> or <h|v> <at-px>");
        Deno.exit(1);
      }
      const byId = atStr === undefined;
      // `remove-divider h` with the position left off used to be an error;
      // read as an id it would match nothing and exit 0.
      if (byId && (a === "h" || a === "v")) {
        console.error("Error: remove-divider requires <id> or <h|v> <at-px>");
        Deno.exit(1);
      }
      const at = byId ? undefined : int("remove-divider <at-px>", atStr);
      let existed;
      const d = mutate((d) => {
        existed = d.removeDivider(a, at);
      });
      renderUnlessDeferred(d);
      const what = byId ? `"${a}"` : `${a} at ${atStr}px`;
      console.log(
        existed
          ? `Removed divider ${what} (rev ${d.rev})`
          : `No divider ${what} — nothing removed (rev ${d.rev})`,
      );
      break;
    }

    case "update-divider": {
      const id = args[1];
      if (!id || id.startsWith("--")) {
        console.error("Error: update-divider requires <id>");
        Deno.exit(1);
      }
      const flags = args.slice(2);
      rejectUnknownFlags("update-divider", flags, [
        "--at",
        "--orient",
        "--label",
        "--color",
        "--dash",
        "--band",
        "--after",
      ]);
      const fields = {};
      for (const f of flags) {
        if (f.startsWith("--at=")) fields.at = int("--at", f.slice(5));
        else if (f.startsWith("--orient=")) fields.orient = f.slice(9);
        else if (f.startsWith("--label=")) fields.label = f.slice(8);
        else if (f.startsWith("--color=")) fields.color = f.slice(8);
        else if (f.startsWith("--dash=")) fields.dash = f.slice(7);
        else if (f.startsWith("--band=")) fields.band = onOffDefault(f, 7);
        else if (f.startsWith("--after=")) {
          fields.after = int("--after", f.slice(8));
        }
      }
      if (Object.keys(fields).length === 0) {
        console.error("Error: update-divider needs at least one --flag=value");
        Deno.exit(1);
      }
      const d = mutate((d) => d.updateDivider(id, fields));
      renderUnlessDeferred(d);
      console.log(`Updated divider "${id}" (rev ${d.rev})`);
      break;
    }

    case "list-dividers": {
      const ds = Diagram.load(STATE).listDividers();
      console.log(`${ds.length} dividers:`);
      for (const v of ds) {
        const label = v.label ? ` "${v.label}"` : "";
        const band = v.isBand ? `, band after ${axisName(v)} ${v.after}` : "";
        console.log(`  ${v.id}  ${v.orient} at ${v.at}px${band}${label}`);
      }
      break;
    }

    case "set-divider-bands": {
      const flag = args[1];
      if (!["on", "off", "default"].includes(flag)) {
        console.error("Error: set-divider-bands requires on|off|default");
        Deno.exit(1);
      }
      const on = flag === "on" ? true : flag === "off" ? false : null;
      const d = mutate((d) => d.setDividerBands(on));
      renderUnlessDeferred(d);
      const n = d.listDividers().filter((v) => v.isBand).length;
      console.log(
        `divider bands: ${flag} — ${n} band divider${
          n === 1 ? "" : "s"
        } (rev ${d.rev})`,
      );
      break;
    }

    case "add-note": {
      const opts = {};
      const positional = [];
      let anchored = false;
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--title=")) opts.title = arg.slice(8);
        else if (arg.startsWith("--color=")) opts.color = arg.slice(8);
        else if (arg.startsWith("--anchor=")) {
          // --anchor=<node>:<side>:<dx>:<dy> — side/dx/dy optional (default E:0:0)
          const [to, side, dx, dy] = arg.slice(9).split(":");
          opts.anchor = {
            to,
            side: side || "E",
            dx: dx ? int("--anchor dx", dx) : 0,
            dy: dy ? int("--anchor dy", dy) : 0,
          };
          anchored = true;
        } else positional.push(arg);
      }
      // x/y are the first two positionals; required unless --anchor is given.
      let x, y;
      const numeric = (s) => s !== undefined && /^-?\d+$/.test(s);
      if (numeric(positional[0]) && numeric(positional[1])) {
        x = parseInt(positional.shift(), 10);
        y = parseInt(positional.shift(), 10);
      } else if (!anchored) {
        console.error(
          "Error: add-note requires <x> <y> [--title=] [--color=] <line>... (or --anchor=node:side:dx:dy)",
        );
        Deno.exit(1);
      }
      let id;
      const d = mutate((d) => {
        id = d.addNote(x, y, positional, opts);
      });
      renderUnlessDeferred(d);
      console.log(
        `Added note "${id}"${
          anchored ? ` anchored to "${opts.anchor.to}"` : ` at (${x}, ${y})`
        } (rev ${d.rev})`,
      );
      break;
    }

    case "remove-note": {
      // remove-note <id>  |  remove-note <x> <y>
      const [, a, b] = args;
      if (!a) {
        console.error("Error: remove-note requires <id> or <x> <y>");
        Deno.exit(1);
      }
      // Coordinate form needs BOTH args numeric; anything else is an id lookup
      // (so `remove-note 10 abc` reports "no such note" rather than searching
      // for y=NaN, which can never match).
      const isInt = (s) => s !== undefined && /^-?\d+$/.test(s);
      const byId = !isInt(a) || !isInt(b);
      let existed;
      const d = mutate((d) => {
        existed = byId ? d.removeNote(a) : d.removeNote(Number(a), Number(b));
      });
      renderUnlessDeferred(d);
      const what = byId ? `"${a}"` : `at (${a}, ${b})`;
      console.log(
        existed
          ? `Removed note ${what} (rev ${d.rev})`
          : `No note ${what} — nothing removed (rev ${d.rev})`,
      );
      break;
    }

    case "free-note": {
      const id = args[1];
      if (!id) {
        console.error("Error: free-note requires <id>");
        Deno.exit(1);
      }
      let freed;
      const d = mutate((d) => {
        freed = d.freeNote(id);
      });
      renderUnlessDeferred(d);
      console.log(
        freed
          ? `Freed note "${id}" back to its anchor/position (rev ${d.rev})`
          : `Note "${id}" had no drag override — nothing to free (rev ${d.rev})`,
      );
      break;
    }

    case "add-group": {
      const rest = args.slice(1);
      const flags = rest.filter((a) => a.startsWith("--"));
      rejectUnknownFlags("add-group", flags, [
        "--color",
        "--dash",
        "--inner",
        "--row",
        "--col",
        ...LABEL_FLAGS,
      ]);
      const [id, label, ...nodes] = rest.filter((a) => !a.startsWith("--"));
      if (!id || label === undefined || nodes.length === 0) {
        console.error(
          "Error: add-group requires <id> <label> <node>... [--color=] [--dash=]",
        );
        Deno.exit(1);
      }
      const opts = {};
      for (const f of flags) {
        if (f.startsWith("--color=")) opts.color = f.slice(8);
        else if (f.startsWith("--dash=")) opts.dash = f.slice(7);
        else if (f === "--inner") opts.layout = "inner";
        else if (f.startsWith("--row=")) opts.row = int("--row", f.slice(6));
        else if (f.startsWith("--col=")) opts.col = int("--col", f.slice(6));
      }
      labelFlags(flags, opts);
      const d = mutate((d) => d.addGroup(id, label, nodes, opts));
      renderUnlessDeferred(d);
      console.log(
        `Added group "${id}" (${nodes.length} node${
          nodes.length === 1 ? "" : "s"
        }) (rev ${d.rev})`,
      );
      break;
    }

    case "update-group": {
      const id = args[1];
      if (!id || id.startsWith("--")) {
        console.error("Error: update-group requires <id>");
        Deno.exit(1);
      }
      const flags = args.slice(2);
      rejectUnknownFlags(
        "update-group",
        flags,
        [
          "--label",
          "--nodes",
          "--add",
          "--remove",
          "--color",
          "--dash",
          "--inner",
          "--annotation",
          "--row",
          "--col",
          "--rowGap",
          "--span",
          ...LABEL_FLAGS,
        ],
      );
      const list = (v) => v.split(",").filter(Boolean);
      const opts = {};
      for (const f of flags) {
        if (f.startsWith("--label=")) opts.label = f.slice(8);
        else if (f.startsWith("--nodes=")) opts.nodes = list(f.slice(8));
        else if (f.startsWith("--add=")) opts.add = list(f.slice(6));
        else if (f.startsWith("--remove=")) opts.remove = list(f.slice(9));
        else if (f.startsWith("--color=")) {
          opts.color = f.slice(8) === "none" ? null : f.slice(8);
        } else if (f.startsWith("--dash=")) {
          opts.dash = f.slice(7) === "none" ? null : f.slice(7);
        } else if (f === "--inner") opts.layout = "inner";
        else if (f === "--annotation") opts.layout = "annotation";
        else if (f.startsWith("--row=")) opts.row = int("--row", f.slice(6));
        else if (f.startsWith("--col=")) opts.col = int("--col", f.slice(6));
        else if (f.startsWith("--rowGap=")) {
          opts.rowGap = f.slice(9) === "none"
            ? null
            : int("--rowGap", f.slice(9), { min: 0 });
        } else if (f.startsWith("--span=")) {
          opts.span = int("--span", f.slice(7), { min: 0 });
        }
      }
      labelFlags(flags, opts);
      if (Object.keys(opts).length === 0) {
        console.error("Error: update-group needs at least one --flag=value");
        Deno.exit(1);
      }
      const d = mutate((d) => d.updateGroup(id, opts));
      renderUnlessDeferred(d);
      console.log(`Updated group "${id}" (rev ${d.rev})`);
      break;
    }

    case "remove-group": {
      const id = args[1];
      if (!id) {
        console.error("Error: remove-group requires <id>");
        Deno.exit(1);
      }
      let existed, parent, moved;
      const d = mutate((d) => {
        parent = d.groupParent(id)?.id;
        moved = d.listGroups().find((g) => g.id === id)?.nodes;
        existed = d.removeGroup(id);
      });
      renderUnlessDeferred(d);
      console.log(
        existed
          ? `Removed group "${id}" (rev ${d.rev})`
          : `No group "${id}" — nothing removed (rev ${d.rev})`,
      );
      if (existed && parent) {
        console.log(
          `Moved ${moved.join(", ")} into group "${parent}"; ` +
            `their row/col are now read in "${parent}"'s grid`,
        );
      }
      break;
    }

    case "list-groups": {
      const groups = Diagram.load(STATE).listGroups();
      console.log(`${groups.length} groups:`);
      for (const g of groups) {
        console.log(
          `  ${g.id}  "${g.label ?? ""}"${
            g.layout === "inner" ? `  inner @ row=${g.row} col=${g.col}` : ""
          }${g.color ? `  color=${g.color}` : ""}${
            g.dash ? `  dash=${g.dash}` : ""
          }  nodes: ${g.nodes.join(", ")}`,
        );
      }
      break;
    }

    case "uniform-width": {
      const v = args[1];
      if (v !== "on" && v !== "off") {
        console.error("Error: uniform-width requires on|off");
        Deno.exit(1);
      }
      const d = mutate((d) => d.setUniformWidth(v === "on"));
      renderUnlessDeferred(d);
      console.log(`uniform-width ${v} (rev ${d.rev})`);
      break;
    }

    case "set-font": {
      const v = args[1];
      if (v !== "mono" && v !== "sans") {
        console.error("Error: set-font requires mono|sans");
        Deno.exit(1);
      }
      const d = mutate((d) => d.setFont(v));
      renderUnlessDeferred(d);
      console.log(`font: ${v} (rev ${d.rev})`);
      break;
    }

    case "set-box-style": {
      const flags = args.slice(1);
      rejectUnknownFlags("set-box-style", flags, [
        "--outlineWidth",
        "--outlineDash",
        "--corners",
        "--reset",
      ]);
      const opts = flags.includes("--reset")
        ? { outlineWidth: null, outlineDash: null, corners: null }
        : {};
      for (const arg of flags) {
        if (arg.startsWith("--outlineWidth=")) {
          opts.outlineWidth = arg.slice(15);
        } else if (arg.startsWith("--outlineDash=")) {
          opts.outlineDash = arg.slice(14);
        } else if (arg.startsWith("--corners=")) {
          opts.corners = arg.slice(10);
        }
      }
      if (Object.keys(opts).length === 0) {
        console.error(
          "Error: set-box-style needs --outlineWidth=, --outlineDash=, --corners= or --reset",
        );
        Deno.exit(1);
      }
      const d = mutate((d) => d.setBoxStyle(opts));
      renderUnlessDeferred(d);
      const s = d._state;
      console.log(
        `box style: ${s.outlineWidth ?? "medium"} ${s.outlineDash ?? "solid"} ${
          s.corners ?? "round"
        } (rev ${d.rev})`,
      );
      break;
    }

    case "set-edge-style": {
      const flags = args.slice(1);
      rejectUnknownFlags("set-edge-style", flags, ["--width", "--reset"]);
      const opts = flags.includes("--reset") ? { width: null } : {};
      for (const arg of flags) {
        if (arg.startsWith("--width=")) opts.width = arg.slice(8);
      }
      if (Object.keys(opts).length === 0) {
        console.error("Error: set-edge-style needs --width= or --reset");
        Deno.exit(1);
      }
      const d = mutate((d) => d.setEdgeStyle(opts));
      renderUnlessDeferred(d);
      console.log(
        `edge style: ${d._state.edgeWidth ?? "medium"} (rev ${d.rev})`,
      );
      break;
    }

    case "set-group-style": {
      const flags = args.slice(1);
      rejectUnknownFlags("set-group-style", flags, [...LABEL_FLAGS, "--reset"]);
      const opts = flags.includes("--reset")
        ? {
          labelPos: null,
          labelAlign: null,
          labelWeight: null,
          labelSize: null,
        }
        : {};
      labelFlags(flags, opts);
      if (Object.keys(opts).length === 0) {
        console.error(
          "Error: set-group-style needs --labelPos=, --labelAlign=, --labelWeight=, --labelSize= or --reset",
        );
        Deno.exit(1);
      }
      const d = mutate((d) => d.setGroupStyle(opts));
      renderUnlessDeferred(d);
      const s = d._state;
      console.log(
        `group labels: ${s.groupLabelPos ?? "top-border"} ${
          s.groupLabelAlign ?? "left"
        } ${s.groupLabelWeight ?? "bold"} ${
          s.groupLabelSize ?? "default"
        }px (rev ${d.rev})`,
      );
      break;
    }

    case "set-title":
    case "set-footer": {
      // No argument clears it — the same shape as `set-font-size reset`.
      const field = cmd === "set-title" ? "title" : "footer";
      const text = args.slice(1).join(" ");
      const d = mutate((d) =>
        field === "title" ? d.setTitle(text) : d.setFooter(text)
      );
      renderUnlessDeferred(d);
      console.log(`${field}: ${text || "(cleared)"} (rev ${d.rev})`);
      break;
    }

    case "set-theme": {
      const v = args[1];
      if (!v) {
        console.error(
          `Error: set-theme requires <name> or 'reset'. Available: ${
            Object.keys(SCHEMES).join(", ")
          }`,
        );
        Deno.exit(1);
      }
      const name = v === "reset" ? null : v;
      const d = mutate((d) => d.setTheme(name));
      renderUnlessDeferred(d);
      console.log(`theme: ${name ?? "(default palette)"} (rev ${d.rev})`);
      break;
    }

    case "set-legend": {
      // auto | off | <color>[:<dash>]=<label>...
      const rest = args.slice(1);
      if (rest.length === 0) {
        console.error(
          'Error: set-legend requires auto, off, or <color>[:<dash>]=<label>... (e.g. amber="Ops builds" pink:dashed="owner TBD")',
        );
        Deno.exit(1);
      }
      let entries;
      if (rest.length === 1 && rest[0] === "auto") entries = null;
      else if (rest.length === 1 && rest[0] === "off") entries = false;
      else {
        entries = rest.map((a) => {
          const eq = a.indexOf("=");
          if (eq <= 0 || eq === a.length - 1) {
            console.error(
              `Error: set-legend entry "${a}" must be <color>[:<dash>]=<label>`,
            );
            Deno.exit(1);
          }
          const [color, dash] = a.slice(0, eq).split(":");
          return { color, label: a.slice(eq + 1), ...(dash ? { dash } : {}) };
        });
      }
      const d = mutate((d) => d.setLegend(entries));
      renderUnlessDeferred(d);
      const what = entries === null
        ? "auto (colors in use)"
        : entries === false
        ? "off"
        : `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
      console.log(`legend: ${what} (rev ${d.rev})`);
      break;
    }

    case "set-font-size": {
      const v = args[1];
      if (!v) {
        console.error("Error: set-font-size requires <px> (6–48) or 'reset'");
        Deno.exit(1);
      }
      const px = (v === "reset" || v === "0")
        ? null
        : int("set-font-size <px>", v);
      const d = mutate((d) => d.setFontSize(px));
      renderUnlessDeferred(d);
      console.log(`font size: ${px ?? "default (13)"} (rev ${d.rev})`);
      break;
    }

    case "set-color": {
      // set-color <name> <bg> <border> | set-color <name> reset
      const [, name, bg, border] = args;
      if (!name || !bg || (bg !== "reset" && !border)) {
        console.error(
          "Error: set-color requires <name> <bg-hex> <border-hex>, or <name> reset",
        );
        Deno.exit(1);
      }
      const reset = bg === "reset";
      const d = mutate((d) =>
        reset ? d.setColor(name, null) : d.setColor(name, bg, border)
      );
      renderUnlessDeferred(d);
      console.log(
        `color ${name}: ${
          reset ? "removed" : `${bg} / ${border}`
        } (rev ${d.rev})`,
      );
      break;
    }

    case "set-edge-preset": {
      // set-edge-preset <name> <hex> [solid|dashed|dotted] | <name> reset
      const [, name, color, dash] = args;
      if (!name || !color) {
        console.error(
          "Error: set-edge-preset requires <name> <hex> [solid|dashed|dotted], or <name> reset",
        );
        Deno.exit(1);
      }
      const reset = color === "reset";
      const d = mutate((d) =>
        reset
          ? d.setEdgePreset(name, null)
          : d.setEdgePreset(name, color, dash ?? "solid")
      );
      renderUnlessDeferred(d);
      console.log(
        `edge preset ${name}: ${
          reset ? "removed" : `${color} ${dash ?? "solid"}`
        } (rev ${d.rev})`,
      );
      break;
    }

    case "set-background": {
      const v = args[1];
      if (!v) {
        console.error("Error: set-background requires <hex> or reset");
        Deno.exit(1);
      }
      const d = mutate((d) => d.setBackground(v === "reset" ? null : v));
      renderUnlessDeferred(d);
      console.log(`background: ${v} (rev ${d.rev})`);
      break;
    }

    case "set-row-gap": {
      const v = args[1];
      if (!v) {
        console.error("Error: set-row-gap requires <px> or reset");
        Deno.exit(1);
      }
      const px = v === "reset" ? null : int("set-row-gap", v, { min: 0 });
      const d = mutate((d) => d.setRowGap(px));
      renderUnlessDeferred(d);
      console.log(`rowGap: ${v} (rev ${d.rev})`);
      break;
    }

    case "set-wrap-slack": {
      const v = args[1];
      if (!v) {
        console.error("Error: set-wrap-slack requires <n> (>= 1) or reset");
        Deno.exit(1);
      }
      const d = mutate((d) => d.setWrapSlack(v === "reset" ? null : Number(v)));
      renderUnlessDeferred(d);
      console.log(`wrapSlack: ${v} (rev ${d.rev})`);
      break;
    }

    case "set-start-markers": {
      const v = args[1];
      if (v !== "on" && v !== "off") {
        console.error("Error: set-start-markers requires on|off");
        Deno.exit(1);
      }
      const d = mutate((d) => d.setStartMarkers(v === "on"));
      renderUnlessDeferred(d);
      console.log(`start markers: ${v} (rev ${d.rev})`);
      break;
    }

    case "set-connector-anchor": {
      const v = args[1];
      if (v !== "align" && v !== "center") {
        console.error("Error: set-connector-anchor requires align|center");
        Deno.exit(1);
      }
      const d = mutate((d) => d.setConnectorAnchor(v));
      renderUnlessDeferred(d);
      console.log(`connector anchor: ${v} (rev ${d.rev})`);
      break;
    }

    case "set-flow": {
      const v = args[1];
      if (!v) {
        console.error("Error: set-flow requires a field or none");
        Deno.exit(1);
      }
      const d = mutate((d) => d.setFlow(v === "none" ? null : v));
      renderUnlessDeferred(d);
      console.log(`flow: ${v} (rev ${d.rev})`);
      break;
    }

    case "flow-place": {
      const gapArg = args.find((a) => a.startsWith("--gap="));
      const gap = gapArg ? int("--gap", gapArg.slice(6), { min: 0 }) : 45;
      const fr = args.find((a) => a.startsWith("--frame="))?.slice(8)
        .match(/^(\d+)x(\d+)$/);
      const frame = fr ? { W: +fr[1], H: +fr[2] } : undefined;
      let order;
      const d = mutate((d) => {
        order = d.flowPlace({ gap, frame });
      });
      renderUnlessDeferred(d);
      console.log(`flow-placed ${order.join(" → ")} (rev ${d.rev})`);
      break;
    }

    case "untangle": {
      const flags = args.slice(1);
      rejectUnknownFlags("untangle", flags, ["--unpin", "--budget", "--seed"]);
      const opts = { unpin: flags.includes("--unpin") };
      for (const f of flags) {
        if (f.startsWith("--budget=")) {
          opts.budget = int("--budget", f.slice(9), { min: 1 });
        } else if (f.startsWith("--seed=")) {
          opts.seed = int("--seed", f.slice(7));
        }
      }
      const d = Diagram.load(STATE);
      const r = d.untangle(opts);
      const fmt = (s) =>
        `${s.crossings} crossings, ${s.labels} label issues, ${s.length} cells of wire`;
      if (!r.moved.length) {
        console.log(`nothing better found (${fmt(r.before)}); board unchanged`);
        break;
      }
      // One attempt: a retry would repeat the whole search against a board
      // someone else has just changed, so say so and let them rerun it.
      try {
        d.save(STATE);
      } catch (e) {
        if (!(e instanceof RevConflict || e instanceof LockBusy)) throw e;
        console.error(
          "Error: the board changed while untangling; nothing was saved. Run it again.",
        );
        Deno.exit(1);
      }
      renderUnlessDeferred(d);
      console.log(
        `untangled: ${fmt(r.before)} → ${
          fmt(r.after)
        }; moved ${r.moved.length} boxes (rev ${d.rev})`,
      );
      break;
    }

    case "set-direction": {
      const v = args[1];
      if (v !== "down" && v !== "right" && v !== "reset") {
        console.error("Error: set-direction requires down|right|reset");
        Deno.exit(1);
      }
      const d = mutate((d) => d.setDirection(v === "reset" ? null : v));
      renderUnlessDeferred(d);
      console.log(`direction: ${v === "reset" ? "down" : v} (rev ${d.rev})`);
      break;
    }

    case "update-node": {
      const id = args[1];
      if (!id) {
        console.error("Error: update-node requires <id>");
        Deno.exit(1);
      }
      const nodeFlags = args.slice(2);
      rejectUnknownFlags(
        "update-node",
        nodeFlags.filter((a) => a.startsWith("--")),
        [
          "--label",
          "--color",
          "--row",
          "--col",
          "--details",
          "--minW",
          "--w",
          "--h",
          "--outlineWidth",
          "--outlineDash",
          "--corners",
          "--outlineReset",
          "--shape",
          "--icon",
          "--frame",
          "--span",
          "--band",
        ],
      );
      const opts = {};
      for (const arg of nodeFlags) {
        if (arg.startsWith("--label=")) opts.label = arg.slice(8);
        else if (arg.startsWith("--color=")) opts.color = arg.slice(8);
        else if (arg.startsWith("--row=")) {
          opts.row = int("--row", arg.slice(6));
        } else if (arg.startsWith("--col=")) {
          opts.col = int("--col", arg.slice(6));
        } else if (arg.startsWith("--details=")) {
          opts.details = arg.slice(10).split(",");
        } else if (arg.startsWith("--minW=")) {
          opts.minW = int("--minW", arg.slice(7), { min: 0 });
        } else if (arg.startsWith("--w=")) { // explicit width (cells); 0 = auto
          opts.w = int("--w", arg.slice(4), { min: 0 });
        } else if (arg.startsWith("--h=")) { // explicit height (cells); 0 = auto
          opts.h = int("--h", arg.slice(4), { min: 0 });
        } else if (arg.startsWith("--outlineWidth=")) {
          opts.outlineWidth = arg.slice(15);
        } else if (arg.startsWith("--outlineDash=")) {
          opts.outlineDash = arg.slice(14);
        } else if (arg.startsWith("--corners=")) {
          opts.corners = arg.slice(10);
        } else if (arg.startsWith("--shape=")) {
          opts.shape = arg.slice(8);
        } else if (arg.startsWith("--icon=")) {
          opts.icon = arg.slice(7);
        } else if (arg.startsWith("--frame=")) {
          opts.frame = arg.slice(8);
        } else if (arg.startsWith("--span=")) {
          opts.span = int("--span", arg.slice(7), { min: 0 });
        } else if (arg.startsWith("--band=")) {
          const v = onOffDefault(arg, 7);
          opts.band = v === false ? false : null;
        } else if (arg === "--outlineReset") {
          opts.outlineWidth = null;
          opts.outlineDash = null;
          opts.corners = null;
        }
      }
      if (Object.keys(opts).length === 0) {
        console.error("Error: update-node needs at least one --flag=value");
        Deno.exit(1);
      }
      const d = mutate((d) => d.updateNode(id, opts));
      renderUnlessDeferred(d);
      console.log(`Updated node "${id}" (rev ${d.rev})`);
      break;
    }

    case "update-edge": {
      // Split positionals from flags so `update-edge --id=ID --label=x` (no
      // positional from/to) parses the same as `update-edge a b --label=x`.
      const rest = args.slice(1);
      const [from, to] = rest.filter((a) => !a.startsWith("--"));
      const id = rest.find((a) => a.startsWith("--id="))?.slice(5); // disambiguates parallel edges
      if (!id && (!from || !to)) {
        console.error("Error: update-edge requires <from> <to> (or --id=ID)");
        Deno.exit(1);
      }
      rejectUnknownFlags(
        "update-edge",
        rest.filter((a) => a.startsWith("--")),
        [
          "--id",
          "--style",
          "--label",
          "--width",
          "--dash",
          "--color",
          "--styleReset",
          "--fromEdge",
          "--toEdge",
          "--fromConn",
          "--toConn",
          "--cost-step",
          "--cost-turn",
          "--cost-near",
          "--cost-overlap",
          "--cost-reset",
          "--labelSide",
          "--labelOffset",
          "--labelSeg",
          "--labelReset",
        ],
      );
      const opts = {};
      for (const arg of rest.filter((a) => a.startsWith("--"))) {
        if (arg.startsWith("--style=")) opts.style = arg.slice(8);
        else if (arg.startsWith("--label=")) opts.label = arg.slice(8);
        else if (arg.startsWith("--width=")) opts.width = arg.slice(8);
        else if (arg.startsWith("--dash=")) opts.dash = arg.slice(7);
        else if (arg.startsWith("--color=")) opts.color = arg.slice(8);
        else if (arg === "--styleReset") {
          opts.width = null;
          opts.dash = null;
          opts.color = null;
        } else if (arg.startsWith("--fromEdge=")) opts.fromEdge = arg.slice(11);
        else if (arg.startsWith("--toEdge=")) opts.toEdge = arg.slice(9);
        else if (arg.startsWith("--fromConn=")) opts.fromConn = arg.slice(11);
        else if (arg.startsWith("--toConn=")) opts.toConn = arg.slice(9);
        else if (arg.startsWith("--cost-step=")) {
          (opts.costs ||= {}).step = int("--cost-step", arg.slice(12), {
            min: 0,
          });
        } else if (arg.startsWith("--cost-turn=")) {
          (opts.costs ||= {}).turn = int("--cost-turn", arg.slice(12), {
            min: 0,
          });
        } else if (arg.startsWith("--cost-near=")) {
          (opts.costs ||= {}).near = int("--cost-near", arg.slice(12), {
            min: 0,
          });
        } else if (arg.startsWith("--cost-overlap=")) {
          (opts.costs ||= {}).overlap = int("--cost-overlap", arg.slice(15), {
            min: 0,
          });
        } else if (arg === "--cost-reset") opts.costs = null;
        else if (arg.startsWith("--labelSide=")) {
          (opts.labelPos ||= {}).side = arg.slice(12);
        } else if (arg.startsWith("--labelOffset=")) {
          (opts.labelPos ||= {}).offset = int("--labelOffset", arg.slice(14), {
            min: 0,
          });
        } else if (arg.startsWith("--labelSeg=")) {
          (opts.labelPos ||= {}).seg = int("--labelSeg", arg.slice(11), {
            min: 0,
          });
        } else if (arg === "--labelReset") opts.labelPos = null;
      }
      if (Object.keys(opts).length === 0) {
        console.error("Error: update-edge needs at least one --flag=value");
        Deno.exit(1);
      }
      const d = mutate((d) => d.updateEdge(from, to, opts, id));
      renderUnlessDeferred(d);
      console.log(
        `Updated edge ${
          id ? `id "${id}"` : `"${from}" -> "${to}"`
        } (rev ${d.rev})`,
      );
      break;
    }

    case "reverse-edge": {
      const [, from, to] = args;
      const id = args.find((a) => a.startsWith("--id="))?.slice(5);
      if (!id && (!from || !to)) {
        console.error("Error: reverse-edge requires <from> <to> (or --id=ID)");
        Deno.exit(1);
      }
      const d = mutate((d) => d.reverseEdge(from, to, id));
      renderUnlessDeferred(d);
      console.log(
        `Reversed edge ${
          id ? `id "${id}"` : `"${from}" -> "${to}"`
        } (rev ${d.rev})`,
      );
      break;
    }

    case "retarget-edge": {
      // Move one (or both) endpoints, preserving style/label/width/dash/color/
      // costs/labelPos. Omitted end stays put; the moved end's side/conn pins are
      // cleared (they named the old box). Atomic + guards self-loops/duplicates.
      const rest = args.slice(1);
      const [from, to] = rest.filter((a) => !a.startsWith("--"));
      const id = rest.find((a) => a.startsWith("--id="))?.slice(5);
      if (!id && (!from || !to)) {
        console.error(
          "Error: retarget-edge requires <from> <to> (or --id=ID) [--newFrom=ID] [--newTo=ID]",
        );
        Deno.exit(1);
      }
      // Undefined (not from/to) when omitted — retargetEdge reads it as "keep this
      // end", so an --id caller can move one end without naming the other.
      let newFrom, newTo;
      rejectUnknownFlags(
        "retarget-edge",
        rest.filter((a) => a.startsWith("--")),
        ["--id", "--newFrom", "--newTo"],
      );
      for (const arg of rest.filter((a) => a.startsWith("--"))) {
        if (arg.startsWith("--newFrom=")) newFrom = arg.slice(10);
        else if (arg.startsWith("--newTo=")) newTo = arg.slice(8);
      }
      if (newFrom === undefined && newTo === undefined) {
        console.error(
          "Error: retarget-edge needs --newFrom=ID and/or --newTo=ID",
        );
        Deno.exit(1);
      }
      const d = mutate((d) => d.retargetEdge(from, to, newFrom, newTo, id));
      renderUnlessDeferred(d);
      console.log(
        `Retargeted edge ${id ? `id "${id}"` : `"${from}" -> "${to}"`}${
          newFrom ? ` newFrom=${newFrom}` : ""
        }${newTo ? ` newTo=${newTo}` : ""} (rev ${d.rev})`,
      );
      break;
    }

    case "set-canvas": {
      // Set board bounds B to W×H. --anchor says where existing content sticks,
      // as in Photoshop (default nw = grow right/down, no movement; se = grow
      // left/up, content follows; c = re-center). --grow never shrinks a side.
      // Throws if too small for the content.
      const pos = args.slice(1).filter((a) => !a.startsWith("--"));
      const size = pos.length === 1 ? pos[0].split(/x/i) : pos;
      if (size.length !== 2) {
        console.error(
          "Error: set-canvas requires <W>x<H> or <W> <H> [--anchor=nw|n|ne|e|se|s|sw|w|c] [--grow]",
        );
        Deno.exit(1);
      }
      const flags = args.slice(1).filter((a) => a.startsWith("--"));
      rejectUnknownFlags("set-canvas", flags, ["--anchor", "--grow"]);
      let anchor = "nw";
      for (const arg of flags) {
        if (arg.startsWith("--anchor=")) anchor = arg.slice(9);
      }
      const grow = flags.includes("--grow");
      const width = int("set-canvas <width>", size[0], { min: 1 });
      const height = int("set-canvas <height>", size[1], { min: 1 });
      const d = mutate((d) => d.setCanvas(width, height, anchor, { grow }));
      renderUnlessDeferred(d);
      console.log(
        `Canvas set to ${d._state.width}×${d._state.height} (anchor ${anchor}, rev ${d.rev})`,
      );
      break;
    }

    case "expand-canvas": {
      // Grow/shrink B by per-side pixel deltas (negative trims). Adding left/up
      // slides content into the new space; right/down leave content put.
      // --by=WxH grows by a total instead, split by --anchor as in set-canvas.
      const flags = args.slice(1);
      rejectUnknownFlags("expand-canvas", flags, [
        "--left",
        "--right",
        "--up",
        "--down",
        "--by",
        "--anchor",
      ]);
      const opts = { left: 0, right: 0, up: 0, down: 0 };
      let any = false, by = null, anchor = null;
      for (const arg of flags) {
        const m = arg.match(/^--(left|right|up|down)=(.*)$/);
        if (m) {
          opts[m[1]] = int(`--${m[1]}`, m[2]);
          any = true;
        } else if (arg.startsWith("--by=")) by = arg.slice(5).split(/x/i);
        else if (arg.startsWith("--anchor=")) anchor = arg.slice(9);
      }
      if (by && any) {
        console.error(
          "Error: expand-canvas takes --by= or per-side flags, not both",
        );
        Deno.exit(1);
      }
      if (anchor && !by) {
        console.error("Error: expand-canvas --anchor needs --by=<W>x<H>");
        Deno.exit(1);
      }
      if (by && by.length !== 2) {
        console.error("Error: --by must be <W>x<H>, e.g. --by=100x200");
        Deno.exit(1);
      }
      if (!by && !any) {
        console.error(
          "Error: expand-canvas needs --by=<W>x<H> or at least one of --left/--right/--up/--down=<px> (negative trims)",
        );
        Deno.exit(1);
      }
      const d = by
        ? (() => {
          const dw = int("--by width", by[0]), dh = int("--by height", by[1]);
          return mutate((d) => d.expandCanvasBy(dw, dh, anchor ?? "nw"));
        })()
        : mutate((d) => d.expandCanvas(opts));
      renderUnlessDeferred(d);
      console.log(
        `Canvas now ${d._state.width}×${d._state.height} (rev ${d.rev})`,
      );
      break;
    }

    case "fit-canvas": {
      // Trim B to hug the content (slides the diagram to a uniform margin).
      const d = mutate((d) => d.fitCanvasToContent());
      renderUnlessDeferred(d);
      console.log(
        `Canvas trimmed to content: ${d._state.width}×${d._state.height} (rev ${d.rev})`,
      );
      break;
    }

    case "render": {
      Diagram.load(STATE).render();
      break;
    }

    case "issues": {
      // Layout defects, without opening the PNG. Exits 1 when there are any,
      // so a build script can stop on them.
      const flags = args.slice(1);
      rejectUnknownFlags("issues", flags, ["--json"]);
      const found = Diagram.load(STATE).issues();
      if (flags.includes("--json")) {
        console.log(JSON.stringify(found, null, 2));
      } else if (found.length === 0) {
        console.log("no issues");
      } else {
        for (const i of found) console.log(`${i.kind}: ${i.message}`);
        console.log(`${found.length} issue(s)`);
      }
      if (found.length) Deno.exit(1);
      break;
    }

    case "batch": {
      // batch [file|-]: run CLI lines from a file (or stdin) in one process,
      // rendering once at the end. Same syntax as the shell: quotes group
      // words, # starts a comment, a trailing \ continues the line.
      const src = args[1] && args[1] !== "-" ? args[1] : "/dev/stdin";
      const lines = parseBatch(Deno.readTextFileSync(src));
      const outer = deferRender;
      deferRender = true;
      let at = null;
      const onExit = () => {
        if (at) console.error(`batch: stopped at line ${at.line}: ${at.text}`);
      };
      globalThis.addEventListener("unload", onExit);
      for (const l of lines) {
        if (l.argv[0] === "init" || l.argv[0] === "batch") {
          throw new Error(
            `batch line ${l.line}: ${l.argv[0]} can't run in a batch`,
          );
        }
        at = l;
        try {
          run(l.argv);
        } catch (err) {
          at = null;
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`batch line ${l.line}: ${l.text}\n  ${msg}`);
        }
      }
      at = null;
      globalThis.removeEventListener("unload", onExit);
      deferRender = outer;
      if (!outer) Diagram.load(STATE).render();
      console.log(
        `batch: ${lines.length} commands${outer ? "" : ", rendered once"}`,
      );
      break;
    }

    case "spread": {
      const d = mutate((d) => d.spreadBoxes());
      renderUnlessDeferred(d);
      console.log(
        `spread complete — positions baked into layout (rev ${d.rev})`,
      );
      break;
    }

    case "snap-h": {
      const d = mutate((d) => d.snapAlign("h"));
      renderUnlessDeferred(d);
      console.log(`snap-h complete (rev ${d.rev})`);
      break;
    }

    case "snap-v": {
      const d = mutate((d) => d.snapAlign("v"));
      renderUnlessDeferred(d);
      console.log(`snap-v complete (rev ${d.rev})`);
      break;
    }

    case "capture": {
      const label = args[1];
      const d = Diagram.load(STATE);
      const { png, json } = captureArtifacts(
        d.stateDir,
        label,
        undefined,
        STATE,
        d.outputPath,
      );
      console.log(`Captured:\n  ${png}\n  ${json}`);
      break;
    }

    case "status": {
      const d = Diagram.load(STATE);
      const wantPos = args.includes("--positions") || args.includes("--json");
      if (wantPos) {
        // Headless read-back of the solved layout: pixel positions agents can
        // place notes/dividers against instead of guessing.
        const solved = d.solvePositions();
        if (args.includes("--json")) {
          console.log(JSON.stringify({ rev: d.rev, ...solved }, null, 2));
        } else {
          console.log(
            `rev ${d.rev}  ·  canvas ${solved.canvas.width}x${solved.canvas.height}  ·  content ${solved.content.w}x${solved.content.h} @ (${solved.content.x},${solved.content.y})`,
          );
          for (const [id, p] of Object.entries(solved.positions)) {
            console.log(
              `  ${id}  x=${p.x} y=${p.y} w=${p.w} h=${p.h}${
                p.pinned ? "  [pinned]" : ""
              }${p.group ? `  [group ${p.group}]` : ""}`,
            );
          }
          for (const [id, g] of Object.entries(solved.groups)) {
            console.log(
              `  group ${id}  x=${g.x} y=${g.y} w=${g.w} h=${g.h}  ${g.layout}${
                g.parent ? `  [in ${g.parent}]` : ""
              }${
                g.intruders.length
                  ? `  [contains non-members: ${g.intruders.join(", ")}]`
                  : ""
              }`,
            );
          }
          for (const [id, n] of Object.entries(solved.notes)) {
            const r = n.rect;
            console.log(
              `  note ${id}  x=${r.x} y=${r.y} w=${r.w} h=${r.h}${
                n.anchored ? "  [anchored]" : ""
              }`,
            );
          }
        }
        break;
      }
      console.log(
        `rev ${d.rev}  ·  ${d.nodes.length} nodes  ·  ${d.edges.length} edges  ·  ${
          Object.keys(d.layout).length
        } layout override(s)`,
      );
      break;
    }

    case "list-nodes": {
      const d = Diagram.load(STATE);
      const nodes = d.listNodes();
      console.log(`${nodes.length} nodes:`);
      for (const n of nodes) {
        console.log(
          `  ${n.id}  row=${n.row} col=${n.col}  color=${n.color}  "${n.label}"`,
        );
        if (n.details && n.details.length > 0) {
          for (const line of n.details) console.log(`    - ${line}`);
        }
      }
      break;
    }

    case "list-edges": {
      const edges = Diagram.load(STATE).listEdges();
      console.log(`${edges.length} edges:`);
      for (const e of edges) {
        const label = e.label ? ` "${e.label}"` : "";
        // id disambiguates parallel edges (same from->to); pass it as --id= to edits.
        console.log(
          `  ${e.from} -> ${e.to}  [${e.style}]${label}  (id: ${e.id})`,
        );
      }
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
  }
}

try {
  run(args);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  Deno.exit(1);
}
