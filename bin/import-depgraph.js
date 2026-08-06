#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-run --allow-ffi --unstable-ffi
/**
 * import-depgraph — turn a Deno module graph into a board.
 *
 * Takes an entrypoint (or a saved `deno info --json` dump) and draws the import
 * DAG: nodes are packages by default, or raw modules with `--granularity=module`.
 * Depth is BFS distance from the entrypoint, so the board reads top-down from
 * what you run to what it ultimately pulls in.
 *
 *   deno task import:deps dev-server.js --out=diagrams/deps
 *   deno task import:deps graph.json --granularity=module --per-row=12
 *
 * Flags:
 *   --out=<dir>            where to write diagram-state.json (default: cwd)
 *   --force                overwrite an existing board there
 *   --granularity=package|module   (default: package)
 *   --per-row=<n>          nodes per row band before wrapping (default: 8)
 *   --max=<n>              keep only the n largest packages
 *   --width= / --height=   canvas size (default 1600x1000)
 *   --title=
 *
 * A package-granularity board of a mid-size project lands around 20 nodes and
 * is genuinely readable. Module granularity on the same project is ~320 nodes
 * and is not — it renders, but see mparrett/agent-diagrams#1 (issue 3) for why
 * the result gets capped and squashed. It exists for spotting shape, not detail.
 */

import {
  assignBands,
  classifySpecifier,
  intFlag,
  makeCanon,
  parseArgs,
  resolveOut,
  seedBoard,
} from "./import-util.js";

const { flags, positional } = parseArgs(Deno.args);
const [input] = positional;

if (!input) {
  console.error(
    "usage: import-depgraph <entrypoint|graph.json> [--out=dir] [flags]",
  );
  console.error(
    "       see the header of bin/import-depgraph.js for all flags",
  );
  Deno.exit(1);
}

const granularity = flags.granularity ?? "package";
if (granularity !== "package" && granularity !== "module") {
  console.error(
    `--granularity must be "package" or "module", got "${granularity}"`,
  );
  Deno.exit(1);
}
const perRow = intFlag(flags, "per-row", 8);
const max = intFlag(flags, "max", Infinity);

// ─── Load the graph ────────────────────────────────────────────
// Accept either a saved dump or an entrypoint we run `deno info` over.
async function loadGraph(spec) {
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(spec));
    if (Array.isArray(parsed?.modules)) return parsed;
  } catch {
    // not a saved dump — fall through and treat it as an entrypoint
  }
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", spec],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    console.error(new TextDecoder().decode(stderr).trim());
    Deno.exit(1);
  }
  return JSON.parse(new TextDecoder().decode(stdout));
}

const graph = await loadGraph(input);

// Canonicalization and ecosystem classification live in import-util.js so they
// can be unit-tested; this script executes on import, so nothing exported from
// here would be reachable from a test.
const canon = makeCanon(graph.redirects ?? {});
const cwdUrl = new URL(`file://${Deno.cwd().replace(/\/?$/, "/")}`).href;

/** Map a module specifier to a group id + display label + color. */
function packageOf(spec) {
  return classifySpecifier(canon(spec), cwdUrl);
}

/** Module granularity: every module is a node, labelled by its tail path. */
function moduleOf(spec) {
  spec = canon(spec);
  return {
    id: spec,
    label: spec.split("/").slice(-2).join("/"),
    color: classifySpecifier(spec, cwdUrl).color,
  };
}

const key = granularity === "module" ? moduleOf : packageOf;

// ─── Collapse to the node/edge graph ───────────────────────────
const nodes = new Map(); // id -> { id, label, color, members:Set }
const edges = new Map(); // "from\0to" -> dep count

function touch(spec) {
  const k = key(spec);
  if (!nodes.has(k.id)) nodes.set(k.id, { ...k, members: new Set() });
  nodes.get(k.id).members.add(canon(spec));
  return k.id;
}

for (const mod of graph.modules ?? []) {
  if (mod.error) continue;
  const from = touch(mod.specifier);
  for (const dep of mod.dependencies ?? []) {
    for (const side of [dep.code, dep.type]) {
      if (!side?.specifier) continue;
      const to = touch(side.specifier);
      if (to === from) continue; // intra-package edges collapse to nothing
      const ek = `${from}\0${to}`;
      edges.set(ek, (edges.get(ek) ?? 0) + 1);
    }
  }
}

// ─── Depth = BFS level from the roots ──────────────────────────
// Not longest-path: real module graphs contain import cycles, and longest-path
// lets a single cycle drive depth up to the node count.
const adj = new Map();
for (const ek of edges.keys()) {
  const [f, t] = ek.split("\0");
  if (!adj.has(f)) adj.set(f, []);
  adj.get(f).push(t);
}

const depth = new Map();
let frontier = (graph.roots ?? []).map((r) => key(r).id);
for (const r of frontier) depth.set(r, 0);
for (let level = 0; frontier.length; level++) {
  const next = [];
  for (const f of frontier) {
    for (const t of adj.get(f) ?? []) {
      if (depth.has(t)) continue;
      depth.set(t, level + 1);
      next.push(t);
    }
  }
  frontier = next;
}
// Unreachable nodes (type-only edges, orphans) land past the last level.
const maxDepth = depth.size ? Math.max(...depth.values()) : 0;
for (const id of nodes.keys()) if (!depth.has(id)) depth.set(id, maxDepth + 1);

// ─── Trim, place, emit ─────────────────────────────────────────
let keep = [...nodes.values()];
if (keep.length > max) {
  keep = keep.sort((a, b) => b.members.size - a.members.size).slice(0, max);
}
const keepIds = new Set(keep.map((n) => n.id));

const bands = assignBands(keep, (n) => depth.get(n.id), perRow);

const statePath = resolveOut(flags);
const d = seedBoard(statePath, {
  title: flags.title ?? `Import graph — ${granularity} view`,
  footer: `${
    graph.modules?.length ?? 0
  } modules → ${keepIds.size} ${granularity}s · ${bands} rows`,
  theme: "afterglow",
  width: intFlag(flags, "width", 1600, { min: 100 }),
  height: intFlag(flags, "height", 1000, { min: 100 }),
});

for (const n of keep) {
  d.addNode(n.id, {
    label: n.label,
    color: n.color,
    details: granularity === "package" && n.members.size > 1
      ? [`${n.members.size} modules`]
      : [],
    row: n.row,
    col: n.col,
  });
}

let drawn = 0;
for (const [ek, count] of edges) {
  const [f, t] = ek.split("\0");
  if (!keepIds.has(f) || !keepIds.has(t)) continue;
  // Weight reads as line style: a package imported once is a thin hairline, a
  // package leaned on heavily is a solid run.
  const style = count > 3 ? "solid" : count > 1 ? "default" : "thin";
  d.addEdge(f, t, style, count > 1 ? String(count) : undefined);
  drawn++;
}

d.save();
console.log(
  `${statePath}: ${keepIds.size} nodes, ${drawn} edges, ${bands} rows`,
);
console.log(`render it with:  deno task cli --state ${statePath} render`);
