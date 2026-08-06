#!/usr/bin/env -S deno run --allow-write --allow-read --allow-env=DIAGRAM_STATE
/**
 * CLI tool for manipulating diagram state and rendering.
 *
 * State file resolution (all commands): --state <path> (or --state=<path>) >
 * DIAGRAM_STATE env > a ./diagram-state.json in the cwd > the bundled
 * diagrams/example board. (`init` always scaffolds in the cwd.)
 *
 * Usage:
 *   deno run --allow-write --allow-read diagram-cli.js add-node <id> <label> <color> <row> <col> [details...]
 *   deno run --allow-write --allow-read diagram-cli.js add-edge <from> <to> <style> [label]
 *   deno run --allow-write --allow-read diagram-cli.js remove-node <id>
 *   deno run --allow-write --allow-read diagram-cli.js remove-edge <from> <to>
 *   deno run --allow-write --allow-read diagram-cli.js move-node <id> <row> <col>
 *   deno run --allow-write --allow-read diagram-cli.js free-node <id>
 *   deno run --allow-write --allow-read diagram-cli.js update-node <id> [--label=...] [--color=...] [--row=N] [--col=N] [--details=a,b,c] [--minW=px|0] [--outlineWidth=thin|medium|thick] [--outlineDash=solid|dashed|dotted]
 *   deno run --allow-write --allow-read diagram-cli.js update-edge <from> <to> [--style=...] [--label=...] [--width=thin|medium|thick] [--dash=solid|dashed|dotted] [--color=...] [--fromEdge=...] [--toEdge=...] [--fromConn=...] [--toConn=...]
 *   deno run --allow-write --allow-read diagram-cli.js render
 *   deno run --allow-write --allow-read diagram-cli.js spread
 *   deno run --allow-write --allow-read diagram-cli.js snap-h
 *   deno run --allow-write --allow-read diagram-cli.js snap-v
 *   deno run --allow-write --allow-read diagram-cli.js list-nodes
 *   deno run --allow-write --allow-read diagram-cli.js list-edges
 */

import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { captureArtifacts, Diagram, resolveStatePath } from "./diagram-api.js";
import { DEFAULT_COLORS, DEFAULT_EDGE_STYLES } from "./diagram-core.js";

const BUILTIN_COLORS = Object.keys(DEFAULT_COLORS);
const BUILTIN_STYLES = Object.keys(DEFAULT_EDGE_STYLES);

// ─── Global --state flag (strip before command parsing) ────────────
const rawArgs = [...Deno.args];
let stateArg;
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a.startsWith("--state=")) {
    stateArg = a.slice(8);
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
const STATE = resolveStatePath(stateArg);

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

// Reject unrecognized --flags so a typo (--lable=) errors instead of silently
// applying nothing and reporting success.
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
  console.error(`Usage: diagram-cli.js [--state <path>] <command> [args...]

State file: --state <path> (any command) > DIAGRAM_STATE env > ./diagram-state.json
in the cwd (so the CLI works from any project) > the bundled diagrams/example board.

Commands:
  init                       Write a starter diagram-state.json in the current dir
  add-node <id> <label> <color> <row> <col> [details...]
  add-edge <from> <to> <style> [label]
  remove-node <id>
  remove-edge <from> <to>
  reverse-edge <from> <to>             Flip direction in place (keeps style/label, swaps per-end pins)
  retarget-edge <from> <to> [--newFrom=ID] [--newTo=ID]   Move an endpoint to another node (keeps style/label/costs)
  move-node <id> <row> <col>
  free-node <id>                       Drop the node's layout override + unpin → returns it to auto-layout
  update-node <id> [--label=...] [--color=NAME|SEMANTIC] [--row=N] [--col=N] [--details=a,b,c] [--minW=px|0] [--w=cells|0] [--h=cells|0]
                          [--outlineWidth=thin|medium|thick] [--outlineDash=solid|dashed|dotted] [--outlineReset]   box outline
  update-edge <from> <to> [--style=...] [--label=...] [--fromEdge=N|S|E|W] [--toEdge=...] [--fromConn=C|C-1|...] [--toConn=...]
                          [--width=thin|medium|thick] [--dash=solid|dashed|dotted] [--color=NAME|SEMANTIC] [--styleReset]   style axes
                          [--cost-step=N] [--cost-turn=N] [--cost-near=N] [--cost-overlap=N] [--cost-reset]   per-edge routing bias
                          [--labelSide=above|below|left|right] [--labelOffset=px] [--labelSeg=N] [--labelReset]   label placement
        Style axes (--width/--dash/--color) override the named --style preset one axis at a time.
        --color takes a named palette color (red, green, ...) or a semantic token (error, success, info, warn, neutral, accent).
  add-divider <h|v> <at-px> [label]    Dotted boundary line across the canvas
  remove-divider <h|v> <at-px>
  add-note <x> <y> [--title=...] [--color=...] [--anchor=node:side:dx:dy] <line>...  Floating text annotation
  remove-note <id> | <x> <y>           Remove a note
  free-note <id>                       Drop a note's drag override → back to its anchor/position
  uniform-width <on|off>     Homogenize box widths (minW'd boxes keep emphasis)
  set-title [text...]        Caption drawn top-left; no argument clears it
  set-footer [text...]       Caption drawn under the legend; no argument clears it
  set-font <mono|sans>       Typeface: monospace (default) or Instrument Sans
  set-font-size <px|reset>   Base font size (box-label px, default 13); scales the whole diagram
  set-connector-anchor <align|center>   Connector anchoring: align (de-kink straight runs, default) or center (fan symmetric about each side's center)
  set-canvas <w> <h> [--anchor=nw|n|ne|e|se|s|sw|w|c]   Set board bounds B (anchor = where content sticks; nw grows right/down)
  expand-canvas [--left=px] [--right=px] [--up=px] [--down=px]   Grow/shrink B per side (negative trims; left/up slide content)
  fit-canvas                 Trim board bounds B to hug the content (slides the diagram to a uniform margin)
  render
  spread                     Force-directed box spreading (bakes positions into layout)
  snap-h                     Snap-align box centers horizontally
  snap-v                     Snap-align box centers vertically
  capture [label]            Snapshot diagram.png + state into artifacts/<ts>[-label]
  status [--positions|--json]  rev + counts; --positions dumps solved {x,y,w,h} per node + canvas/content bbox
  list-nodes
  list-edges

Built-in colors: ${BUILTIN_COLORS.join(", ")}
Built-in styles: ${BUILTIN_STYLES.join(", ")}
(Extend either via the "colors" / "edgeStyles" keys in diagram-state.json —
 custom names become valid for that diagram.)`);
  Deno.exit(1);
}

if (!cmd) usage();

if (cmd === "init") {
  // init scaffolds in the cwd (or --state path) — it never targets the bundled
  // example board the way other commands' zero-arg default can.
  const target = resolve(Deno.cwd(), stateArg ?? "diagram-state.json");
  try {
    Deno.statSync(target);
    console.error(`Error: ${target} already exists — refusing to overwrite`);
    Deno.exit(1);
  } catch { /* not found — proceed */ }
  Deno.writeTextFileSync(target, JSON.stringify(STARTER_STATE, null, 2) + "\n");
  // Print a render command that actually works from where the user is standing:
  // in the tool repo the `deno task` alias exists; from a foreign cwd it doesn't.
  const toolDir = dirname(fromFileUrl(import.meta.url));
  const inRepo = Deno.cwd() === toolDir;
  const needsStateFlag = target !== resolve(Deno.cwd(), "diagram-state.json");
  const renderCmd = inRepo
    ? "deno task render"
    : `deno run --allow-read --allow-write ${
      join(toolDir, "render-diagram.js")
    }` +
      (needsStateFlag ? ` --state=${target}` : "");
  console.log(`Wrote starter ${target}\nEdit it, then render:\n  ${renderCmd}`);
  Deno.exit(0);
}

function run() {
  // Mutate through CAS-retry: loads fresh, applies the op, saves with rev guard,
  // retrying (reload + re-apply) on a concurrent write. Returns the saved Diagram.
  const mutate = (opFn) => Diagram.withRetry(STATE, opFn);

  switch (cmd) {
    case "add-node": {
      const [, id, label, color, rowStr, colStr, ...details] = args;
      if (!id || !label || !color || !rowStr || !colStr) {
        console.error(
          "Error: add-node requires <id> <label> <color> <row> <col> [details...]",
        );
        Deno.exit(1);
      }
      const row = int("add-node <row>", rowStr);
      const col = int("add-node <col>", colStr);
      const d = mutate((d) =>
        d.addNode(id, { label, color, details, row, col })
      );
      d.render();
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
      d.render();
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
      d.render();
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
      d.render();
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
      d.render();
      console.log(
        `Moved node "${id}" to row=${rowStr} col=${colStr} (rev ${d.rev})`,
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
      d.render();
      console.log(
        freed
          ? `Freed node "${id}" to auto-layout (rev ${d.rev})`
          : `Node "${id}" had no layout override — nothing to free (rev ${d.rev})`,
      );
      break;
    }

    case "add-divider": {
      const [, orient, atStr, ...labelParts] = args;
      if (!orient || !atStr) {
        console.error("Error: add-divider requires <h|v> <at-px> [label]");
        Deno.exit(1);
      }
      const label = labelParts.length ? labelParts.join(" ") : undefined;
      const at = int("add-divider <at-px>", atStr);
      const d = mutate((d) => d.addDivider(orient, at, { label }));
      d.render();
      console.log(`Added ${orient} divider at ${atStr}px (rev ${d.rev})`);
      break;
    }

    case "remove-divider": {
      const [, orient, atStr] = args;
      if (!orient || !atStr) {
        console.error("Error: remove-divider requires <h|v> <at-px>");
        Deno.exit(1);
      }
      const at = int("remove-divider <at-px>", atStr);
      let existed;
      const d = mutate((d) => {
        existed = d.removeDivider(orient, at);
      });
      d.render();
      console.log(
        existed
          ? `Removed ${orient} divider at ${atStr}px (rev ${d.rev})`
          : `No ${orient} divider at ${atStr}px — nothing removed (rev ${d.rev})`,
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
      d.render();
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
      d.render();
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
      d.render();
      console.log(
        freed
          ? `Freed note "${id}" back to its anchor/position (rev ${d.rev})`
          : `Note "${id}" had no drag override — nothing to free (rev ${d.rev})`,
      );
      break;
    }

    case "uniform-width": {
      const v = args[1];
      if (v !== "on" && v !== "off") {
        console.error("Error: uniform-width requires on|off");
        Deno.exit(1);
      }
      const d = mutate((d) => d.setUniformWidth(v === "on"));
      d.render();
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
      d.render();
      console.log(`font: ${v} (rev ${d.rev})`);
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
      d.render();
      console.log(`${field}: ${text || "(cleared)"} (rev ${d.rev})`);
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
      d.render();
      console.log(`font size: ${px ?? "default (13)"} (rev ${d.rev})`);
      break;
    }

    case "set-connector-anchor": {
      const v = args[1];
      if (v !== "align" && v !== "center") {
        console.error("Error: set-connector-anchor requires align|center");
        Deno.exit(1);
      }
      const d = mutate((d) => d.setConnectorAnchor(v));
      d.render();
      console.log(`connector anchor: ${v} (rev ${d.rev})`);
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
          "--outlineReset",
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
        } else if (arg === "--outlineReset") {
          opts.outlineWidth = null;
          opts.outlineDash = null;
        }
      }
      if (Object.keys(opts).length === 0) {
        console.error("Error: update-node needs at least one --flag=value");
        Deno.exit(1);
      }
      const d = mutate((d) => d.updateNode(id, opts));
      d.render();
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
      d.render();
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
      d.render();
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
      d.render();
      console.log(
        `Retargeted edge ${id ? `id "${id}"` : `"${from}" -> "${to}"`}${
          newFrom ? ` newFrom=${newFrom}` : ""
        }${newTo ? ` newTo=${newTo}` : ""} (rev ${d.rev})`,
      );
      break;
    }

    case "set-canvas": {
      // Set board bounds B to exactly W×H. --anchor says where existing content
      // sticks (default nw = grow right/down, no movement; se = grow left/up,
      // content follows; c = re-center). Throws if too small for the content.
      const [, w, h] = args;
      if (!w || !h) {
        console.error(
          "Error: set-canvas requires <width> <height> [--anchor=nw|n|ne|e|se|s|sw|w|c]",
        );
        Deno.exit(1);
      }
      let anchor = "nw";
      rejectUnknownFlags(
        "set-canvas",
        args.slice(3).filter((a) => a.startsWith("--")),
        ["--anchor"],
      );
      for (const arg of args.slice(3)) {
        if (arg.startsWith("--anchor=")) anchor = arg.slice(9);
      }
      const width = int("set-canvas <width>", w, { min: 1 });
      const height = int("set-canvas <height>", h, { min: 1 });
      const d = mutate((d) => d.setCanvas(width, height, anchor));
      d.render();
      console.log(
        `Canvas set to ${d._state.width}×${d._state.height} (anchor ${anchor}, rev ${d.rev})`,
      );
      break;
    }

    case "expand-canvas": {
      // Grow/shrink B by per-side pixel deltas (negative trims). Adding left/up
      // slides content into the new space; right/down leave content put.
      const opts = { left: 0, right: 0, up: 0, down: 0 };
      let any = false;
      rejectUnknownFlags(
        "expand-canvas",
        args.slice(1).filter((a) => a.startsWith("--")),
        ["--left", "--right", "--up", "--down"],
      );
      for (const arg of args.slice(1)) {
        const m = arg.match(/^--(left|right|up|down)=(.*)$/);
        if (m) {
          opts[m[1]] = int(`--${m[1]}`, m[2]);
          any = true;
        }
      }
      if (!any) {
        console.error(
          "Error: expand-canvas needs at least one of --left/--right/--up/--down=<px> (negative trims)",
        );
        Deno.exit(1);
      }
      const d = mutate((d) => d.expandCanvas(opts));
      d.render();
      console.log(
        `Canvas now ${d._state.width}×${d._state.height} (rev ${d.rev})`,
      );
      break;
    }

    case "fit-canvas": {
      // Trim B to hug the content (slides the diagram to a uniform margin).
      const d = mutate((d) => d.fitCanvasToContent());
      d.render();
      console.log(
        `Canvas trimmed to content: ${d._state.width}×${d._state.height} (rev ${d.rev})`,
      );
      break;
    }

    case "render": {
      Diagram.load(STATE).render();
      break;
    }

    case "spread": {
      const d = mutate((d) => d.spreadBoxes());
      d.render();
      console.log(
        `spread complete — positions baked into layout (rev ${d.rev})`,
      );
      break;
    }

    case "snap-h": {
      const d = mutate((d) => d.snapAlign("h"));
      d.render();
      console.log(`snap-h complete (rev ${d.rev})`);
      break;
    }

    case "snap-v": {
      const d = mutate((d) => d.snapAlign("v"));
      d.render();
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
  run();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  Deno.exit(1);
}
