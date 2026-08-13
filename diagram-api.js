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
  createAstarState,
  DASH_TOKENS,
  DEFAULT_COSTS,
  deriveTheme,
  drawBoxes,
  drawDividers,
  drawEdgeLabels,
  drawFailedRoutes,
  drawNotes,
  drawRoutes,
  EDGE_WIDTHS,
  fontFamily,
  Grid,
  makePalette,
  OUTLINE_WIDTHS,
  resolveColorToken,
  resolveNotePositions,
  routeEdges,
  snapAlign,
  spreadBoxes,
} from "./diagram-core.js";
import { SCHEMES } from "./themes.js";

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
/**
 * WORKAROUND (2026-07-31) for the @gfx/canvas glyph drop — one of three faults
 * on this library's ledger, alongside the shadowBlur displacement under
 * ctx.scale and the getImageData that doesn't reflect the canvas.
 * See docs/project_notes/upstream-defects.md; `just upstream-check` retests.
 *
 * A string measured with descriptor D on the throwaway layout canvas cannot
 * afterwards be *drawn* with descriptor D on the render canvas: fillText
 * silently produces no pixels. It cost every `details` line on boards of any
 * size, while labels (bold) and the legend/footer (never measured on the
 * scratch) drew fine. Breaking any leg of the (canvas, descriptor, string)
 * triple cures it.
 *
 * So the layout pass measures through a parallel family name backed by the same
 * font file: identical metrics, different cache key, nothing shared with the
 * draw.
 *
 * The underlying fault has no standalone reproduction, so it could not be filed
 * upstream and may be fixed without announcement. That is what the canary in
 * tests/raster-parity.test.js watches for: it renders with the aliases OFF and
 * fails once the text starts drawing anyway. When it fails, delete this.
 */
const MEASURE_SUFFIX = "Measure";

let _fontsLoaded = false;
function ensureFonts() {
  if (_fontsLoaded) return;
  _fontsLoaded = true; // attempt once per process either way
  try {
    const dir = join(dirname(fromFileUrl(import.meta.url)), "assets", "fonts");
    // Skia picks the weight from each file's own metadata, so regular + bold
    // register under one family alias.
    const reg = (file, family) =>
      Fonts.register(Deno.readFileSync(join(dir, file)), family);
    reg("DejaVuSansMono.ttf", "DiagramMono");
    reg("DejaVuSansMono-Bold.ttf", "DiagramMono");
    // Sans option ("font": "sans"). SemiBold serves as bold — friendlier at the
    // 13px box-label size than the full 700 weight.
    reg("InstrumentSans-Regular.ttf", "DiagramSans");
    reg("InstrumentSans-SemiBold.ttf", "DiagramSans");
    // Compatibility for any older state/custom code that still names monospace.
    reg("DejaVuSansMono.ttf", "monospace");
    reg("DejaVuSansMono-Bold.ttf", "monospace");
    // Measurement-only aliases — see MEASURE_SUFFIX. Same files, so metrics are
    // identical to the families above and browser↔renderer parity is unaffected.
    reg("DejaVuSansMono.ttf", "DiagramMono" + MEASURE_SUFFIX);
    reg("DejaVuSansMono-Bold.ttf", "DiagramMono" + MEASURE_SUFFIX);
    reg("InstrumentSans-Regular.ttf", "DiagramSans" + MEASURE_SUFFIX);
    reg("InstrumentSans-SemiBold.ttf", "DiagramSans" + MEASURE_SUFFIX);
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

  for (const [id, p] of Object.entries(layout)) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      at(`layout["${id}"] must be {x, y} numbers, got ${JSON.stringify(p)}`);
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
    this.nodes.push(node);
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
    if (Array.isArray(this._state.pinned)) {
      this._state.pinned = this._state.pinned.filter((p) => p !== id);
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
    // Outline axes: a token sets it, null clears it (back to the 2px solid default).
    if (opts.outlineWidth !== undefined) {
      if (opts.outlineWidth === null) delete node.outlineWidth;
      else {
        this._validateEnum(opts.outlineWidth, OUTLINE_WIDTHS, "outlineWidth");
        node.outlineWidth = opts.outlineWidth;
      }
    }
    if (opts.outlineDash !== undefined) {
      if (opts.outlineDash === null) delete node.outlineDash;
      else {
        this._validateEnum(opts.outlineDash, DASH_TOKENS, "outlineDash");
        node.outlineDash = opts.outlineDash;
      }
    }
  }

  moveNode(id, row, col) {
    const node = this.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Node "${id}" not found`);
    node.row = row;
    node.col = col;
  }

  // Release a node back to automatic placement: drop its layout override (and
  // unpin it). Without this, a frozen layout[id] shadows row/col — so after the
  // editor's full-snapshot freezes the board, an agent's moveNode is a no-op
  // until the node is freed. Returns whether it had an override to remove.
  freeNode(id) {
    if (!this.nodes.some((n) => n.id === id)) {
      throw new Error(`Node "${id}" not found`);
    }
    const had = Object.prototype.hasOwnProperty.call(this.layout, id);
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
  mergeLayout(map) {
    for (const [id, pos] of Object.entries(map || {})) {
      if (
        this.nodes.find((n) => n.id === id) && pos &&
        Number.isFinite(pos.x) && Number.isFinite(pos.y)
      ) {
        this.layout[id] = { x: pos.x, y: pos.y };
      }
    }
  }

  // Bake grid-space box positions into pixel overrides. Positions stay integer
  // (col/row are integral), so col*CELL round-trips exactly through computeLayout.
  persistGridBoxes(boxes) {
    for (const b of boxes) {
      this.layout[b.id] = { x: b.col * CELL, y: b.row * CELL };
    }
  }

  // Set the color scheme (persisted as a top-level `theme` field).
  setTheme(name) {
    if (!SCHEMES[name]) {
      throw new Error(
        `Unknown theme "${name}". Available: ${
          Object.keys(SCHEMES).join(", ")
        }`,
      );
    }
    this._state.theme = name;
    this.palette = paletteFromState(this._state);
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
  setCanvas(w, h, anchor = "nw") {
    const W0 = this._state.width || DEFAULT_W,
      H0 = this._state.height || DEFAULT_H;
    const newW = Math.round(Number(w)), newH = Math.round(Number(h));
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

  // Shrink (or grow) B to hug the content: slide the diagram to a uniform margin,
  // then set B to the renderer's exact grid extent so frame == PNG. The one-click
  // "trim canvas". No-op on an empty board.
  fitCanvasToContent(margin = 40) {
    const c = this.solvePositions().content;
    if (c.w <= 0) return;
    const sdx = Math.round((margin - c.x) / CELL) * CELL,
      sdy = Math.round((margin - c.y) / CELL) * CELL;
    this._resizeCanvas(20000, 20000, sdx, sdy); // translate under an oversized B (validation trivially passes)
    const g = this._gridExtent(); // then tighten to what the renderer actually uses
    this._state.width = g.W;
    this._state.height = g.H;
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

  // The renderer's exact content extent (grid cells, not pixel bbox) + the 40/50
  // margins — i.e. what _fitCanvas grows to. Used to set B so frame == PNG.
  _gridExtent() {
    const scratch = createCanvas(10, 10);
    ensureFonts();
    const gb = this._computeGridBoxes(scratch.getContext("2d"));
    return boardExtent(gb);
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
    if (dx || dy) {
      // Snap the shift to the grid so the stored node positions match what the
      // renderer snaps them to (no stored-vs-rendered drift). Everything moves by
      // the same amount, so relative layout is preserved exactly.
      const sdx = Math.round(dx / CELL) * CELL,
        sdy = Math.round(dy / CELL) * CELL;
      const layout = {};
      for (const [id, p] of Object.entries(sp.positions)) {
        layout[id] = { x: p.x + sdx, y: p.y + sdy };
      }
      this.layout = layout; // freeze every node at its shifted spot
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
    }
    this._state.width = newW;
    this._state.height = newH;
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
      ? ids.filter((id) => this.nodes.some((n) => n.id === id))
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
  // measureAliases: false measures with the family the render also draws with,
  // i.e. reproduces the glyph-drop fault. Exists solely for the canary test —
  // production callers must leave it on. See MEASURE_SUFFIX.
  _computeGridBoxes(ctx, { measureAliases = true } = {}) {
    const { W } = this._dims;
    const state = {
      nodes: this.nodes,
      edges: this.edges,
      layout: this.layout,
      rowY: this.rowY,
      uniformWidth: this._state.uniformWidth,
      font: this._state.font, // affects text width → box size
      fontSize: this._state.fontSize, // scales box geometry with the font
    };
    if (measureAliases) {
      state.measureFamily = fontFamily(state) + MEASURE_SUFFIX;
    }
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
    const content = gridBoxes.length
      ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
      : { x: 0, y: 0, w: 0, h: 0 };
    // Resolved note positions (anchor/override applied) so agents can verify
    // annotation placement without rendering.
    const notes = {};
    for (
      const r of resolveNotePositions(
        this._state.notes,
        this.noteLayout,
        gridBoxes,
      )
    ) {
      notes[r.id ?? `${r.x},${r.y}`] = {
        x: r.x,
        y: r.y,
        anchored: !!(r.anchor && !this.noteLayout[r.id]),
      };
    }
    return { positions, content, canvas: { width: W, height: H }, notes };
  }

  // ─── Auto-derive a legend from the colors actually used ───
  _legend() {
    if (Array.isArray(this._state.legend)) return this._state.legend;
    if (this._state.legend === false) return [];
    const used = [];
    // Skip colorless nodes: they render with the fallback box color but have no
    // token to label, and a legend entry with an undefined label crashes
    // fillText (an agent can easily omit "color").
    for (const n of this.nodes) {
      if (n.color && !used.includes(n.color)) used.push(n.color);
    }
    // resolveColorToken so semantic tokens (error/warn/success) match the box swatch.
    return used.map((c) => ({
      color: resolveColorToken(this.palette, c).border,
      label: c,
    }));
  }

  // ─── Render to PNG ────────────────────────────────────────
  render() {
    const { canvas, W, H, scale, DPR, maxDim, routes } = this.renderToCanvas();

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
  renderToCanvas({ measureAliases = true, shadows = false } = {}) {
    const pal = this.palette = paletteFromState(this._state); // pick up any state mutations
    const { DPR } = this._dims;

    // Compute layout first (scratch context for text measurement), then grow the
    // canvas to encompass every box. Boxes dragged beyond the authored
    // width/height (the editor canvas is larger) are thus never clipped.
    const scratch = createCanvas(10, 10);
    ensureFonts(); // before any measureText — metrics must match drawing
    const gridBoxes = this._computeGridBoxes(scratch.getContext("2d"), {
      measureAliases,
    });
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

    // Boundary dividers — annotation layer beneath wires and boxes
    drawDividers(ctx, this._state.dividers, W, H, pal);

    // Build routing grid + route (layout already computed above)
    const grid = new Grid(COLS, ROWS);
    const costs = { ...DEFAULT_COSTS, ...(this._state.costs || {}) };
    const connMap = buildGrid(grid, gridBoxes, costs);
    const astarState = createAstarState(COLS, ROWS);
    const routes = routeEdges(
      astarState,
      grid,
      this.edges,
      gridBoxes,
      connMap,
      costs,
      pal,
      { centerConnectors: this._state.connectorAnchor === "center" },
    );

    // Draw (failed-route markers go on top of boxes, mirroring the live editor)
    const labelRects = drawRoutes(ctx, routes, CELL, pal, {
      bridges: this._state.crossingBridges !== false,
      boxes: gridBoxes,
    });
    drawBoxes(ctx, gridBoxes, CELL, pal, { shadow: shadows });
    drawEdgeLabels(ctx, labelRects, pal);
    drawNotes(
      ctx,
      resolveNotePositions(this._state.notes, this.noteLayout, gridBoxes),
      pal,
    );
    drawFailedRoutes(ctx, routes, gridBoxes, CELL); // surface broken edges in the artifact, not just the console

    // Legend (auto-derived from used colors unless given / disabled)
    const legend = this._legend();
    if (legend.length > 0) {
      ctx.font = `${pal.sizes.legend}px ${pal.font}`;
      ctx.textAlign = "left";
      const legendY = H - (this._state.footer ? 35 : 20);
      legend.forEach((item, i) => {
        const x = 20 + i * 160;
        ctx.fillStyle = item.color;
        ctx.fillRect(x, legendY, 12, 12);
        ctx.fillStyle = pal.textDim;
        ctx.fillText(item.label, x + 18, legendY + 10);
      });
      if (this._state.footer) {
        ctx.fillStyle = pal.textDim;
        ctx.fillText(this._state.footer, 20, legendY + 25);
      }
    } else if (this._state.footer) {
      ctx.fillStyle = pal.textDim;
      ctx.font = `${pal.sizes.footer}px ${pal.font}`;
      ctx.textAlign = "left";
      ctx.fillText(this._state.footer, 20, H - 20);
    }

    return { canvas, ctx, W, H, scale, DPR, maxDim, gridBoxes, routes, pal };
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
