/**
 * Shared helpers for the `bin/import-*.js` graph importers.
 *
 * Importers turn a real graph (a module dep graph, a file tree) into a board.
 * They all hit the same two problems, so the fixes live here rather than in
 * each importer.
 */

import { Diagram } from "../diagram-api.js";

/** `--key=value` / `--key` → object; everything else → positional list. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    if (a.startsWith("--")) {
      // Split once: a value may legitimately contain "=" (a title, a URL).
      const eq = a.indexOf("=");
      if (eq === -1) flags[a.slice(2)] = true;
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/**
 * Read a boolean flag. `--force` and `--force=true` enable; absent,
 * `--force=false` and `--force=0` do not — a bare truthiness test on the parsed
 * string turns `--force=false` into "force on", which is the opposite of what
 * it says.
 */
export function boolFlag(flags, name) {
  const v = flags[name];
  if (v === undefined) return false;
  if (v === true) return true;
  const s = String(v).toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  console.error(`--${name} takes true/false, got "${v}"`);
  Deno.exit(1);
}

/**
 * Read an integer flag, failing loudly rather than writing NaN into the board.
 *
 * `Number("abc")` is NaN and `JSON.stringify` writes NaN as `null`, so an
 * unvalidated `--per-row=abc` produced a state file whose every node had
 * `row: null, col: null` — printed "Infinity rows", exited 0, and only failed
 * later when the renderer rejected the file. Mirrors `int()` in diagram-cli.js,
 * which exists for exactly this failure.
 */
export function intFlag(flags, name, fallback, { min = 1 } = {}) {
  const raw = flags[name];
  if (raw === undefined || raw === true) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    console.error(`--${name} must be an integer, got "${raw}"`);
    Deno.exit(1);
  }
  if (n < min) {
    console.error(`--${name} must be ${min} or greater, got ${n}`);
    Deno.exit(1);
  }
  return n;
}

/**
 * Build a specifier canonicalizer over a `deno info` redirect map.
 *
 * `deno info` reports unresolved `jsr:`/`npm:` specifiers alongside their
 * resolved https:// form. Without following the map every jsr import shows up
 * twice — once as a real module, once as a dangling alias node.
 *
 * The `seen` guard matters: a redirect map is data from an external tool, and a
 * cycle in it would otherwise spin forever.
 */
export function makeCanon(redirects = {}) {
  return function canon(spec) {
    const seen = new Set();
    while (redirects[spec] && !seen.has(spec)) {
      seen.add(spec);
      spec = redirects[spec];
    }
    return spec;
  };
}

/**
 * Classify an (already canonicalized) module specifier into a node id, display
 * label and color. Color encodes the ecosystem, which is what the legend reads.
 */
export function classifySpecifier(spec, cwdUrl) {
  if (cwdUrl && spec.startsWith(cwdUrl)) {
    const rel = spec.slice(cwdUrl.length);
    return { id: rel, label: rel, color: "blue" };
  }
  if (spec.startsWith("file://")) {
    return { id: spec, label: spec.split("/").slice(-1)[0], color: "blue" };
  }
  if (spec.startsWith("node:")) return { id: spec, label: spec, color: "gray" };

  let m = spec.match(/^https:\/\/deno\.land\/std@[\d.]+\/([^/]+)\//);
  if (m) return { id: `std/${m[1]}`, label: `std/${m[1]}`, color: "green" };
  m = spec.match(/^https:\/\/jsr\.io\/(@[^/]+\/[^/]+)\//);
  if (m) return { id: m[1], label: m[1], color: "purple" };
  m = spec.match(/^https:\/\/deno\.land\/x\/([^/@]+)/);
  if (m) return { id: `x/${m[1]}`, label: `x/${m[1]}`, color: "teal" };

  // Anything else: keep the host+tail so it's identifiable, but keep it short —
  // one very long label widens every box once uniformWidth is on.
  const bare = spec.replace(/^https?:\/\//, "");
  return {
    id: bare,
    label: bare.split("/").slice(-2).join("/"),
    color: "amber",
  };
}

/**
 * Assign row/col from a depth map, wrapping wide levels into multiple bands.
 *
 * computeLayout spreads a row horizontally without bound and never reclaims
 * vertical space, so a 28-node level renders as a 5500px strip that hits the
 * renderer's 4096px raster cap. Wrapping keeps the board in a sane aspect
 * ratio. `items` are mutated in place with `row` and `col`.
 */
export function assignBands(items, depthOf, perRow) {
  const levels = new Map();
  for (const it of items) {
    const d = depthOf(it);
    if (!levels.has(d)) levels.set(d, []);
    levels.get(d).push(it);
  }
  let band = 0;
  for (const d of [...levels.keys()].sort((a, b) => a - b)) {
    const members = levels.get(d);
    members.forEach((it, i) => {
      it.row = band + Math.floor(i / perRow);
      it.col = i % perRow;
    });
    band += Math.ceil(members.length / perRow);
  }
  return band;
}

/** Create an empty board at `statePath` and return it loaded and configured. */
export function seedBoard(statePath, { title, footer, theme, width, height }) {
  Deno.writeTextFileSync(
    statePath,
    JSON.stringify({ nodes: [], edges: [], rev: 0 }, null, 2),
  );
  const d = Diagram.load(statePath);
  d.setTitle(title);
  d.setFooter(footer);
  d.setTheme(theme);
  d.setCanvasSize(width, height);
  return d;
}

/**
 * Resolve the output state path, refusing to clobber an existing board unless
 * `--force` was passed. Importers regenerate wholesale, so an accidental run in
 * a directory that already holds a hand-tuned diagram would discard it.
 */
export function resolveOut(flags) {
  const dir = typeof flags.out === "string" ? flags.out : Deno.cwd();
  Deno.mkdirSync(dir, { recursive: true });
  const path = `${dir.replace(/\/$/, "")}/diagram-state.json`;
  let exists = true;
  try {
    Deno.statSync(path);
  } catch {
    exists = false;
  }
  if (exists && !boolFlag(flags, "force")) {
    console.error(
      `refusing to overwrite ${path} — pass --force, or --out=<dir> to write elsewhere`,
    );
    Deno.exit(1);
  }
  return path;
}
