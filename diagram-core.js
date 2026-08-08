/**
 * diagram-core.js — Shared diagram engine.
 *
 * Pure ES module with no platform-specific dependencies.
 * Used by both the browser live whiteboard and Deno server-side PNG renderer.
 *
 * Routing engine based on A* with TypedArray state + generation counter.
 * Layout engine converts abstract JSON positions to grid-space boxes.
 */

// ================================================================
// CONSTANTS
// ================================================================
export const CELL = 15;
export const EDGE_MARGIN = 1;
export const BOARD_MARGIN = 40;
export const BOARD_MARGIN_BOTTOM = 50;

export const T_EMPTY = 0;
export const T_BLOCKED = 1;
export const T_NEAR = 2;
export const T_CONN = 3;

export const D_NONE = 0, D_N = 1, D_E = 2, D_S = 3, D_W = 4;
export const MOVES = [
  { dx: 0, dy: -1, id: D_N },
  { dx: 1, dy: 0, id: D_E },
  { dx: 0, dy: 1, id: D_S },
  { dx: -1, dy: 0, id: D_W },
];
export const EXIT_DIR = { N: D_N, E: D_E, S: D_S, W: D_W };
// The move that enters the box across a side's outward normal — used to force a
// perpendicular target entry (symmetric to the source's exitDir constraint).
export const OPPOSITE_DIR = { [D_N]: D_S, [D_S]: D_N, [D_E]: D_W, [D_W]: D_E };
export const SIDE_TO_EDGE = { top: "N", bottom: "S", left: "W", right: "E" };

// Default node color palette — neutral named colors.
// Override or extend via the "colors" key in diagram-state.json.
export const DEFAULT_COLORS = {
  blue: { bg: "#1a1a2e", border: "#68f" },
  green: { bg: "#1a2a1a", border: "#4a9" },
  amber: { bg: "#2a2a1a", border: "#ca6" },
  purple: { bg: "#2a1a2a", border: "#c6a" },
  teal: { bg: "#1a2a2a", border: "#6ca" },
  red: { bg: "#2a1a1a", border: "#f66" },
  pink: { bg: "#2a1a1a", border: "#c88" },
  gray: { bg: "#222831", border: "#888" },
};

// Default edge style palette — neutral line styles.
// Override or extend via the "edgeStyles" key in diagram-state.json.
export const DEFAULT_EDGE_STYLES = {
  default: { color: "#888", dash: [] },
  solid: { color: "#c6a", dash: [] },
  dashed: { color: "#ca6", dash: [6, 3] },
  dotted: { color: "#6ca", dash: [2, 3] },
  thin: { color: "#555", dash: [4, 4] },
  alert: { color: "#f66", dash: [3, 3] },
};

// Independent styling axes. A named `style` (above) is a preset base; the
// per-edge/per-node `width`/`dash`/`color` fields override one axis at a time
// over it. Token strings (not raw px) so they're self-documenting for the CLI
// and round-trip cleanly through the JSON state. See routeEdges/drawBoxes.
export const EDGE_WIDTHS = { thin: 1.25, medium: 2, thick: 3.25 };
export const OUTLINE_WIDTHS = { thin: 1, medium: 2, thick: 3 };
export const DASH_TOKENS = { solid: [], dashed: [6, 3], dotted: [2, 3] };

// Semantic color tokens → named palette colors. Lets an edge/node carry intent
// ("error") that re-maps per theme, as an alternative to a literal named color.
// Theme/state-overridable via makePalette (themeObj.semantic / state.semantic).
export const DEFAULT_SEMANTIC = {
  neutral: "gray",
  info: "blue",
  success: "green",
  warn: "amber",
  error: "red",
  accent: "purple",
};

// Default chrome colors — the original dark look, used when no theme is set.
export const DEFAULT_CHROME = {
  background: "#16162a",
  text: "#e0e0e0", // node labels
  textDim: "#999999", // details, legend, footer, edge labels
  title: "#8888cc",
  gridLine: "#1c2128",
};

/**
 * Resolve a state's font choice to the family name the engine draws with.
 *   "mono" (default) → "DiagramMono" (bundled DejaVu Sans Mono in both the
 *   renderer and editor).
 *   "sans"           → "DiagramSans" (bundled Instrument Sans; the editor
 *   declares a matching @font-face).
 */
export function fontFamily(state = {}) {
  return state.font === "sans" ? "DiagramSans" : "DiagramMono";
}

// The box-label size everything else scales from. state.fontSize (the box-label
// px, default 13) scales the whole table proportionally so boxes grow/shrink
// with their text. Literals here are exactly today's hardcoded sizes, so an
// unset fontSize (scale 1) renders byte-identically.
const BASE_LABEL_PX = 13;
export function fontSizes(state = {}) {
  const fs = Number.isFinite(state.fontSize) && state.fontSize > 0
    ? state.fontSize
    : BASE_LABEL_PX;
  const k = fs / BASE_LABEL_PX; // 1 when unset
  const r = (v) => Math.round(v * k);
  return {
    scale: k,
    label: r(13),
    detail: r(10),
    edgeLabel: r(10),
    legend: r(10),
    title: r(16),
    timestamp: r(10),
    footer: r(10),
    divider: r(10),
    noteTitle: r(11),
    noteText: r(10),
    // Box geometry must scale too or boxes won't fit larger text. labelBaseline
    // is the label's baseline offset within its line (today's literal 12).
    box: {
      padTop: r(12),
      padBottom: r(10),
      labelH: r(18),
      detailH: r(14),
      gap: r(4),
      padX: r(20),
      labelBaseline: r(12),
    },
  };
}
// Scale-1 sizes (today's literals) — the default when no pal/sizes is threaded.
export const DEFAULT_SIZES = fontSizes();

/**
 * Build a palette: one plain object holding every color the engine draws with.
 * There is deliberately NO module-level palette state — a palette is built
 * per-diagram and passed to the draw/route functions, so two diagrams loaded
 * in the same process can never leak colors into each other.
 *
 *   themeObj — output of deriveTheme(scheme), or null for the built-in look.
 *   state    — diagram state; its colors/edgeStyles/background override the theme.
 */
export function makePalette(themeObj = null, state = {}) {
  return {
    colors: {
      ...(themeObj?.colors ?? DEFAULT_COLORS),
      ...(state.colors || {}),
    },
    edgeStyles: {
      ...(themeObj?.edgeStyles ?? DEFAULT_EDGE_STYLES),
      ...(state.edgeStyles || {}),
    },
    semantic: {
      ...DEFAULT_SEMANTIC,
      ...(themeObj?.semantic ?? {}),
      ...(state.semantic || {}),
    },
    background: state.background || themeObj?.background ||
      DEFAULT_CHROME.background,
    text: themeObj?.text ?? DEFAULT_CHROME.text,
    textDim: themeObj?.textDim ?? DEFAULT_CHROME.textDim,
    title: themeObj?.title ?? DEFAULT_CHROME.title,
    gridLine: themeObj?.gridLine ?? DEFAULT_CHROME.gridLine,
    font: fontFamily(state),
    sizes: fontSizes(state),
  };
}

export const DEFAULT_PALETTE = makePalette();

/**
 * Resolve a color token to a palette color entry ({bg, border}). A token may be
 * a semantic alias (error → red) or a named palette color (red). Semantic wins,
 * then named; unknown tokens fall back to the first palette color. Shared by
 * edge stroke and box outline so both speak the same color vocabulary.
 */
export function resolveColorToken(pal, token) {
  const colors = pal.colors || DEFAULT_COLORS;
  const named = (pal.semantic && pal.semantic[token]) || token;
  return colors[named] || Object.values(colors)[0];
}

// ── Theme derivation ───────────────────────────────────────────
function hexToRgb(h) {
  h = h.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}
/** Blend hex `a` toward hex `b` by fraction `t` (0 = a, 1 = b). */
export function mixHex(a, b, t) {
  const x = hexToRgb(a), y = hexToRgb(b);
  return "#" +
    x.map((v, i) =>
      Math.round(v * (1 - t) + y[i] * t).toString(16).padStart(2, "0")
    ).join("");
}

/**
 * Map a raw terminal scheme ({bg, fg, 16 ANSI colors}) onto diagram entities.
 * Node bg = its accent blended ~86% toward the canvas bg, so it works for both
 * light and dark schemes automatically. A scheme may set `nodeBg` to a fixed
 * fill (e.g. near-white "card" boxes that pop off a tinted canvas) — then the
 * accent only colors the border. Only the box bg uses it; everything else still
 * derives from bg/fg.
 */
export function deriveTheme(s) {
  const node = (accent) => ({
    bg: s.nodeBg || mixHex(accent, s.bg, 0.86),
    border: accent,
  });
  return {
    background: s.bg,
    text: s.fg,
    textDim: mixHex(s.fg, s.bg, 0.45),
    title: s.brBlue || s.blue,
    gridLine: mixHex(s.fg, s.bg, 0.9),
    colors: {
      blue: node(s.blue),
      green: node(s.green),
      amber: node(s.yellow),
      purple: node(s.magenta),
      teal: node(s.cyan),
      red: node(s.red),
      pink: node(s.brMagenta),
      gray: {
        bg: s.nodeBg || mixHex(s.brBlack, s.bg, 0.86),
        border: mixHex(s.fg, s.bg, 0.5),
      },
    },
    edgeStyles: {
      default: { color: mixHex(s.fg, s.bg, 0.4), dash: [] },
      solid: { color: s.magenta, dash: [] },
      dashed: { color: s.yellow, dash: [6, 3] },
      dotted: { color: s.cyan, dash: [2, 3] },
      thin: { color: mixHex(s.fg, s.bg, 0.5), dash: [4, 4] },
      alert: { color: s.red, dash: [3, 3] },
    },
  };
}

// Box drawing constants
export const BOX_PAD_TOP = 12;
export const BOX_PAD_BOTTOM = 10;
export const BOX_LABEL_H = 18;
export const BOX_DETAIL_H = 14;
export const BOX_GAP = 4;
export const BOX_PAD_X = 20;
export const MIN_BOX_W = 100;
// Card minimum: the smallest box is MIN_BOX_W × MIN_BOX_H, shaped 4:3 so short
// labels read as cards, not thin strips. The ratio sizes only this *minimum* —
// it is NOT a clamp on wider boxes; content grows the box past the floor
// per-axis (a long label stays wide/flat, we don't force wide content tall).
// BOX_ASPECT_* exist solely to derive MIN_BOX_H from MIN_BOX_W.
export const BOX_ASPECT_W = 4;
export const BOX_ASPECT_H = 3;
export const MIN_BOX_H = Math.round(MIN_BOX_W * BOX_ASPECT_H / BOX_ASPECT_W);
export const MIN_ARROW_SEGMENT = CELL * 3;

// Default cost parameters
export const DEFAULT_COSTS = { step: 10, turn: 30, near: 40, overlap: 20 };

// ================================================================
// MIN-HEAP
// ================================================================
export class Heap {
  constructor() {
    this.a = [];
  }
  push(x) {
    this.a.push(x);
    this._up(this.a.length - 1);
  }
  pop() {
    const top = this.a[0], last = this.a.pop();
    if (this.a.length) {
      this.a[0] = last;
      this._dn(0);
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].f <= this.a[i].f) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  _dn(i) {
    const n = this.a.length;
    for (;;) {
      let m = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.a[l].f < this.a[m].f) m = l;
      if (r < n && this.a[r].f < this.a[m].f) m = r;
      if (m === i) break;
      [this.a[m], this.a[i]] = [this.a[i], this.a[m]];
      i = m;
    }
  }
}

// ================================================================
// GRID
// ================================================================
export class Grid {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.type = new Uint8Array(cols * rows);
    this.extra = new Float32Array(cols * rows);
  }
  i(x, y) {
    return y * this.cols + x;
  }
  get(x, y) {
    return this.type[this.i(x, y)];
  }
  set(x, y, v) {
    this.type[this.i(x, y)] = v;
  }
  addCost(x, y, c) {
    this.extra[this.i(x, y)] += c;
  }
  cost(x, y) {
    return this.extra[this.i(x, y)];
  }
  ok(x, y) {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }
  reset() {
    this.type.fill(0);
    this.extra.fill(0);
  }
}

// ================================================================
// CONNECTOR HELPERS
// ================================================================

/** Number of connection points per edge: one per cell along the span. */
export function connCount(box, edge) {
  return (edge === "N" || edge === "S") ? box.w : box.h;
}

/**
 * Resolve symbolic connector index.
 *   'C'   → center = floor((n-1)/2)
 *   'C-1' → one before center, 'C+1' → one after
 *   number → as-is
 */
export function resolveIdx(box, edge, sym) {
  const n = connCount(box, edge);
  const center = Math.floor((n - 1) / 2);
  if (sym === "C") return center;
  if (typeof sym === "string" && sym.startsWith("C")) {
    return center + parseInt(sym.slice(1));
  }
  return sym;
}

/** Generate n evenly-spaced connection points 1 cell OUTSIDE the named edge. */
export function connPositions(box, edge, n) {
  const pts = [];
  const isHoriz = edge === "N" || edge === "S";
  const span = isHoriz ? box.w : box.h;
  for (let i = 0; i < n; i++) {
    const offset = n === 1
      ? Math.floor((span - 1) / 2)
      : Math.round(i * (span - 1) / (n - 1));
    let gx, gy;
    if (isHoriz) {
      gy = edge === "N" ? box.row - 1 : box.row + box.h;
      gx = box.col + offset;
    } else {
      gx = edge === "E" ? box.col + box.w : box.col - 1;
      gy = box.row + offset;
    }
    pts.push({ gx, gy, idx: i });
  }
  return pts;
}

// ================================================================
// A* ROUTER — TypedArray with generation counter
// ================================================================

/** Allocate A* state arrays for a given grid size. */
export function createAstarState(cols, rows) {
  const size = cols * rows * 5;
  return {
    cols,
    rows,
    gArr: new Float32Array(size),
    parArr: new Int32Array(size),
    genArr: new Uint32Array(size),
    generation: 0,
  };
}

/** Resize A* state arrays (e.g. when grid dimensions change). */
export function resizeAstarState(state, cols, rows) {
  const size = cols * rows * 5;
  state.cols = cols;
  state.rows = rows;
  state.gArr = new Float32Array(size);
  state.parArr = new Int32Array(size);
  state.genArr = new Uint32Array(size);
  state.generation = 0;
}

/**
 * A* pathfinding on orthogonal grid.
 * Returns array of {x, y} grid points, or null if no path found.
 */
// entryDir (optional): the only move allowed to land on the target cell, so the
// wire enters perpendicular to the target's side instead of grazing along it.
export function astar(
  state,
  grid,
  sx,
  sy,
  exitDir,
  ex,
  ey,
  costs,
  entryDir = 0,
) {
  const { cols } = grid;
  const gen = ++state.generation;
  const K = (x, y, d) => (y * cols + x) * 5 + d;
  const H = (x, y) => (Math.abs(ex - x) + Math.abs(ey - y)) * costs.step;

  const heap = new Heap();
  const sk = K(sx, sy, D_NONE);
  state.gArr[sk] = 0;
  state.genArr[sk] = gen;
  state.parArr[sk] = -1;
  heap.push({ x: sx, y: sy, dir: D_NONE, g: 0, f: H(sx, sy) });

  let found = -1;

  while (heap.size > 0) {
    const cur = heap.pop();
    const ck = K(cur.x, cur.y, cur.dir);

    if (cur.x === ex && cur.y === ey) {
      found = ck;
      break;
    }
    if (state.genArr[ck] === gen && state.gArr[ck] < cur.g) continue;

    for (const mv of MOVES) {
      if (exitDir && cur.dir === D_NONE && mv.id !== exitDir) continue;

      const nx = cur.x + mv.dx, ny = cur.y + mv.dy;
      if (entryDir && nx === ex && ny === ey && mv.id !== entryDir) continue; // perpendicular target entry
      if (!grid.ok(nx, ny)) continue;

      const t = grid.get(nx, ny);
      if (t === T_BLOCKED) continue;

      let cost = costs.step + grid.cost(nx, ny);
      // Penalize routing through other conn points (not hard block — dense layouts need it)
      if (t === T_CONN && !(nx === ex && ny === ey)) cost += costs.near * 2;
      if (cur.dir !== D_NONE && cur.dir !== mv.id) cost += costs.turn;
      // NB: `turn` is effectively near-boolean. The path the optimizer picks is
      // piecewise-constant in this cost: 0 = turns free (A* returns an arbitrary
      // shortest staircase → zigzag); any >0 = minimize turns (clean L/Z). The
      // *magnitude* only changes the result where fewer turns would cost more
      // steps (a detour) — i.e. around obstacles — and only at discrete
      // thresholds, so e.g. turn=30 and turn=100 usually route identically.
      // Rescaling (int→float, or a 0..1 range) does NOT add gradation; the
      // governing quantity is the ratio turn/step.
      // TODO(maybe): if a smooth "straightness" knob is ever wanted, it needs a
      // different formulation (e.g. a per-cell continue-straight reward, or
      // folding turn bias into the heuristic, exposed on a log scale) — not a
      // rescale of this term.

      const ng = cur.g + cost;
      const nk = K(nx, ny, mv.id);
      const prevG = state.genArr[nk] === gen ? state.gArr[nk] : Infinity;
      if (ng < prevG) {
        state.gArr[nk] = ng;
        state.genArr[nk] = gen;
        state.parArr[nk] = ck;
        heap.push({ x: nx, y: ny, dir: mv.id, g: ng, f: ng + H(nx, ny) });
      }
    }
  }

  if (found < 0) return null;

  const path = [];
  let cur = found;
  while (cur >= 0) {
    const d = cur % 5, xy = (cur - d) / 5;
    path.push({ x: xy % cols, y: Math.floor(xy / cols) });
    cur = state.parArr[cur];
  }
  return path.reverse();
}

// ================================================================
// PATH SIMPLIFICATION — cross-product collinearity test
// ================================================================
export function simplifyPath(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    if ((b.x - a.x) * (c.y - b.y) - (c.x - b.x) * (b.y - a.y) === 0) continue;
    out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ================================================================
// SIDE SELECTION
// ================================================================
export function pickSide(srcBox, tgtBox) {
  const srcCx = srcBox.col + srcBox.w / 2;
  const srcCy = srcBox.row + srcBox.h / 2;
  const tgtCx = tgtBox.col + tgtBox.w / 2;
  const tgtCy = tgtBox.row + tgtBox.h / 2;
  const dx = tgtCx - srcCx;
  const dy = tgtCy - srcCy;
  if (Math.abs(dy) > Math.abs(dx) * 0.4) {
    return dy > 0
      ? { srcSide: "bottom", tgtSide: "top" }
      : { srcSide: "top", tgtSide: "bottom" };
  }
  return dx > 0
    ? { srcSide: "right", tgtSide: "left" }
    : { srcSide: "left", tgtSide: "right" };
}

// ================================================================
// BOX COLLISION
// ================================================================
export function boxOverlaps(box, col, row, allBoxes) {
  const gap = 1;
  for (const other of allBoxes) {
    if (other === box) continue;
    if (
      col + box.w + gap > other.col &&
      other.col + other.w + gap > col &&
      row + box.h + gap > other.row &&
      other.row + other.h + gap > row
    ) {
      return true;
    }
  }
  return false;
}

// ================================================================
// LAYOUT: JSON abstract coords → grid-space boxes
// ================================================================

// Trim a string until `str + …` fits, then append the ellipsis. `fits` is a
// closure over the caller's budget + already-set font.
function ellipsize(str, fits) {
  str = str.replace(/\s*…?$/, "");
  while (str.length && !fits(str + "…")) str = str.slice(0, -1);
  return str + "…";
}

// Greedy word-wrap of a box title to at most 2 lines within budgetPx; the 2nd
// line is ellipsized if the title still overflows. budgetPx = Infinity → no
// wrap (the auto-size path), so non-explicit-width boxes keep one line and stay
// byte-identical to before. Returns 1 or 2 lines.
export function wrapLabel(
  ctx,
  label,
  budgetPx,
  font = "monospace",
  sizes = DEFAULT_SIZES,
) {
  label = String(label ?? "");
  ctx.font = `bold ${sizes.label}px ${font}`;
  const fits = (s) => ctx.measureText(s).width <= budgetPx;
  if (!Number.isFinite(budgetPx) || fits(label)) return [label];

  const words = label.split(/\s+/).filter(Boolean);
  let i = 0, l1 = "";
  for (; i < words.length; i++) { // pack line 1 (force ≥1 word even if it overflows)
    const t = l1 ? l1 + " " + words[i] : words[i];
    if (fits(t) || !l1) l1 = t;
    else break;
  }
  if (i >= words.length) return [l1];
  let l2 = "";
  for (; i < words.length; i++) { // pack line 2
    const t = l2 ? l2 + " " + words[i] : words[i];
    if (fits(t) || !l2) l2 = t;
    else break;
  }
  if (i < words.length || !fits(l2)) l2 = ellipsize(l2, fits); // leftover words / too-long → …
  return [l1, l2];
}

// Width (px) to fit pre-wrapped label lines + detail lines, floored to the
// card/emphasis minimum. Shared by measureNodeWidth (single line) and the
// wrap-aware layout path.
function contentWidth(ctx, labelLines, node, font, sizes) {
  ctx.font = `bold ${sizes.label}px ${font}`;
  let maxW = 0;
  for (const ln of labelLines) maxW = Math.max(maxW, ctx.measureText(ln).width);
  ctx.font = `${sizes.detail}px ${font}`;
  for (const ln of (node.details || [])) {
    maxW = Math.max(maxW, ctx.measureText(ln).width);
  }
  // node.minW: per-node floor (px) — deliberate emphasis ("make this one bigger")
  return Math.max(
    MIN_BOX_W,
    node.minW || 0,
    Math.ceil(maxW + sizes.box.padX * 2),
  );
}

export function measureNodeWidth(
  ctx,
  node,
  font = "monospace",
  sizes = DEFAULT_SIZES,
) {
  return contentWidth(ctx, [node.label], node, font, sizes);
}

export function nodeBoxHeight(details, sizes = DEFAULT_SIZES, labelLines = 1) {
  const b = sizes.box;
  const detailH = details && details.length > 0
    ? b.gap + details.length * b.detailH
    : 0;
  return b.padTop + labelLines * b.labelH + detailH + b.padBottom;
}

// Single source of truth for a box's pixel size + wrapped title. Honors explicit
// node.w/node.h (cells, from a drag-resize): the title wraps to ≤2 lines to fit
// an explicit width, and the box can't shrink below the longest word or the card
// minimum. Auto width → no wrap. Used by computeLayout and the editor's live
// resize, so the dragged size matches what re-rendering produces.
export function nodeBoxSize(
  ctx,
  node,
  font = "monospace",
  sizes = DEFAULT_SIZES,
) {
  const explicitWpx = node.w > 0 ? node.w * CELL : 0;
  const budget = explicitWpx > 0 ? explicitWpx - sizes.box.padX * 2 : Infinity;
  const labelLines = wrapLabel(ctx, node.label, budget, font, sizes);
  const w = Math.max(
    contentWidth(ctx, labelLines, node, font, sizes),
    explicitWpx,
  );
  const h = Math.max(
    nodeBoxHeight(node.details, sizes, labelLines.length),
    MIN_BOX_H,
    node.h > 0 ? node.h * CELL : 0,
  );
  return { w, h, labelLines };
}

export function boardExtentForContent(content, baseW = 0, baseH = 0) {
  const hasContent = content && Number.isFinite(content.x) &&
    Number.isFinite(content.y) &&
    Number.isFinite(content.w) && Number.isFinite(content.h) &&
    (content.w > 0 || content.h > 0);
  const W = Math.max(
    baseW,
    hasContent ? content.x + content.w + BOARD_MARGIN : 0,
  );
  const H = Math.max(
    baseH,
    hasContent ? content.y + content.h + BOARD_MARGIN_BOTTOM : 0,
  );
  return { W, H, COLS: Math.floor(W / CELL), ROWS: Math.floor(H / CELL) };
}

export function boardExtent(gridBoxes, baseW = 0, baseH = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of gridBoxes || []) {
    x0 = Math.min(x0, b.col * CELL);
    y0 = Math.min(y0, b.row * CELL);
    x1 = Math.max(x1, (b.col + b.w) * CELL);
    y1 = Math.max(y1, (b.row + b.h) * CELL);
  }
  const content = isFinite(x0)
    ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    : null;
  return boardExtentForContent(content, baseW, baseH);
}

/**
 * Compute grid-space boxes from diagram state JSON.
 * Returns array of box objects with {id, label, color, details, col, row, w, h, pixW, pixH, _origCol, _origRow}.
 */
export function computeLayout(ctx, state, canvasW) {
  const { nodes, edges, rowY = {}, layout = {} } = state;
  const LAYOUT_MARGIN = 40;
  const LAYOUT_MIN_GAP = 30;

  // Measure pixel dimensions (with the state's font + size — both change box size).
  // state.measureFamily lets a caller measure through a different family name
  // backed by the same font file — see the measurement aliases in diagram-api.js.
  // Unset (the editor) measures with the family it draws with, as before.
  const FONT = state.measureFamily || fontFamily(state);
  const SIZES = fontSizes(state);
  const pixDims = new Map();
  for (const node of nodes) {
    // Minimum card: a small box is floored to MIN_BOX_W × MIN_BOX_H (the 4:3
    // base shape) so short labels read as cards, not strips. Content grows the
    // box past the floor per-axis — a long label stays as wide/flat as it needs
    // (we don't force wide content tall, which would balloon single-line boxes).
    // nodeBoxSize is the single source of truth (explicit-width title wrap +
    // card floor); the editor's live resize calls it too, so a dragged box
    // matches what re-rendering produces.
    const { w, h, labelLines } = nodeBoxSize(ctx, node, FONT, SIZES);
    pixDims.set(node.id, { w, h, labelLines });
  }

  // uniformWidth: homogenize — every box without an explicit minW takes the
  // widest such box's width, so size variation reads as deliberate emphasis
  // (minW'd boxes) rather than as an artifact of label length.
  if (state.uniformWidth) {
    const fixed = (node) => node.minW || node.w > 0; // minW'd or explicitly-sized boxes opt out
    let mw = 0;
    for (const node of nodes) {
      if (!fixed(node)) mw = Math.max(mw, pixDims.get(node.id).w);
    }
    for (const node of nodes) if (!fixed(node)) pixDims.get(node.id).w = mw;
  }

  // Per-node absolute overrides (from drags / layout passes). An override supplies
  // BOTH coordinates, so the node is removed from row-grouping entirely.
  const overridden = new Set(
    nodes.filter((n) => layout[n.id]).map((n) => n.id),
  );
  const isFixed = (id) => overridden.has(id);

  // Effective Y per row index. Explicit rowY entries win; otherwise rows stack
  // by the tallest box in each row plus a routing gap. (The old fixed 80px band
  // overlapped rows whenever a box had 3+ detail lines, which blocked its S-side
  // connectors against the box below → "Missing conn point" route failures.)
  const ROW_GAP_PX = 45; // ≥3 grid cells of wiring room between rows
  const rowIdxs = [
    ...new Set(nodes.filter((n) => !overridden.has(n.id)).map((n) => n.row)),
  ]
    .sort((a, b) => a - b);
  const rowYEff = new Map();
  let rowCursor = 48, prevIdx = null;
  for (const r of rowIdxs) {
    // Skipped row indices are an authoring hint for extra air — honor them.
    if (prevIdx !== null && r - prevIdx > 1) {
      rowCursor += (r - prevIdx - 1) * ROW_GAP_PX;
    }
    const y = rowY[String(r)] !== undefined ? rowY[String(r)] : rowCursor;
    rowYEff.set(r, y);
    let maxH = 0;
    for (const n of nodes) {
      if (!overridden.has(n.id) && n.row === r) {
        maxH = Math.max(maxH, pixDims.get(n.id).h);
      }
    }
    rowCursor = Math.max(rowCursor, y + maxH + ROW_GAP_PX);
    prevIdx = r;
  }

  // Group non-overridden nodes by effective Y pixel value
  const rowGroups = new Map();
  for (const node of nodes) {
    if (overridden.has(node.id)) continue;
    const y = rowYEff.get(node.row);
    if (!rowGroups.has(y)) rowGroups.set(y, []);
    rowGroups.get(y).push(node);
  }

  // Position nodes within rows
  const positions = new Map();
  const usableWidth = canvasW - 2 * LAYOUT_MARGIN;

  // Overridden nodes get their absolute pixel position directly.
  for (const node of nodes) {
    if (!overridden.has(node.id)) continue;
    const dims = pixDims.get(node.id);
    const o = layout[node.id];
    positions.set(node.id, { x: o.x, y: o.y, w: dims.w, h: dims.h });
  }

  for (const [y, rowNodes] of rowGroups) {
    rowNodes.sort((a, b) => a.col - b.col);
    const auto = rowNodes;

    const cols = auto.map((n) => n.col);
    const minCol = Math.min(...cols);
    const maxCol = Math.max(...cols);
    const colRange = maxCol - minCol;

    if (auto.length === 1) {
      const node = auto[0];
      const dims = pixDims.get(node.id);
      const allCols = nodes.map((n) => n.col);
      const globalMaxCol = Math.max(...allCols);
      const frac = globalMaxCol > 0 ? node.col / globalMaxCol : 0.5;
      const x = LAYOUT_MARGIN + frac * (usableWidth - dims.w);
      positions.set(node.id, {
        x: Math.max(LAYOUT_MARGIN, x),
        y,
        w: dims.w,
        h: dims.h,
      });
    } else if (colRange === 0) {
      const totalAutoWidth = auto.reduce((s, n) => s + pixDims.get(n.id).w, 0);
      const totalGap = usableWidth - totalAutoWidth;
      const gap = Math.max(LAYOUT_MIN_GAP, totalGap / (auto.length + 1));
      let cx = LAYOUT_MARGIN + gap;
      for (const node of auto) {
        const dims = pixDims.get(node.id);
        positions.set(node.id, { x: cx, y, w: dims.w, h: dims.h });
        cx += dims.w + gap;
      }
    } else {
      for (const node of auto) {
        const dims = pixDims.get(node.id);
        const frac = (node.col - minCol) / colRange;
        const x = LAYOUT_MARGIN + frac * (usableWidth - dims.w);
        positions.set(node.id, {
          x: Math.max(LAYOUT_MARGIN, x),
          y,
          w: dims.w,
          h: dims.h,
        });
      }
      const sorted = [...auto].sort((a, b) =>
        positions.get(a.id).x - positions.get(b.id).x
      );
      for (let i = 1; i < sorted.length; i++) {
        const prev = positions.get(sorted[i - 1].id);
        const curr = positions.get(sorted[i].id);
        const minX = prev.x + prev.w + LAYOUT_MIN_GAP;
        if (curr.x < minX) curr.x = minX;
      }
    }
  }

  // Spring-repulsion pass
  const REPEL_STRENGTH = 3000;
  const SPRING_STRENGTH = 0.01;
  const ANCHOR_STRENGTH = 0.08;
  const DESIRED_GAP = LAYOUT_MIN_GAP + 10;
  const DAMPING = 0.6;
  const ITERS = 30;

  const anchorX = new Map();
  for (const node of nodes) {
    const pos = positions.get(node.id);
    if (pos) anchorX.set(node.id, pos.x);
  }

  const vx = new Map();
  for (const node of nodes) vx.set(node.id, 0);
  const allPositioned = nodes.filter((n) => positions.has(n.id));

  for (let iter = 0; iter < ITERS; iter++) {
    const forces = new Map();
    for (const n of allPositioned) forces.set(n.id, 0);

    // Repulsion
    for (let i = 0; i < allPositioned.length; i++) {
      const a = positions.get(allPositioned[i].id);
      const aId = allPositioned[i].id;
      if (isFixed(aId)) continue;
      for (let j = i + 1; j < allPositioned.length; j++) {
        const b = positions.get(allPositioned[j].id);
        const bId = allPositioned[j].id;
        const aCx = a.x + a.w / 2, bCx = b.x + b.w / 2;
        const aCy = a.y + a.h / 2, bCy = b.y + b.h / 2;
        const dx = bCx - aCx, dy = bCy - aCy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) continue;
        const combinedW = (a.w + b.w) / 2 + DESIRED_GAP;
        if (Math.abs(dx) > combinedW * 2.5) continue;
        const force = REPEL_STRENGTH / (dist * dist);
        const fx = (dx / dist) * force;
        forces.set(aId, forces.get(aId) - fx);
        if (!isFixed(bId)) forces.set(bId, forces.get(bId) + fx);
      }
    }

    // Edge springs
    for (const edge of edges) {
      const aPos = positions.get(edge.from);
      const bPos = positions.get(edge.to);
      if (!aPos || !bPos) continue;
      const dx = (bPos.x + bPos.w / 2) - (aPos.x + aPos.w / 2);
      const fx = dx * SPRING_STRENGTH;
      if (!isFixed(edge.from)) {
        forces.set(edge.from, forces.get(edge.from) + fx);
      }
      if (!isFixed(edge.to)) forces.set(edge.to, forces.get(edge.to) - fx);
    }

    // Anchor pull
    for (const node of allPositioned) {
      if (isFixed(node.id)) continue;
      const pos = positions.get(node.id);
      const dx = anchorX.get(node.id) - pos.x;
      forces.set(node.id, forces.get(node.id) + dx * ANCHOR_STRENGTH);
    }

    // Apply forces
    for (const node of allPositioned) {
      if (isFixed(node.id)) continue;
      const pos = positions.get(node.id);
      const v = (vx.get(node.id) + forces.get(node.id)) * DAMPING;
      vx.set(node.id, v);
      pos.x += v;
      pos.x = Math.max(
        LAYOUT_MARGIN,
        Math.min(canvasW - LAYOUT_MARGIN - pos.w, pos.x),
      );
    }

    // Fix overlaps within rows
    for (const [, rNodes] of rowGroups) {
      const sorted = [...rNodes]
        .filter((n) => positions.has(n.id))
        .sort((a, b) => positions.get(a.id).x - positions.get(b.id).x);
      for (let i = 1; i < sorted.length; i++) {
        const prev = positions.get(sorted[i - 1].id);
        const curr = positions.get(sorted[i].id);
        const minX = prev.x + prev.w + LAYOUT_MIN_GAP;
        if (curr.x < minX) {
          const overlap = minX - curr.x;
          curr.x = minX;
          if (!isFixed(sorted[i - 1].id)) {
            prev.x -= overlap * 0.3;
            prev.x = Math.max(LAYOUT_MARGIN, prev.x);
          }
        }
      }
    }
  }

  // Convert to grid-space boxes
  const gridBoxes = [];
  for (const node of nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    const dims = pixDims.get(node.id);
    const col = Math.round(pos.x / CELL);
    const row = Math.round(pos.y / CELL);
    const w = Math.ceil(dims.w / CELL);
    const h = Math.ceil(dims.h / CELL);
    gridBoxes.push({
      id: node.id,
      label: node.label,
      color: node.color,
      outlineWidth: node.outlineWidth,
      outlineDash: node.outlineDash,
      details: node.details || [],
      labelLines: dims.labelLines,
      col,
      row,
      w,
      h,
      pixW: dims.w,
      pixH: dims.h,
      _origCol: col,
      _origRow: row,
    });
  }

  // Final separation pass, in the cell space the boxes are actually drawn in.
  //
  // Everything above packs rows in pixel space against `pos.w` (the exact
  // content width), but a box is drawn `Math.ceil(pixW / CELL)` cells wide and
  // anchored at `Math.round(pos.x / CELL)` — so a row that satisfies
  // LAYOUT_MIN_GAP pre-snap can still overlap once snapped. The spring pass
  // compounds it: its in-loop fixup (see the `prev.x -= overlap * 0.3` nudge
  // above) can re-break the constraint on a neighbour it already settled, and
  // nothing re-checks. The result was boxes drawn on top of each other by up to
  // 75px — worst with `uniformWidth`, which leaves a dense row no gap budget.
  //
  // The sweep walks a row left to right behind a cursor — the rightmost column
  // spoken for so far — and never moves a box left, so it is monotone and
  // terminates, and boxes keep their relative order.
  //
  // Overridden nodes are a human's drags, so the sweep never *moves* one — but
  // it must still see them, or it would shove an auto box straight into one. A
  // pinned box is an immovable obstacle: an auto box that would land on one
  // jumps past it. A pin is matched against each box's own row span, since a
  // tall pin can straddle rows.
  //
  // Scope, precisely: auto boxes are laned by an equal `row`, and pins are
  // matched by span. So this separates auto/auto within a drawn row, and
  // auto/pin wherever their rows overlap. It does NOT separate two *auto* boxes
  // in different rows — the row stacking upstream (maxH + ROW_GAP_PX) keeps
  // those apart, except where an explicit `rowY` forces two rows to overlap,
  // which is not addressed here.
  const MIN_GAP_CELLS = Math.ceil(LAYOUT_MIN_GAP / CELL);
  // Ascending by column, so the per-box obstacle scan below settles in one pass.
  const pinnedBoxes = gridBoxes
    .filter((b) => overridden.has(b.id))
    .sort((a, b) => a.col - b.col);
  const drawnRows = new Map();
  for (const b of gridBoxes) {
    if (overridden.has(b.id)) continue;
    if (!drawnRows.has(b.row)) drawnRows.set(b.row, []);
    drawnRows.get(b.row).push(b);
  }
  for (const rowBoxes of drawnRows.values()) {
    const lane = [...rowBoxes].sort((a, b) => a.col - b.col);

    let cursor = null; // rightmost column claimed so far
    for (const b of lane) {
      let col = cursor === null
        ? b.col
        : Math.max(b.col, cursor + MIN_GAP_CELLS);
      // Only pins overlapping *this* box's own rows constrain it. Testing
      // against the row's tallest box instead would let one tall neighbour drag
      // every short box in the row around a pin none of them touch.
      const obstacles = pinnedBoxes.filter(
        (p) => p.row < b.row + b.h && b.row < p.row + p.h,
      );
      // Clearing the left neighbour can push a box onto an obstacle further
      // right; obstacles ascend by column, so one pass settles it.
      for (const o of obstacles) {
        if (
          col < o.col + o.w + MIN_GAP_CELLS && o.col < col + b.w + MIN_GAP_CELLS
        ) {
          col = o.col + o.w + MIN_GAP_CELLS;
        }
      }
      b.col = col;
      b._origCol = col;
      cursor = cursor === null ? col + b.w : Math.max(cursor, col + b.w);
    }
  }

  return gridBoxes;
}

// ================================================================
// GRID BUILDING
// ================================================================

/**
 * Stamp BLOCKED, NEAR, and CONN cells on the grid for the given boxes.
 * Returns connMap: Map<string, {gx, gy, exitDir}>.
 */
export function buildGrid(grid, boxes, costs) {
  grid.reset();
  const connMap = new Map();

  // 1. Mark cells inside boxes as impassable
  for (const b of boxes) {
    for (let r = b.row; r < b.row + b.h; r++) {
      for (let c = b.col; c < b.col + b.w; c++) {
        if (grid.ok(c, r)) grid.set(c, r, T_BLOCKED);
      }
    }
  }

  // 2. 1-cell clearance ring
  for (const b of boxes) {
    for (let r = b.row - 1; r < b.row + b.h + 1; r++) {
      for (let c = b.col - 1; c < b.col + b.w + 1; c++) {
        if (!grid.ok(c, r) || grid.get(c, r) !== T_EMPTY) continue;
        grid.set(c, r, T_NEAR);
        grid.addCost(c, r, costs.near);
      }
    }
  }

  // 3. Place connection points
  for (const b of boxes) {
    for (const edge of ["N", "E", "S", "W"]) {
      const n = connCount(b, edge);
      for (const { gx, gy, idx } of connPositions(b, edge, n)) {
        if (!grid.ok(gx, gy) || grid.get(gx, gy) === T_BLOCKED) continue;
        connMap.set(`${b.id}_${edge}_${idx}`, {
          gx,
          gy,
          exitDir: EXIT_DIR[edge],
        });
        grid.set(gx, gy, T_CONN);
        grid.extra[grid.i(gx, gy)] = 0;
      }
    }
  }

  return connMap;
}

// ================================================================
// EDGE ROUTING
// ================================================================

/**
 * A connector is only usable if its first step (along its exit direction)
 * is open — a conn cell can exist in a 1-cell corridor whose exit is walled
 * by the neighboring box, and A* can never make the first move from it.
 */
function exitOpen(grid, cp) {
  const mv = MOVES.find((m) => m.id === cp.exitDir);
  const nx = cp.gx + mv.dx, ny = cp.gy + mv.dy;
  return grid.ok(nx, ny) && grid.get(nx, ny) !== T_BLOCKED;
}

/**
 * Nearest *usable* connector on a side. The desired index may have been
 * dropped at grid-build time (its cell fell inside another box or off-grid),
 * or be unexitable (1-cell corridor against a neighbor) — walk outward from
 * it. Returns null if the whole side is unavailable.
 */
export function nearestConn(
  connMap,
  boxId,
  edgeName,
  desiredIdx,
  count,
  grid = null,
) {
  for (let d = 0; d < count; d++) {
    for (const i of d === 0 ? [desiredIdx] : [desiredIdx - d, desiredIdx + d]) {
      if (i < 0 || i >= count) continue;
      const cp = connMap.get(`${boxId}_${edgeName}_${i}`);
      if (cp && (!grid || exitOpen(grid, cp))) return cp;
    }
  }
  return null;
}

/** Sides of `fromBox` ordered by how directly they face `toBox`. */
function sidePreference(fromBox, toBox) {
  const dx = (toBox.col + toBox.w / 2) - (fromBox.col + fromBox.w / 2);
  const dy = (toBox.row + toBox.h / 2) - (fromBox.row + fromBox.h / 2);
  const h = dx >= 0 ? ["E", "W"] : ["W", "E"];
  const v = dy >= 0 ? ["S", "N"] : ["N", "S"];
  return Math.abs(dy) > Math.abs(dx)
    ? [v[0], h[0], h[1], v[1]]
    : [h[0], v[0], v[1], h[1]];
}

/**
 * Resolve a usable connector for `box`: the requested side first (nearest
 * placed index), then the remaining sides ordered toward `otherBox`. A tight
 * layout thus degrades to a less-ideal side instead of a failed route.
 */
function resolveConn(connMap, box, requestedEdge, desiredIdx, otherBox, grid) {
  let cp = nearestConn(
    connMap,
    box.id,
    requestedEdge,
    desiredIdx,
    connCount(box, requestedEdge),
    grid,
  );
  if (cp) return cp;
  for (const side of sidePreference(box, otherBox)) {
    if (side === requestedEdge) continue;
    cp = nearestConn(
      connMap,
      box.id,
      side,
      resolveIdx(box, side, "C"),
      connCount(box, side),
      grid,
    );
    if (cp) return cp;
  }
  return null;
}

/**
 * Decide, for every edge, which side of each box it uses and which connector
 * symbol ('C', 'C±n') it gets. Two passes: first pick sides (explicit
 * fromEdge/toEdge win, else geometric pickSide) and count edges per side; then
 * distribute each side's edges symmetrically around its center connector.
 * Returns [{srcEdge, tgtEdge, srcSym, tgtSym}] aligned with edgeDefs.
 */
// Pass 1 of connector allocation, on its own: for every edge, which box side it
// leaves the source from (srcEdge) and enters the target on (tgtEdge) — N/E/S/W.
// Explicit fromEdge/toEdge win; otherwise pickSide decides. Exported so the
// editor can offer per-side connector spread/collapse without recomputing this.
export function edgeSides(edgeDefs, boxes) {
  const boxById = boxes instanceof Map
    ? boxes
    : new Map(boxes.map((b) => [b.id, b]));
  return edgeDefs.map((edge) => {
    const srcBox = boxById.get(edge.from), tgtBox = boxById.get(edge.to);
    if (!srcBox || !tgtBox) return { srcEdge: "S", tgtEdge: "N" };
    if (edge.fromEdge && edge.toEdge) {
      return { srcEdge: edge.fromEdge, tgtEdge: edge.toEdge };
    }
    const sides = pickSide(srcBox, tgtBox);
    return {
      srcEdge: edge.fromEdge || SIDE_TO_EDGE[sides.srcSide],
      tgtEdge: edge.toEdge || SIDE_TO_EDGE[sides.tgtSide],
    };
  });
}

// Cell index on `box`'s `side` that lines up with `other` along the shared axis
// (x for N/S, y for E/W). Prefers the two boxes' overlap band — computed
// identically from either end, so both connectors land on the same coordinate
// and the wire runs straight; with no overlap it clamps toward `other`, leaving
// only the single unavoidable jog.
function alignedIdx(side, box, other) {
  const horiz = side === "N" || side === "S";
  const bLo = horiz ? box.col : box.row;
  const bSpan = horiz ? box.w : box.h;
  const oLo = horiz ? other.col : other.row;
  const oSpan = horiz ? other.w : other.h;
  const lo = Math.max(bLo, oLo);
  const hi = Math.min(bLo + bSpan - 1, oLo + oSpan - 1);
  const coord = lo <= hi ? (lo + hi) / 2 : oLo + (oSpan - 1) / 2;
  return Math.max(0, Math.min(bSpan - 1, Math.round(coord - bLo)));
}

function allocateConnectors(edgeDefs, _boxes, boxById, opts = {}) {
  const centerMode = opts.centerConnectors === true; // anchor on side center, not overlap band
  const alloc = edgeSides(edgeDefs, boxById); // Pass 1 — sides (mutated below with symbols)

  // Pass 2 — symbols. Explicit fromConn/toConn win. The rest are ordered
  // *barycentrically*: each box side's edges are sorted by where their
  // counterpart box sits along that side's axis, then assigned connectors
  // around the center in that order. Wires leave the box already pointing
  // toward their destination — shorter runs, far fewer crossings at the box
  // face — the scrappy version of port assignment in orthogonal routers.
  const groups = new Map(); // "boxId|side" → [{i, role, explicit, other}]
  for (let i = 0; i < edgeDefs.length; i++) {
    const edge = edgeDefs[i], a = alloc[i];
    const srcBox = boxById.get(edge.from), tgtBox = boxById.get(edge.to);
    if (!srcBox || !tgtBox) continue;
    const add = (boxId, side, entry) => {
      const k = `${boxId}|${side}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(entry);
    };
    add(edge.from, a.srcEdge, {
      i,
      role: "src",
      explicit: edge.fromConn,
      other: tgtBox,
    });
    add(edge.to, a.tgtEdge, {
      i,
      role: "tgt",
      explicit: edge.toConn,
      other: srcBox,
    });
  }
  // Counterpart center along the side's axis: X for N/S sides, Y for E/W.
  const axisCoord = (side, box) =>
    (side === "N" || side === "S") ? box.col + box.w / 2 : box.row + box.h / 2;
  for (const [key, entries] of groups) {
    const sep = key.lastIndexOf("|");
    const box = boxById.get(key.slice(0, sep));
    const side = key.slice(sep + 1);
    const n = connCount(box, side);
    const total = entries.length; // explicit + auto share the side's span
    // `!= null` (not `!e.explicit`): connector index 0 is a valid pin — the
    // top/left slot — so it must count as explicit, not fall through to auto.
    const isPinned = (e) => e.explicit != null;
    const autos = entries.filter((e) => !isPinned(e));
    autos.sort((x, y) =>
      (axisCoord(side, x.other) - axisCoord(side, y.other)) || (x.i - y.i)
    );
    // Anchor the cluster on the overlap-aligned cell (median of members'
    // targets) instead of the box center, so a lone edge runs straight and a
    // cluster biases toward its counterparts. Barycentric order is preserved;
    // the symmetric ±spread keeps multi-edge sides evenly fanned. Indices are
    // emitted directly (resolveIdx passes numbers through); explicit pins win.
    const center = Math.floor((n - 1) / 2); // side-center connector index
    let anchor = center;
    // The offset that maps each ordered auto to a slot. center mode uses a
    // fractional base ((total-1)/2) so the fan is symmetric about the center —
    // a lone edge lands dead-center, even counts straddle it instead of
    // left-biasing. align mode (the de-kinker) uses an integer base and the
    // overlap-aligned anchor below.
    let offsetBase = (total - 1) / 2;
    if (!centerMode) {
      offsetBase = Math.floor((total - 1) / 2);
      // A lone destination connector defaults to the side center — the clean
      // "first connect" look — instead of the overlap-aligned cell. Multi-edge
      // sides still fan barycentrically, and lone *source* connectors keep their
      // overlap alignment, so the de-kinker's straight runs survive there.
      const loneDest = total === 1 && autos.length === 1 &&
        autos[0].role === "tgt";
      if (autos.length && !loneDest) {
        const targets = autos.map((e) => alignedIdx(side, box, e.other)).sort((
          a,
          b,
        ) => a - b);
        anchor = targets[Math.floor((targets.length - 1) / 2)];
        const hiBound = Math.max(offsetBase, n - total + offsetBase); // keep the ±spread on the side
        anchor = Math.max(offsetBase, Math.min(hiBound, anchor));
      }
    }
    autos.forEach((e, k) => {
      const idx = Math.max(
        0,
        Math.min(n - 1, Math.round(anchor + (k - offsetBase))),
      );
      if (e.role === "src") alloc[e.i].srcSym = idx;
      else alloc[e.i].tgtSym = idx;
    });
    for (const e of entries) {
      if (!isPinned(e)) continue;
      if (e.role === "src") alloc[e.i].srcSym = e.explicit;
      else alloc[e.i].tgtSym = e.explicit;
    }
  }
  return alloc;
}

/**
 * Route all edges using A*.
 * edgeDefs: { from, to, style, label?, fromEdge?, toEdge?, fromConn?, toConn? }
 * Returns array of route objects: { edge, path, color, dash, tgtExitDir? }.
 */
export function routeEdges(
  astarState,
  grid,
  edgeDefs,
  boxes,
  connMap,
  costs,
  pal = DEFAULT_PALETTE,
  opts = {},
) {
  const boxById = new Map(boxes.map((b) => [b.id, b]));
  const alloc = allocateConnectors(edgeDefs, boxes, boxById, opts);
  const routes = [];

  // A free endpoint (fromPos/toPos, set when its node was deleted) lives at a
  // bare grid cell — clamp it in-bounds; treat it as a 0-size box for side math.
  const freeCell = (pos) => ({
    gx: Math.max(0, Math.min(grid.cols - 1, Math.floor(pos.x / CELL))),
    gy: Math.max(0, Math.min(grid.rows - 1, Math.floor(pos.y / CELL))),
  });
  const cellCenterPx = (c) => ({
    x: c.gx * CELL + CELL / 2,
    y: c.gy * CELL + CELL / 2,
  });
  const asBox = (c) => ({ col: c.gx, row: c.gy, w: 0, h: 0 });

  for (let i = 0; i < edgeDefs.length; i++) {
    const edge = edgeDefs[i];
    // Named style is the preset base; explicit width/dash/color override one axis.
    const style = pal.edgeStyles[edge.style] || pal.edgeStyles.default;
    const color = edge.color
      ? resolveColorToken(pal, edge.color).border
      : style.color;
    const dash = edge.dash
      ? (DASH_TOKENS[edge.dash] || style.dash)
      : style.dash;
    const width = EDGE_WIDTHS[edge.width] ?? 2;
    // Per-edge cost overrides compose over the global costs (same {...global,
    // ...override} merge used for state.costs). Lets a single wire bias its own
    // routing — e.g. a response edge raising `overlap`/`turn` so it doesn't sit
    // on top of its request counterpart. A* runs per-edge, so the heuristic
    // stays consistent within each route.
    const ec = (edge.costs && typeof edge.costs === "object")
      ? { ...costs, ...edge.costs }
      : costs;

    const srcBox = boxById.get(edge.from);
    const tgtBox = boxById.get(edge.to);
    // Free end = the node is gone but a position was pinned (delete-keep-edges);
    // a node gone with no position stays unroutable (a bare orphan → path null).
    const srcFree = (!srcBox && edge.fromPos && Number.isFinite(edge.fromPos.x))
      ? freeCell(edge.fromPos)
      : null;
    const tgtFree = (!tgtBox && edge.toPos && Number.isFinite(edge.toPos.x))
      ? freeCell(edge.toPos)
      : null;
    if ((!srcBox && !srcFree) || (!tgtBox && !tgtFree)) {
      routes.push({ edge, path: null, color, dash, width });
      continue;
    }

    // ── Both ends bound to boxes: the common path. Untouched → byte-identical. ──
    if (srcBox && tgtBox) {
      const { srcEdge, tgtEdge, srcSym, tgtSym } = alloc[i];
      const srcResolved = Math.max(
        0,
        Math.min(
          connCount(srcBox, srcEdge) - 1,
          resolveIdx(srcBox, srcEdge, srcSym),
        ),
      );
      const tgtResolved = Math.max(
        0,
        Math.min(
          connCount(tgtBox, tgtEdge) - 1,
          resolveIdx(tgtBox, tgtEdge, tgtSym),
        ),
      );

      const srcConn = resolveConn(
        connMap,
        srcBox,
        srcEdge,
        srcResolved,
        tgtBox,
        grid,
      );
      const tgtConn = resolveConn(
        connMap,
        tgtBox,
        tgtEdge,
        tgtResolved,
        srcBox,
        grid,
      );

      if (!srcConn || !tgtConn) {
        console.warn(
          "No usable connector:",
          `${edge.from}_${srcEdge}_${srcResolved}`,
          "->",
          `${edge.to}_${tgtEdge}_${tgtResolved}`,
        );
        routes.push({ edge, path: null, color, dash, width });
        continue;
      }

      // Force a perpendicular entry into the target connector (clean, like the
      // source exit); relax it only if that leaves no route (e.g. the approach
      // cell is boxed in), preserving the old robustness.
      const entryDir = OPPOSITE_DIR[tgtConn.exitDir];
      const path = astar(
        astarState,
        grid,
        srcConn.gx,
        srcConn.gy,
        srcConn.exitDir,
        tgtConn.gx,
        tgtConn.gy,
        ec,
        entryDir,
      ) ||
        astar(
          astarState,
          grid,
          srcConn.gx,
          srcConn.gy,
          srcConn.exitDir,
          tgtConn.gx,
          tgtConn.gy,
          ec,
        );
      routes.push({
        edge,
        path,
        color,
        dash,
        width,
        tgtExitDir: tgtConn.exitDir,
      });
      if (path) { for (const p of path) grid.addCost(p.x, p.y, ec.overlap); }
      continue;
    }

    // ── At least one free end: route to/from a bare cell. The box side faces the
    //    free point; the free side carries no connector slot or entry/exit
    //    constraint. (Box↔box allocation above is left untouched.) ──
    const srcFreePx = srcFree ? cellCenterPx(srcFree) : null;
    const tgtFreePx = tgtFree ? cellCenterPx(tgtFree) : null;
    let sCP, tCP;
    if (srcBox) {
      const other = tgtBox || asBox(tgtFree);
      const side = sidePreference(srcBox, other)[0];
      sCP = resolveConn(
        connMap,
        srcBox,
        side,
        resolveIdx(srcBox, side, "C"),
        other,
        grid,
      );
    } else {
      sCP = { gx: srcFree.gx, gy: srcFree.gy, exitDir: D_NONE };
    }
    if (tgtBox) {
      const other = srcBox || asBox(srcFree);
      const side = sidePreference(tgtBox, other)[0];
      tCP = resolveConn(
        connMap,
        tgtBox,
        side,
        resolveIdx(tgtBox, side, "C"),
        other,
        grid,
      );
    } else {
      tCP = { gx: tgtFree.gx, gy: tgtFree.gy, exitDir: D_NONE };
    }
    if (!sCP || !tCP) { // box end couldn't find a connector — still expose the handle
      routes.push({
        edge,
        path: null,
        color,
        dash,
        width,
        srcFree: !!srcFree,
        tgtFree: !!tgtFree,
        srcFreePx,
        tgtFreePx,
      });
      continue;
    }
    const entryDir = tgtBox ? OPPOSITE_DIR[tCP.exitDir] : D_NONE;
    const path = astar(
      astarState,
      grid,
      sCP.gx,
      sCP.gy,
      sCP.exitDir,
      tCP.gx,
      tCP.gy,
      ec,
      entryDir,
    ) ||
      astar(astarState, grid, sCP.gx, sCP.gy, sCP.exitDir, tCP.gx, tCP.gy, ec);
    routes.push({
      edge,
      path,
      color,
      dash,
      width,
      tgtExitDir: tgtBox ? tCP.exitDir : undefined,
      srcFree: !!srcFree,
      tgtFree: !!tgtFree,
      srcFreePx,
      tgtFreePx,
    });
    if (path) { for (const p of path) grid.addCost(p.x, p.y, ec.overlap); }
  }

  return routes;
}

// ================================================================
// SNAP-ALIGN
// ================================================================
// A lane break is a gap between consecutive box centers larger than this fraction
// of the local box size. Relative to box size (not a fixed cell count) so it scales
// with the diagram: boxes sharing a column have near-equal centers, while a real
// column break is a gap on the order of a box width.
const LANE_BREAK_RATIO = 0.5;

export function snapAlign(axis, boxes, cols, rows) {
  const isH = axis === "h";
  if (boxes.length < 2) return false;
  // Center + extent of each box along the axis being aligned (H → columns/x).
  const entries = boxes.map((b) => ({
    box: b,
    center: isH ? b.col + b.w / 2 : b.row + b.h / 2,
    extent: isH ? b.w : b.h,
  }));
  entries.sort((a, b) => a.center - b.center);

  // Discover lanes from the data: start a new lane wherever the gap to the previous
  // box exceeds LANE_BREAK_RATIO of the local box size. Each lane is then snapped to
  // its own median center, so a box sitting alone stays put (nothing to align to).
  const lanes = [];
  let lane = [entries[0]];
  for (let k = 1; k < entries.length; k++) {
    const gap = entries[k].center - entries[k - 1].center;
    const localExtent = (entries[k].extent + entries[k - 1].extent) / 2;
    if (gap > LANE_BREAK_RATIO * localExtent) {
      lanes.push(lane);
      lane = [entries[k]];
    } else lane.push(entries[k]);
  }
  lanes.push(lane);

  let changed = false;
  for (const members of lanes) {
    if (members.length < 2) continue;
    const centers = members.map((e) => e.center).sort((a, b) => a - b);
    const median = centers[Math.floor(centers.length / 2)];
    for (const { box, extent } of members) {
      const target = Math.round(median - extent / 2); // new col (H) / row (V)
      if (target === (isH ? box.col : box.row)) continue;
      const nc = isH ? target : box.col;
      const nr = isH ? box.row : target;
      if (
        nc < EDGE_MARGIN || nc + box.w > cols - EDGE_MARGIN ||
        nr < EDGE_MARGIN || nr + box.h > rows - EDGE_MARGIN
      ) continue;
      const origCol = box.col, origRow = box.row;
      box.col = -999;
      box.row = -999;
      const collides = boxOverlaps(box, nc, nr, boxes);
      box.col = origCol;
      box.row = origRow;
      if (collides) continue;
      box.col = nc;
      box.row = nr;
      changed = true;
    }
  }
  return changed;
}

// ================================================================
// FORCE-DIRECTED SPREAD
// ================================================================
export function spreadBoxes(boxes, edgeDefs, cols, rows) {
  const ITERS = 30;
  const MAX_STEP = 2;
  const REPULSE = 800;
  const SPRING = 0.03;
  const CENTER_K = 0.02;
  const REST_LEN = 10;

  const boxById = new Map(boxes.map((b) => [b.id, b]));

  const edgePairs = edgeDefs
    .map((e) => [boxById.get(e.from), boxById.get(e.to)])
    .filter(([a, b]) => a && b);

  const canvasCX = cols / 2;
  const canvasCY = rows / 2;

  for (let iter = 0; iter < ITERS; iter++) {
    const fx = new Map(), fy = new Map();
    for (const b of boxes) {
      fx.set(b, 0);
      fy.set(b, 0);
    }

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const acx = a.col + a.w / 2, acy = a.row + a.h / 2;
        const bcx = b.col + b.w / 2, bcy = b.row + b.h / 2;
        let dx = acx - bcx, dy = acy - bcy;
        const dist2 = dx * dx + dy * dy;
        if (dist2 < 1) {
          dx = 1;
          dy = 1;
        }
        const dist = Math.sqrt(dist2);
        const force = REPULSE / dist2;
        const ux = dx / dist, uy = dy / dist;
        fx.set(a, fx.get(a) + ux * force);
        fy.set(a, fy.get(a) + uy * force);
        fx.set(b, fx.get(b) - ux * force);
        fy.set(b, fy.get(b) - uy * force);
      }
    }

    for (const [a, b] of edgePairs) {
      const acx = a.col + a.w / 2, acy = a.row + a.h / 2;
      const bcx = b.col + b.w / 2, bcy = b.row + b.h / 2;
      const dx = bcx - acx, dy = bcy - acy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue;
      const stretch = (dist - REST_LEN) * SPRING;
      const ux = dx / dist, uy = dy / dist;
      fx.set(a, fx.get(a) + ux * stretch);
      fy.set(a, fy.get(a) + uy * stretch);
      fx.set(b, fx.get(b) - ux * stretch);
      fy.set(b, fy.get(b) - uy * stretch);
    }

    for (const b of boxes) {
      const bcx = b.col + b.w / 2, bcy = b.row + b.h / 2;
      fx.set(b, fx.get(b) + (canvasCX - bcx) * CENTER_K);
      fy.set(b, fy.get(b) + (canvasCY - bcy) * CENTER_K);
    }

    for (const b of boxes) {
      let dx = fx.get(b), dy = fy.get(b);
      dx = Math.max(-MAX_STEP, Math.min(MAX_STEP, dx));
      dy = Math.max(-MAX_STEP, Math.min(MAX_STEP, dy));
      const ndx = Math.round(dx), ndy = Math.round(dy);
      if (ndx === 0 && ndy === 0) continue;
      const nc = b.col + ndx, nr = b.row + ndy;
      if (
        nc < EDGE_MARGIN || nc + b.w > cols - EDGE_MARGIN ||
        nr < EDGE_MARGIN || nr + b.h > rows - EDGE_MARGIN
      ) continue;
      const origCol = b.col, origRow = b.row;
      b.col = -999;
      b.row = -999;
      const collides = boxOverlaps(b, nc, nr, boxes);
      b.col = origCol;
      b.row = origRow;
      if (collides) continue;
      b.col = nc;
      b.row = nr;
    }
  }
}

// ================================================================
// DRAWING PRIMITIVES
// ================================================================

export function drawRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draw arrowhead at (x2,y2).
 * If `angle` is provided, use it directly (radians). Otherwise infer from (x1,y1)->(x2,y2).
 */
export function drawArrowhead(ctx, x2, y2, color, angle) {
  const a = angle ?? 0;
  const L = 7, sp = 0.4;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - L * Math.cos(a - sp), y2 - L * Math.sin(a - sp));
  ctx.lineTo(x2 - L * Math.cos(a + sp), y2 - L * Math.sin(a + sp));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// Map exit direction → arrow angle (arrow points OPPOSITE to exit, i.e. into the box)
const EXIT_DIR_TO_ARROW_ANGLE = {
  [D_N]: Math.PI / 2, // exit north → arrow points south (down)
  [D_E]: Math.PI, // exit east  → arrow points west  (left)
  [D_S]: -Math.PI / 2, // exit south → arrow points north (up)
  [D_W]: 0, // exit west  → arrow points east  (right)
};

// ================================================================
// HIGH-LEVEL DRAWING
// ================================================================

export function drawGridLines(ctx, cols, rows, cell, pal = DEFAULT_PALETTE) {
  ctx.strokeStyle = pal.gridLine;
  ctx.lineWidth = 0.5;
  for (let c = 0; c <= cols; c++) {
    ctx.beginPath();
    ctx.moveTo(c * cell, 0);
    ctx.lineTo(c * cell, rows * cell);
    ctx.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * cell);
    ctx.lineTo(cols * cell, r * cell);
    ctx.stroke();
  }
}

export function drawHeatmap(ctx, grid, cell, nearCost) {
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      const t = grid.get(x, y), e = grid.cost(x, y);
      if (t === T_BLOCKED) {
        ctx.fillStyle = "#da363322";
        ctx.fillRect(x * cell, y * cell, cell, cell);
      } else if (e > 0) {
        ctx.fillStyle = `rgba(255,152,0,${Math.min(e / nearCost, 1) * 0.38})`;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  }
}

// ─── Label-placement geometry (Phase 2b) ──────────────────────────
function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h &&
    a.y + a.h > b.y;
}
function segSeg(p1, p2, p3, p4) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1),
    d2 = d(p3, p4, p2),
    d3 = d(p1, p2, p3),
    d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function segHitsRect(p, q, r) {
  const inside = (pt) =>
    pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;
  if (inside(p) || inside(q)) return true;
  const c = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, {
    x: r.x + r.w,
    y: r.y + r.h,
  }, { x: r.x, y: r.y + r.h }];
  for (let i = 0; i < 4; i++) {
    if (segSeg(p, q, c[i], c[(i + 1) % 4])) return true;
  }
  return false;
}
// Chip rect + text baseline for a label centered on a segment midpoint, placed
// on the given side at the given perpendicular offset. above/below suit a
// horizontal wire, left/right a vertical one.
function labelPlacement(mx, my, tw, side, offset) {
  let lx, ly;
  if (side === "above") {
    lx = mx - tw / 2;
    ly = my - offset;
  } else if (side === "below") {
    lx = mx - tw / 2;
    ly = my + offset + 9;
  } else if (side === "left") {
    lx = mx - offset - tw;
    ly = my + 3;
  } else {
    lx = mx + offset;
    ly = my + 3;
  } // right
  return { lx, ly, rect: { x: lx - 3, y: ly - 9, w: tw + 6, h: 13 } };
}

// A free (unconnected) connector end — a hollow port; the editor lets you drag
// it onto a box to reconnect. Drawn in the wire's colour over the background.
function drawFreeHandle(ctx, x, y, color, bg) {
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.stroke();
}

// Where a horizontal segment of one wire crosses a vertical segment of another at
// a strict interior point of both: returns {x,y}, else null. Parallel, collinear,
// diagonal, and T-junction (endpoint-on-segment) cases all return null — only true
// over/under crossings qualify for a bridge gap.
function segCrossPoint(p1, p2, p3, p4) {
  const aH = Math.abs(p1.y - p2.y) < 0.5, aV = Math.abs(p1.x - p2.x) < 0.5;
  const bH = Math.abs(p3.y - p4.y) < 0.5, bV = Math.abs(p3.x - p4.x) < 0.5;
  let H, V;
  if (aH && bV) {
    H = [p1, p2];
    V = [p3, p4];
  } else if (aV && bH) {
    H = [p3, p4];
    V = [p1, p2];
  } else return null;
  const hy = H[0].y, vx = V[0].x;
  const hx0 = Math.min(H[0].x, H[1].x), hx1 = Math.max(H[0].x, H[1].x);
  const vy0 = Math.min(V[0].y, V[1].y), vy1 = Math.max(V[0].y, V[1].y);
  const eps = 0.5; // strict interior — a wire merely turning/ending here is not a crossing
  if (vx > hx0 + eps && vx < hx1 - eps && hy > vy0 + eps && hy < vy1 - eps) {
    return { x: vx, y: hy };
  }
  return null;
}

const nearPolyEnd = (pt, poly, m) =>
  Math.hypot(pt.x - poly[0].x, pt.y - poly[0].y) < m ||
  Math.hypot(pt.x - poly[poly.length - 1].x, pt.y - poly[poly.length - 1].y) <
    m;

// For each drawn wire, the points where it should break to pass *under* a later
// wire. z = index in `drawn` (= paint order), so wire i dips under every wire j>i
// it crosses; the over wire needs no change since it already paints on top. The
// gap is sized to the over wire so a thicker trace carves a proportional bridge.
// Crossings hugging either wire's endpoints are skipped — those are connectors and
// shared junctions, where a gap would just look like a broken wire.
export function computeBridgeBreaks(drawn, cell) {
  const breaks = drawn.map(() => []);
  const endMargin = cell * 0.5;
  for (let i = 0; i < drawn.length; i++) {
    const A = drawn[i].pts;
    for (let j = i + 1; j < drawn.length; j++) {
      const B = drawn[j].pts;
      const gap = (drawn[j].route.width ?? 2) / 2 + 3;
      for (let a = 0; a < A.length - 1; a++) {
        for (let b = 0; b < B.length - 1; b++) {
          const x = segCrossPoint(A[a], A[a + 1], B[b], B[b + 1]);
          if (
            !x || nearPolyEnd(x, A, endMargin) || nearPolyEnd(x, B, endMargin)
          ) continue;
          breaks[i].push({ x: x.x, y: x.y, gap });
        }
      }
    }
  }
  return breaks;
}

// Stroke an orthogonal polyline, lifting the pen for a small window around each
// break point (which always falls in a segment interior, never at a corner, so
// corners still render whole). Dash phase restarts per visible sub-segment — a
// cosmetic non-issue at these gap sizes.
function strokePolylineWithGaps(ctx, pts, breaks) {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 0.01) continue;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const wins = [];
    for (const br of breaks) {
      const t = (br.x - a.x) * ux + (br.y - a.y) * uy; // arc length to the break
      const perp = Math.abs((br.x - a.x) * -uy + (br.y - a.y) * ux);
      if (perp < 0.5 && t > 0 && t < len) wins.push([t - br.gap, t + br.gap]);
    }
    wins.sort((m, n) => m[0] - n[0]);
    let cursor = 0;
    const seg = (t0, t1) => {
      if (t1 - t0 <= 0.01) return;
      ctx.beginPath();
      ctx.moveTo(a.x + ux * t0, a.y + uy * t0);
      ctx.lineTo(a.x + ux * t1, a.y + uy * t1);
      ctx.stroke();
    };
    for (const [w0, w1] of wins) {
      seg(cursor, Math.max(cursor, w0));
      cursor = Math.max(cursor, w1);
    }
    seg(cursor, len);
  }
}

// Returns the label chip rects [{edge, rect:{x,y,w,h}}] in canvas px, so the
// editor can hit-test labels. The PNG renderer ignores the return value.
export function drawRoutes(
  ctx,
  routes,
  cell,
  pal = DEFAULT_PALETTE,
  opts = {},
) {
  const chipColor = pal.background;
  const labelRects = [];
  const allPolys = []; // every drawn wire's points — for label/line avoidance
  const labelTasks = []; // deferred to a second pass so labels can avoid each other + wires

  // Pass 0 — resolve every drawable route to its pixel polyline up front, so the
  // crossing-bridge pass can see all wires before any is stroked.
  const drawn = [];
  for (const route of routes) {
    if (!route.path || route.path.length < 2) {
      // No drawable path, but keep a free end's handle on screen so it's grabbable.
      if (route.srcFreePx) {
        drawFreeHandle(
          ctx,
          route.srcFreePx.x,
          route.srcFreePx.y,
          route.color,
          chipColor,
        );
      }
      if (route.tgtFreePx) {
        drawFreeHandle(
          ctx,
          route.tgtFreePx.x,
          route.tgtFreePx.y,
          route.color,
          chipColor,
        );
      }
      continue;
    }
    const pts = simplifyPath(
      route.path.map((p) => ({
        x: p.x * cell + cell / 2,
        y: p.y * cell + cell / 2,
      })),
    );
    allPolys.push(pts);
    drawn.push({ route, pts });
  }

  const breaks = opts.bridges === false
    ? null
    : computeBridgeBreaks(drawn, cell);

  for (let di = 0; di < drawn.length; di++) {
    const { route, pts } = drawn[di];
    const n = pts.length;
    const color = route.color;
    const dash = route.dash || [];

    ctx.strokeStyle = color;
    ctx.lineWidth = route.width ?? 2;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.setLineDash(dash);
    const myBreaks = breaks && breaks[di];
    if (myBreaks && myBreaks.length) {
      strokePolylineWithGaps(ctx, pts, myBreaks);
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Start dot — or a free-end handle if the source is unconnected.
    if (route.srcFree) {
      drawFreeHandle(ctx, pts[0].x, pts[0].y, color, chipColor);
    } else {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    // Arrowhead — match the actual final segment (snapped to a right angle), so
    // the head always aligns with the drawn wire. A* only constrains the source
    // exit, not the target entry, so a pinned/awkward target side can be reached
    // parallel to the box edge; keying off tgtExitDir then points the head 90°
    // off the wire. Fall back to the connector's exit normal only if the final
    // segment is degenerate. (Perpendicular entry — the common case — gives the
    // same angle either way.)
    if (route.tgtFree) {
      // Unconnected target → a draggable handle instead of an arrowhead.
      drawFreeHandle(ctx, pts[n - 1].x, pts[n - 1].y, color, chipColor);
    } else {
      let arrowAngle;
      const dx = pts[n - 1].x - pts[n - 2].x, dy = pts[n - 1].y - pts[n - 2].y;
      if (Math.hypot(dx, dy) > 0.5) {
        arrowAngle = Math.round(Math.atan2(dy, dx) / (Math.PI / 2)) *
          (Math.PI / 2);
      } else if (
        route.tgtExitDir !== undefined &&
        EXIT_DIR_TO_ARROW_ANGLE[route.tgtExitDir] !== undefined
      ) {
        arrowAngle = EXIT_DIR_TO_ARROW_ANGLE[route.tgtExitDir];
      } else {
        arrowAngle = 0;
      }
      drawArrowhead(ctx, pts[n - 1].x, pts[n - 1].y, color, arrowAngle);
    }

    // Edge label — defer placement to pass 2 (below) so labels can avoid each
    // other and wires. Pick the host segment now (longest by default; an
    // explicit labelPos.seg pins it — midpoint vertices tend to sit at corners
    // hard against a box).
    const label = route.edge.label;
    if (label) {
      const lp = route.edge.labelPos || {};
      let bi = 0, bestLen = -1;
      for (let i = 0; i < n - 1; i++) {
        const segLen = Math.abs(pts[i + 1].x - pts[i].x) +
          Math.abs(pts[i + 1].y - pts[i].y);
        if (segLen > bestLen) {
          bestLen = segLen;
          bi = i;
        }
      }
      if (Number.isInteger(lp.seg) && lp.seg >= 0 && lp.seg < n - 1) {
        bi = lp.seg;
      }
      const a = pts[bi], b = pts[bi + 1];
      const horiz = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
      labelTasks.push({
        route,
        label,
        lp,
        horiz,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      });
    }
  }

  // Pass 2 — place labels. An explicit labelPos.side/offset is honored verbatim.
  // Otherwise the historical position (above a horizontal wire / right of a
  // vertical one, 8px off) is used as-is UNLESS its chip overlaps an
  // already-placed label — only then do we search mirrored sides / larger
  // offsets, breaking ties by fewest wire crossings. So diagrams without label
  // collisions render byte-identically to before.
  ctx.font = `${(pal.sizes || DEFAULT_SIZES).edgeLabel}px ${pal.font}`;
  ctx.textAlign = "left";
  const wireCross = (rect) => {
    let c = 0;
    for (const poly of allPolys) {
      for (
        let i = 0;
        i < poly.length - 1;
        i++
      ) if (segHitsRect(poly[i], poly[i + 1], rect)) c++;
    }
    return c;
  };
  const placed = [];
  for (const t of labelTasks) {
    const tw = ctx.measureText(t.label).width;
    const baseOff = Number.isFinite(t.lp.offset) ? t.lp.offset : 8;
    const orient = t.horiz ? ["above", "below"] : ["right", "left"];
    const explicit = t.lp.side && (orient.includes(t.lp.side));
    let chosen;
    if (explicit) {
      chosen = labelPlacement(t.mx, t.my, tw, t.lp.side, baseOff);
    } else {
      const primary = labelPlacement(t.mx, t.my, tw, orient[0], baseOff);
      const overlapsLabel = (rect) => placed.some((p) => rectsOverlap(rect, p));
      if (!overlapsLabel(primary.rect)) {
        chosen = primary;
      } else {
        let best = primary, bestScore = 100 + wireCross(primary.rect);
        for (const off of [baseOff, baseOff * 2, baseOff * 3]) {
          for (const side of orient) {
            if (off === baseOff && side === orient[0]) continue; // == primary
            const cand = labelPlacement(t.mx, t.my, tw, side, off);
            const score = (overlapsLabel(cand.rect) ? 100 : 0) +
              wireCross(cand.rect);
            if (score < bestScore) {
              bestScore = score;
              best = cand;
            }
          }
        }
        chosen = best;
      }
    }
    ctx.fillStyle = chipColor;
    ctx.fillRect(chosen.rect.x, chosen.rect.y, chosen.rect.w, chosen.rect.h);
    ctx.fillStyle = pal.textDim;
    ctx.fillText(t.label, chosen.lx, chosen.ly);
    placed.push(chosen.rect);
    // mx/my/horiz describe the host segment so the editor can invert this
    // placement when a label is dragged (perpendicular distance → offset, sign
    // → side). The PNG renderer ignores the return value.
    labelRects.push({
      edge: t.route.edge,
      rect: chosen.rect,
      mx: t.mx,
      my: t.my,
      horiz: t.horiz,
    });
  }
  return labelRects;
}

/** Draw failed routes as red X markers. */
export function drawFailedRoutes(ctx, routes, boxes, cell) {
  ctx.save();
  ctx.setLineDash([]);
  const boxById = new Map(boxes.map((b) => [b.id, b]));
  for (const route of routes) {
    if (route.path !== null) continue;
    const srcBox = boxById.get(route.edge.from);
    const tgtBox = boxById.get(route.edge.to);
    if (srcBox && tgtBox) {
      const mx = ((srcBox.col + srcBox.w / 2) + (tgtBox.col + tgtBox.w / 2)) /
        2 * cell;
      const my = ((srcBox.row + srcBox.h / 2) + (tgtBox.row + tgtBox.h / 2)) /
        2 * cell;
      ctx.strokeStyle = "#f66";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(mx - 5, my - 5);
      ctx.lineTo(mx + 5, my + 5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(mx + 5, my - 5);
      ctx.lineTo(mx - 5, my + 5);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Apply an alpha to a colour, as `rgba(r, g, b, a)`.
 *
 * Replaces the old `color + "bb"` string concatenation, which was broken twice
 * over. It assumed 6-digit hex, so the default palette's 3-digit borders became
 * `"#68f" + "bb"` = `"#68fbb"` — not a colour at all. And even from 6-digit
 * input the 8-digit result is rejected by @gfx/canvas for strokeStyle (browsers
 * accept it; this Skia binding does not). Either way the assignment was ignored
 * and the box border drew in whatever colour happened to be current — black on
 * every board, themed or not. rgba() is understood by both.
 *
 * Non-hex input (named colours, existing rgb()/rgba()) is returned unchanged:
 * there is nothing sane to parse, and an unchanged colour is a better failure
 * than an invalid one.
 */
export function withAlpha(color, alpha) {
  if (typeof color !== "string") return color;
  const hex = color.trim();
  const m = /^#([0-9a-f]{3,8})$/i.exec(hex);
  if (!m) return color;
  const d = m[1];
  let r, g, b;
  if (d.length === 3 || d.length === 4) {
    r = parseInt(d[0] + d[0], 16);
    g = parseInt(d[1] + d[1], 16);
    b = parseInt(d[2] + d[2], 16);
  } else if (d.length === 6 || d.length === 8) {
    r = parseInt(d.slice(0, 2), 16);
    g = parseInt(d.slice(2, 4), 16);
    b = parseInt(d.slice(4, 6), 16);
  } else {
    return color; // 5 or 7 digits — not a colour
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// The alphas the box outline and its drop shadow are drawn at. These are the
// 0xbb / 0x44 of the old concatenation, kept identical so themed boards render
// as before (bar the black-border bug this fixes).
const OUTLINE_ALPHA = 0xbb / 255;
const SHADOW_ALPHA = 0x44 / 255;

export function drawBoxes(
  ctx,
  boxes,
  cell,
  pal = DEFAULT_PALETTE,
  { shadow = true } = {},
) {
  for (const b of boxes) {
    const x = b.col * cell, y = b.row * cell;
    const w = b.w * cell;
    const h = b.h * cell;
    const color = resolveColorToken(pal, b.color);

    ctx.save();
    // The drop shadow is decorative. The browser editor renders it correctly,
    // but native Skia (@gfx/canvas) renders shadowBlur displaced under
    // ctx.scale(DPR) — a phantom fill that overdraws neighbouring labels — so
    // the PNG renderer passes { shadow: false }. Re-enable if the lib fixes it.
    if (shadow) {
      ctx.shadowColor = withAlpha(color.border, SHADOW_ALPHA);
      ctx.shadowBlur = 12;
    }
    ctx.fillStyle = color.bg;
    drawRoundRect(ctx, x, y, w, h, 6);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = withAlpha(color.border, OUTLINE_ALPHA);
    ctx.lineWidth = OUTLINE_WIDTHS[b.outlineWidth] ?? 2;
    ctx.setLineDash(b.outlineDash ? (DASH_TOKENS[b.outlineDash] || []) : []);
    drawRoundRect(ctx, x, y, w, h, 6);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label — one or two wrapped title lines (labelLines from computeLayout; a
    // raw box without it falls back to its single label).
    const S = pal.sizes || DEFAULT_SIZES;
    const labelLines = b.labelLines || [b.label];
    // Center the text block vertically: the box may be taller than its content
    // (aspect floor / explicit height / wrapped title), so push the block down
    // by half the slack instead of letting it hug the top.
    const slackY =
      Math.max(0, h - nodeBoxHeight(b.details, S, labelLines.length)) / 2;
    let labelY = y + slackY + S.box.padTop + S.box.labelBaseline;
    ctx.fillStyle = pal.text;
    ctx.font = `bold ${S.label}px ${pal.font}`;
    ctx.textAlign = "left";
    for (const line of labelLines) {
      const labelW = ctx.measureText(line).width;
      ctx.fillText(line, x + (w - labelW) / 2, labelY);
      labelY += S.box.labelH;
    }
    labelY -= S.box.labelH; // back to the last drawn line's baseline for detail spacing

    // Detail lines
    if (b.details && b.details.length > 0) {
      ctx.fillStyle = pal.textDim;
      ctx.font = `${S.detail}px ${pal.font}`;
      const detailStartY = labelY + S.box.gap + S.box.detailH;
      b.details.forEach((line, di) => {
        const lineW = ctx.measureText(line).width;
        ctx.fillText(
          line,
          x + (w - lineW) / 2,
          detailStartY + di * S.box.detailH,
        );
      });
    }
  }
}

/**
 * Boundary dividers — full-width/-height dotted lines that partition the
 * canvas into regions (the "boxes inside boxes" alternative). Annotation only:
 * wires route straight through them, layout ignores them.
 *
 *   dividers: [{ orient: "h"|"v", at: <px>, label?, color?, dash? }]
 *
 * A horizontal divider runs across the canvas at y = at (label at the left
 * edge, above the line); a vertical one runs down at x = at (label at the
 * top, beside the line). Color defaults to the palette's dim text.
 */
export function drawDividers(ctx, dividers, W, H, pal = DEFAULT_PALETTE) {
  for (const d of dividers || []) {
    if (
      !d || (d.orient !== "h" && d.orient !== "v") || !Number.isFinite(d.at)
    ) continue;
    const color = d.color || pal.textDim;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    // Resolve dash tokens the way edges (routeEdges) and node outlines
    // (drawBoxes) do. Passing the raw value through meant a token string —
    // the spelling the rest of the API takes — reached Skia's setLineDash and
    // segfaulted the process. Arrays still pass through for existing boards.
    ctx.setLineDash(
      DASH_TOKENS[d.dash] || (Array.isArray(d.dash) ? d.dash : [2, 5]),
    );
    ctx.beginPath();
    if (d.orient === "h") {
      ctx.moveTo(0, d.at);
      ctx.lineTo(W, d.at);
    } else {
      ctx.moveTo(d.at, 0);
      ctx.lineTo(d.at, H);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (d.label) {
      ctx.font = `bold ${(pal.sizes || DEFAULT_SIZES).divider}px ${pal.font}`;
      ctx.textAlign = "left";
      const tw = ctx.measureText(d.label).width;
      const lx = d.orient === "h" ? 8 : d.at + 8;
      const ly = d.orient === "h" ? d.at - 6 : 14;
      ctx.fillStyle = pal.background;
      ctx.fillRect(lx - 3, ly - 9, tw + 6, 13);
      ctx.fillStyle = color;
      ctx.fillText(d.label, lx, ly);
    }
    ctx.restore();
  }
}

/**
 * Free-floating text annotations — "info panel" notes that live outside any
 * box: a caption next to a connector, a callout explaining a region, etc.
 *
 *   notes: [{ x, y, text: "…"|["line", …], title?, color? }]
 *
 * Drawn in dim text (or `color`) at absolute pixel position, optional bold
 * title line. Annotation only: no layout or routing interaction.
 */
/**
 * Resolve each note's effective pixel position, mirroring how nodes resolve
 * (authoring hint + absolute override):
 *   1. `noteLayout[note.id]` present → use it verbatim (a GUI drag wrote it).
 *   2. else `note.anchor` resolves to a solved box → box edge + dx/dy (the
 *      authoring hint — the note rides the box through re-layout).
 *   3. else fall back to the note's own absolute x/y (back-compat).
 * Returns note-like objects with resolved {x,y} so drawNotes stays a dumb
 * draw fn. `boxes` are the solved grid boxes from computeLayout.
 */
export function resolveNotePositions(notes, noteLayout = {}, boxes = []) {
  const byId = new Map((boxes || []).map((b) => [b.id, b]));
  const out = [];
  for (const nt of notes || []) {
    if (!nt) continue;
    let x = nt.x, y = nt.y;
    const ov = nt.id != null ? noteLayout[nt.id] : undefined;
    if (ov && Number.isFinite(ov.x) && Number.isFinite(ov.y)) {
      x = ov.x;
      y = ov.y;
    } else if (nt.anchor && byId.has(nt.anchor.to)) {
      const b = byId.get(nt.anchor.to);
      // Anchor to the *drawn* box, not its content extent. `pixW`/`pixH` are up
      // to a cell smaller than what gets painted, so an E-anchored note with
      // dx=0 used to land inside the visible border — and disagreed with the
      // `w`/`h` that solvePositions reports for the same box.
      const bx = b.col * CELL, by = b.row * CELL;
      const bw = b.w * CELL, bh = b.h * CELL;
      let ax = bx + bw, ay = by + bh / 2; // default E (right edge, vertical center)
      switch (nt.anchor.side) {
        case "W":
          ax = bx;
          ay = by + bh / 2;
          break;
        case "N":
          ax = bx + bw / 2;
          ay = by;
          break;
        case "S":
          ax = bx + bw / 2;
          ay = by + bh;
          break;
      }
      x = ax + (Number.isFinite(nt.anchor.dx) ? nt.anchor.dx : 0);
      y = ay + (Number.isFinite(nt.anchor.dy) ? nt.anchor.dy : 0);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ ...nt, x, y });
  }
  return out;
}

/**
 * Bounding size of a note's text block (for editor hit-testing). Width = widest
 * line; height runs from the first baseline down. Uses the same fonts as
 * drawNotes so the hit rect matches what's drawn.
 */
export function measureNote(ctx, note, pal = DEFAULT_PALETTE) {
  const S = pal.sizes || DEFAULT_SIZES;
  const lines = (Array.isArray(note.text) ? note.text : [note.text]).filter(
    (l) => l != null,
  );
  let w = 0;
  if (note.title) {
    ctx.font = `bold ${S.noteTitle}px ${pal.font}`;
    w = Math.max(w, ctx.measureText(note.title).width);
  }
  ctx.font = `${S.noteText}px ${pal.font}`;
  for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
  const h = (note.title ? Math.round(15 * S.scale) : 0) +
    lines.length * Math.round(14 * S.scale);
  return { w, h };
}

export function drawNotes(ctx, notes, pal = DEFAULT_PALETTE) {
  const S = pal.sizes || DEFAULT_SIZES;
  const titleGap = Math.round(15 * S.scale), lineH = Math.round(14 * S.scale);
  for (const nt of notes || []) {
    if (!nt || !Number.isFinite(nt.x) || !Number.isFinite(nt.y)) continue;
    const lines = (Array.isArray(nt.text) ? nt.text : [nt.text]).filter((l) =>
      l != null
    );
    const color = nt.color || pal.textDim;
    let y = nt.y;
    ctx.textAlign = "left";
    ctx.fillStyle = color;
    if (nt.title) {
      ctx.font = `bold ${S.noteTitle}px ${pal.font}`;
      ctx.fillText(nt.title, nt.x, y);
      y += titleGap;
    }
    ctx.font = `${S.noteText}px ${pal.font}`;
    for (const line of lines) {
      ctx.fillText(line, nt.x, y);
      y += lineH;
    }
  }
}

export function drawConnPoints(ctx, connMap, cell) {
  for (const [, cp] of connMap) {
    const px = cp.gx * cell + cell / 2, py = cp.gy * cell + cell / 2;
    ctx.beginPath();
    ctx.arc(px, py, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "#f0c04048";
    ctx.strokeStyle = "#f0c040aa";
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
  }
}
