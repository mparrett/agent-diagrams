/**
 * Diagram API — loads/saves diagram-state.json and renders to PNG.
 *
 * The Diagram class provides a programmatic interface for manipulating
 * diagram state (addNode, removeNode, etc.). All rendering logic is
 * delegated to diagram-core.js.
 *
 * Presentation (title, legend, footer, canvas size, background) is read
 * from the state JSON — nothing here is hardcoded to a particular diagram.
 */

import { createCanvas, Fonts } from "@gfx/canvas";
import { dirname, fromFileUrl, join, resolve } from "@std/path";

import {
  BOARD_MARGIN,
  BOARD_MARGIN_BOTTOM,
  boardExtent,
  boardExtentForContent,
  buildGrid,
  CELL,
  computeLayout,
  CORNER_RADII,
  createAstarState,
  DASH_TOKENS,
  DEFAULT_COSTS,
  deriveTheme,
  drawBoxes,
  drawDividers,
  drawEdgeLabels,
  drawFailedRoutes,
  drawGroupLabels,
  drawGroups,
  drawLegend,
  drawNotes,
  drawRoutes,
  EDGE_WIDTHS,
  findIssues,
  Grid,
  GROUP_LABEL_ALIGN,
  GROUP_LABEL_POS,
  GROUP_LABEL_WEIGHT,
  groupFrames,
  groupLabelRects,
  innerGroups,
  isColorToken,
  legendEntries,
  makePalette,
  measureNote,
  NODE_ICONS,
  NODE_SHAPES,
  OUTLINE_WIDTHS,
  resolveNotePositions,
  routeEdges,
  snapAlign,
  spreadBoxes,
} from "./diagram-core.js";
export { legendSwatchXs } from "./diagram-core.js";
import { SCHEMES } from "./themes.js";
import { fieldFn, flowPlace, flowSpine } from "./flow-field.js";

/**
 * Resolve the state-file path: explicit arg > DIAGRAM_STATE env > zero-config default.
 * Explicit/env paths resolve against the *current working directory* — NOT the tool
 * repo — so out-of-repo authoring works. The zero-config default prefers a
 * diagram-state.json in the cwd (the file `init` scaffolds, so init→render→CLI agree),
 * and otherwise falls back to the bundled example board (resolved against the repo, so
 * `render`/`serve` with no args render something regardless of where they're run).
 * (Env read is skipped gracefully when --allow-env wasn't granted.)
 */
export const EXAMPLE_STATE = "diagrams/example/diagram-state.json";

export function resolveStatePath(explicit) {
  let p = explicit;
  if (!p) {
    try {
      p = Deno.env.get("DIAGRAM_STATE") || undefined;
    } catch { /* no --allow-env — fall through to the default */ }
  }
  if (p) return resolve(Deno.cwd(), p);
  const cwdState = resolve(Deno.cwd(), "diagram-state.json");
  try {
    Deno.statSync(cwdState);
    return cwdState; // local diagram wins (out-of-repo authoring via `init`)
  } catch { /* none in cwd — use the bundled example board */ }
  return resolve(dirname(fromFileUrl(import.meta.url)), EXAMPLE_STATE);
}

/** Build the palette a state implies: theme (if any) + its custom overrides. */
export function paletteFromState(state) {
  const scheme = state.theme && SCHEMES[state.theme]
    ? SCHEMES[state.theme]
    : null;
  return makePalette(scheme ? deriveTheme(scheme) : null, state);
}

// ═══════════════════════════════════════════════════════════════
// FONTS
// ═══════════════════════════════════════════════════════════════
// Native Skia's built-in face lacks arrows/checks (→ ✓ ✗ ◀ render as tofu), so
// register the bundled DejaVu Sans Mono + Instrument Sans under the same
// DiagramMono/DiagramSans families the editor declares via @font-face. The font
// registry is global to the canvas module, so registering once covers every
// canvas (including the scratch ones used for text measurement — important:
// metrics and drawing must use the same font). Unlike the old WASM canvaskit,
// native Skia shapes proportional fonts correctly, so sans now measures the same
// here as in the browser. Falls back silently if assets are gone.
let _fontsLoaded = false;
// Fonts.register hands Skia a pointer into the Uint8Array without copying it,
// and Skia reads glyphs from that memory for the life of the process. Dropping
// the array let the garbage collector free it under Skia, so a render drew
// whatever then occupied it: missing letters, symbols from a fallback face,
// bold set in regular, a different PNG on every run. This array is the only
// thing keeping the font data alive. Never let it go out of scope.
const _fontBuffers = [];
function ensureFonts() {
  if (_fontsLoaded) return;
  _fontsLoaded = true; // attempt once per process either way
  try {
    const dir = join(dirname(fromFileUrl(import.meta.url)), "assets", "fonts");
    // Skia picks the weight from each file's own metadata, so regular + bold
    // register under one family alias.
    const reg = (file, family) => {
      const data = Deno.readFileSync(join(dir, file));
      _fontBuffers.push(data);
      Fonts.register(data, family);
    };
    reg("DejaVuSansMono.ttf", "DiagramMono");
    reg("DejaVuSansMono-Bold.ttf", "DiagramMono");
    // Sans option ("font": "sans"). SemiBold serves as bold — friendlier at the
    // 13px box-label size than the full 700 weight.
    reg("InstrumentSans-Regular.ttf", "DiagramSans");
    reg("InstrumentSans-SemiBold.ttf", "DiagramSans");
    // Compatibility for any older state/custom code that still names monospace.
    reg("DejaVuSansMono.ttf", "monospace");
    reg("DejaVuSansMono-Bold.ttf", "monospace");
  } catch (e) {
    console.warn(
      "font load failed (PNG falls back to built-in font):",
      e instanceof Error ? e.message : e,
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// DEFAULTS (overridable per-diagram via state JSON)
// ═══════════════════════════════════════════════════════════════
const DEFAULT_W = 1500;
const DEFAULT_H = 900;
const DEFAULT_DPR = 2;
const DEFAULT_MAX_DIM = 4096; // cap the PNG's longest *pixel* side; uniform downscale keeps vector content crisp

// ═══════════════════════════════════════════════════════════════
// CONCURRENCY ERRORS
// ═══════════════════════════════════════════════════════════════
// Thrown when the on-disk rev advanced since this Diagram was loaded
// (someone else wrote). Caught by withRetry to reload + re-apply.
export class RevConflict extends Error {}
// Thrown when the write lock couldn't be acquired in time. Also retried.
export class LockBusy extends Error {}

const LOCK_STALE_MS = 5000;

// ═══════════════════════════════════════════════════════════════
// CANVAS ANCHORS
// ═══════════════════════════════════════════════════════════════
// Where existing content sticks when the board is resized, as the fraction of
// the size delta absorbed on the leading (left / top) side. 0 = that edge holds
// still and the board grows away from it; 1 = the opposite edge holds still and
// content slides to follow; 0.5 = re-centered.
//
// An explicit table rather than substring tests on the code: "center" contains
// both "e" and "n", so an `includes`-based decoder silently read it as a
// north-east anchor. Exported so the CLI can list the valid tokens.
export const ANCHOR_FRACTIONS = {
  nw: { x: 0, y: 0 },
  n: { x: 0.5, y: 0 },
  ne: { x: 1, y: 0 },
  w: { x: 0, y: 0.5 },
  c: { x: 0.5, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  e: { x: 1, y: 0.5 },
  sw: { x: 0, y: 1 },
  s: { x: 0.5, y: 1 },
  se: { x: 1, y: 1 },
};

// Block the current thread for `ms` without busy-spinning (used only on the
// rare lock-contention path). Atomics.wait is available in Deno's main thread.
// Columns a node fills: a positive integer sets it, 0 or null clears it.
function setSpan(node, span) {
  if (span === null || span === 0) {
    delete node.span;
    return;
  }
  if (!Number.isInteger(span) || span < 1) {
    throw new Error(
      `span must be a whole number of columns >= 1, got "${span}"`,
    );
  }
  node.span = span;
}

function requireHex(value, what) {
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value ?? "")) {
    throw new Error(`${what} must be a hex color like #c2410c, got "${value}"`);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeStaleLock(lockPath) {
  let st;
  try {
    st = Deno.statSync(lockPath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return true;
    throw e;
  }
  const mtime = st.mtime?.getTime();
  if (!mtime || Date.now() - mtime < LOCK_STALE_MS) return false;
  try {
    Deno.removeSync(lockPath);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return true;
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════
// STATE VALIDATION
// ═══════════════════════════════════════════════════════════════
/** A malformed diagram-state.json. Carries every problem found, not just the first. */
export class InvalidState extends Error {}

/**
 * Structural rules for groups listing groups (Stage 2 nesting): an annotation
 * group is never listed, a group has at most one inner parent, a node is in at
 * most one inner group, and inner groups form no cycle. Returns one message per
 * violation, naming the ids involved.
 */
export function groupNestingErrors(groups) {
  const errs = [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const isInner = (id) => byId.get(id)?.layout === "inner";
  for (const g of groups) {
    for (const id of g.nodes) {
      if (byId.has(id) && !isInner(id)) {
        errs.push(
          `group "${g.id}" lists annotation group "${id}"; only inner groups can be listed`,
        );
      }
    }
  }
  const inner = groups.filter((g) => g.layout === "inner");
  const listers = new Map();
  for (const g of inner) {
    for (const id of new Set(g.nodes)) {
      if (!listers.has(id)) listers.set(id, []);
      listers.get(id).push(`"${g.id}"`);
    }
  }
  for (const [id, gs] of listers) {
    if (gs.length < 2) continue;
    const names = gs.join(" and ");
    errs.push(
      byId.has(id)
        ? `group "${id}" is listed by inner groups ${names}; a group can have only one inner parent`
        : `node "${id}" is in inner groups ${names}; list it in its innermost group only`,
    );
  }
  const state = new Map(); // id -> "open" while on the walk, "done" after
  const walk = (g, path) => {
    state.set(g.id, "open");
    path.push(g.id);
    for (const id of g.nodes) {
      if (!isInner(id)) continue;
      if (state.get(id) === "open") {
        const loop = path.slice(path.indexOf(id));
        errs.push(`inner groups form a cycle: ${[...loop, id].join(" -> ")}`);
      } else if (!state.has(id)) walk(byId.get(id), path);
    }
    path.pop();
    state.set(g.id, "done");
  };
  for (const g of inner) if (!state.has(g.id)) walk(g, []);
  return errs;
}

/**
 * The `innerLayout` entries, as [groupId, id], filed under a group that is not
 * an inner group listing that id: layout ignores them and a write drops them.
 */
export function staleInnerPins(state) {
  const out = [];
  const lists = new Map();
  for (const g of state.groups || []) {
    if (g?.layout === "inner" && Array.isArray(g.nodes) && !lists.has(g.id)) {
      lists.set(g.id, g.nodes);
    }
  }
  const il = state.innerLayout;
  if (!il || typeof il !== "object") return out;
  for (const [gid, pins] of Object.entries(il)) {
    if (!pins || typeof pins !== "object") continue;
    for (const id of Object.keys(pins)) {
      if (!lists.get(gid)?.includes(id)) out.push([gid, id]);
    }
  }
  return out;
}

/**
 * Check a parsed state before it becomes a Diagram.
 *
 * The file is the source of truth and agents hand-edit it, so a bad field used
 * to surface either as an opaque TypeError ("this.edges is not iterable") or —
 * worse — as silent geometry corruption: a non-finite row/col flows through
 * computeLayout into `Math.max(MARGIN, NaN)` and the box lands nowhere in
 * particular, with every command still reporting success.
 *
 * Errors name the file and the offending id so one failed run self-corrects.
 * Reports ALL problems at once; a hand-edit typically breaks several fields.
 *
 * Deliberately NOT an error: an edge endpoint that doesn't resolve to a node.
 * That's a supported state (delete-node-keep-edges leaves free ends pinned by
 * fromPos/toPos), so it only warns.
 */
export function validateState(state, path = "diagram-state.json") {
  const errs = [];
  const at = (m) => errs.push(m);

  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new InvalidState(`${path}: expected a JSON object at the top level`);
  }
  for (const key of ["nodes", "edges"]) {
    if (!Array.isArray(state[key])) {
      at(
        `missing or non-array "${key}" (found ${
          state[key] === undefined ? "nothing" : typeof state[key]
        })`,
      );
    }
  }
  if (errs.length) {
    throw new InvalidState(`${path}:\n  - ${errs.join("\n  - ")}`);
  }

  const layout = (state.layout && typeof state.layout === "object")
    ? state.layout
    : {};
  const seen = new Set();
  for (const [i, n] of state.nodes.entries()) {
    if (!n || typeof n !== "object") {
      at(`nodes[${i}] is not an object`);
      continue;
    }
    if (typeof n.id !== "string" || n.id === "") {
      at(`nodes[${i}] needs a non-empty string "id"`);
      continue;
    }
    if (seen.has(n.id)) at(`duplicate node id "${n.id}"`);
    seen.add(n.id);
    // row/col are the authoring hints; a layout override supersedes them, so a
    // node is only under-specified when it has neither.
    const hasOverride = layout[n.id] != null;
    for (const k of ["row", "col"]) {
      if (n[k] === undefined) {
        if (!hasOverride) {
          at(
            `node "${n.id}" has no "${k}" and no layout override — it would be placed arbitrarily`,
          );
        }
      } else if (!Number.isFinite(n[k])) {
        at(`node "${n.id}" has a non-numeric "${k}" (${JSON.stringify(n[k])})`);
      }
    }
  }

  if (Array.isArray(state.groups)) {
    const groups = state.groups.filter((g) =>
      g && typeof g.id === "string" && Array.isArray(g.nodes)
    );
    for (const g of groups) {
      if (seen.has(g.id)) at(`id "${g.id}" is both a node and a group`);
    }
    for (const m of groupNestingErrors(groups)) at(m);
  }

  for (const [id, p] of Object.entries(layout)) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      at(`layout["${id}"] must be {x, y} numbers, got ${JSON.stringify(p)}`);
    }
  }
  if (state.innerLayout !== undefined) {
    const il = state.innerLayout;
    if (!il || typeof il !== "object" || Array.isArray(il)) {
      at(`innerLayout must be an object, got ${JSON.stringify(il)}`);
    } else {
      for (const [gid, pins] of Object.entries(il)) {
        if (!pins || typeof pins !== "object" || Array.isArray(pins)) {
          at(`innerLayout["${gid}"] must be an object of {x, y} pins`);
          continue;
        }
        for (const [id, p] of Object.entries(pins)) {
          if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
            at(
              `innerLayout["${gid}"]["${id}"] must be {x, y} numbers, got ${
                JSON.stringify(p)
              }`,
            );
          }
        }
      }
    }
  }
  if (state.noteLayout && typeof state.noteLayout === "object") {
    for (const [id, p] of Object.entries(state.noteLayout)) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        at(
          `noteLayout["${id}"] must be {x, y} numbers, got ${
            JSON.stringify(p)
          }`,
        );
      }
    }
  }

  for (const [i, e] of state.edges.entries()) {
    if (!e || typeof e !== "object") {
      at(`edges[${i}] is not an object`);
      continue;
    }
    if (typeof e.from !== "string" || typeof e.to !== "string") {
      at(`edges[${i}] needs string "from" and "to"`);
    }
  }

  for (const [i, d] of (state.dividers || []).entries()) {
    if (!d || (d.orient !== "h" && d.orient !== "v")) {
      at(`dividers[${i}].orient must be "h" or "v"`);
    } else if (!Number.isFinite(d.at)) {
      at(`dividers[${i}].at must be a number (pixels)`);
    }
  }

  for (const [i, nt] of (state.notes || []).entries()) {
    if (!nt || typeof nt !== "object") {
      at(`notes[${i}] is not an object`);
      continue;
    }
    const positioned = Number.isFinite(nt.x) && Number.isFinite(nt.y);
    if (!positioned && !nt.anchor) {
      at(`notes[${i}] needs numeric x/y or an anchor`);
    }
  }

  if (errs.length) {
    throw new InvalidState(`${path}:\n  - ${errs.join("\n  - ")}`);
  }

  // Warn-only: free endpoints are a feature, not corruption.
  const dangling = state.edges.filter((e) =>
    e && (!seen.has(e.from) || !seen.has(e.to))
  );
  if (dangling.length) {
    console.warn(
      `${path}: ${dangling.length} edge endpoint(s) reference no node — ` +
        `rendered as free ends if pinned by fromPos/toPos, otherwise hidden`,
    );
  }
  const stale = staleInnerPins(state);
  if (stale.length) {
    console.warn(
      `${path}: ignoring innerLayout pin(s) filed under a group that does ` +
        `not list them: ${
          stale.map(([g, id]) => `${g}/${id}`).join(", ")
        } — dropped on the next write`,
    );
  }
  return state;
}

// ═══════════════════════════════════════════════════════════════
// DIAGRAM CLASS
// ═══════════════════════════════════════════════════════════════
export class Diagram {
  constructor(state, stateDir, statePath) {
    this.statePath = statePath ??
      (stateDir ? join(stateDir, "diagram-state.json") : undefined);
    this._state = state;
    this.palette = paletteFromState(state);
    this.nodes = state.nodes;
    this.edges = state.edges;
    this.layout = state.layout || {}; // per-node absolute {x,y} overrides
    this.noteLayout = state.noteLayout || {}; // per-note absolute {x,y} overrides (GUI drags)
    this.rowY = state.rowY || {};
    // Assign stable ids to any legacy note lacking one (in-memory only; persisted
    // on the next real save, never written just to add ids). Collision-safe.
    {
      const seen = new Set(
        (state.notes || []).map((n) => n?.id).filter(Boolean),
      );
      let i = 0;
      for (const nt of state.notes || []) {
        if (!nt || nt.id) continue;
        let id;
        do {
          id = `note${i++}`;
        } while (seen.has(id));
        nt.id = id;
        seen.add(id);
      }
    }
    // Likewise backfill stable edge ids. Legacy diagrams have no duplicate
    // (from,to) pairs (the old uniqueness guard forbade them), so each edge
    // deterministically becomes `from~to` — stable across reloads. Parallel
    // edges (same pair) get `from~to~2`, `~3`… Materialized on the next save.
    for (const e of this.edges) {
      if (!e.id) e.id = this._freshEdgeId(e.from, e.to);
    }
    this.rev = state.rev ?? 0;
    this._loadedRev = state.rev ?? 0; // rev observed at load, for CAS
    this.stateDir = stateDir;
  }

  // Absolute PNG path this diagram renders to (state.output, default diagram.png).
  // The live server serves/watches/captures the same path.
  get outputPath() {
    return join(this.stateDir, this._state.output || "diagram.png");
  }

  // ─── Canvas dimensions (state-driven) ─────────────────────
  get _dims() {
    const W = this._state.width || DEFAULT_W;
    const H = this._state.height || DEFAULT_H;
    const DPR = this._state.dpr || DEFAULT_DPR;
    return {
      W,
      H,
      DPR,
      COLS: Math.floor(W / CELL),
      ROWS: Math.floor(H / CELL),
    };
  }

  // ─── Load / Save ───────────────────────────────────────────
  static load(path) {
    const resolvedPath = path ?? Diagram._defaultStatePath();
    const raw = Deno.readTextFileSync(resolvedPath);
    let state;
    try {
      state = JSON.parse(raw);
    } catch (e) {
      // Name the file — the CLI resolves the path from cwd/env/default, so a
      // bare "Unexpected token" leaves the caller guessing which file broke.
      throw new InvalidState(`${resolvedPath}: invalid JSON — ${e.message}`);
    }
    validateState(state, resolvedPath);
    return new Diagram(state, dirname(resolvedPath), resolvedPath);
  }

  // Cheap read of the on-disk rev without loading/parsing the whole diagram or
  // touching the global palette. Used for a stale-write pre-check. Missing file → 0.
  static diskRev(path) {
    const resolvedPath = path ?? Diagram._defaultStatePath();
    try {
      return JSON.parse(Deno.readTextFileSync(resolvedPath)).rev ?? 0;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return 0;
      throw e;
    }
  }

  /**
   * Persist state with optimistic concurrency:
   *   - a short-lived lockfile serializes cross-process writers (CLI vs dev-server),
   *   - a `rev` compare-and-swap rejects writes made against stale state,
   *   - the write is atomic (temp file + rename) so a crash can't corrupt the file.
   * Throws RevConflict / LockBusy — both are retryable via Diagram.withRetry.
   */
  save(path) {
    const resolvedPath = path ?? this.statePath ??
      join(this.stateDir, "diagram-state.json");
    const lockPath = resolvedPath + ".lock";
    const tmpPath = resolvedPath + ".tmp";

    // Acquire the lock (atomic create). Brief retries; give up → LockBusy (retried upstream).
    let lock = null;
    for (let i = 0; i < 10 && !lock; i++) {
      try {
        lock = Deno.openSync(lockPath, { createNew: true, write: true });
      } catch (e) {
        if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
        if (removeStaleLock(lockPath)) continue;
        sleepSync(15);
      }
    }
    if (!lock) throw new LockBusy(`Could not acquire ${lockPath}`);

    try {
      // Compare-and-swap on rev.
      let diskRev = this._loadedRev;
      try {
        diskRev = JSON.parse(Deno.readTextFileSync(resolvedPath)).rev ?? 0;
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e; // missing file → first write
      }
      if (diskRev !== this._loadedRev) {
        throw new RevConflict(
          `disk rev ${diskRev} !== loaded rev ${this._loadedRev}`,
        );
      }

      const nextRev = this._loadedRev + 1;
      this._pruneInnerLayout();
      const state = {
        ...this._state,
        nodes: this.nodes,
        edges: this.edges,
        layout: this.layout,
        noteLayout: this.noteLayout,
        rowY: this.rowY,
        rev: nextRev,
      };
      Deno.writeTextFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n");
      Deno.renameSync(tmpPath, resolvedPath); // atomic
      this._state = state;
      this.rev = nextRev;
      this._loadedRev = nextRev;
    } finally {
      lock.close();
      try {
        Deno.removeSync(lockPath);
      } catch { /* already gone */ }
    }
  }

  /**
   * Load → apply op → save, retrying on RevConflict/LockBusy by reloading fresh
   * state and re-applying the op. opFn receives the freshly-loaded Diagram.
   * Returns the Diagram that successfully saved.
   */
  static withRetry(path, opFn, { tries = 5 } = {}) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      const d = Diagram.load(path);
      opFn(d);
      try {
        d.save(path);
        return d;
      } catch (e) {
        if (e instanceof RevConflict || e instanceof LockBusy) {
          lastErr = e;
          continue;
        }
        throw e; // domain errors (not found / already exists) propagate immediately
      }
    }
    throw new RevConflict(
      `withRetry exhausted after ${tries} attempts: ${lastErr?.message ?? ""}`,
    );
  }

  static _defaultStatePath() {
    return resolveStatePath();
  }

  // ─── Node operations ──────────────────────────────────────
  addNode(id, opts) {
    if (this.nodes.find((n) => n.id === id)) {
      throw new Error(`Node "${id}" already exists`);
    }
    if ((this._state.groups || []).some((g) => g.id === id)) {
      throw new Error(`id "${id}" is already a group`);
    }
    this._validateColor(opts.color);
    const node = {
      id,
      label: opts.label,
      color: opts.color,
      details: opts.details || [],
      row: opts.row,
      col: opts.col,
    };
    if (opts.minW) node.minW = opts.minW;
    if (opts.span !== undefined) setSpan(node, opts.span);
    this.nodes.push(node);
    try {
      this._applyNodeLook(node, opts);
    } catch (e) {
      this.nodes.pop();
      throw e;
    }
  }

  // Idempotent: returns false if the node was already gone (retry-safe under
  // concurrent writers — "remove" means "ensure absent"). Returns true if removed.
  // keepEdges leaves connectors touching this node in place. orphanPos {x,y}
  // pins each now-dangling end to a position so it renders as a draggable free
  // end (the deleted node's last centre); without it the orphan is unroutable
  // and hidden. Default (no keepEdges) cascades the edges out.
  removeNode(id, { keepEdges = false, orphanPos = null } = {}) {
    const idx = this.nodes.findIndex((n) => n.id === id);
    if (idx === -1) return false;
    this.nodes.splice(idx, 1);
    if (!keepEdges) {
      this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
    } else if (
      orphanPos && Number.isFinite(orphanPos.x) && Number.isFinite(orphanPos.y)
    ) {
      // Fan the dangling ends out diagonally so several don't land exactly on
      // top of each other (each stays individually grabbable in the editor).
      let k = 0;
      for (const e of this.edges) {
        const off = k * 2 * CELL;
        if (e.from === id) {
          e.fromPos = { x: orphanPos.x + off, y: orphanPos.y + off };
          k++;
        }
        if (e.to === id) {
          e.toPos = { x: orphanPos.x + off, y: orphanPos.y + off };
          k++;
        }
      }
    }
    delete this.layout[id];
    this._dropInnerPins([id]);
    if (Array.isArray(this._state.pinned)) {
      this._state.pinned = this._state.pinned.filter((p) => p !== id);
    }
    for (const g of this._state.groups || []) {
      if (Array.isArray(g.nodes)) g.nodes = g.nodes.filter((n) => n !== id);
    }
    return true;
  }

  updateNode(id, opts) {
    const node = this.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Node "${id}" not found`);
    if (opts.color !== undefined) {
      this._validateColor(opts.color);
      node.color = opts.color;
    }
    if (opts.label !== undefined) node.label = opts.label;
    if (opts.details !== undefined) node.details = opts.details;
    if (opts.row !== undefined) node.row = opts.row;
    if (opts.col !== undefined) node.col = opts.col;
    if (opts.minW !== undefined) { // 0/null clears the emphasis floor
      if (opts.minW) node.minW = opts.minW;
      else delete node.minW;
    }
    if (opts.span !== undefined) setSpan(node, opts.span);
    // Explicit size in *cells* (from a drag-resize). 0 clears → back to auto;
    // a positive count sets the target (computeLayout still clamps up to content
    // so a shrunk box can't clip). Reject garbage so an agent's bad value errors
    // instead of silently wiping the size.
    for (const dim of ["w", "h"]) {
      if (opts[dim] === undefined) continue;
      const n = Number(opts[dim]);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(
          `${dim} must be a non-negative cell count, got "${opts[dim]}"`,
        );
      }
      if (n > 0) node[dim] = Math.round(n);
      else delete node[dim];
    }
    this._applyNodeLook(node, opts);
    // Box style axes: a token sets it, null clears it (back to the board-wide
    // default, else medium solid round).
    this._applyBoxStyle(node, opts);
  }

  // A node's shape, icon and frame. Each takes its default name or null to
  // clear: shape "box", icon "none", frame "box". Validates all three before
  // writing any.
  _applyNodeLook(node, opts) {
    const axes = [
      ["shape", NODE_SHAPES, "box"],
      ["icon", NODE_ICONS, "none"],
      ["frame", { none: true }, "box"],
    ];
    for (const [key, table, dflt] of axes) {
      const v = opts[key];
      if (v == null || v === dflt) continue;
      this._validateEnum(v, table, key);
    }
    for (const [key, , dflt] of axes) {
      const v = opts[key];
      if (v === undefined) continue;
      if (v === null || v === dflt) delete node[key];
      else node[key] = v;
    }
  }

  // Set or clear (null) each box-style token present in `opts` on `target`
  // (a node, or the state for the board-wide defaults). Validates all three
  // before writing any, so a bad token leaves `target` unchanged.
  _applyBoxStyle(target, opts) {
    const axes = [
      ["outlineWidth", OUTLINE_WIDTHS],
      ["outlineDash", DASH_TOKENS],
      ["corners", CORNER_RADII],
    ];
    for (const [key, map] of axes) {
      if (opts[key] != null) this._validateEnum(opts[key], map, key);
    }
    for (const [key] of axes) {
      if (opts[key] === undefined) continue;
      if (opts[key] === null) delete target[key];
      else target[key] = opts[key];
    }
  }

  moveNode(id, row, col) {
    const node = this.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Node "${id}" not found`);
    node.row = row;
    node.col = col;
  }

  // Release a node or group back to automatic placement: drop its layout
  // override or its pin in its parent group (and unpin it). Without this, a
  // frozen layout[id] shadows row/col — so after the editor's full-snapshot
  // freezes the board, an agent's moveNode is a no-op until the node is freed.
  // Returns whether it had an override to remove.
  freeNode(id) {
    if (
      !this.nodes.some((n) => n.id === id) &&
      !(this._state.groups || []).some((g) => g.id === id)
    ) {
      throw new Error(`No node or group "${id}"`);
    }
    const relative = this._dropInnerPins([id]);
    const had = Object.hasOwn(this.layout, id) || relative;
    delete this.layout[id];
    if (Array.isArray(this._state.pinned)) {
      this._state.pinned = this._state.pinned.filter((p) => p !== id);
    }
    return had;
  }

  // ─── Edge operations ──────────────────────────────────────
  // Stable unique edge id. `from~to` for the first edge of a pair; `from~to~2`,
  // `~3`… for parallel edges between the same pair. Decoupled from from/to so it
  // survives reverse/retarget (the id stays put while the endpoints move).
  _freshEdgeId(from, to) {
    const taken = new Set(this.edges.map((e) => e.id).filter(Boolean));
    const base = `${from}~${to}`;
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}~${n}`)) n++;
    return `${base}~${n}`;
  }

  // Locate an edge: by id when given (the only unambiguous handle for parallel
  // edges), else by (from,to) first-match (legacy/CLI convenience).
  _locateEdge(from, to, id) {
    return id != null
      ? this.edges.find((e) => e.id === id)
      : this.edges.find((e) => e.from === from && e.to === to);
  }

  // Parallel edges between the same (from,to) pair are allowed — they land on
  // distinct connector slots. Each edge carries a unique `id`. A caller may pass
  // an explicit id (the editor pre-generates one so its follow-up update can
  // target the new edge); a taken id is suffixed to stay unique. Returns the edge.
  addEdge(from, to, style, label, id) {
    if (!this.nodes.find((n) => n.id === from)) {
      throw new Error(`Node "${from}" not found`);
    }
    if (!this.nodes.find((n) => n.id === to)) {
      throw new Error(`Node "${to}" not found`);
    }
    this._validateStyle(style);
    const edge = {
      id: (id != null && !this.edges.some((e) => e.id === id))
        ? id
        : this._freshEdgeId(from, to),
      from,
      to,
      style,
    };
    if (label) edge.label = label;
    this.edges.push(edge);
    return edge;
  }

  // Idempotent (retry-safe): false if the edge was already gone, true if removed.
  removeEdge(from, to, id) {
    const edge = this._locateEdge(from, to, id);
    if (!edge) return false;
    this.edges.splice(this.edges.indexOf(edge), 1);
    return true;
  }

  updateEdge(from, to, opts, id) {
    const edge = this._locateEdge(from, to, id);
    if (!edge) throw new Error(`Edge "${id ?? from + " -> " + to}" not found`);
    if (opts.style !== undefined) {
      this._validateStyle(opts.style);
      edge.style = opts.style;
    }
    if (opts.label !== undefined) edge.label = opts.label;
    // Independent styling axes over the named `style` base: a token sets the
    // override, null clears it (back to whatever `style` provides for that axis).
    if (opts.width !== undefined) {
      if (opts.width === null) delete edge.width;
      else {
        this._validateEnum(opts.width, EDGE_WIDTHS, "width");
        edge.width = opts.width;
      }
    }
    if (opts.dash !== undefined) {
      if (opts.dash === null) delete edge.dash;
      else {
        this._validateEnum(opts.dash, DASH_TOKENS, "dash");
        edge.dash = opts.dash;
      }
    }
    if (opts.color !== undefined) {
      if (opts.color === null) delete edge.color;
      else {
        this._validateColor(opts.color);
        edge.color = opts.color;
      }
    }
    // Pins: a value sets it, null clears it (spread → back to auto distribution).
    for (const k of ["fromEdge", "toEdge", "fromConn", "toConn"]) {
      if (opts[k] === undefined) continue;
      if (opts[k] === null) delete edge[k];
      else edge[k] = opts[k];
    }
    // Free-endpoint position: {x,y} pins an end loose (the router draws it as a
    // draggable handle); null clears it (back to its from/to box binding).
    for (const k of ["fromPos", "toPos"]) {
      if (opts[k] === undefined) continue;
      if (opts[k] === null) delete edge[k];
      else if (
        opts[k] && Number.isFinite(opts[k].x) && Number.isFinite(opts[k].y)
      ) edge[k] = { x: opts[k].x, y: opts[k].y };
    }
    // Label placement: { side, offset, seg }. side "auto" (or null) clears to the
    // default longest-segment placement with collision avoidance.
    if (opts.labelPos !== undefined) {
      if (opts.labelPos === null) delete edge.labelPos;
      else {
        const lp = {};
        const side = opts.labelPos.side;
        if (["above", "below", "left", "right"].includes(side)) lp.side = side;
        if (Number.isFinite(opts.labelPos.offset)) {
          lp.offset = opts.labelPos.offset;
        }
        if (Number.isInteger(opts.labelPos.seg)) lp.seg = opts.labelPos.seg;
        if (Object.keys(lp).length) edge.labelPos = lp;
        else delete edge.labelPos;
      }
    }
    // Per-edge routing-cost overrides: merge known numeric keys; null clears all.
    if (opts.costs !== undefined) {
      if (opts.costs === null) delete edge.costs;
      else {
        const next = { ...edge.costs };
        for (const k of Object.keys(DEFAULT_COSTS)) {
          if (Number.isFinite(opts.costs?.[k])) next[k] = opts.costs[k];
        }
        if (Object.keys(next).length) edge.costs = next;
        else delete edge.costs;
      }
    }
  }

  // Flip an edge's direction in place, preserving style/label and swapping the
  // per-end pins pairwise. Atomic on purpose: a remove+add pair could be torn
  // by a concurrent writer, leaving the edge gone; this mutates the one record.
  reverseEdge(from, to, id) {
    const edge = this._locateEdge(from, to, id);
    if (!edge) throw new Error(`Edge "${id ?? from + " -> " + to}" not found`);
    // Swap the edge's own endpoints (id-located edges may not match the from/to
    // params). Parallel edges are allowed, so no reverse-direction dup guard.
    [edge.from, edge.to] = [edge.to, edge.from];
    [edge.fromEdge, edge.toEdge] = [edge.toEdge, edge.fromEdge];
    [edge.fromConn, edge.toConn] = [edge.toConn, edge.fromConn];
    for (const k of ["fromEdge", "toEdge", "fromConn", "toConn"]) {
      if (edge[k] === undefined) delete edge[k]; // keep the JSON clean
    }
  }

  // Move one (or both) endpoints of an edge to different nodes, in place —
  // preserving style/label/width/dash/color/costs/labelPos. Atomic like
  // reverseEdge: a remove+add pair could be torn by a concurrent writer,
  // leaving the edge gone. Clears the *moved* end's side/connector pins (they
  // named the old box's geometry) and guards self-loops + duplicates.
  retargetEdge(from, to, newFrom, newTo, id) {
    const edge = this._locateEdge(from, to, id);
    if (!edge) throw new Error(`Edge "${id ?? from + " -> " + to}" not found`);
    // Work from the edge's own current endpoints (an id-located edge may not
    // match the from/to params). A nullish new endpoint means "keep this end" —
    // lets `--id` callers move just one end without naming the other.
    const curFrom = edge.from, curTo = edge.to;
    newFrom = newFrom ?? curFrom;
    newTo = newTo ?? curTo;
    // Only the *changing* end must resolve to a real node. The unchanged end may
    // legitimately reference a missing node — that's a free endpoint (pinned by
    // fromPos/toPos), e.g. reconnecting one side of a fully-disconnected wire.
    if (newFrom !== curFrom && !this.nodes.find((n) => n.id === newFrom)) {
      throw new Error(`Node "${newFrom}" not found`);
    }
    if (newTo !== curTo && !this.nodes.find((n) => n.id === newTo)) {
      throw new Error(`Node "${newTo}" not found`);
    }
    if (newFrom === newTo) {
      throw new Error(`Edge cannot connect "${newFrom}" to itself`);
    }
    // No duplicate guard: parallel edges between the same pair are allowed.
    // Reconnecting an end clears its free-position pin (fromPos/toPos) so it
    // binds to the box again instead of staying loose.
    if (newFrom !== curFrom) {
      edge.from = newFrom;
      delete edge.fromEdge;
      delete edge.fromConn;
      delete edge.fromPos;
    }
    if (newTo !== curTo) {
      edge.to = newTo;
      delete edge.toEdge;
      delete edge.toConn;
      delete edge.toPos;
    }
  }

  // ─── Query ────────────────────────────────────────────────
  getNode(id) {
    return this.nodes.find((n) => n.id === id);
  }
  getEdge(from, to, id) {
    return this._locateEdge(from, to, id);
  }
  listNodes() {
    return [...this.nodes];
  }
  listEdges() {
    return [...this.edges];
  }

  // ─── Validation (against THIS diagram's palette — custom colors count) ──
  // A color token is either a named palette color (red) or a semantic alias
  // (error → red); both are accepted, the message teaches the full set.
  _validateColor(color) {
    const named = this.palette.colors[color];
    const semantic = this.palette.semantic && this.palette.semantic[color];
    if (!named && !semantic) {
      const names = Object.keys(this.palette.colors).join(", ");
      const sems = Object.keys(this.palette.semantic || {}).join(", ");
      throw new Error(
        `Invalid color "${color}". Must be a named color (${names}) or a semantic token (${sems})`,
      );
    }
  }

  _validateStyle(style) {
    if (!this.palette.edgeStyles[style]) {
      throw new Error(
        `Invalid style "${style}". Must be one of: ${
          Object.keys(this.palette.edgeStyles).join(", ")
        }`,
      );
    }
  }

  // Enum-token validator for the width/dash axes. `map` is the token→value table
  // from diagram-core (EDGE_WIDTHS / OUTLINE_WIDTHS / DASH_TOKENS); its keys are
  // the valid tokens, listed in the error so one failed call self-corrects.
  _validateEnum(val, map, name) {
    if (!Object.prototype.hasOwnProperty.call(map, val)) {
      throw new Error(
        `Invalid ${name} "${val}". Must be one of: ${
          Object.keys(map).join(", ")
        }`,
      );
    }
  }

  // ─── Layout overrides ─────────────────────────────────────
  // Merge a {id: {x,y}} map into the per-node overrides (used by POST /layout).
  // Commutative with content edits — only touches `layout`.
  // Drop the layout overrides for `ids`, returning those boxes to auto-layout.
  // Pins are left to setPinned, which the editor sends alongside.
  // A relative pin is released with it, from its parent group's entry.
  releaseLayout(ids) {
    for (const id of ids || []) delete this.layout[id];
    this._dropInnerPins(ids || []);
  }

  // Accepts nodes outside every inner group and root inner group ids; an inner
  // group places its members, so their ids are dropped.
  mergeLayout(map) {
    const inner = innerGroups(this._state.groups, this.nodes);
    const member = new Set(inner.flatMap((g) => [...g.members, ...g.children]));
    const roots = new Set(
      inner.filter((g) => g.parent === null).map((g) => g.id),
    );
    for (const [id, pos] of Object.entries(map || {})) {
      const placeable = roots.has(id) ||
        (!member.has(id) && this.nodes.some((n) => n.id === id));
      if (
        placeable && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)
      ) {
        this.layout[id] = { x: pos.x, y: pos.y };
      }
    }
  }

  // Merge {groupId: {id: {x, y}}} relative pins: px from the group's content
  // origin, clamped to x, y >= 0. Ids that are not a direct member (node or
  // child group) of the inner group they are filed under are dropped.
  mergeInnerLayout(map) {
    const groups = this._state.groups || [];
    for (const [gid, pins] of Object.entries(map || {})) {
      const g = groups.find((o) => o.id === gid && o.layout === "inner");
      if (!g || !pins || typeof pins !== "object") continue;
      for (const [id, pos] of Object.entries(pins)) {
        if (
          !g.nodes.includes(id) || !pos || !Number.isFinite(pos.x) ||
          !Number.isFinite(pos.y)
        ) continue;
        const il = this._state.innerLayout ||= {};
        (il[gid] ||= {})[id] = { x: Math.max(0, pos.x), y: Math.max(0, pos.y) };
      }
    }
  }

  // Drop each id's relative pin, wherever it is filed. Returns whether any was.
  _dropInnerPins(ids) {
    const il = this._state.innerLayout;
    if (!il || typeof il !== "object") return false;
    let had = false;
    for (const [gid, pins] of Object.entries(il)) {
      for (const id of ids) {
        if (pins && Object.hasOwn(pins, id)) {
          delete pins[id];
          had = true;
        }
      }
      if (!pins || Object.keys(pins).length === 0) delete il[gid];
    }
    if (Object.keys(il).length === 0) delete this._state.innerLayout;
    return had;
  }

  _pruneInnerLayout() {
    for (const [gid, id] of staleInnerPins(this._state)) {
      delete this._state.innerLayout[gid][id];
    }
    const il = this._state.innerLayout;
    if (!il || typeof il !== "object") return;
    for (const [gid, pins] of Object.entries(il)) {
      if (!pins || Object.keys(pins).length === 0) delete il[gid];
    }
    if (Object.keys(il).length === 0) delete this._state.innerLayout;
  }

  // Bake grid-space box positions into pixel overrides. Positions stay integer
  // (col/row are integral), so col*CELL round-trips exactly through computeLayout.
  persistGridBoxes(boxes) {
    for (const b of boxes) {
      this.layout[b.id] = { x: b.col * CELL, y: b.row * CELL };
    }
  }

  // Set the color scheme (persisted as a top-level `theme` field).
  // null drops it back to the built-in palette.
  setTheme(name) {
    if (name == null) {
      delete this._state.theme;
      this.palette = paletteFromState(this._state);
      return;
    }
    if (!Object.hasOwn(SCHEMES, name)) {
      throw new Error(
        `Unknown theme "${name}". Available: ${
          Object.keys(SCHEMES).join(", ")
        }`,
      );
    }
    this._state.theme = name;
    this.palette = paletteFromState(this._state);
  }

  // Define or override a node color: `name` becomes valid for add-node/--color
  // and the legend, and wins over the theme. null bg removes the entry.
  setColor(name, bg, border) {
    if (!name) throw new Error("setColor requires a color name");
    if (bg == null) {
      if (this._state.colors) delete this._state.colors[name];
      if (this._state.colors && !Object.keys(this._state.colors).length) {
        delete this._state.colors;
      }
    } else {
      requireHex(bg, "background");
      requireHex(border, "border");
      this._state.colors = { ...this._state.colors, [name]: { bg, border } };
    }
    this.palette = paletteFromState(this._state);
  }

  // Define or override a named edge style (the `style` an edge is added with).
  // null color removes the entry.
  setEdgePreset(name, color, dash = "solid") {
    if (!name) throw new Error("setEdgePreset requires a style name");
    if (color == null) {
      if (this._state.edgeStyles) delete this._state.edgeStyles[name];
      if (
        this._state.edgeStyles && !Object.keys(this._state.edgeStyles).length
      ) {
        delete this._state.edgeStyles;
      }
    } else {
      requireHex(color, "color");
      if (!Object.hasOwn(DASH_TOKENS, dash)) {
        throw new Error(
          `dash must be one of ${
            Object.keys(DASH_TOKENS).join(", ")
          }, got "${dash}"`,
        );
      }
      this._state.edgeStyles = {
        ...this._state.edgeStyles,
        [name]: { color, dash: DASH_TOKENS[dash] },
      };
    }
    this.palette = paletteFromState(this._state);
  }

  // Canvas background color; null returns to the theme's.
  setBackground(hex) {
    if (hex == null) delete this._state.background;
    else {
      requireHex(hex, "background");
      this._state.background = hex;
    }
    this.palette = paletteFromState(this._state);
  }

  // How much extra box area (x the smallest fit) a box may take to avoid
  // wrapping its text; null returns to the default.
  setWrapSlack(n) {
    if (n == null) delete this._state.wrapSlack;
    else if (!Number.isFinite(n) || n < 1) {
      throw new Error(`wrapSlack must be a number >= 1, got "${n}"`);
    } else this._state.wrapSlack = n;
  }

  // Space between rows in px (default 45, room for wires); null returns to
  // the default. Group frames still get their clearance on top.
  setRowGap(px) {
    if (px == null) delete this._state.rowGap;
    else if (!Number.isFinite(px) || px < 0) {
      throw new Error(`rowGap must be a number of px >= 0, got "${px}"`);
    } else this._state.rowGap = px;
  }

  // Whether each wire has a start marker (a dot at its source); off draws it
  // from the box edge. Stored only when off.
  setStartMarkers(on) {
    if (on) delete this._state.startMarkers;
    else this._state.startMarkers = false;
  }

  // Connector anchoring mode: "align" (overlap-band de-kinker, default) or
  // "center" (every auto connector fans symmetrically about the side center).
  // "align"/null are stored as the absent default to keep state minimal.
  setConnectorAnchor(mode) {
    if (mode != null && mode !== "align" && mode !== "center") {
      throw new Error(
        `connectorAnchor must be "align" or "center", got "${mode}"`,
      );
    }
    if (mode === "center") this._state.connectorAnchor = "center";
    else delete this._state.connectorAnchor;
  }

  // Which way the board reads: "down" (default) or "right". Sets the sides
  // an auto-routed wire takes between boxes that sit diagonally apart.
  setDirection(dir) {
    if (dir != null && dir !== "down" && dir !== "right") {
      throw new Error(`direction must be "down" or "right", got "${dir}"`);
    }
    if (dir === "right") this._state.direction = "right";
    else delete this._state.direction;
  }

  // Flow field (spike): a preset name, or "a>b". Steers wire sides and
  // routing; null clears it.
  setFlow(spec) {
    if (spec == null) {
      delete this._state.flow;
      return;
    }
    if (!fieldFn(spec)) throw new Error(`unknown flow field "${spec}"`);
    this._state.flow = spec;
  }

  // Pin every board-level node along one streamline of the board's flow
  // field: the longest edge chain along it, the rest beside their neighbours.
  // `frame` ({W, H} px) is the area the field spans; by default about twice
  // the boxes' area with their gaps, at 16:10. The canvas is fitted after.
  flowPlace({ gap = 45, field = this._state.flow, frame } = {}) {
    if (!fieldFn(field)) throw new Error("flow-place needs a flow field");
    const { positions } = this.solvePositions();
    const nodes = this.nodes.filter((n) => positions[n.id]);
    let { W, H } = frame ?? {};
    if (!frame) {
      const area = nodes.reduce(
        (a, n) => a + (positions[n.id].w + gap) * (positions[n.id].h + gap),
        0,
      ) * 2;
      W = Math.round(Math.sqrt(area * 1.6));
      H = Math.round(area / W);
    }
    const { spine, side } = flowSpine(nodes, this.edges);
    const dims = (id) => ({ id, w: positions[id].w, h: positions[id].h });
    const pins = flowPlace(
      spine.map(dims),
      side.map((s) => ({ ...dims(s.id), near: s.near })),
      field,
      W,
      H,
      { gap, cell: CELL },
    );
    for (const [id, p] of Object.entries(pins)) this.layout[id] = p;
    this.fitCanvasToContent();
    return spine;
  }

  // ─── Dividers (boundary lines) ────────────────────────────
  // Annotation-only h/v dotted lines that partition the canvas into regions.
  addDivider(orient, at, opts = {}) {
    if (orient !== "h" && orient !== "v") {
      throw new Error(`Divider orient must be "h" or "v", got "${orient}"`);
    }
    if (!Number.isFinite(at)) {
      throw new Error(
        `Divider position must be a number (pixels), got "${at}"`,
      );
    }
    const d = { orient, at };
    if (opts.label) d.label = opts.label;
    if (opts.color) d.color = opts.color;
    // Validate at the boundary so a typo fails here rather than rendering as
    // something unintended. Unlike addEdge/styleNode, which take tokens only,
    // a divider also accepts an explicit [on, off] pair — it is the one dash
    // that is a visual choice about a rule rather than a semantic style, so a
    // caller wanting a specific pattern has nowhere else to say it. Elements
    // are checked too: ["a","b"] would persist and draw a NaN dash.
    if (opts.dash) {
      if (Array.isArray(opts.dash)) {
        if (!opts.dash.every((n) => Number.isFinite(n))) {
          throw new Error(
            `Invalid dash ${
              JSON.stringify(opts.dash)
            }. Array form must be finite numbers, e.g. [2, 3]`,
          );
        }
      } else {
        this._validateEnum(opts.dash, DASH_TOKENS, "dash");
      }
      d.dash = opts.dash;
    }
    this._state.dividers = [...(this._state.dividers || []), d];
  }

  // Idempotent (retry-safe): false if no divider matched, true if removed.
  // Matches by orient+position (the natural key — labels are optional).
  removeDivider(orient, at) {
    const ds = this._state.dividers || [];
    const idx = ds.findIndex((d) => d.orient === orient && d.at === at);
    if (idx === -1) return false;
    ds.splice(idx, 1);
    return true;
  }

  listDividers() {
    return [...(this._state.dividers || [])];
  }

  // ─── Groups (labeled frames around sets of nodes) ──────────
  // Annotation only: see groupFrames in diagram-core.js.
  _groupNodes(ids, what) {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error(`${what} needs at least one node id`);
    }
    const known = (id) =>
      this.nodes.some((n) => n.id === id) ||
      (this._state.groups || []).some((g) => g.id === id);
    const missing = ids.filter((id) => !known(id));
    if (missing.length) {
      throw new Error(`${what}: no such node or group: ${missing.join(", ")}`);
    }
    return [...new Set(ids)];
  }

  // Set or clear (null) the label style fields in `opts` on `target`: a group
  // (keys labelPos, ...), or the state for board defaults (groupLabelPos, ...).
  // Validates every field before writing any.
  _applyGroupLabel(target, opts, prefix = "label") {
    const fields = [
      ["Pos", GROUP_LABEL_POS],
      ["Align", GROUP_LABEL_ALIGN],
      ["Weight", GROUP_LABEL_WEIGHT],
      ["Size", null],
    ];
    for (const [f, table] of fields) {
      const v = opts["label" + f];
      if (v == null) continue;
      if (table) this._validateEnum(v, table, "label" + f);
      else if (!(Number.isFinite(v) && v > 0 && v <= 200)) {
        throw new Error(
          `labelSize must be a number of px in 1-200, got "${v}"`,
        );
      }
    }
    for (const [f] of fields) {
      const v = opts["label" + f];
      if (v === undefined) continue;
      if (v === null) delete target[prefix + f];
      else target[prefix + f] = v;
    }
  }

  // Board-wide group label defaults; a group's own field wins.
  setGroupStyle(opts) {
    this._applyGroupLabel(this._state, opts, "groupLabel");
  }

  _groupStyle(g, opts) {
    this._applyGroupLabel(g, opts);
    if (opts.color !== undefined) {
      if (opts.color === null) delete g.color;
      else {
        this._validateColor(opts.color);
        g.color = opts.color;
      }
    }
    if (opts.dash !== undefined) {
      if (opts.dash === null) delete g.dash;
      else {
        this._validateEnum(opts.dash, DASH_TOKENS, "dash");
        g.dash = opts.dash;
      }
    }
    // Layout: "inner" lays the members out inside the group, which sits on the
    // parent board at its own row/col; "annotation" (stored as absent) frames
    // them where they land.
    if (opts.layout !== undefined) {
      if (opts.layout !== "inner" && opts.layout !== "annotation") {
        throw new Error(
          `group layout must be "inner" or "annotation", got "${opts.layout}"`,
        );
      }
      if (opts.layout === "inner") g.layout = "inner";
      else delete g.layout;
    }
    for (const k of ["row", "col"]) {
      if (opts[k] === undefined) continue;
      if (!Number.isInteger(opts[k])) {
        throw new Error(`group ${k} must be an integer, got "${opts[k]}"`);
      }
      g[k] = opts[k];
    }
    if (g.layout === "inner") {
      if (!Number.isInteger(g.row) || !Number.isInteger(g.col)) {
        throw new Error(
          `inner group "${g.id}" needs a row and col on the parent board`,
        );
      }
    }
  }

  // Throw if `groups` (the would-be groups array) breaks a nesting rule.
  _checkGroups(groups) {
    const errs = groupNestingErrors(groups);
    if (errs.length) throw new Error(errs.join("\n"));
  }

  // An inner group places its members now; their overrides, their pins in
  // any other group, and pin markers without a pin here would sit in the file
  // ignored.
  _claimMembers(g) {
    if (g.layout !== "inner") return;
    for (const id of g.nodes) delete this.layout[id];
    const il = this._state.innerLayout;
    for (const gid of Object.keys(il || {})) {
      if (gid === g.id) continue;
      for (const id of g.nodes) delete il[gid][id];
    }
    this._pruneInnerLayout();
    const own = this._state.innerLayout?.[g.id] ?? {};
    if (Array.isArray(this._state.pinned)) {
      this._state.pinned = this._state.pinned.filter((id) =>
        !g.nodes.includes(id) || Object.hasOwn(own, id)
      );
    }
  }

  // Drop group `gid`'s relative pins and pin markers for `ids`.
  _unpinFrom(gid, ids) {
    const pins = this._state.innerLayout?.[gid];
    if (pins) { for (const id of ids) delete pins[id]; }
    this._pruneInnerLayout();
    if (Array.isArray(this._state.pinned)) {
      this._state.pinned = this._state.pinned.filter((id) => !ids.includes(id));
    }
  }

  addGroup(id, label, nodes, opts = {}) {
    const groups = this._state.groups || [];
    if (!id) throw new Error("group id is required");
    if (groups.some((g) => g.id === id)) {
      throw new Error(`Group "${id}" already exists`);
    }
    if (this.nodes.some((n) => n.id === id)) {
      throw new Error(`id "${id}" is already a node`);
    }
    const g = { id, nodes: this._groupNodes(nodes, `group "${id}"`) };
    if (label) g.label = label;
    this._groupStyle(g, opts);
    this._checkGroups([...groups, g]);
    (this._state.groups ||= []).push(g);
    this._claimMembers(g);
  }

  // opts: label, color, dash (null clears each), nodes (replaces the set),
  // add / remove (arrays of ids, applied after nodes). Validates on a copy, so
  // a rejected update leaves the group as it was.
  updateGroup(id, opts = {}) {
    const groups = this._state.groups || [];
    const g = groups.find((g) => g.id === id);
    if (!g) throw new Error(`Group "${id}" not found`);
    const c = structuredClone(g);
    if (opts.label !== undefined) {
      if (opts.label) c.label = opts.label;
      else delete c.label;
    }
    let nodes = opts.nodes
      ? this._groupNodes(opts.nodes, `group "${id}"`)
      : c.nodes;
    if (opts.add) {
      nodes = [
        ...new Set([...nodes, ...this._groupNodes(opts.add, `group "${id}"`)]),
      ];
    }
    if (opts.remove) nodes = nodes.filter((n) => !opts.remove.includes(n));
    if (nodes.length === 0) {
      throw new Error(`group "${id}" would be empty; use remove-group`);
    }
    c.nodes = nodes;
    if (opts.rowGap === null) delete c.rowGap;
    else if (opts.rowGap !== undefined) {
      if (!Number.isFinite(opts.rowGap) || opts.rowGap < 0) {
        throw new Error(
          `rowGap must be a number of px >= 0, got "${opts.rowGap}"`,
        );
      }
      c.rowGap = opts.rowGap;
    }
    if (opts.span !== undefined) setSpan(c, opts.span);
    if (opts.layout === "annotation" && g.layout === "inner") {
      const parent = groups.find((o) =>
        o !== g && o.layout === "inner" && o.nodes.includes(id)
      );
      if (parent) {
        throw new Error(
          `group "${id}" is listed by inner group "${parent.id}"; remove it there first`,
        );
      }
      const kids = nodes.filter((n) =>
        groups.some((o) => o.id === n && o.layout === "inner")
      );
      if (kids.length) {
        throw new Error(
          `group "${id}" lists inner groups ${
            kids.map((k) => `"${k}"`).join(", ")
          }; remove them first`,
        );
      }
    }
    this._groupStyle(c, opts);
    this._checkGroups(groups.map((o) => o === g ? c : o));
    const removed = g.nodes.filter((n) => !c.nodes.includes(n));
    for (const k of Object.keys(g)) delete g[k];
    Object.assign(g, c);
    this._unpinFrom(id, removed);
    if (g.layout !== "inner") {
      // No longer laid out: its own box and members' pins mean nothing.
      delete this.layout[id];
      this._unpinFrom(id, g.nodes);
      if (this._state.innerLayout) delete this._state.innerLayout[id];
      this._pruneInnerLayout();
    }
    this._claimMembers(g);
  }

  // The inner group that lists group `id`, if any.
  groupParent(id) {
    return (this._state.groups || []).find((o) =>
      o.id !== id && o.layout === "inner" && o.nodes.includes(id)
    );
  }

  // Idempotent (retry-safe): false if no such group. A nested group's direct
  // members move into its parent at its position; any annotation group that
  // listed it drops the id.
  removeGroup(id) {
    const gs = this._state.groups || [];
    const idx = gs.findIndex((g) => g.id === id);
    if (idx === -1) return false;
    const [g] = gs.splice(idx, 1);
    if (g.layout === "inner") {
      delete this.layout[id];
      this._unpinFrom(id, g.nodes);
      this._dropInnerPins([id]);
      if (this._state.innerLayout) delete this._state.innerLayout[id];
      this._pruneInnerLayout();
      if (Array.isArray(this._state.pinned)) {
        this._state.pinned = this._state.pinned.filter((p) => p !== id);
      }
    }
    const parent = this.groupParent(id);
    if (parent) {
      const moved = g.nodes.filter((n) => !parent.nodes.includes(n));
      parent.nodes.splice(parent.nodes.indexOf(id), 1, ...moved);
    }
    for (const o of gs) {
      if (o !== parent) o.nodes = o.nodes.filter((n) => n !== id);
    }
    if (gs.length === 0) delete this._state.groups;
    return true;
  }

  listGroups() {
    return [...(this._state.groups || [])];
  }

  // ─── Notes (free-floating text annotations) ────────────────
  // Notes carry a stable `id` (synthesized for legacy notes at load) so a GUI
  // drag can pin them via `noteLayout[id]` and an `anchor` can ride a box —
  // mirroring how nodes use row/col + layout overrides.
  _freshNoteId() {
    const seen = new Set(
      (this._state.notes || []).map((n) => n?.id).filter(Boolean),
    );
    let i = 0, id;
    do {
      id = `note${i++}`;
    } while (seen.has(id));
    return id;
  }

  // Validate/normalize an anchor hint ({to, side, dx, dy}) against current nodes.
  _normAnchor(anchor) {
    if (!anchor || !anchor.to) {
      throw new Error("anchor needs a target node id (to)");
    }
    if (!this.nodes.some((n) => n.id === anchor.to)) {
      throw new Error(`anchor target "${anchor.to}" is not a node`);
    }
    const side = anchor.side ?? "E";
    if (!["N", "E", "S", "W"].includes(side)) {
      throw new Error(`anchor side must be N|E|S|W, got "${side}"`);
    }
    return {
      to: anchor.to,
      side,
      dx: Number(anchor.dx) || 0,
      dy: Number(anchor.dy) || 0,
    };
  }

  addNote(x, y, text, opts = {}) {
    const lines = (Array.isArray(text) ? text : [text]).filter((l) =>
      l != null && l !== ""
    );
    if (lines.length === 0 && !opts.title) {
      throw new Error("Note needs text (or a title)");
    }
    const nt = { id: opts.id || this._freshNoteId(), text: lines };
    // Absolute x/y are the fallback; required unless an anchor is given.
    if (opts.anchor) nt.anchor = this._normAnchor(opts.anchor);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      nt.x = x;
      nt.y = y;
    } else if (!nt.anchor) {
      throw new Error(
        "Note position must be numbers (pixels), or give an --anchor",
      );
    }
    if (opts.title) nt.title = opts.title;
    if (opts.color) nt.color = opts.color;
    this._state.notes = [...(this._state.notes || []), nt];
    return nt.id;
  }

  // Edit a note's content/anchor. `anchor: null` detaches; `text`/`title`/`color`
  // are replaced when provided (empty title/color clears).
  updateNote(id, fields = {}) {
    const nt = (this._state.notes || []).find((n) => n?.id === id);
    if (!nt) throw new Error(`No note "${id}"`);
    if (fields.text !== undefined) {
      nt.text = (Array.isArray(fields.text) ? fields.text : [fields.text])
        .filter((l) => l != null);
    }
    if (fields.title !== undefined) {
      if (fields.title) nt.title = fields.title;
      else delete nt.title;
    }
    if (fields.color !== undefined) {
      if (fields.color) nt.color = fields.color;
      else delete nt.color;
    }
    if (fields.anchor !== undefined) {
      if (fields.anchor) nt.anchor = this._normAnchor(fields.anchor);
      else delete nt.anchor;
    }
    return true;
  }

  // Idempotent (retry-safe). Accepts a note id (string) or legacy (x, y) match.
  removeNote(idOrX, y) {
    const ns = this._state.notes || [];
    const idx = typeof idOrX === "string"
      ? ns.findIndex((n) => n?.id === idOrX)
      : ns.findIndex((n) => n.x === idOrX && n.y === y);
    if (idx === -1) return false;
    const [removed] = ns.splice(idx, 1);
    if (removed?.id && this.noteLayout[removed.id]) {
      delete this.noteLayout[removed.id];
      this._state.noteLayout = this.noteLayout;
    }
    return true;
  }

  // Merge per-note absolute {x,y} overrides (what a GUI drag writes — the note's
  // pin). Mirrors mergeLayout; only ids of existing notes are accepted.
  mergeNoteLayout(map) {
    if (!map || typeof map !== "object") return;
    const valid = new Set(
      (this._state.notes || []).map((n) => n?.id).filter(Boolean),
    );
    for (const [id, p] of Object.entries(map)) {
      if (
        !valid.has(id) || !p || !Number.isFinite(p.x) || !Number.isFinite(p.y)
      ) continue;
      this.noteLayout[id] = { x: p.x, y: p.y };
    }
    this._state.noteLayout = this.noteLayout;
  }

  // Drop a note's drag override so it returns to its anchor (or absolute x/y).
  // The note's `free-node` analogue. Idempotent.
  freeNote(id) {
    if (!this.noteLayout[id]) return false;
    delete this.noteLayout[id];
    this._state.noteLayout = this.noteLayout;
    return true;
  }

  listNotes() {
    return [...(this._state.notes || [])];
  }

  // Toggle homogenized box widths (persisted as top-level `uniformWidth`).
  setUniformWidth(on) {
    this._state.uniformWidth = !!on;
  }

  // Set the typeface (persisted as top-level `font`: "mono" | "sans").
  setFont(font) {
    if (font !== "mono" && font !== "sans") {
      throw new Error(`Font must be "mono" or "sans", got "${font}"`);
    }
    this._state.font = font;
    this.palette = paletteFromState(this._state);
  }

  // Caption text drawn top-left. Pass null/"" to drop it.
  setTitle(text) {
    if (text == null || text === "") delete this._state.title;
    else this._state.title = String(text);
  }

  // Legend: null → auto-derived from the colors in use, false → hidden, or an
  // array of { color, label, dash? } where color is a palette name, semantic
  // token, or hex. Names are checked here so a typo fails instead of drawing
  // the fallback color.
  setLegend(entries) {
    if (entries == null) {
      delete this._state.legend;
      return;
    }
    if (entries === false) {
      this._state.legend = false;
      return;
    }
    if (!Array.isArray(entries)) {
      throw new Error("legend must be null, false, or an array of entries");
    }
    const pal = paletteFromState(this._state);
    this._state.legend = entries.map((e) => {
      if (!e || typeof e.label !== "string" || !e.label) {
        throw new Error("each legend entry needs a non-empty label");
      }
      if (!isColorToken(pal, e.color) && !/^#[0-9a-f]{3,8}$/i.test(e.color)) {
        throw new Error(
          `legend color "${e.color}" is not a palette color, semantic token, or hex. Palette: ${
            Object.keys(pal.colors).join(", ")
          }`,
        );
      }
      const out = { color: e.color, label: e.label };
      if (e.dash) {
        this._validateEnum(e.dash, DASH_TOKENS, "legend dash");
        out.dash = e.dash;
      }
      return out;
    });
  }

  // Caption line drawn under the legend. Pass null/"" to drop it.
  setFooter(text) {
    if (text == null || text === "") delete this._state.footer;
    else this._state.footer = String(text);
  }

  // Set the base font size (box-label px, default 13). Scales the whole size
  // table — boxes grow/shrink with their text. `null`/0 returns to the default.
  setFontSize(px) {
    if (px == null || px === 0) delete this._state.fontSize;
    else {
      const n = Number(px);
      if (!Number.isFinite(n) || n < 6 || n > 48) {
        throw new Error(`fontSize must be 6–48 px, got "${px}"`);
      }
      this._state.fontSize = n;
    }
    this.palette = paletteFromState(this._state);
  }

  // Board-wide box style defaults (top-level `outlineWidth`, `outlineDash`,
  // `corners`). A box without its own token takes these. Same shape as
  // updateNode's: a token sets the axis, null clears it, undefined leaves it.
  setBoxStyle(opts) {
    this._applyBoxStyle(this._state, opts);
  }

  // Board-wide edge width; an edge's own `width` wins. null clears it.
  setEdgeStyle(opts) {
    if (opts.width === undefined) return;
    if (opts.width === null) delete this._state.edgeWidth;
    else {
      this._validateEnum(opts.width, EDGE_WIDTHS, "width");
      this._state.edgeWidth = opts.width;
    }
  }

  // Board (export-frame) dimensions B. The editor's auto-grow and the canvas
  // resize ops persist B here; render()/_fitCanvas still treat it as a floor and
  // grow defensively, so a hand-shrunk board can never clip a box. Either arg may
  // be omitted to leave that dimension unchanged.
  setCanvasSize(w, h) {
    if (w != null) {
      const W = Math.round(Number(w));
      if (!Number.isFinite(W) || W <= 0) {
        throw new Error(`width must be > 0, got "${w}"`);
      }
      this._state.width = W;
    }
    if (h != null) {
      const H = Math.round(Number(h));
      if (!Number.isFinite(H) || H <= 0) {
        throw new Error(`height must be > 0, got "${h}"`);
      }
      this._state.height = H;
    }
  }

  // Set B to exactly w×h, Photoshop-style: `anchor` (a 9-point compass code like
  // nw|n|ne|e|se|s|sw|w|c — default nw) says where existing content sticks, which
  // determines whether/which way content shifts. nw grows right/down with no
  // movement; se grows left/up (content slides to follow); c re-centers.
  // `grow` keeps each side at least its current size, so it never shrinks.
  setCanvas(w, h, anchor = "nw", { grow = false } = {}) {
    const W0 = this._state.width || DEFAULT_W,
      H0 = this._state.height || DEFAULT_H;
    let newW = Math.round(Number(w)), newH = Math.round(Number(h));
    if (grow) {
      newW = Math.max(W0, newW);
      newH = Math.max(H0, newH);
    }
    const a = String(anchor).toLowerCase();
    const f = ANCHOR_FRACTIONS[a];
    if (!f) {
      throw new Error(
        `anchor must be one of: ${
          Object.keys(ANCHOR_FRACTIONS).join(", ")
        }, got "${anchor}"`,
      );
    }
    // Fraction of the size delta that lands on the leading (left/top) side.
    // Table lookup, NOT substring tests: "center" contains both "e" and "n", so
    // the old a.includes(…) form decoded it as east+north — a silent NE anchor.
    this._resizeCanvas(
      newW,
      newH,
      Math.round((newW - W0) * f.x),
      Math.round((newH - H0) * f.y),
    );
  }

  // Grow/shrink B by per-side pixel deltas (negative trims). Adding left/up space
  // slides content into it; right/down leave content put. The natural agent verb.
  expandCanvas({ left = 0, right = 0, up = 0, down = 0 } = {}) {
    const W0 = this._state.width || DEFAULT_W,
      H0 = this._state.height || DEFAULT_H;
    const L = Math.round(Number(left) || 0), R = Math.round(Number(right) || 0);
    const U = Math.round(Number(up) || 0), D = Math.round(Number(down) || 0);
    this._resizeCanvas(W0 + L + R, H0 + U + D, L, U);
  }

  // Grow (or, with negative deltas, shrink) B by dw×dh, split by `anchor` as in
  // setCanvas: nw adds it all right/down, c splits it evenly.
  expandCanvasBy(dw, dh, anchor = "nw") {
    const W0 = this._state.width || DEFAULT_W,
      H0 = this._state.height || DEFAULT_H;
    this.setCanvas(W0 + Math.round(dw), H0 + Math.round(dh), anchor);
  }

  // Shrink (or grow) B to hug the content: slide the diagram to a uniform margin,
  // then set B to the renderer's exact grid extent so frame == PNG. The one-click
  // "trim canvas". No-op on an empty board.
  // Fits the boxes plus notes and group frames, so trimming never clips an
  // annotation.
  fitCanvasToContent(margin = 40) {
    const sp = this.solvePositions();
    if (sp.content.w <= 0) return;
    const c = sp.extent;
    const sdx = Math.round((margin - c.x) / CELL) * CELL,
      sdy = Math.round((margin - c.y) / CELL) * CELL;
    const fit = boardExtentForContent({
      x: c.x + sdx,
      y: c.y + sdy,
      w: c.w,
      h: c.h,
    });
    this._resizeCanvas(Math.ceil(fit.W), Math.ceil(fit.H), sdx, sdy);
    // The renderer grows B to whole cells around the boxes; store what it will
    // draw, so the size reported here is the PNG's.
    const drawn = this.solvePositions().canvas;
    this._state.width = Math.max(this._state.width, drawn.width);
    this._state.height = Math.max(this._state.height, drawn.height);
  }

  // Grow B to a target rect (board px, e.g. the editor's visible viewport), clamped
  // so content stays fully enclosed with the renderer's margins — i.e. the frame can
  // only grow past content, never crop it. The "expand to extents" complement of
  // fitCanvasToContent. No-op on an empty board.
  fitCanvasToRect({ x, y, w, h }, margin = BOARD_MARGIN) {
    const c = this.solvePositions().content;
    if (c.w <= 0) return;
    let x0 = Math.min(x, c.x - margin), y0 = Math.min(y, c.y - margin);
    const x1 = Math.max(x + w, c.x + c.w + BOARD_MARGIN),
      y1 = Math.max(y + h, c.y + c.h + BOARD_MARGIN_BOTTOM);
    x0 = Math.floor(x0 / CELL) * CELL; // snap to whole cells (only ever enlarges)
    y0 = Math.floor(y0 / CELL) * CELL;
    const newW = Math.ceil((x1 - x0) / CELL) * CELL,
      newH = Math.ceil((y1 - y0) / CELL) * CELL;
    this._resizeCanvas(newW, newH, -x0, -y0);
  }

  // Core resize: shift all absolutely-positioned content by (dx,dy) and set B to
  // (newW,newH). Validates B ⊇ E (with the renderer's 40/50 margin) BEFORE
  // mutating, so a too-small/over-shifted resize throws instead of clipping.
  _resizeCanvas(newW, newH, dx, dy) {
    if (
      !Number.isFinite(newW) || !Number.isFinite(newH) || newW <= 0 || newH <= 0
    ) throw new Error("canvas dimensions must be positive");
    if (newW > 20000 || newH > 20000) {
      throw new Error("canvas dimensions capped at 20000");
    }
    const sp = this.solvePositions();
    const c = sp.content;
    if (c.w > 0) {
      const cx = c.x + dx, cy = c.y + dy;
      if (cx < 0 || cy < 0) {
        throw new Error(
          "resize would push content off the top/left — too small for that anchor",
        );
      }
      const min = boardExtentForContent({ x: cx, y: cy, w: c.w, h: c.h });
      if (min.W > newW || min.H > newH) {
        throw new Error(
          `canvas ${newW}x${newH} too small for content (needs ≥ ${
            Math.ceil(min.W)
          }x${Math.ceil(min.H)})`,
        );
      }
    }
    // Everything moves by exactly the snapped shift, so relative layout is
    // preserved. Positioned things (overrides, explicit row Ys, notes,
    // dividers) shift their own coordinates. Auto-placed boxes stay auto: they
    // follow through state.offset. Their x also depends on the canvas width
    // (the column block is centred), so the offset is measured, not predicted.
    // This used to write an override for every box, which froze the board.
    const sdx = Math.round(dx / CELL) * CELL,
      sdy = Math.round(dy / CELL) * CELL;
    const refId = Object.keys(sp.positions).find((id) => !this.layout[id]);
    for (const id of Object.keys(this.layout)) {
      this.layout[id] = {
        x: this.layout[id].x + sdx,
        y: this.layout[id].y + sdy,
      };
    }
    for (const k of Object.keys(this.rowY)) this.rowY[k] += sdy;
    for (const nt of this._state.notes || []) {
      if (!nt.anchor && Number.isFinite(nt.x) && Number.isFinite(nt.y)) {
        nt.x += sdx;
        nt.y += sdy;
      }
    }
    for (const id of Object.keys(this.noteLayout)) {
      this.noteLayout[id] = {
        x: this.noteLayout[id].x + sdx,
        y: this.noteLayout[id].y + sdy,
      };
    }
    for (const d of this._state.dividers || []) {
      d.at += d.orient === "h" ? sdy : sdx; // h sits at a Y, v at an X
    }
    this._state.width = newW;
    this._state.height = newH;
    if (refId) {
      const before = sp.positions[refId];
      const after = this.solvePositions().positions[refId];
      const off = this._state.offset ?? { x: 0, y: 0 };
      off.x += before.x + sdx - after.x;
      off.y += before.y + sdy - after.y;
      if (off.x || off.y) this._state.offset = off;
      else delete this._state.offset;
    }
  }

  // Merge routing-cost overrides (persisted as a top-level `costs` field) so the
  // PNG/CLI render reproduces what the editor's sliders were tuned to. Only known
  // numeric cost keys are accepted.
  setCosts(costs) {
    const next = { ...this._state.costs };
    for (const k of Object.keys(DEFAULT_COSTS)) {
      if (Number.isFinite(costs?.[k])) next[k] = costs[k];
    }
    this._state.costs = next;
  }

  // The subset of nodes the human manually placed (markers in the editor).
  // Editor-only metadata — does NOT affect layout (computeLayout keys off the
  // `layout` map, not this). Stale ids (nodes since removed) are dropped.
  setPinned(ids) {
    const valid = Array.isArray(ids)
      ? ids.filter((id) =>
        this.nodes.some((n) => n.id === id) ||
        (this._state.groups || []).some((g) =>
          g.id === id && g.layout === "inner"
        )
      )
      : [];
    this._state.pinned = [...new Set(valid)];
  }

  // ─── Snap-align ───────────────────────────────────────────
  snapAlign(axis) {
    const { W, H, DPR, COLS, ROWS } = this._dims;
    const canvas = createCanvas(W * DPR, H * DPR);
    ensureFonts();
    const ctx = canvas.getContext("2d");
    ctx.scale(DPR, DPR);
    const gridBoxes = this._computeGridBoxes(ctx);
    const changed = snapAlign(axis, gridBoxes, COLS, ROWS);
    if (changed) this.persistGridBoxes(gridBoxes); // bake the new arrangement
    console.log(
      changed
        ? `snap-align(${axis}): adjusted`
        : `snap-align(${axis}): no changes needed`,
    );
  }

  // ─── Force-directed spread ────────────────────────────────
  spreadBoxes() {
    const { W, H, DPR, COLS, ROWS } = this._dims;
    const canvas = createCanvas(W * DPR, H * DPR);
    ensureFonts();
    const ctx = canvas.getContext("2d");
    ctx.scale(DPR, DPR);
    const gridBoxes = this._computeGridBoxes(ctx);
    spreadBoxes(gridBoxes, this.edges, COLS, ROWS);
    this.persistGridBoxes(gridBoxes); // bake the new arrangement
    console.log("spreadBoxes: completed");
  }

  // ─── Compute grid boxes ───────────────────────────────────
  // The whole board state goes through, as the editor passes it. A hand-picked
  // subset silently dropped every layout setting nobody remembered to add:
  // maxNodeW and wrapSlack were honored by the editor and ignored here.
  _computeGridBoxes(ctx) {
    const { W } = this._dims;
    const state = {
      ...this._state,
      nodes: this.nodes,
      edges: this.edges,
      layout: this.layout,
      rowY: this.rowY,
    };
    return computeLayout(ctx, state, W);
  }

  // ─── Grow the canvas to encompass every box ───────────────
  // Boxes dragged beyond the authored width/height (the editor canvas is
  // larger) are thus never clipped. Shared by render() and solvePositions()
  // so the headless read-back reports the exact canvas the PNG would use.
  _fitCanvas(gridBoxes) {
    const { W: baseW, H: baseH } = this._dims;
    return boardExtent(gridBoxes, baseW, baseH);
  }

  // ─── Headless read-back of the solved layout ──────────────
  // Runs the same layout the renderer would, without writing a PNG. Lets agents
  // place notes/dividers against real pixel positions instead of guessing.
  // Returns { positions: {id:{x,y,w,h,col,row,pinned}}, content:{x,y,w,h}, canvas:{width,height} }.
  solvePositions() {
    const scratch = createCanvas(10, 10);
    ensureFonts(); // metrics must match drawing
    const gridBoxes = this._computeGridBoxes(scratch.getContext("2d"));
    const { W, H } = this._fitCanvas(gridBoxes);
    const pinned = new Set(
      Array.isArray(this._state.pinned) ? this._state.pinned : [],
    );

    const positions = {};
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of gridBoxes) {
      const x = b.col * CELL, y = b.row * CELL;
      // w/h are the *drawn* size — the box is painted `ceil(pixW / CELL)` cells
      // wide, up to a cell more than its content measures. Reporting pixW here
      // described a box narrower than the PNG contains, so agents placing notes
      // and dividers off this read-back were aiming at the wrong edge. The
      // content size is still available as pixW/pixH for callers that want it.
      const w = b.w * CELL, h = b.h * CELL;
      positions[b.id] = {
        x,
        y,
        w,
        h,
        pixW: b.pixW,
        pixH: b.pixH,
        col: b.col,
        row: b.row,
        pinned: pinned.has(b.id),
      };
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }
    // Members of an inner group are placed by it; say which. `members` is
    // direct members only, so this is the innermost group.
    const inner = innerGroups(this._state.groups, this.nodes);
    for (const g of inner) {
      for (const id of g.members) if (positions[id]) positions[id].group = g.id;
    }
    const innerParent = new Map(inner.map((g) => [g.id, g.parent]));
    const content = gridBoxes.length
      ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
      : { x: 0, y: 0, w: 0, h: 0 };
    // Resolved note positions (anchor/override applied) so agents can verify
    // annotation placement without rendering.
    // x/y are where drawNotes puts the first baseline; rect is the drawn text
    // block, for checking a note against the boxes above.
    const pal = paletteFromState(this._state);
    const sctx = scratch.getContext("2d");
    const measure = (n) => measureNote(sctx, n, pal);
    const notes = {};
    for (
      const r of resolveNotePositions(
        this._state.notes,
        this.noteLayout,
        gridBoxes,
        measure,
      )
    ) {
      const m = measure(r);
      notes[r.id ?? `${r.x},${r.y}`] = {
        x: r.x,
        y: r.y,
        rect: {
          x: Math.round(r.x),
          y: Math.round(r.y - m.ascent),
          w: Math.ceil(m.w),
          h: m.h,
        },
        anchored: !!(r.anchor && !this.noteLayout[r.id]),
      };
    }
    const groups = {};
    // Everything drawn on the board, annotations included: what fit-canvas
    // must keep on the canvas. `content` stays boxes-only.
    const drawn = gridBoxes.length ? [content] : [];
    for (const n of Object.values(notes)) drawn.push(n.rect);
    const frames = groupFrames(
      this._state.groups,
      gridBoxes,
      pal,
      this._state,
    );
    // A label wider than its frame overhangs it; keep the whole label on.
    for (const l of groupLabelRects(sctx, frames, pal)) {
      drawn.push({ x: l.x, y: l.y, w: l.w, h: l.h });
    }
    for (const f of frames) {
      groups[f.id] = {
        ...f.rect,
        members: f.members,
        intruders: f.intruders,
        layout: innerParent.has(f.id) ? "inner" : "annotation",
      };
      const parent = innerParent.get(f.id);
      if (parent) groups[f.id].parent = parent;
      drawn.push(f.labelled);
    }
    const extent = drawn.length
      ? (() => {
        const x0 = Math.min(...drawn.map((r) => r.x)),
          y0 = Math.min(...drawn.map((r) => r.y));
        return {
          x: x0,
          y: y0,
          w: Math.max(...drawn.map((r) => r.x + r.w)) - x0,
          h: Math.max(...drawn.map((r) => r.y + r.h)) - y0,
        };
      })()
      : { x: 0, y: 0, w: 0, h: 0 };
    return {
      positions,
      content,
      extent,
      canvas: { width: W, height: H },
      notes,
      groups,
    };
  }

  _legend() {
    return legendEntries(this._state, this.nodes, this.palette);
  }

  // ─── Render to PNG ────────────────────────────────────────
  render() {
    const { canvas, W, H, scale, DPR, maxDim, routes, frames } = this
      .renderToCanvas();

    // Write PNG
    const outPath = this.outputPath;
    const tmpPath = `${outPath}.${Deno.pid}.${crypto.randomUUID()}.tmp`;
    const buf = canvas.encode("png");
    try {
      Deno.writeFileSync(tmpPath, buf);
      Deno.renameSync(tmpPath, outPath);
    } finally {
      try {
        Deno.removeSync(tmpPath);
      } catch { /* already renamed or absent */ }
    }

    const failCount = routes.filter((r) => r.path === null).length;
    const capped = scale < DPR
      ? ` (capped @${DPR}x → ${maxDim}px)`
      : ` @${DPR}x`;
    console.log(
      `Wrote ${outPath} (${W}x${H}${capped}, ${canvas.width}x${canvas.height}px)` +
        (failCount > 0 ? ` — ${failCount} route failure(s)` : ""),
    );
    // Layout ignores groups, so a non-member can land inside a frame and read
    // as belonging to it. Say which, so the caller can move it.
    for (const f of frames) {
      if (f.intruders.length) {
        console.error(
          `warning: group "${f.id}" frame contains non-member(s): ${
            f.intruders.join(", ")
          } — move them out with row/col, or add them to the group.`,
        );
      }
    }
    // The cap is a uniform downscale, so a very wide board "succeeds" into an
    // unreadable PNG — a 15025px canvas lands at 654px tall. Say so on stderr:
    // the success line above mentions it only parenthetically, and a caller
    // watching for failure sees none.
    if (scale < DPR) {
      console.error(
        `warning: ${outPath} was downscaled to ${
          (scale / DPR * 100).toFixed(0)
        }% to fit the ${maxDim}px raster cap — text may be unreadable. ` +
          `The board is ${W}x${H}; narrow it (fewer nodes per row) or lower fontSize.`,
      );
    }
  }

  /**
   * Draw the diagram onto a canvas and hand back the canvas plus everything
   * needed to interpret its pixels — WITHOUT encoding or writing a PNG.
   *
   * Split out of render() so a caller can inspect what was actually rasterized
   * (see raster-check.js): the solved boxes tell you where each label and detail
   * line should be, and `scale` maps board pixels to device pixels. Reading the
   * real canvas beats decoding the PNG back, and beats reimplementing the draw
   * order in a test where it would silently drift.
   *
   * render() is now this plus encode-and-write, so the two can never disagree.
   */
  // shadows: true re-enables the box drop shadow, i.e. reproduces the shadowBlur
  // displacement fault. Exists solely for the canary test — production callers
  // must leave it off. See docs/project_notes/upstream-defects.md.
  renderToCanvas({ shadows = false } = {}) {
    const pal = this.palette = paletteFromState(this._state); // pick up any state mutations
    const { DPR } = this._dims;

    // Compute layout first (scratch context for text measurement), then grow the
    // canvas to encompass every box. Boxes dragged beyond the authored
    // width/height (the editor canvas is larger) are thus never clipped.
    const scratch = createCanvas(10, 10);
    ensureFonts(); // before any measureText — metrics must match drawing
    const gridBoxes = this._computeGridBoxes(scratch.getContext("2d"));
    const { W, H, COLS, ROWS } = this._fitCanvas(gridBoxes);

    // Cap the PNG's longest *pixel* side — a deliberately large board (now that B
    // is settable) would otherwise produce an enormous file. Uniform downscale;
    // vector content renders crisp at the reduced scale rather than shrinking a
    // finished bitmap. Logical W×H (the frame) is unchanged — this only affects
    // output resolution.
    const maxDim = this._state.maxDim || DEFAULT_MAX_DIM;
    let scale = DPR;
    const longestPx = Math.max(W, H) * scale;
    if (longestPx > maxDim) scale *= maxDim / longestPx;

    const canvas = createCanvas(Math.round(W * scale), Math.round(H * scale));
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    // Background
    ctx.fillStyle = pal.background;
    ctx.fillRect(0, 0, W, H);

    // Title, and optionally a generated-at stamp.
    //
    // The stamp is OPT-IN (`"timestamp": true`) because it is the only
    // wall-clock input to the render: with it on, the same JSON produces a
    // different PNG every time, so a git-tracked diagram.png churns on every
    // render and can't be diffed. Off by default keeps "same JSON → same PNG"
    // literally true, which is what the state-as-source-of-truth model promises.
    if (this._state.title) {
      ctx.fillStyle = this._state.titleColor || pal.title;
      ctx.font = `bold ${pal.sizes.title}px ${pal.font}`;
      ctx.textAlign = "left";
      ctx.fillText(this._state.title, 20, 22);
      if (this._state.timestamp) {
        ctx.fillStyle = pal.textDim;
        ctx.font = `${pal.sizes.timestamp}px ${pal.font}`;
        const utc = new Date().toISOString().replace("T", " ").slice(0, 19);
        ctx.fillText(`Generated: ${utc} UTC`, 20, 38);
      }
    }

    // Boundary dividers and group frames — annotation layer beneath wires and boxes
    drawDividers(ctx, this._state.dividers, W, H, pal);
    const frames = groupFrames(this._state.groups, gridBoxes, pal, this._state);
    const groupLabels = drawGroups(ctx, frames, pal);

    // Build routing grid + route (layout already computed above)
    const grid = new Grid(COLS, ROWS);
    const costs = { ...DEFAULT_COSTS, ...(this._state.costs || {}) };
    const connMap = buildGrid(
      grid,
      gridBoxes,
      costs,
      groupLabels,
      frames.map((f) => f.rect),
    );
    const astarState = createAstarState(COLS, ROWS);
    const routes = routeEdges(
      astarState,
      grid,
      this.edges,
      gridBoxes,
      connMap,
      costs,
      pal,
      {
        centerConnectors: this._state.connectorAnchor === "center",
        edgeWidth: this._state.edgeWidth,
        direction: this._state.direction,
        flow: this._state.flow,
      },
    );

    // Draw (failed-route markers go on top of boxes, mirroring the live editor)
    const labelRects = drawRoutes(ctx, routes, CELL, pal, {
      bridges: this._state.crossingBridges !== false,
      startMarkers: this._state.startMarkers !== false,
      boxes: gridBoxes,
      avoid: groupLabels,
      frames: frames.map((f) => f.rect),
      frameFills: frames,
    });
    drawGroupLabels(ctx, groupLabels, pal);
    drawBoxes(ctx, gridBoxes, CELL, pal, { shadow: shadows });
    drawEdgeLabels(ctx, labelRects, pal);
    drawNotes(
      ctx,
      resolveNotePositions(
        this._state.notes,
        this.noteLayout,
        gridBoxes,
        (n) => measureNote(ctx, n, pal),
      ),
      pal,
    );
    drawFailedRoutes(ctx, routes, gridBoxes, CELL); // surface broken edges in the artifact, not just the console

    // Legend (auto-derived from used colors unless given / disabled)
    const legend = this._legend();
    drawLegend(ctx, legend, H, pal, this._state.footer);

    return {
      canvas,
      ctx,
      W,
      H,
      scale,
      DPR,
      maxDim,
      gridBoxes,
      routes,
      pal,
      frames,
      labelRects,
      groupLabels,
    };
  }

  // Layout defects in the solved board (wires sharing a track, bunched
  // connectors, labels on boxes or off the board, group labels wider than
  // their frame, frame intruders, failed routes). See findIssues.
  issues() {
    return findIssues(this.renderToCanvas());
  }
}

// ═══════════════════════════════════════════════════════════════
// ARTIFACTS
// ═══════════════════════════════════════════════════════════════
/**
 * Snapshot the current render (srcPng, default diagram.png) + diagram-state.json
 * into artifacts/<ISO-timestamp>[-label].{png,json}. Pure file copy — no CAS.
 * Returns the written paths.
 */
export function captureArtifacts(stateDir, label, ts, statePath, srcPng) {
  const stamp = (ts ?? new Date().toISOString()).replace(/[:.]/g, "-").slice(
    0,
    19,
  );
  const base = label ? `${stamp}-${label}` : stamp;
  const dir = join(stateDir, "artifacts");
  Deno.mkdirSync(dir, { recursive: true });
  const png = join(dir, `${base}.png`);
  const json = join(dir, `${base}.json`);
  Deno.copyFileSync(srcPng ?? join(stateDir, "diagram.png"), png);
  Deno.copyFileSync(statePath ?? join(stateDir, "diagram-state.json"), json);
  return { png, json };
}
