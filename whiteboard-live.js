// deno-lint-ignore-file no-window no-window-prefix
/**
 * whiteboard-live.js — the interactive browser editor.
 *
 * Extracted from whiteboard-live.html so the ~2.8k lines of editor logic sit
 * under deno lint / fmt / check like the rest of the source. Loaded as
 * `<script type="module" src>`; imports diagram-core.js + themes.js from the
 * same directory, exactly as the inline version did.
 *
 * This file targets the BROWSER, not Deno — `window` is the correct global
 * here, so the two Deno-runtime rules about it are disabled above. Every other
 * lint rule applies (and earned its keep: the extraction immediately surfaced
 * four pieces of dead code the inline version had been hiding).
 */

import {
  BOARD_MARGIN,
  BOARD_MARGIN_BOTTOM,
  boardExtent,
  boardExtentForContent,
  boxOverlaps,
  buildGrid,
  CELL,
  computeLayout,
  connCount,
  createAstarState,
  DEFAULT_COSTS,
  deriveTheme,
  drawBoxes,
  drawConnPoints,
  drawDividers,
  drawFailedRoutes,
  drawGridLines,
  drawHeatmap,
  drawNotes,
  drawRoutes,
  EDGE_MARGIN,
  edgeSides,
  Grid,
  makePalette,
  measureNote,
  nodeBoxSize,
  resolveNotePositions,
  routeEdges,
  snapAlign as coreSnapAlign,
  spreadBoxes as coreSpread,
} from "./diagram-core.js";
import { DEFAULT_SCHEME, SCHEMES } from "./themes.js";

// Active palette — built per-diagram, passed to every draw call (no module
// state in the engine, so theme changes can't leak between diagrams).
let PAL = makePalette();
function rebuildPalette(state) {
  const tn = (state.theme && SCHEMES[state.theme])
    ? state.theme
    : DEFAULT_SCHEME;
  PAL = makePalette(deriveTheme(SCHEMES[tn]), state);
  return tn;
}
const validColors = () => Object.keys(PAL.colors);

// ─── Board selection ───────────────────────────────────────────
// ?d=<name> picks a whiteboard from the server's registry (GET /diagrams);
// no param = the server's default board. API is the URL prefix for all
// board-scoped requests (state, png, write endpoints).
const BOARD = new URLSearchParams(location.search).get("d") || "default";
const API = BOARD === "default" ? "" : "/d/" + BOARD;

// ================================================================
// STATE
// ================================================================
let diagramState = null;
let BOXES = [];
let NOTES = []; // resolved note hit-targets: {id, x, y, rect:{x,y,w,h}} (notes are pixel-native)
let noteLayoutLocal = {}; // per-note absolute {x,y} overrides (GUI drags); parallels the box layout snapshot
let noteDirty = false; // a note moved → persist the noteLayout snapshot
let hoverNoteId = null;
let EDGES_DEF = [];
let grid = null;
let connMap = new Map();
let routes = [];
let astarState = null;
let COLS = 100, ROWS = 60;
let CSS_W, CSS_H;

let costs = { ...DEFAULT_COSTS };
let showGrid = false, showHeat = false, showConn = false;
let dragMode = true, drag = null, didDrag = false;
let connectMode = false, connectSourceId = null, connectCursor = null;
// Hover affordances: the box/edge under the cursor (held by id / by from-to,
// never by object ref — mergeReload rebuilds BOXES and routes).
let hoverBoxId = null, hoverEdge = null, hoverLabel = false;
let hoverPin = false; // cursor is over a pin marker → click-to-unpin (pointer cursor)
let hoverEndpoint = null; // { edge, role } when over a connector endpoint handle → draggable
let hoverNub = null; // { boxId, side } when over a connect nub → drag out to create an edge
// Touch has no hover, so a tap "selects" a box/edge to reveal its nubs / endpoint
// handles (the hover replacement). Cleared by tapping empty space or dragging.
let selectedBoxId = null, selectedEdgeId = null;
const coarsePointer = matchMedia("(pointer: coarse)").matches; // finger-sized hit targets
let hoverFrame = null; // 'e' | 's' | 'se' when over a board-frame resize handle
let hoverResize = null; // { box, dir:'se' } when over a box's resize corner
let labelRects = []; // [{edge, rect}] from the last drawRoutes — edge-label hit targets
// Nodes the human manually placed (a subset of the full layout snapshot). Pure
// metadata — drives the pin marker; positions still come from the layout map.
let pinnedSet = new Set();
let pinsDirty = false; // pinnedSet changed without a move → persist anyway
let dimsDirty = false; // board bounds B resized without a move → persist anyway

// ─── Collaboration state ───────────────────────────────────────
let lastRev = 0; // rev we're synced to
let lastSentNonce = null; // nonce of our last POST (used in theme/costs/layout bodies)
// A SET of recently-sent nonces, not just the last: a burst of posts (e.g. the
// spread/collapse loop) each carry their own nonce. If the server's 150ms
// debounce doesn't coalesce them, an intermediate echo would miss a single
// lastSentNonce and trigger a spurious mergeReload. Membership in this set
// suppresses any of our own echoes; entries self-expire well after the debounce.
const sentNonces = new Set();
function newNonce() {
  const n = Math.random().toString(36).slice(2);
  sentNonces.add(n);
  setTimeout(() => sentNonces.delete(n), 5000);
  lastSentNonce = n;
  return n;
}
let baseline = new Map(); // id -> {col,row} at last sync with disk
let pendingReload = false; // an inbound change arrived mid-drag
let persistTimer = null;

// ================================================================
// CANVAS
// ================================================================
const cvs = document.getElementById("c");
const stage = document.querySelector(".stage");
const ctx = cvs.getContext("2d");
let DPR = 1;
let VIEW_W = 0, VIEW_H = 0; // canvas CSS-pixel size (= the stage)
// View transform: board → screen is  screen = (board - pan) * zoom.  panX/panY
// is the board point at the viewport's top-left; zoom is screen-px per board-px.
// The A* grid and every draw call stay in board pixels; pan/zoom lives entirely
// here and in canvasCoords' inverse, so the engine never sees the viewport.
const view = { panX: 0, panY: 0, zoom: 1 };
const MIN_ZOOM = 0.1, MAX_ZOOM = 4;
const FRAME_HANDLE_DRAW = 9; // visible handle size (screen px) — stays subtle on touch
const FRAME_HANDLE_HIT = coarsePointer ? 22 : 9; // grab tolerance (screen px) — generous for fingers, invisible
const FRAME_HANDLE_CAP = coarsePointer ? 28 : 18; // board-px ceiling — stays < the 40px content margin so it can't grab a box
const MAX_BOARD = 20000; // sane upper bound on a deliberate board resize
const DESK = "#010409", BOARD_FRAME = "#30363d";

// Size the backing store to the *stage* (not the board) — the board can now be
// larger or smaller than the viewport and is reached by pan/zoom.
function initCanvas() {
  DPR = window.devicePixelRatio || 1;
  // The board frame IS B (diagramState.width/height) — the exact export rectangle
  // the PNG renderer uses — so frame, readout, disk, and PNG all agree. The A*
  // grid (COLS×ROWS) sits just inside it (floor(B/CELL)); the sub-cell remainder
  // is export margin, never a routing cell. Falls back pre-load.
  CSS_W = diagramState?.width || COLS * CELL;
  CSS_H = diagramState?.height || ROWS * CELL;
  const r = stage.getBoundingClientRect();
  VIEW_W = Math.max(1, Math.round(r.width));
  VIEW_H = Math.max(1, Math.round(r.height));
  cvs.style.width = VIEW_W + "px";
  cvs.style.height = VIEW_H + "px";
  cvs.width = Math.round(VIEW_W * DPR);
  cvs.height = Math.round(VIEW_H * DPR);
}

// board → device-pixel transform for the current view.
function applyView() {
  const s = DPR * view.zoom;
  ctx.setTransform(s, 0, 0, s, -view.panX * s, -view.panY * s);
}
function clampZoom(z) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

// Fit the *content* (the actual diagram) into the viewport, centered, with only
// a thin margin — so the diagram fills the screen instead of floating inside the
// larger export frame. Falls back to the full board when there's no content.
function zoomToFit(margin = 16) {
  if (!VIEW_W || !VIEW_H) return;
  const e = contentExtent();
  const tx = e ? e.x : 0,
    ty = e ? e.y : 0,
    tw = e ? e.w : CSS_W,
    th = e ? e.h : CSS_H;
  view.zoom = clampZoom(
    Math.min((VIEW_W - 2 * margin) / tw, (VIEW_H - 2 * margin) / th),
  );
  view.panX = (tx + tw / 2) - VIEW_W / (2 * view.zoom);
  view.panY = (ty + th / 2) - VIEW_H / (2 * view.zoom);
}

// View (pan/zoom) persists per board so a reload restores where you were instead
// of snapping back to fit; manual pan/zoom survives too. First-ever open (no saved
// view) still fits, and the Fit button re-centers on demand (and re-saves).
const VIEW_KEY = "wb-view:" + BOARD;
let saveViewTimer = null;
function scheduleSaveView() {
  clearTimeout(saveViewTimer);
  saveViewTimer = setTimeout(saveView, 400);
}
function saveView() {
  try {
    localStorage.setItem(
      VIEW_KEY,
      JSON.stringify({ panX: view.panX, panY: view.panY, zoom: view.zoom }),
    );
  } catch {
    /* storage blocked (private browsing) — the view just won't persist */
  }
}
function restoreView() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
    if (
      v && Number.isFinite(v.panX) && Number.isFinite(v.panY) &&
      Number.isFinite(v.zoom)
    ) {
      view.panX = v.panX;
      view.panY = v.panY;
      view.zoom = clampZoom(v.zoom);
      return true;
    }
  } catch { /* absent or malformed — fall through to fit */ }
  return false;
}

// Zoom by `factor` keeping the board point under (clientX,clientY) fixed.
function zoomAtClient(clientX, clientY, factor) {
  const before = canvasCoords({ clientX, clientY });
  view.zoom = clampZoom(view.zoom * factor);
  const after = canvasCoords({ clientX, clientY });
  view.panX += before.x - after.x;
  view.panY += before.y - after.y;
}

// ================================================================
// REBUILD + RENDER
// ================================================================
function rebuild() {
  grid = new Grid(COLS, ROWS);
  connMap = buildGrid(grid, BOXES, costs);
  routes = routeEdges(astarState, grid, EDGES_DEF, BOXES, connMap, costs, PAL, {
    centerConnectors: diagramState.connectorAnchor === "center",
  });
}

// Resolve notes (anchor/override applied) against the current boxes and measure
// their hit rects. Cheap (a handful of notes) so it runs each render, keeping
// NOTES in sync for hit-testing. Returns the resolved list for drawNotes.
function buildNotes() {
  const resolved = resolveNotePositions(
    diagramState?.notes,
    noteLayoutLocal,
    BOXES,
  );
  NOTES = resolved.map((r) => {
    const m = measureNote(ctx, r, PAL);
    // Text baseline sits at r.y; the first line's cap is ~11px above. Pad the
    // rect a little so the thin text is an easy grab target.
    return {
      id: r.id,
      x: r.x,
      y: r.y,
      rect: { x: r.x - 4, y: r.y - 13, w: m.w + 8, h: m.h + 8 },
    };
  });
  return resolved;
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  ctx.fillStyle = DESK; // the "desk" outside the board
  ctx.fillRect(0, 0, cvs.width, cvs.height);

  applyView();
  ctx.fillStyle = PAL.background;
  ctx.fillRect(0, 0, CSS_W, CSS_H); // the board (export frame)

  if (showGrid) drawGridLines(ctx, COLS, ROWS, CELL, PAL);
  if (showHeat && grid) drawHeatmap(ctx, grid, CELL, costs.near);
  drawDividers(ctx, diagramState?.dividers, CSS_W, CSS_H, PAL);
  labelRects = drawRoutes(ctx, routes, CELL, PAL) || []; // stash for label hit-testing
  drawAlignGuides(); // smart alignment guides — under the boxes, so they peek out in the gaps
  drawBoxes(ctx, BOXES, CELL, PAL);
  drawPinOverlay(); // manual-placement markers (editor-only)
  drawNotes(ctx, buildNotes(), PAL);
  if (showConn || connectMode) drawConnPoints(ctx, connMap, CELL); // Connect mode reveals attach slots
  drawFailedRoutes(ctx, routes, BOXES, CELL);
  drawHoverOverlay(); // before connect overlay → source ring wins
  drawCreateNubs(); // drag-out-to-connect nubs on the hovered box
  drawEndpointOverlay(); // edge endpoint handles + drag rubber-band
  drawConnectOverlay();
  drawBoardFrame(); // export-frame border, on top
  updateZoomLabel(); // HUD tracks board/content/zoom each frame
  scheduleSaveView(); // persist pan/zoom (debounced) so reload restores it
}

// ── Smart alignment guides (Figma/Photoshop-style) ────────────────
// While dragging a box, its left/center/right and top/center/bottom lines snap to
// nearby boxes' matching lines (magnet), and the alignment is drawn as a guide.
const GUIDE_TOL = 2; // cells of magnetism (~30px); Alt-drag disables it
let dragGuides = null; // [{axis:'x'|'y', at, lo, hi}] for the current frame

// Nearest shift (cells) that aligns one of `mine`'s lines to a neighbor line within
// GUIDE_TOL, or null. `othersLines` is an array of each neighbor's [near,center,far].
function snapAxis(mine, othersLines) {
  let shift = null, dist = GUIDE_TOL + 1e-9;
  for (const m of mine) {
    for (const arr of othersLines) {
      for (const t of arr) {
        const d = Math.abs(t - m);
        if (d <= dist) {
          dist = d;
          shift = t - m;
        }
      }
    }
  }
  return shift;
}
// Guide lines satisfied with box `b` at (col,row): one per edge/center coincidence,
// each spanning the union of the two boxes along the perpendicular axis.
function computeGuides(b, col, row) {
  const map = new Map(); // dedupe coincident lines, widening their span
  const add = (axis, at, lo, hi) => {
    const k = axis + ":" + at, g = map.get(k);
    if (g) {
      g.lo = Math.min(g.lo, lo);
      g.hi = Math.max(g.hi, hi);
    } else map.set(k, { axis, at, lo, hi });
  };
  const bx = [col, col + b.w / 2, col + b.w],
    by = [row, row + b.h / 2, row + b.h];
  for (const o of BOXES) {
    if (o.id === b.id) continue;
    const ox = [o.col, o.col + o.w / 2, o.col + o.w],
      oy = [o.row, o.row + o.h / 2, o.row + o.h];
    for (const m of bx) {
      for (const t of ox) {
        if (Math.abs(m - t) < 0.5) {
          add("x", t, Math.min(row, o.row), Math.max(row + b.h, o.row + o.h));
        }
      }
    }
    for (const m of by) {
      for (const t of oy) {
        if (Math.abs(m - t) < 0.5) {
          add("y", t, Math.min(col, o.col), Math.max(col + b.w, o.col + o.w));
        }
      }
    }
  }
  return [...map.values()];
}
function drawAlignGuides() {
  if (!dragGuides || !dragGuides.length || !(drag && drag.b && !drag.kind)) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = "rgba(255,77,141,0.45)";
  ctx.lineWidth = 0.75 / view.zoom; // soft, thin magenta
  ctx.setLineDash([4 / view.zoom, 4 / view.zoom]);
  for (const g of dragGuides) {
    ctx.beginPath();
    if (g.axis === "x") {
      ctx.moveTo(g.at * CELL, g.lo * CELL);
      ctx.lineTo(g.at * CELL, g.hi * CELL);
    } else {
      ctx.moveTo(g.lo * CELL, g.at * CELL);
      ctx.lineTo(g.hi * CELL, g.at * CELL);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// The board's export frame, drawn as a thin border so the user can see B (the
// PNG boundary) against the content inside it. Width is 1/zoom board-px so it
// stays ~1 screen-px at any zoom.
function drawBoardFrame() {
  applyView();
  ctx.lineWidth = 1 / view.zoom;
  ctx.strokeStyle = BOARD_FRAME;
  ctx.strokeRect(0, 0, CSS_W, CSS_H);
  // Resize handles: 4 edge midpoints + 4 corners. Drawn at a constant screen
  // size; the active/hovered one lights up. E/S/SE resize in place; any handle
  // touching W or N slides content to follow (committed server-side).
  const s = FRAME_HANDLE_DRAW / view.zoom, h = s / 2;
  const active = drag?.kind === "frame" ? drag.edge : hoverFrame;
  const sq = (cx, cy, key) => {
    ctx.fillStyle = active === key ? "#58a6ff" : BOARD_FRAME;
    ctx.fillRect(cx - h, cy - h, s, s);
  };
  sq(CSS_W, CSS_H / 2, "e");
  sq(CSS_W / 2, CSS_H, "s");
  sq(0, CSS_H / 2, "w");
  sq(CSS_W / 2, 0, "n");
  sq(CSS_W, CSS_H, "se");
  sq(0, CSS_H, "sw");
  sq(CSS_W, 0, "ne");
  sq(0, 0, "nw");
  // Ghost rect at the prospective bounds while dragging a content-shifting edge
  // (content doesn't move until release, when the server slides it to follow).
  if (drag?.kind === "frame" && drag.ghost) {
    const g = drag.ghost;
    ctx.save();
    ctx.strokeStyle = "#58a6ff";
    ctx.lineWidth = 1 / view.zoom;
    ctx.setLineDash([6 / view.zoom, 4 / view.zoom]);
    ctx.strokeRect(g.left, g.top, g.right - g.left, g.bottom - g.top);
    ctx.restore();
  }
}

// Board-frame resize handle under a board-space point, or null. Corners win over
// edges; then edges along their full length. Tolerance is a constant screen
// distance (so it doesn't shrink when zoomed out).
function frameHandleAt(p) {
  // Capped (board-px) so it can never reach a box (content sits ≥40px inside B),
  // even when zoomed far out where a screen-constant tol would be huge.
  const tol = Math.min(FRAME_HANDLE_HIT / view.zoom, FRAME_HANDLE_CAP);
  const nearE = Math.abs(p.x - CSS_W) <= tol,
    nearS = Math.abs(p.y - CSS_H) <= tol;
  const nearW = Math.abs(p.x) <= tol, nearN = Math.abs(p.y) <= tol;
  const inY = p.y >= -tol && p.y <= CSS_H + tol,
    inX = p.x >= -tol && p.x <= CSS_W + tol;
  if (nearE && nearS) return "se";
  if (nearW && nearS) return "sw";
  if (nearE && nearN) return "ne";
  if (nearW && nearN) return "nw";
  if (nearE && inY) return "e";
  if (nearS && inX) return "s";
  if (nearW && inY) return "w"; // any W/N handle resizes with content translate (committed server-side)
  if (nearN && inX) return "n";
  return null;
}

// Box resize handle: the SE corner of any box (drag to grow/shrink w+h in cell
// increments). Corner only — sits away from connector endpoints/nubs (side
// midpoints), so it never competes with them. Board-space point.
const BOX_RESIZE_PX = 11;
function boxResizeAt(p) {
  const tol = BOX_RESIZE_PX / view.zoom;
  for (const b of BOXES) {
    const x1 = (b.col + b.w) * CELL, y1 = (b.row + b.h) * CELL;
    if (Math.abs(p.x - x1) <= tol && Math.abs(p.y - y1) <= tol) {
      return { box: b, dir: "se" };
    }
  }
  return null;
}

// Prospective B bounds while dragging a content-shifting (W/N-touching) handle:
// each moving edge follows the cursor, clamped so it can't cross into content.
function frameGhostBounds(edge, p) {
  const ext = contentExtent();
  const min = ext ? boardExtentForContent(ext) : null;
  const maxL = ext ? ext.x - BOARD_MARGIN : CSS_W,
    maxT = ext ? ext.y - BOARD_MARGIN : CSS_H;
  const minR = min ? min.W : 0, minB = min ? min.H : 0;
  return {
    left: edge.includes("w") ? Math.min(Math.round(p.x), maxL) : 0,
    top: edge.includes("n") ? Math.min(Math.round(p.y), maxT) : 0,
    right: edge.includes("e") ? Math.max(Math.round(p.x), minR) : CSS_W,
    bottom: edge.includes("s") ? Math.max(Math.round(p.y), minB) : CSS_H,
  };
}

// The smallest B that still contains all content (+ the renderer's 40/50 margin),
// so a frame-resize can't shrink the board into a box. Mirrors fitGridToBoxes.
function contentMinBounds() {
  const min = boardExtentForContent(
    contentExtent(),
    BOARD_MARGIN,
    BOARD_MARGIN_BOTTOM,
  );
  return { w: min.W, h: min.H };
}

// Pin markers: a small monochrome map-pin in the top-right corner of every
// manually-placed box. Editor-only (the PNG renderer never draws it).
// Pin marker glyph anchor (box top-right corner). Shared by the renderer and
// the click hit-test so the clickable target can't drift from the drawn dot.
function pinMarkerPos(b) {
  return { px: (b.col + b.w) * CELL - 6, py: b.row * CELL + 6 };
}

function drawPinOverlay() {
  if (pinnedSet.size === 0) return;
  ctx.save();
  for (const b of BOXES) {
    if (!pinnedSet.has(b.id)) continue;
    const { px, py } = pinMarkerPos(b);
    ctx.fillStyle = "#1f6feb";
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.fill(); // pin head
    ctx.beginPath();
    ctx.moveTo(px, py + 2);
    ctx.lineTo(px, py + 7); // pin stem
    ctx.strokeStyle = "#1f6feb";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

// Pinned box whose pin marker is under a canvas-space point, else null. Hit
// radius is generous vs. the ~4px glyph so the marker is easy to click; the
// test is anchored on the glyph's midpoint (head + stem). Used to click-unpin.
const PIN_HIT = 9;
function pinMarkerAt(p) {
  for (const b of BOXES) {
    if (!pinnedSet.has(b.id)) continue;
    const { px, py } = pinMarkerPos(b);
    if (Math.hypot(p.x - px, p.y - (py + 2)) <= PIN_HIT) return b;
  }
  return null;
}

// Hover chrome: ring the box, or glow the edge, under the cursor. Editor-only —
// drawn after the core draw calls, never inside diagram-core.
function drawHoverOverlay() {
  // Box hover ring + SE resize handle. The handle shows whenever a box is
  // hovered (discoverable); the cursor sitting on the corner (hoverResize) sets
  // hoverBoxId null, so ring off either signal.
  const ringId = hoverBoxId ?? selectedBoxId; // tap-selection rings the box on touch (no hover)
  const ringBox = hoverResize?.box ||
    (ringId !== null ? BOXES.find((x) => x.id === ringId) : null);
  if (ringBox) {
    const b = ringBox;
    const x = b.col * CELL, y = b.row * CELL, w = b.w * CELL, h = b.h * CELL;
    ctx.save();
    ctx.strokeStyle = PAL.colors[b.color]?.border || "#58a6ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x - 3, y - 3, w + 6, h + 6, 8);
    ctx.stroke();
    // SE resize handle — emphasized when the cursor is on it.
    ctx.fillStyle = "#1f6feb";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x + w, y + h, hoverResize ? 5 : 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  } else if (hoverEdge) {
    const route = routes.find((r) => sameEdge(r.edge, hoverEdge));
    if (!route || !route.path || route.path.length < 2) return;
    // Mirror hitTestEdge's cell→canvas point mapping (don't call into core).
    const pts = route.path.map((p) => ({
      x: p.x * CELL + CELL / 2,
      y: p.y * CELL + CELL / 2,
    }));
    ctx.save();
    ctx.strokeStyle = route.color;
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();
  }
}

// ── Draggable connector endpoints ───────────────────────────────
// An edge's two endpoint handles (src, tgt) as drawn, or null if neither end has
// a visible handle. Each side may be null when only one end is grabbable. Cells
// are centered exactly as drawRoutes draws them.
// Hit tolerances are compared in board space (canvasCoords already divided out
// the zoom), so a fixed board radius shrinks on screen as you zoom out — on a
// mobile fit-zoom a "7" can be ~2 CSS px. Convert a desired on-screen radius to
// board px at the current zoom, capped so an extreme zoom-out can't make the grab
// span unrelated geometry. (Mirrors the frame-handle's `/ view.zoom` sizing.)
const screenTol = (screenPx, capBoard) =>
  Math.min(screenPx / view.zoom, capBoard);
const ENDPOINT_HIT = coarsePointer ? 16 : 9; // on-screen grab radius (CSS px); fingers need more
// Canvas-space center of a box, or null if the id isn't a current box.
function boxCenterPx(id) {
  const b = BOXES.find((x) => x.id === id);
  return b
    ? { x: (b.col + b.w / 2) * CELL, y: (b.row + b.h / 2) * CELL }
    : null;
}
function edgeEndpoints(edge) {
  const route = routes.find((r) => sameEdge(r.edge, edge));
  if (!route) return null;
  const c = (p) => ({ x: p.x * CELL + CELL / 2, y: p.y * CELL + CELL / 2 });
  if (route.path && route.path.length >= 2) {
    return { src: c(route.path[0]), tgt: c(route.path[route.path.length - 1]) };
  }
  // Route failed to draw a path, but a *free* end still has a visible, grabbable
  // handle (drawRoutes renders it); box-anchored ends draw nothing.
  if (route.srcFreePx || route.tgtFreePx) {
    return { src: route.srcFreePx ?? null, tgt: route.tgtFreePx ?? null };
  }
  return null;
}

// The edge endpoint handle under a canvas-space point, or null. Scans every
// routed edge — endpoints sit on box perimeters, so this must win over box-drag
// there. Returns { edge, role:'src'|'tgt', x, y }.
function endpointAt(p) {
  const tol = screenTol(ENDPOINT_HIT, 28);
  for (const route of routes) {
    const eps = edgeEndpoints(route.edge);
    if (!eps) continue;
    if (eps.src && Math.hypot(p.x - eps.src.x, p.y - eps.src.y) <= tol) {
      return { edge: route.edge, role: "src", ...eps.src };
    }
    if (eps.tgt && Math.hypot(p.x - eps.tgt.x, p.y - eps.tgt.y) <= tol) {
      return { edge: route.edge, role: "tgt", ...eps.tgt };
    }
  }
  return null;
}

// Nearest box side (N/E/S/W code, as fromEdge/toEdge store it) to a canvas point.
function nearestSide(b, p) {
  const x0 = b.col * CELL,
    y0 = b.row * CELL,
    x1 = (b.col + b.w) * CELL,
    y1 = (b.row + b.h) * CELL;
  const dN = Math.abs(p.y - y0),
    dS = Math.abs(p.y - y1),
    dW = Math.abs(p.x - x0),
    dE = Math.abs(p.x - x1);
  const m = Math.min(dN, dS, dE, dW);
  return m === dN ? "N" : m === dS ? "S" : m === dE ? "E" : "W";
}

// Endpoint handles on the hovered edge, plus the live rubber-band shared by the
// endpoint drag (re-pin/retarget) and the create drag (drag-out-to-connect).
function drawEndpointOverlay() {
  // hover (mouse) or tap-selected (touch) edge exposes its draggable endpoints.
  const shownEdge = hoverEdge ||
    (selectedEdgeId ? EDGES_DEF.find((e) => e.id === selectedEdgeId) : null);
  if (shownEdge && !drag) { // handles vanish once any drag starts
    const eps = edgeEndpoints(shownEdge);
    if (eps) {
      ctx.save();
      ctx.fillStyle = "#1f6feb";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      for (const role of ["src", "tgt"]) {
        const h = eps[role];
        if (!h) continue; // a failed route may expose only one (free) end
        const big = hoverEndpoint && hoverEndpoint.role === role; // the one under the cursor
        ctx.beginPath();
        ctx.arc(h.x, h.y, big ? 5 : 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  if (drag?.kind === "endpoint" || drag?.kind === "create") {
    // Target-based feedback: blue when the drop will snap to a specific connector
    // slot (nub), gray when it'll land provisionally (empty space, or a box's auto
    // slot). The rubber-band stays drawn until release — it must not vanish when you
    // hover a target, even while the endpoint drag is live-routing an orthogonal path.
    const accent = drag.overSlot ? "#1f6feb" : "#8b949e"; // blue = nub landing, gray = provisional
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(drag.fixed.x, drag.fixed.y);
    ctx.lineTo(drag.cur.x, drag.cur.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (drag.overBox && drag.overBox.id !== drag.from) { // valid candidate drop box → green ring
      const b = drag.overBox;
      ctx.strokeStyle = "#3fb950";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.roundRect(
        b.col * CELL - 3,
        b.row * CELL - 3,
        b.w * CELL + 6,
        b.h * CELL + 6,
        8,
      );
      ctx.stroke();
    }
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(drag.cur.x, drag.cur.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ── Drag-out-to-connect (create) ────────────────────────────────
// "Connect nubs": one per connector slot on each side, just outside the box edge
// at that cell's center. A side has connCount(box, side) slots (box.w for N/S,
// box.h for E/W), indexed 0..n-1 — the same index space as fromConn/toConn.
// Dragging a nub out authors a new edge pinned to that exact slot (fromEdge +
// fromConn); dropping on a target slot pins the far end too.
const NUB_GAP = 11, NUB_HIT = coarsePointer ? 11 : 7; // on-screen grab radius (CSS px); createNubAt returns the nearest slot, so overlap resolves cleanly
// Canvas-space center of slot `idx` on `side`, sitting NUB_GAP outside the edge.
function nubPos(b, side, idx) {
  const x0 = b.col * CELL,
    y0 = b.row * CELL,
    x1 = (b.col + b.w) * CELL,
    y1 = (b.row + b.h) * CELL;
  if (side === "N") {
    return { x: (b.col + idx + 0.5) * CELL, y: y0 - NUB_GAP, side, idx };
  }
  if (side === "S") {
    return { x: (b.col + idx + 0.5) * CELL, y: y1 + NUB_GAP, side, idx };
  }
  if (side === "E") {
    return { x: x1 + NUB_GAP, y: (b.row + idx + 0.5) * CELL, side, idx };
  }
  return { x: x0 - NUB_GAP, y: (b.row + idx + 0.5) * CELL, side, idx }; // W
}
// All slot nubs for a box, keyed by side.
function boxNubs(b) {
  const out = { N: [], E: [], S: [], W: [] };
  for (const side of ["N", "E", "S", "W"]) {
    const n = connCount(b, side);
    for (let i = 0; i < n; i++) out[side].push(nubPos(b, side, i));
  }
  return out;
}
// The connect nub nearest a canvas-space point within NUB_HIT, or null. Scans
// all boxes/slots and returns the closest so adjacent slots resolve cleanly.
// Returns { box, side, idx, x, y }.
function createNubAt(p) {
  let best = null, bestD = screenTol(NUB_HIT, CELL); // screen-constant, capped at one cell so it can't reach a neighbor box's slots
  for (const b of BOXES) {
    for (const side of ["N", "E", "S", "W"]) {
      const n = connCount(b, side);
      for (let i = 0; i < n; i++) {
        const nb = nubPos(b, side, i);
        const d = Math.hypot(p.x - nb.x, p.y - nb.y);
        if (d <= bestD) {
          bestD = d;
          best = { box: b, side, idx: i, x: nb.x, y: nb.y };
        }
      }
    }
  }
  return best;
}
// Draw every connector slot on a box, dimmed, with `active` ({side, idx} or null)
// emphasized — the slot the cursor would snap to.
function drawBoxSlots(b, active) {
  const nubs = boxNubs(b);
  for (const side of ["N", "E", "S", "W"]) {
    for (const nb of nubs[side]) {
      const on = active && active.side === side && active.idx === nb.idx;
      ctx.fillStyle = on ? "#3fb950" : "rgba(63,185,80,0.45)";
      ctx.beginPath();
      ctx.arc(nb.x, nb.y, on ? 5.5 : 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
// Slots for the hovered box (discoverability, idle) or — during a create/endpoint
// drag — for the candidate target box, with the snapped slot highlighted.
function drawCreateNubs() {
  if (connectMode) return;
  ctx.save();
  ctx.strokeStyle = "#0d1117";
  ctx.lineWidth = 1.5;
  if (drag?.kind === "create" || drag?.kind === "endpoint") {
    const b = drag.overBox;
    // For create, the source box can't be its own target; for endpoint re-pin the
    // dragged end may legitimately land back on its own box, so show its slots.
    if (b && (drag.kind === "endpoint" || b.id !== drag.from)) {
      drawBoxSlots(
        b,
        drag.overSlot && drag.overSlot.box.id === b.id ? drag.overSlot : null,
      );
    }
    // Keep the originating nub lit for the whole create gesture, so the new
    // edge's anchor stays visible until it's placed or abandoned.
    if (drag.kind === "create" && drag.fixed) {
      ctx.fillStyle = "#3fb950";
      ctx.beginPath();
      ctx.arc(drag.fixed.x, drag.fixed.y, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  } else if (!drag) {
    const ids = new Set();
    if (hoverBoxId !== null) ids.add(hoverBoxId);
    if (selectedBoxId !== null) ids.add(selectedBoxId); // tap-revealed (touch)
    if (hoverNub) ids.add(hoverNub.boxId);
    for (const id of ids) {
      const b = BOXES.find((x) => x.id === id);
      if (b) {
        drawBoxSlots(b, hoverNub && hoverNub.boxId === id ? hoverNub : null);
      }
    }
  }
  ctx.restore();
}

// Connect-mode chrome: ring the chosen source node + rubber-band to the cursor.
function drawConnectOverlay() {
  if (!connectMode || !connectSourceId) return;
  const b = BOXES.find((x) => x.id === connectSourceId);
  if (!b) return;
  const x = b.col * CELL, y = b.row * CELL, w = b.w * CELL, h = b.h * CELL;
  ctx.save();
  ctx.strokeStyle = "#58a6ff";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
  if (connectCursor) {
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y + h / 2);
    ctx.lineTo(connectCursor.x, connectCursor.y);
    ctx.stroke();
  }
  ctx.restore();
}

// ================================================================
// DRAG
// ================================================================
cvs.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return; // primary button / touch — right-click & long-press open the menu
  if (e.pointerType === "touch") {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size >= 2) { // second finger → pinch-zoom; abandon the single-finger intent
      cancelLongPress();
      drag = null;
      updateCursor();
      const p = [...activePointers.values()];
      pinch = { dist: ptDist(p[0], p[1]) };
      render();
      return;
    }
    startLongPress(e); // hold-to-open-menu armed for any mode
  }
  if (!dragMode || connectMode) return;
  didDrag = false;
  dragDownX = e.clientX;
  dragDownY = e.clientY;
  dragMoved = false; // arm the movement threshold
  // keep move/up while off-canvas; throws if the pointer already ended
  try {
    cvs.setPointerCapture(e.pointerId);
    activePointerId = e.pointerId;
  } catch { /* pointer gone */ }
  const p = canvasCoords(e);
  const hit = hitTest(p);
  if (hit.kind === "note") {
    drag = {
      kind: "note",
      id: hit.note.id,
      ox: p.x - hit.note.x,
      oy: p.y - hit.note.y,
    };
    hoverBoxId = null;
    hoverEdge = null;
    hoverNoteId = hit.note.id;
    updateCursor();
    return;
  }
  if (hit.kind === "endpoint") {
    const eps = edgeEndpoints(hit.edge);
    // Capture the edge + its original endpoint binding so the live-route preview
    // (which transiently mutates the dragged end) can be restored on drop/cancel.
    const ed = EDGES_DEF.find((e) => e.id === hit.edge.id);
    // The other end anchors the rubber-band. On a failed route it may have no
    // drawn handle (box-anchored), so fall back to its box center, else the
    // grabbed handle itself — never null.
    const otherEnd = hit.endpoint.role === "src" ? eps.tgt : eps.src;
    const otherId = hit.endpoint.role === "src" ? hit.edge.to : hit.edge.from;
    const fixed = otherEnd ?? boxCenterPx(otherId) ??
      { x: hit.endpoint.x, y: hit.endpoint.y };
    drag = {
      kind: "endpoint",
      id: hit.edge.id,
      from: hit.edge.from,
      to: hit.edge.to,
      role: hit.endpoint.role,
      fixed,
      cur: p,
      overBox: null,
      edge: ed,
      saved: ed
        ? { from: ed.from, to: ed.to, fromPos: ed.fromPos, toPos: ed.toPos }
        : null,
      liveCell: null,
      live: false,
    };
    hoverBoxId = null;
    hoverEdge = null;
    hoverNoteId = null;
    hoverEndpoint = null;
    updateCursor();
    return;
  }
  if (hit.kind === "nub") {
    drag = {
      kind: "create",
      from: hit.nub.box.id,
      fromSide: hit.nub.side,
      fromConn: hit.nub.idx,
      fixed: { x: hit.nub.x, y: hit.nub.y },
      cur: p,
      overBox: null,
      overSlot: null,
    };
    hoverBoxId = null;
    hoverEdge = null;
    hoverNoteId = null;
    hoverEndpoint = null;
    hoverNub = null;
    updateCursor();
    return;
  }
  if (hit.kind === "pin") {
    pinnedSet.delete(hit.box.id);
    resolveAuto(new Set([hit.box.id]));
    setStatus("unpinned — re-laid out");
    return;
  }
  if (hit.kind === "frame") {
    drag = { kind: "frame", edge: hit.frame };
    hoverBoxId = null;
    hoverEdge = null;
    updateCursor();
    return;
  }
  if (hit.kind === "boxresize") {
    drag = { kind: "boxresize", b: hit.box };
    hoverBoxId = null;
    hoverEdge = null;
    hoverResize = null;
    updateCursor();
    return;
  }
  if (hit.kind === "box") {
    const gc = Math.floor(p.x / CELL), gr = Math.floor(p.y / CELL);
    drag = { b: hit.box, oc: gc - hit.box.col, or: gr - hit.box.row };
    hoverBoxId = null;
    hoverEdge = null; // the grabbed box follows the cursor; no hover ring
    updateCursor();
    return;
  }
  if (hit.kind === "label") {
    drag = {
      kind: "label",
      id: hit.edge.id,
      from: hit.edge.from,
      to: hit.edge.to,
      mx: hit.label.mx,
      my: hit.label.my,
      horiz: hit.label.horiz,
    };
    hoverBoxId = null;
    hoverEdge = null;
    hoverNoteId = null;
    updateCursor();
    return;
  }
  if (hit.kind === "empty" || hit.kind === "edge") { // empty/edge space → pan the viewport
    // tapKind/tapEdge let a no-move tap reveal an edge's endpoints (touch) or clear selection on empty.
    drag = {
      kind: "pan",
      sx: e.clientX,
      sy: e.clientY,
      px: view.panX,
      py: view.panY,
      tapKind: hit.kind,
      tapEdge: hit.edge || null,
    };
    updateCursor();
  }
});

cvs.addEventListener("pointermove", (e) => {
  if (activePointers.has(e.pointerId)) {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }
  if (pinch) { // two fingers down → scale around their midpoint
    if (activePointers.size >= 2) {
      const p = [...activePointers.values()];
      const nd = ptDist(p[0], p[1]);
      if (pinch.dist > 0 && nd > 0) {
        zoomAtClient(
          (p[0].x + p[1].x) / 2,
          (p[0].y + p[1].y) / 2,
          nd / pinch.dist,
        );
        render();
      }
      pinch.dist = nd;
    }
    return; // suppress single-finger drag while pinching
  }
  if (
    lpStart &&
    Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > LP_MOVE
  ) cancelLongPress(); // moved → it's a drag
  if (connectMode && connectSourceId) {
    const p = canvasCoords(e);
    connectCursor = p;
    render();
    return;
  }
  if (drag && !dragMoved) { // hold mutation until past the slop radius
    if (Math.hypot(e.clientX - dragDownX, e.clientY - dragDownY) < DRAG_SLOP) {
      return;
    }
    dragMoved = true;
  }
  if (drag?.kind === "pan") {
    didDrag = true;
    const r = cvs.getBoundingClientRect();
    view.panX = drag.px -
      (e.clientX - drag.sx) * (VIEW_W / r.width) / view.zoom;
    view.panY = drag.py -
      (e.clientY - drag.sy) * (VIEW_H / r.height) / view.zoom;
    render();
    return;
  }
  if (drag?.kind === "frame") {
    didDrag = true;
    const p = canvasCoords(e);
    if (!drag.edge.includes("w") && !drag.edge.includes("n")) { // E/S/SE → resize in place (no content move)
      const min = contentMinBounds();
      if (drag.edge.includes("e")) {
        CSS_W = diagramState.width = Math.max(
          min.w,
          Math.min(MAX_BOARD, Math.round(p.x)),
        );
      }
      if (drag.edge.includes("s")) {
        CSS_H = diagramState.height = Math.max(
          min.h,
          Math.min(MAX_BOARD, Math.round(p.y)),
        );
      }
    } else { // touches W/N → ghost preview; commit (with content shift) on drop
      drag.ghost = frameGhostBounds(drag.edge, p);
    }
    render(); // grid/routes unchanged (boxes don't move) — resync on drop
    return;
  }
  if (drag?.kind === "boxresize") {
    didDrag = true;
    const p = canvasCoords(e);
    const b = drag.b;
    const node = diagramState.nodes.find((n) => n.id === b.id);
    // Cursor → target cell size (NW corner fixed). Probe nodeBoxSize on a copy
    // (no shared-state mutation yet): it wraps the title to the new width and
    // clamps both axes to the content/card floor, so the title reflows live and
    // the box can't shrink small enough to clip.
    const targetW = Math.max(1, Math.round(p.x / CELL) - b.col);
    const targetH = Math.max(1, Math.round(p.y / CELL) - b.row);
    const sz = nodeBoxSize(
      ctx,
      { ...node, w: targetW, h: targetH },
      PAL.font,
      PAL.sizes,
    );
    const w = Math.ceil(sz.w / CELL), h = Math.ceil(sz.h / CELL);
    if (
      w === b.w && h === b.h &&
      sz.labelLines.length === (b.labelLines?.length ?? 1)
    ) return;
    // Refuse a resize that would collide with a neighbor (mirrors box-move),
    // else the enlarged box would block their shared connector cells.
    if (
      boxOverlaps(
        { ...b, w, h },
        b.col,
        b.row,
        BOXES.filter((x) => x !== b),
      )
    ) return;
    node.w = targetW;
    node.h = targetH;
    b.w = w;
    b.h = h;
    b.pixW = sz.w;
    b.pixH = sz.h;
    b.labelLines = sz.labelLines;
    fitGridToBoxes();
    rebuild();
    render(); // grow B if needed, re-grid, re-route
    return;
  }
  if (drag?.kind === "note") {
    didDrag = true;
    const p = canvasCoords(e);
    const nx = Math.max(0, Math.min(CSS_W, p.x - drag.ox));
    const ny = Math.max(0, Math.min(CSS_H, p.y - drag.oy));
    noteLayoutLocal[drag.id] = { x: Math.round(nx), y: Math.round(ny) }; // a drag pins the note (override wins)
    noteDirty = true;
    render();
    return;
  }
  if (drag?.kind === "label") {
    didDrag = true;
    const p = canvasCoords(e);
    // Invert labelPlacement: distance from the host-segment midpoint → offset,
    // which side of it the cursor is on → side (cross the wire to flip).
    let side, offset;
    if (drag.horiz) {
      side = p.y < drag.my ? "above" : "below";
      offset = Math.abs(p.y - drag.my);
    } else {
      side = p.x < drag.mx ? "left" : "right";
      offset = Math.abs(p.x - drag.mx);
    }
    offset = Math.max(0, Math.min(400, Math.round(offset)));
    const edge = diagramState.edges.find((x) => x.id === drag.id);
    if (edge) {
      const lp = { side, offset };
      if (Number.isInteger(edge.labelPos?.seg)) lp.seg = edge.labelPos.seg; // preserve a pinned segment
      edge.labelPos = lp;
      render(); // routing is unchanged; only label placement moves
    }
    return;
  }
  if (drag?.kind === "endpoint" || drag?.kind === "create") {
    didDrag = true;
    drag.cur = canvasCoords(e);
    // A slot just outside a box edge also targets that box, so dropping precisely
    // on a slot works even though the cursor sits outside the box rect.
    drag.overSlot = createNubAt(drag.cur);
    drag.overBox = drag.overSlot ? drag.overSlot.box : nodeAt(e);
    // Cursor affords the landing: copy = will attach to a target, grabbing = free drag.
    cvs.style.cursor = (drag.overSlot || drag.overBox) ? "copy" : "grabbing";
    if (drag.kind === "endpoint") liveRouteEndpoint(e); // re-route the dragged wire live (cell-throttled)
    else render();
    return;
  }
  if (!drag) {
    updateHover(e);
    return;
  }
  didDrag = true;
  const { gc, gr } = cellAt(e);
  const clampC = (c) =>
    Math.max(EDGE_MARGIN, Math.min(COLS - drag.b.w - EDGE_MARGIN, c));
  const clampR = (r) =>
    Math.max(EDGE_MARGIN, Math.min(ROWS - drag.b.h - EDGE_MARGIN, r));
  const rawNc = clampC(gc - drag.oc), rawNr = clampR(gr - drag.or);
  let nc = rawNc, nr = rawNr;
  if (!e.altKey) { // Alt-drag = free placement (magnet off)
    const others = BOXES.filter((o) => o.id !== drag.b.id);
    const sx = snapAxis(
      [nc, nc + drag.b.w / 2, nc + drag.b.w],
      others.map((o) => [o.col, o.col + o.w / 2, o.col + o.w]),
    );
    const sy = snapAxis(
      [nr, nr + drag.b.h / 2, nr + drag.b.h],
      others.map((o) => [o.row, o.row + o.h / 2, o.row + o.h]),
    );
    if (sx !== null) nc = clampC(Math.round(nc + sx));
    if (sy !== null) nr = clampR(Math.round(nr + sy));
  }
  if (nc !== drag.b.col || nr !== drag.b.row) {
    if (boxOverlaps(drag.b, nc, nr, BOXES)) {
      nc = rawNc;
      nr = rawNr; // snapped into a neighbor → unsnapped fallback
      if (nc === drag.b.col && nr === drag.b.row) return;
      if (boxOverlaps(drag.b, nc, nr, BOXES)) {
        if (dragGuides) {
          dragGuides = null;
          render();
        }
        return;
      }
    }
    drag.b.col = nc;
    drag.b.row = nr;
    dragGuides = computeGuides(drag.b, nc, nr);
    rebuild();
    render();
  }
});

// A no-move tap selects a box/edge to reveal its connector affordances (the
// touch hover replacement); tapping it again, tapping empty space, or any real
// drag clears the selection.
function updateTapSelection(pointerType) {
  if (pointerType !== "touch") return; // desktop has hover; leave it alone
  hoverBoxId = null;
  hoverEdge = null; // touch has no hover-out; selection is the only reveal
  if (didDrag) {
    selectedBoxId = selectedEdgeId = null;
    return;
  } // a drag, not a tap
  if (!drag) return;
  if (drag.b && !drag.kind) { // tapped a box
    selectedBoxId = selectedBoxId === drag.b.id ? null : drag.b.id;
    selectedEdgeId = null;
  } else if (drag.kind === "pan" && drag.tapKind === "edge" && drag.tapEdge) {
    selectedEdgeId = selectedEdgeId === drag.tapEdge.id
      ? null
      : drag.tapEdge.id;
    selectedBoxId = null;
  } else if (drag.kind === "pan") { // tapped empty space
    selectedBoxId = selectedEdgeId = null;
  }
}

cvs.addEventListener("pointerup", (e) => {
  cancelLongPress();
  const wasPinching = !!pinch;
  dropPointer(e);
  if (activePointerId !== null) {
    try {
      cvs.releasePointerCapture(activePointerId);
    } catch { /* already released */ }
    activePointerId = null;
  }
  if (wasPinching) return; // tail of a pinch — no tap/drag commit
  if (!lpFired) updateTapSelection(e.pointerType); // hover replacement for touch — run before the branches consume `drag`
  // Frame-resize drop: resync the grid/A* to the new B and persist it. The 40/50
  // clamp during the drag keeps B ⊇ E, so fitGridToBoxes won't re-grow it.
  if (drag?.kind === "frame") {
    const moved = didDrag, edge = drag.edge, ghost = drag.ghost;
    drag = null;
    updateCursor();
    if (moved && ghost) {
      // Any W/N-touching handle: the diagram slides to follow the moved edge(s).
      // Let the server do the shift (nodes + notes + dividers, atomic) — per-side
      // deltas from the ghost vs the original bounds — then reload the result.
      render();
      const exp = {};
      if (edge.includes("w")) exp.left = -ghost.left;
      if (edge.includes("n")) exp.up = -ghost.top;
      if (edge.includes("e")) exp.right = ghost.right - CSS_W;
      if (edge.includes("s")) exp.down = ghost.bottom - CSS_H;
      // A W/N expand shifts all content by (left, up) in board space (see
      // expandCanvas). Pan the view by the same amount so content stays visually
      // put and the dragged edge follows the cursor — instead of the edge staying
      // fixed while content slides toward it.
      view.panX += exp.left || 0;
      view.panY += exp.up || 0;
      commitCanvasResize(exp);
    } else if (moved) { // E/S/SE in-place resize
      fitGridToBoxes();
      rebuild();
      render();
      dimsDirty = true;
      schedulePersist();
      setStatus(`canvas ${diagramState.width}×${diagramState.height}`);
    } else render();
    if (pendingReload) {
      pendingReload = false;
      mergeReload();
    }
    return;
  }
  // Box-resize drop: persist explicit w/h (cells) on the node; if the box grew
  // the board, the dims ride along via schedulePersist.
  if (drag?.kind === "boxresize") {
    const b = drag.b, moved = didDrag;
    drag = null;
    updateCursor();
    if (moved) {
      hoverBoxId = b.id;
      const node = diagramState.nodes.find((n) => n.id === b.id);
      fitGridToBoxes();
      rebuild();
      render();
      // Persist the size first; only then the board-size snapshot. Sequencing
      // them avoids a /layout save racing ahead with a stale baseRev (409 →
      // mergeReload, which doesn't carry node.w/h and would drop the resize).
      postNode({ action: "update", id: b.id, fields: { w: node.w, h: node.h } })
        .then(() => {
          setStatus(
            `resized ${b.id} → ${node.w}×${node.h} cells (rev ${lastRev})`,
          );
          if (dimsDirty) schedulePersist();
        })
        .catch((err) => setStatus("resize save failed: " + err.message));
    } else render();
    if (pendingReload) {
      pendingReload = false;
      mergeReload();
    }
    return;
  }
  // Label drop: persist the new labelPos directly (nonce-suppressed; no
  // mergeReload — placement changed, routing didn't).
  if (drag?.kind === "label") {
    const moved = didDrag; // a no-move click falls through to open the editor
    const { id } = drag;
    drag = null;
    updateCursor();
    render();
    if (moved) {
      const edge = diagramState.edges.find((x) => x.id === id);
      if (edge) {
        postEdge({ action: "update", id, fields: { labelPos: edge.labelPos } })
          .then(() => setStatus("label moved (rev " + lastRev + ")"))
          .catch((err) => setStatus("label save failed: " + err.message));
      }
    }
    if (pendingReload) {
      pendingReload = false;
      mergeReload();
    }
    return;
  }
  // Endpoint drop: re-pin a side (own box) or retarget to another box.
  if (drag?.kind === "endpoint") {
    const moved = didDrag; // a no-move click falls through to the edge editor
    const { id, role, overBox, overSlot, cur, edge, saved } = drag;
    const slot = overSlot && overBox && overSlot.box.id === overBox.id
      ? { side: overSlot.side, idx: overSlot.idx }
      : null;
    restoreEnd(edge, saved); // undo the live-route preview; commit applies the real change
    drag = null;
    updateCursor();
    rebuild();
    render();
    if (moved && overBox) commitEndpointDrag(id, role, overBox, cur, slot);
    else if (moved) repositionFreeEnd(id, role, cur); // loose end → move it; bound end → no-op
    if (pendingReload) {
      pendingReload = false;
      mergeReload();
    }
    return;
  }
  // Create drop: drag out from a nub onto another box → new edge.
  if (drag?.kind === "create") {
    const moved = didDrag;
    const { from, fromSide, fromConn, overBox, overSlot } = drag;
    // Pin the target slot only when the drop landed on a specific slot of the
    // drop box; a loose drop inside the box keeps the auto-picked target side.
    const tgtSlot = overSlot && overBox && overSlot.box.id === overBox.id
      ? { side: overSlot.side, idx: overSlot.idx }
      : null;
    drag = null;
    updateCursor();
    render();
    if (moved && overBox && overBox.id !== from) {
      commitCreateDrag(from, fromSide, fromConn, overBox, tgtSlot);
    } else if (moved && overBox) {
      setStatus("connect: cannot link a node to itself");
    } else if (moved) setStatus("connect: dropped on empty — no edge");
    if (pendingReload) {
      pendingReload = false;
      mergeReload();
    }
    return;
  }
  // Pan drop: pure view change — nothing to persist. render() so a no-move tap on
  // empty space repaints after updateTapSelection cleared any tap-selection.
  if (drag?.kind === "pan") {
    drag = null;
    updateCursor();
    render();
    if (pendingReload) {
      pendingReload = false;
      mergeReload();
    }
    return;
  }
  const wasDragging = !!drag;
  const wasNote = drag?.kind === "note";
  if (wasDragging && !wasNote) {
    if (e.pointerType !== "touch") hoverBoxId = drag.b.id; // cursor still over the dropped box (touch: selection drives nubs)
    if (!pinnedSet.has(drag.b.id)) {
      pinnedSet.add(drag.b.id);
      pinsDirty = true;
    } // a hand-placed box is pinned
  }
  drag = null;
  updateCursor();
  if (wasDragging) {
    render();
    schedulePersist();
  } // re-show hover ring + auto-persist the drag
  if (pendingReload) {
    pendingReload = false;
    mergeReload();
  } // apply deferred inbound change
});

// Commit an endpoint drag. Dropped on the edge's own box → re-pin that end's
// side (fromEdge/toEdge) to the nearest side/slot; dropped on another box →
// retarget that end (server-side atomic, by edge id). Parallel edges are allowed,
// so retarget no longer guards against an existing edge on the same pair — only
// self-loops. The edge is located by its stable id throughout.
async function commitEndpointDrag(id, role, dropBox, cur, slot) {
  const edge = diagramState.edges.find((x) => x.id === id);
  if (!edge) return;
  const ownBox = role === "src" ? edge.from : edge.to;
  const edgeKey = role === "src" ? "fromEdge" : "toEdge";
  const connKey = role === "src" ? "fromConn" : "toConn";
  try {
    if (dropBox.id === ownBox) {
      // Re-pin this end. A precise slot pins side + connector; a loose drop on the
      // box pins just the side and clears the connector back to auto.
      const side = slot ? slot.side : nearestSide(dropBox, cur);
      await postEdge({
        action: "update",
        id,
        fields: { [edgeKey]: side, [connKey]: slot ? slot.idx : null },
      });
      setStatus(
        `${role === "src" ? "source" : "target"} → ${SIDE_NAME[side]}${
          slot ? " #" + slot.idx : ""
        } (rev ${lastRev})`,
      );
    } else {
      const newFrom = role === "src" ? dropBox.id : edge.from;
      const newTo = role === "tgt" ? dropBox.id : edge.to;
      if (newFrom === newTo) {
        setStatus("cannot connect a node to itself");
        return;
      }
      // retarget clears the moved end's side/connector pins; re-apply them if the
      // drop landed on a specific slot of the new box. id is stable across retarget.
      await postEdge({ action: "retarget", id, newFrom, newTo });
      if (slot) {
        await postEdge({
          action: "update",
          id,
          fields: { [edgeKey]: slot.side, [connKey]: slot.idx },
        });
      }
      setStatus(
        `retargeted ${newFrom} → ${newTo}${
          slot ? " @" + slot.side + slot.idx : ""
        } (rev ${lastRev})`,
      );
    }
    await mergeReload(); // routing changed — pull fresh state + re-solve
  } catch (e) {
    setStatus("endpoint update failed: " + e.message);
  }
}

// Endpoint dropped on empty space: if this end is loose (free, has from/toPos),
// move its pinned position to the drop point; a bound end stays put (detaching a
// connected end is not a gesture yet).
async function repositionFreeEnd(id, role, cur) {
  const edge = diagramState.edges.find((x) => x.id === id);
  const posKey = role === "src" ? "fromPos" : "toPos";
  if (!edge || !edge[posKey]) {
    setStatus("endpoint: dropped on empty — no change");
    return;
  }
  try {
    await postEdge({
      action: "update",
      id,
      fields: { [posKey]: { x: Math.round(cur.x), y: Math.round(cur.y) } },
    });
    setStatus(`loose end moved (rev ${lastRev})`);
    await mergeReload();
  } catch (e) {
    setStatus("move failed: " + e.message);
  }
}

// Restore an edge's endpoint binding from a snapshot (undo a live-route preview).
function restoreEnd(edge, s) {
  if (!edge || !s) return;
  edge.from = s.from;
  edge.to = s.to;
  if (s.fromPos) edge.fromPos = s.fromPos;
  else delete edge.fromPos;
  if (s.toPos) edge.toPos = s.toPos;
  else delete edge.toPos;
}

// Live-route the dragged endpoint as it moves: transiently bind the dragged end
// to the box under the cursor (reconnect preview) or, for an already-free end, to
// the cursor point, then re-solve every route so the wire reflows orthogonally in
// real time. Throttled to grid-cell changes (A* per pixel would be wasteful). The
// transient mutation is reverted on drop (mouseup) and superseded by mergeReload.
function liveRouteEndpoint(e) {
  if (!drag.edge || !drag.saved) {
    render();
    return;
  }
  const { gc, gr } = cellAt(e);
  const ck = gc + "," + gr + (drag.overBox ? ":" + drag.overBox.id : "");
  if (ck === drag.liveCell) {
    render();
    return;
  } // same target cell/box → keep current preview
  drag.liveCell = ck;
  restoreEnd(drag.edge, drag.saved); // reset before re-applying so changes don't stack
  drag.live = false;
  const otherNode = drag.role === "src" ? drag.saved.to : drag.saved.from;
  const ownNode = drag.role === "src" ? drag.saved.from : drag.saved.to;
  if (drag.overBox && drag.overBox.id !== otherNode) {
    if (drag.role === "src") {
      drag.edge.from = drag.overBox.id;
      delete drag.edge.fromPos;
    } else {
      drag.edge.to = drag.overBox.id;
      delete drag.edge.toPos;
    }
    drag.live = true;
  } else if (!drag.overBox && !BOXES.some((b) => b.id === ownNode)) {
    // Empty space + an already-loose end (its node is gone) → preview at the cursor.
    const pos = { x: Math.round(drag.cur.x), y: Math.round(drag.cur.y) };
    if (drag.role === "src") drag.edge.fromPos = pos;
    else drag.edge.toPos = pos;
    drag.live = true;
  }
  rebuild();
  render();
}

// Commit a create drag: add an edge from the nub's box to the drop box, pinned to
// the exact source slot the nub was pulled from (fromEdge + fromConn). If the drop
// landed on a specific target slot, pin that end too (toEdge + toConn); otherwise
// the target side/connector stays auto. Parallel edges to an existing pair are
// allowed — the server returns the new edge's id, which we use to pin its slots.
async function commitCreateDrag(from, fromSide, fromConn, dropBox, tgtSlot) {
  const to = dropBox.id;
  try {
    const { result: id } = await postEdge({
      action: "add",
      edge: { from, to, style: "default" },
    });
    const fields = { fromEdge: fromSide, fromConn };
    if (tgtSlot) {
      fields.toEdge = tgtSlot.side;
      fields.toConn = tgtSlot.idx;
    }
    await postEdge({ action: "update", id, fields });
    setStatus(`added ${from} → ${to} (rev ${lastRev})`);
    await mergeReload();
  } catch (e) {
    setStatus("add edge failed: " + e.message);
  }
}

// Commit a left/top frame resize: the server slides all content (nodes + notes +
// dividers) to follow the moved edge, atomically, then we reload the result.
async function commitCanvasResize(deltas) {
  try {
    await postCanvas({ action: "expand", ...deltas });
    await mergeReload();
    setStatus(`canvas ${diagramState.width}×${diagramState.height}`);
  } catch (e) {
    setStatus("resize failed: " + e.message);
    mergeReload();
  }
}

// ================================================================
// HIT-TESTING (canvas-space helpers)
// ================================================================
// Map a mouse event to board pixels — the inverse of the view transform — so
// hit-tests match what was drawn regardless of pan/zoom.
function canvasCoords(e) {
  const r = cvs.getBoundingClientRect();
  const cssX = (e.clientX - r.left) * (VIEW_W / r.width);
  const cssY = (e.clientY - r.top) * (VIEW_H / r.height);
  return { x: view.panX + cssX / view.zoom, y: view.panY + cssY / view.zoom };
}

// Grid cell (board space → col/row) under a mouse event. Routes through the
// view-inverted canvasCoords so box hit-testing tracks pan/zoom.
function cellAt(e) {
  const p = canvasCoords(e);
  return { gc: Math.floor(p.x / CELL), gr: Math.floor(p.y / CELL) };
}

// Box under a mouse event, or null. Uses grid cells like the drag/dblclick paths.
function nodeAt(e) {
  return nodeAtPoint(canvasCoords(e));
}

function nodeAtPoint(p) {
  const gc = Math.floor(p.x / CELL), gr = Math.floor(p.y / CELL);
  return BOXES.find((b) =>
    gc >= b.col && gc < b.col + b.w && gr >= b.row && gr < b.row + b.h
  ) || null;
}

// Note under a canvas-space point, or null. Notes draw on top of boxes, so
// they're tested before boxes/edges. Last-drawn wins on overlap (topmost).
function noteAt(p) {
  for (let i = NOTES.length - 1; i >= 0; i--) {
    const r = NOTES[i].rect;
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
      return NOTES[i];
    }
  }
  return null;
}

function ptSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Edges are compared by endpoints, not identity — mergeReload rebuilds route
// objects, so a held reference goes stale while the {from,to} pair persists.
const boxIdOf = (b) => b?.id ?? null;
// Edge identity is the `id` (parallel edges share from/to). Fall back to from/to
// only for transient edges not yet assigned an id (optimistic create).
const sameEdge = (a, b) =>
  (!a && !b) || !!(a && b && (
    (a.id != null && b.id != null)
      ? a.id === b.id
      : (a.from === b.from && a.to === b.to)
  ));

// Backfill stable ids on inbound state (legacy files carry none until first save).
// Same scheme as the server (diagram-api `_freshEdgeId`): `from~to`, then `~2`…
// so the editor and server agree on ids before any save materializes them.
function ensureEdgeIds(edges) {
  const taken = new Set(edges.map((e) => e.id).filter(Boolean));
  for (const e of edges) {
    if (e.id) continue;
    let id = `${e.from}~${e.to}`, n = 2;
    while (taken.has(id)) id = `${e.from}~${e.to}~${n++}`;
    e.id = id;
    taken.add(id);
  }
}

function hitTest(p, { includeNub = !connectMode } = {}) {
  const note = noteAt(p);
  if (note) return { kind: "note", p, note };

  const endpoint = endpointAt(p);
  if (endpoint) return { kind: "endpoint", p, endpoint, edge: endpoint.edge };

  const nub = includeNub ? createNubAt(p) : null;
  if (nub) return { kind: "nub", p, nub, box: nub.box };

  const pinBox = pinMarkerAt(p);
  if (pinBox) return { kind: "pin", p, box: pinBox };

  const frame = frameHandleAt(p);
  if (frame) return { kind: "frame", p, frame };

  const resize = connectMode ? null : boxResizeAt(p);
  if (resize) return { kind: "boxresize", p, box: resize.box, dir: resize.dir };

  const box = nodeAtPoint(p);
  if (box) return { kind: "box", p, box };

  const label = labelHandleAt(p);
  if (label) return { kind: "label", p, label, edge: label.edge };

  const edge = hitTestEdge(p.x, p.y);
  if (edge) return { kind: "edge", p, edge };

  return { kind: "empty", p };
}

// Recompute hover target from a mouse event; repaint only on a transition.
const epKey = (ep) =>
  ep ? (ep.edge.id ?? ep.edge.from + ">" + ep.edge.to) + ":" + ep.role : null;
const nubKey = (nb) => nb ? nb.boxId + ":" + nb.side + ":" + nb.idx : null;
function updateHover(e) {
  const p = canvasCoords(e);
  const hit = hitTest(p);
  const noteId = hit.kind === "note" ? hit.note.id : null;
  const ep = hit.kind === "endpoint" ? hit.endpoint : null;
  const nub = hit.kind === "nub"
    ? { boxId: hit.nub.box.id, side: hit.nub.side, idx: hit.nub.idx }
    : null;
  const b = (hit.kind === "box" || hit.kind === "pin") ? hit.box : null;
  const labelEdge = hit.kind === "label" ? hit.edge : null;
  // An endpoint hover keeps its edge "hovered" so the handles stay drawn.
  const edge = hit.kind === "endpoint"
    ? hit.edge
    : (hit.kind === "label" || hit.kind === "edge")
    ? hit.edge
    : null;
  const overPin = hit.kind === "pin";
  const fr = hit.kind === "frame" ? hit.frame : null;
  const rz = hit.kind === "boxresize" ? hit.box.id : null;
  if (
    noteId !== hoverNoteId || boxIdOf(b) !== hoverBoxId ||
    !sameEdge(edge, hoverEdge) || !!labelEdge !== hoverLabel ||
    overPin !== hoverPin || epKey(ep) !== epKey(hoverEndpoint) ||
    nubKey(nub) !== nubKey(hoverNub) || fr !== hoverFrame ||
    rz !== (hoverResize?.box.id ?? null)
  ) {
    hoverNoteId = noteId;
    hoverBoxId = boxIdOf(b);
    hoverEdge = edge;
    hoverLabel = !!labelEdge;
    hoverPin = overPin;
    hoverEndpoint = ep;
    hoverNub = nub;
    hoverFrame = fr;
    hoverResize = hit.kind === "boxresize"
      ? { box: hit.box, dir: hit.dir }
      : null;
    updateCursor();
    render();
  }
}

// Single owner of the canvas cursor. Legible states distinguish what the thing
// under the pointer affords: `move` = repositionable (box/note/label), `pointer`
// = clickable or a connector handle (edge editor, connect nub, endpoint re-pin),
// `default` = inert. `grabbing` while a drag is live, `crosshair` in connect
// mode. (Open-hand `grab` reads as "pan the canvas", so it's avoided for
// objects — it muddied draggable vs. clickable.)
function updateCursor() {
  const fr = drag?.kind === "frame" ? drag.edge : (drag ? null : hoverFrame);
  const rz = drag?.kind === "boxresize" || (!drag && hoverResize); // box SE corner
  cvs.style.cursor = fr
    ? ((fr === "se" || fr === "nw")
      ? "nwse-resize"
      : (fr === "ne" || fr === "sw")
      ? "nesw-resize"
      : (fr === "e" || fr === "w")
      ? "ew-resize"
      : "ns-resize") // board-frame resize
    : rz
    ? "nwse-resize" // box resize corner
    : drag
    ? "grabbing"
    : connectMode
    ? "crosshair"
    : hoverEndpoint
    ? "pointer" // connector endpoint → drag to re-pin/retarget
    : hoverNub
    ? "pointer" // connect nub → drag out to create
    : hoverPin
    ? "pointer" // pin marker → click to unpin
    : (hoverNoteId !== null || hoverBoxId !== null || hoverLabel)
    ? "move" // draggable → reposition
    : hoverEdge
    ? "pointer" // clickable → opens editor
    : "default";
}

// Full label hit record (with host-segment mx/my/horiz) under a canvas point, or
// null — used to start a label drag, and by hitTest for label hover/edit.
function labelHandleAt(p) {
  for (const lr of labelRects) {
    const r = lr.rect;
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
      return lr;
    }
  }
  return null;
}

// Closest routed edge to a canvas-space point, within `tol` px (else null).
function hitTestEdge(x, y, tol = screenTol(coarsePointer ? 12 : 6, 20)) {
  let best = null, bestD = tol;
  for (const route of routes) {
    if (!route.path || route.path.length < 2) continue;
    const pts = route.path.map((p) => ({
      x: p.x * CELL + CELL / 2,
      y: p.y * CELL + CELL / 2,
    }));
    for (let i = 1; i < pts.length; i++) {
      const d = ptSegDist(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
      if (d < bestD) {
        bestD = d;
        best = route.edge;
      }
    }
  }
  return best;
}

cvs.addEventListener("pointercancel", (e) => {
  cancelLongPress();
  dropPointer(e);
  if (activePointerId !== null) {
    try {
      cvs.releasePointerCapture(activePointerId);
    } catch { /* already released */ }
    activePointerId = null;
  }
  if (drag?.kind === "pan") {
    drag = null;
    updateCursor();
    return;
  } // interrupted gesture — drop any transient drag
  drag = null;
  updateCursor();
  render();
});

cvs.addEventListener("click", (e) => {
  if (lpFired) {
    lpFired = false;
    return;
  } // compat click after a long-press — swallow it
  if (didDrag) {
    didDrag = false;
    return;
  } // tail of a drag, not a click
  if (connectMode) {
    handleConnectClick(e);
    return;
  }
  // A plain click on an edge no longer opens the editor — that was surprising
  // (you expect select/drag/nothing from a single click). Edit a connector via
  // double-click or right-click → Edit instead.
});

function handleConnectClick(e) {
  const b = nodeAt(e);
  if (!b) {
    connectSourceId = null;
    connectCursor = null;
    render();
    return;
  } // empty → reset
  if (!connectSourceId) {
    connectSourceId = b.id;
    setStatus("connect: now pick a target");
    render();
    return;
  }
  if (b.id === connectSourceId) {
    connectSourceId = null;
    connectCursor = null;
    render();
    return;
  } // self → cancel
  const from = connectSourceId, to = b.id;
  connectSourceId = null;
  connectCursor = null;
  render();
  openEdgeEditor(from, to, e.clientX, e.clientY, true); // deferred create — Save commits it (parallel edges allowed)
}

// ================================================================
// SAVE POSITIONS
// ================================================================
function savePositions() {
  if (!diagramState) return;
  // Export the full per-node {x,y} `layout` map — the authoritative override the
  // renderer and /layout endpoint consume — so the copied JSON round-trips.
  // (Legacy pinnedX/rowY are intentionally omitted: rowY is keyed by row index,
  // not node id, so the old node-keyed export silently failed to paste back.)
  const layout = Object.fromEntries(
    BOXES.map((b) => [b.id, { x: b.col * CELL, y: b.row * CELL }]),
  );
  const exported = {
    boxes: BOXES.map((b) => ({
      id: b.id,
      gridCol: b.col,
      gridRow: b.row,
      gridW: b.w,
      gridH: b.h,
    })),
    // pinnedSet is the live truth; diagramState.pinned is the stale disk copy
    // (own pin edits are nonce-suppressed and never echo back into it).
    diagramState: { ...diagramState, layout, pinned: [...pinnedSet] },
  };
  const json = JSON.stringify(exported, null, 2);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(json).then(
      () => setStatus("Positions copied to clipboard"),
      () => downloadJSON(json),
    );
  } else {
    downloadJSON(json);
  }
}

function downloadJSON(json) {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "diagram-positions.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setStatus("Positions downloaded as diagram-positions.json");
}

// The loaded diagram's own title shows as a subtitle under the static brand
// ("Diagram Tool"); the brand no longer gets hijacked by per-diagram titles.
function setDiagramTitle(t) {
  const el = document.getElementById("diagramTitle");
  el.textContent = t || "";
  el.hidden = !t;
}

function setStatus(msg) {
  const el = document.getElementById("status");
  el.textContent = msg;
  setTimeout(() => {
    if (el.textContent === msg) el.textContent = "";
  }, 3000);
}

// ================================================================
// CONTROLS
// ================================================================
document.getElementById("bGrid").onclick = function () {
  showGrid = !showGrid;
  this.classList.toggle("on", showGrid);
  render();
};
document.getElementById("bHeat").onclick = function () {
  showHeat = !showHeat;
  this.classList.toggle("on", showHeat);
  render();
};
document.getElementById("bConn").onclick = function () {
  showConn = !showConn;
  this.classList.toggle("on", showConn);
  render();
};
// Drag and Connect are mutually exclusive modes (segmented radio): selecting one
// deactivates the other so exactly one interaction mode is ever active.
function setMode(mode) {
  dragMode = mode === "drag";
  connectMode = mode === "connect";
  connectSourceId = null;
  connectCursor = null;
  hoverBoxId = null;
  hoverEdge = null; // stale hover from the old mode
  selectedBoxId = null;
  selectedEdgeId = null; // and stale tap-selection
  document.getElementById("bDrag").classList.toggle("on", dragMode);
  document.getElementById("bConnect").classList.toggle("on", connectMode);
  updateCursor();
  setStatus(connectMode ? "connect: pick a source node" : "");
  render();
}
document.getElementById("bDrag").onclick = () => setMode("drag");
document.getElementById("bConnect").onclick = () => setMode("connect");
// NOTE: there used to be a "Reset" button here, documented as "drops all manual
// positions back to auto-layout". It restored b._origCol/_origRow — but
// computeLayout sets _origCol from the *solved* position, which for any node
// carrying a layout override IS that override. So after the first full re-solve
// (mergeReload — i.e. any content edit by anyone, including an agent) Reset
// silently became a no-op, while still looking like it worked on a freshly
// loaded board. There is also no coherent behavior it could have had: "back to
// auto-layout" means dropping every override, after which nothing is manually
// placed, so the pin set must clear too — which is exactly Auto Layout. Removed
// rather than duplicated; see Auto Layout / Auto Layout (keep pins) below.
document.getElementById("bAlignH").onclick = () => {
  if (coreSnapAlign("h", BOXES, COLS, ROWS)) {
    rebuild();
    render();
    schedulePersist();
  }
};
document.getElementById("bAlignV").onclick = () => {
  if (coreSnapAlign("v", BOXES, COLS, ROWS)) {
    rebuild();
    render();
    schedulePersist();
  }
};
// ── Expand / Contract ─────────────────────────────────────────────
// A shared slider between the layout at session start (level 0) and the fully
// force-spread layout (level 1) and one stop past it (1.5), in 50% steps. Expand
// climbs (0→0.5→1→1.5), Contract descends; at the floor it compacts toward the centroid.
// Any other layout change (drag, reset, auto-layout) invalidates the session — we
// detect that by comparing a position signature against our own last result.
const SPREAD_MAX = 1.5; // stops at 0 → 50% → 100% → 150% (150% extrapolates past the force-equilibrium)
let spreadSession = null;
function posSig() {
  return BOXES.map((b) => b.id + ":" + b.col + "," + b.row).join(";");
}
function ensureSpreadSession() {
  if (spreadSession && spreadSession.sig === posSig()) return;
  const origin = new Map(BOXES.map((b) => [b.id, { col: b.col, row: b.row }]));
  const copy = BOXES.map((b) => ({ ...b })); // full-spread destination on a disposable copy
  coreSpread(copy, EDGES_DEF, COLS, ROWS);
  const dest = new Map(copy.map((b) => [b.id, { col: b.col, row: b.row }]));
  spreadSession = { origin, dest, level: 0, sig: posSig() };
}
function applySpreadLevel(L) {
  const s = spreadSession;
  for (const b of BOXES) {
    const o = s.origin.get(b.id), d = s.dest.get(b.id);
    if (!o || !d) continue;
    // Levels past 1.0 extrapolate beyond the force-equilibrium, so clamp to the
    // board margins to keep boxes on-canvas.
    b.col = Math.max(
      EDGE_MARGIN,
      Math.min(
        COLS - b.w - EDGE_MARGIN,
        Math.round(o.col + (d.col - o.col) * L),
      ),
    );
    b.row = Math.max(
      EDGE_MARGIN,
      Math.min(
        ROWS - b.h - EDGE_MARGIN,
        Math.round(o.row + (d.row - o.row) * L),
      ),
    );
  }
  s.level = L;
  rebuild();
  render();
  schedulePersist();
  s.sig = posSig(); // our own result; next press knows nothing else moved
}
// One incremental pull of every box toward the shared centroid (outer boxes last,
// so inner ones vacate first), collision- and margin-guarded.
function compactTowardCentroid() {
  if (!BOXES.length) return false;
  let cx = 0, cy = 0;
  for (const b of BOXES) {
    cx += b.col + b.w / 2;
    cy += b.row + b.h / 2;
  }
  cx /= BOXES.length;
  cy /= BOXES.length;
  const d2 = (b) => (b.col + b.w / 2 - cx) ** 2 + (b.row + b.h / 2 - cy) ** 2;
  const order = [...BOXES].sort((a, z) => d2(z) - d2(a)); // farthest first
  let moved = false;
  for (const b of order) {
    const nc = Math.max(
      EDGE_MARGIN,
      Math.min(
        COLS - b.w - EDGE_MARGIN,
        Math.round(b.col + (cx - (b.col + b.w / 2)) * 0.15),
      ),
    );
    const nr = Math.max(
      EDGE_MARGIN,
      Math.min(
        ROWS - b.h - EDGE_MARGIN,
        Math.round(b.row + (cy - (b.row + b.h / 2)) * 0.15),
      ),
    );
    if ((nc !== b.col || nr !== b.row) && !boxOverlaps(b, nc, nr, BOXES)) {
      b.col = nc;
      b.row = nr;
      moved = true;
    }
  }
  return moved;
}
document.getElementById("bExpand").onclick = () => {
  ensureSpreadSession();
  if (spreadSession.level >= SPREAD_MAX) {
    setStatus("already fully expanded");
    return;
  }
  applySpreadLevel(Math.min(SPREAD_MAX, spreadSession.level + 0.5));
  setStatus("expand " + Math.round(spreadSession.level * 100) + "%");
};
document.getElementById("bContract").onclick = () => {
  ensureSpreadSession();
  if (spreadSession.level > 0) {
    applySpreadLevel(Math.max(0, spreadSession.level - 0.5));
    setStatus("contract → " + Math.round(spreadSession.level * 100) + "%");
  } else if (compactTowardCentroid()) {
    rebuild();
    render();
    schedulePersist();
    spreadSession = null; // compaction moved the baseline; next expand re-bases
    setStatus("compacted");
  } else setStatus("nothing to compact");
};
// Re-solve the auto-layout for `freeIds` (drop their layout overrides, solve
// against the still-frozen others), then re-freeze the full snapshot via
// schedulePersist so the editor stays WYSIWYG with the PNG.
function resolveAuto(freeIds) {
  const layout = {};
  for (const b of BOXES) {
    if (!freeIds.has(b.id)) {
      layout[b.id] = { x: b.col * CELL, y: b.row * CELL };
    }
  }
  BOXES = computeLayout(
    ctx,
    { ...diagramState, layout },
    diagramState.width || 1500,
  );
  pinsDirty = true;
  fitGridToBoxes();
  rebuild();
  render();
  schedulePersist();
}
// Auto Layout: clear every pin and re-solve the whole board from scratch.
// Shrink to content: trim B to hug the diagram (server slides content to a
// uniform margin), then refit the view so the tightened result is centered.
document.getElementById("bTrimCanvas").onclick = async () => {
  try {
    await postCanvas({ action: "fit" });
    await mergeReload();
    zoomToFit();
    render();
    setStatus(
      `trimmed to content (${diagramState.width}×${diagramState.height})`,
    );
  } catch (e) {
    setStatus("trim failed: " + e.message);
  }
};
// Expand the export frame to the current visible area (board px). The server clamps
// so content is never cropped — so when zoomed in past the content edges it grows
// only as far as content + margins allow.
document.getElementById("bExpandCanvas").onclick = async () => {
  try {
    const rect = {
      x: view.panX,
      y: view.panY,
      w: VIEW_W / view.zoom,
      h: VIEW_H / view.zoom,
    };
    await postCanvas({ action: "fitRect", rect });
    await mergeReload();
    zoomToFit();
    render();
    setStatus(
      `expanded to extents (${diagramState.width}×${diagramState.height})`,
    );
  } catch (e) {
    setStatus("expand failed: " + e.message);
  }
};
document.getElementById("bAutoLayout").onclick = () => {
  pinnedSet.clear();
  resolveAuto(new Set(BOXES.map((b) => b.id)));
  setStatus("auto-layout: re-solved, pins cleared");
};
// Auto Layout (keep pins): re-flow only the unpinned nodes; pinned nodes keep
// their positions and act as fixed obstacles the rest lay out around. Lets you
// place a few anchors by hand, then re-solve everything else around them.
document.getElementById("bAutoLayoutKeep").onclick = () => {
  const freeIds = new Set(
    BOXES.filter((b) => !pinnedSet.has(b.id)).map((b) => b.id),
  );
  if (freeIds.size === 0) {
    setStatus("all nodes pinned — nothing to re-flow");
    return;
  }
  resolveAuto(freeIds); // pinnedSet untouched → pins retain their overrides
  setStatus(
    `re-laid out ${freeIds.size} unpinned node(s) around ${pinnedSet.size} pin(s)`,
  );
};
document.getElementById("bSave").onclick = savePositions;
// Open the live PNG viewer for the current board in a new tab.
document.getElementById("bViewer").onclick = () => {
  window.open(
    BOARD === "default" ? "whiteboard.html" : "whiteboard.html?d=" + BOARD,
    "_blank",
    "noopener",
  );
};

// Theme picker — populate from SCHEMES, apply live + persist on change.
const themeSelect = document.getElementById("themeSelect");
for (const [name, s] of Object.entries(SCHEMES)) {
  const opt = document.createElement("option");
  opt.value = name;
  opt.textContent = s.label || name;
  themeSelect.appendChild(opt);
}
themeSelect.addEventListener("change", async () => {
  const name = themeSelect.value;
  diagramState.theme = name;
  rebuildPalette(diagramState); // theme + custom overrides, in one build
  rebuild();
  render();
  newNonce();
  try {
    const r = await fetch(API + "/theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        theme: name,
        baseRev: lastRev,
        nonce: lastSentNonce,
      }),
    });
    if (r.ok) {
      lastRev = (await r.json()).rev;
      setStatus("theme: " + name + " (rev " + lastRev + ")");
    } else setStatus("theme save rejected: HTTP " + r.status);
  } catch (e) {
    setStatus("theme save failed: " + e.message);
  }
});

// Font size — scales text + box geometry. Optimistic local re-layout, then persist.
const fontSizeInput = document.getElementById("fontSizeInput");
async function applyFontSize(px) {
  if (px == null) delete diagramState.fontSize;
  else diagramState.fontSize = px;
  rebuildPalette(diagramState); // pal.sizes follows state.fontSize
  BOXES = computeLayout(ctx, diagramState, diagramState.width || 1500); // boxes resize with the font
  fitGridToBoxes();
  rebuild();
  render();
  newNonce();
  try {
    const r = await fetch(API + "/fontsize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fontSize: px ?? 0,
        baseRev: lastRev,
        nonce: lastSentNonce,
      }),
    });
    if (r.ok) {
      lastRev = (await r.json()).rev;
      setStatus("font size: " + (px ?? "default") + " (rev " + lastRev + ")");
    } else setStatus("font-size save rejected: HTTP " + r.status);
  } catch (e) {
    setStatus("font-size save failed: " + e.message);
  }
}
fontSizeInput.addEventListener("change", () => {
  const v = fontSizeInput.value.trim();
  if (v === "") return applyFontSize(null);
  const n = parseInt(v, 10);
  if (Number.isFinite(n) && n >= 6 && n <= 48) applyFontSize(n);
  else setStatus("font size must be 6–48");
});
document.getElementById("fontSizeReset").onclick = () => {
  fontSizeInput.value = "";
  applyFontSize(null);
};

// Connector anchoring — center (symmetric fan) vs align (de-kink straight runs).
const centerConnectorsBox = document.getElementById("centerConnectors");
centerConnectorsBox.addEventListener("change", async () => {
  const mode = centerConnectorsBox.checked ? "center" : "align";
  if (mode === "center") diagramState.connectorAnchor = "center";
  else delete diagramState.connectorAnchor;
  rebuild();
  render(); // routes re-allocate with the new anchor
  newNonce();
  try {
    const r = await fetch(API + "/connectoranchor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, baseRev: lastRev, nonce: lastSentNonce }),
    });
    if (r.ok) {
      lastRev = (await r.json()).rev;
      setStatus("connectors: " + mode + " (rev " + lastRev + ")");
    } else setStatus("connector-anchor save rejected: HTTP " + r.status);
  } catch (e) {
    setStatus("connector-anchor save failed: " + e.message);
  }
});

// ── Shared live-styling controls (chips / color picker / stepper) ──
// The editors apply every change immediately to the targeted edge/box (the
// setBoxColor pattern: optimistic local mutate → rebuild → render → nonce-
// suppressed POST, so the open panel survives its own SSE echo). Reset reverts
// to a snapshot taken when the editor opened; Delete still removes the target.
const WIDTH_OPTS = [
  { value: "thin", label: "Thin" },
  { value: "medium", label: "Medium" },
  { value: "thick", label: "Thick" },
];
const DASH_OPTS = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];

function mount(id, el) {
  const c = document.getElementById(id);
  c.innerHTML = "";
  c.appendChild(el);
}

// One-of chip group. options: [{value,label,title?}]; onPick(value). One .on.
function buildChipGroup(options, current, onPick) {
  const g = document.createElement("div");
  g.className = "chip-group";
  const chips = new Map();
  for (const o of options) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = o.label;
    if (o.title) b.title = o.title;
    b.classList.toggle("on", o.value === current);
    b.onclick = () => {
      current = o.value;
      for (const [v, el] of chips) el.classList.toggle("on", v === current);
      onPick(o.value);
    };
    chips.set(o.value, b);
    g.appendChild(b);
  }
  return g;
}

// Color-token picker: semantic chips (error → red, re-maps per theme) above a
// row of named-color dots. One value across both rows; onPick(token). When
// allowDefault, a leading "default" chip clears the override (token = null).
function buildColorPicker(current, onPick, { allowDefault = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "color-picker";
  const semRow = document.createElement("div");
  semRow.className = "chip-group wrap";
  const dotRow = document.createElement("div");
  dotRow.className = "ctx-swatches";
  // Co-select: a semantic token and the named color it maps to are equivalent,
  // so highlight both whichever was picked (error ⇄ red). We compare by resolved
  // named color; what's stored stays exactly what was clicked (intent preserved).
  const refresh = () => {
    const resolved = current ? (PAL.semantic[current] || current) : "";
    for (const el of semRow.children) {
      const v = el.dataset.v;
      el.classList.toggle(
        "on",
        v === ""
          ? current === ""
          : (resolved !== "" && (PAL.semantic[v] || v) === resolved),
      );
    }
    for (const el of dotRow.children) {
      el.classList.toggle(
        "current",
        resolved !== "" && el.dataset.v === resolved,
      );
    }
  };
  const pick = (v) => {
    current = v;
    onPick(v === "" ? null : v);
    refresh();
  };
  if (allowDefault) {
    const d = document.createElement("button");
    d.className = "chip";
    d.textContent = "default";
    d.dataset.v = "";
    d.title = "theme's default edge color";
    d.onclick = () => pick("");
    semRow.appendChild(d);
  }
  for (const s of Object.keys(PAL.semantic)) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = s;
    b.dataset.v = s;
    b.title = "semantic → " + PAL.semantic[s];
    b.onclick = () => pick(s);
    semRow.appendChild(b);
  }
  for (const c of validColors()) {
    const d = document.createElement("button");
    d.className = "ctx-swatch";
    d.dataset.v = c;
    d.style.background = PAL.colors[c]?.border || "#58a6ff";
    d.title = c;
    d.onclick = () => pick(c);
    dotRow.appendChild(d);
  }
  refresh();
  wrap.appendChild(semRow);
  wrap.appendChild(dotRow);
  return wrap;
}

// − value + stepper. value may be null (shows placeholder); onChange(number).
function buildStepper(value, step, min, onChange) {
  const s = document.createElement("div");
  s.className = "stepper";
  let v = Number.isFinite(value) ? value : null;
  const dec = document.createElement("button");
  dec.textContent = "−";
  const val = document.createElement("span");
  val.className = "stepper-val";
  const inc = document.createElement("button");
  inc.textContent = "+";
  const show = () => {
    val.textContent = v == null ? "8" : String(v);
  };
  dec.onclick = () => {
    v = Math.max(min, (v == null ? 8 : v) - step);
    show();
    onChange(v);
  };
  inc.onclick = () => {
    v = (v == null ? 8 : v) + step;
    show();
    onChange(v);
  };
  show();
  s.appendChild(dec);
  s.appendChild(val);
  s.appendChild(inc);
  return s;
}

// Orientation of the labeled (longest) segment of an edge's route: 'h' or 'v'.
// Used to map the Auto/↖/↘ side chips to concrete above|below|left|right.
function edgeHostOrientation(id) {
  const route = routes.find((r) => r.edge.id === id);
  if (route && route.path && route.path.length >= 2) {
    const p = route.path;
    let bi = 0, best = -1;
    for (let i = 0; i < p.length - 1; i++) {
      const L = Math.abs(p[i + 1].x - p[i].x) + Math.abs(p[i + 1].y - p[i].y);
      if (L > best) {
        best = L;
        bi = i;
      }
    }
    return Math.abs(p[bi + 1].x - p[bi].x) >= Math.abs(p[bi + 1].y - p[bi].y)
      ? "h"
      : "v";
  }
  // Route missing/failed → fall back to the box geometry. Derive endpoints from
  // the edge (the signature is id-only now; from/to no longer in scope).
  const edge = EDGES_DEF.find((e) => e.id === id);
  const sb = edge && BOXES.find((b) => b.id === edge.from),
    tb = edge && BOXES.find((b) => b.id === edge.to);
  if (sb && tb) {
    return Math.abs(tb.col - sb.col) >= Math.abs(tb.row - sb.row) ? "h" : "v";
  }
  return "h";
}

// ── Node editor: live edits of text / color / outline; Reset / Delete ──
const nodeEditor = document.getElementById("nodeEditor");
const neLabel = document.getElementById("neLabel");
const neDetails = document.getElementById("neDetails");
const neDelete = document.getElementById("neDelete");
let editingId = null;
let neSnapshot = null; // node styling at open, for Reset

// Show a popover at (clientX,clientY), clamped to stay fully on-screen. Measures
// the *rendered* size after display — mobile CSS widens these to min(92vw,320px),
// so a hard-coded guess let a right-edge tap push the editor off the viewport.
function placePopover(el, clientX, clientY) {
  el.style.left = "0px";
  el.style.top = "0px";
  el.style.display = "flex";
  const w = el.offsetWidth, h = el.offsetHeight; // forces layout (no paint) before we reposition
  el.style.left = Math.max(12, Math.min(clientX, window.innerWidth - w - 12)) +
    "px";
  el.style.top = Math.max(12, Math.min(clientY, window.innerHeight - h - 12)) +
    "px";
}

function showEditor(clientX, clientY) {
  placePopover(nodeEditor, clientX, clientY);
  neLabel.focus();
  neLabel.select();
}

// POST a content op through the CAS-guarded /node endpoint.
async function postNode(payload) {
  payload.baseRev = lastRev;
  payload.nonce = newNonce();
  const r = await fetch(API + "/node", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || ("HTTP " + r.status));
  }
  lastRev = (await r.json()).rev;
}

// Apply node fields live: mutate the state node + its rendered box, repaint,
// then persist (nonce-suppressed). reflow=true does a mergeReload afterward for
// changes that resize the box (label/details) so geometry re-solves.
async function applyNodeFields(id, fields, { reflow = false } = {}) {
  const node = diagramState.nodes.find((n) => n.id === id);
  const box = BOXES.find((b) => b.id === id);
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) {
      if (node) delete node[k];
      if (box) delete box[k];
    } else {
      if (node) node[k] = v;
      if (box) box[k] = v;
    }
  }
  rebuild();
  render();
  try {
    await postNode({ action: "update", id, fields });
    setStatus("updated (rev " + lastRev + ")");
    if (reflow) await mergeReload();
  } catch (e) {
    setStatus("save failed: " + e.message);
  }
}

function renderNodeControls(n) {
  mount(
    "neColor",
    buildColorPicker(
      n.color,
      (t) => applyNodeFields(editingId, { color: t || validColors()[0] }),
    ),
  );
  mount(
    "neOutlineWidth",
    buildChipGroup(
      WIDTH_OPTS,
      n.outlineWidth ?? "medium",
      (v) => applyNodeFields(editingId, { outlineWidth: v }),
    ),
  );
  mount(
    "neOutlineDash",
    buildChipGroup(
      DASH_OPTS,
      n.outlineDash ?? "solid",
      (v) => applyNodeFields(editingId, { outlineDash: v }),
    ),
  );
}

// Edit an existing node. Text applies on change (blur/Enter); chips apply on click.
function openNodeEditor(id, clientX, clientY) {
  const n = diagramState.nodes.find((x) => x.id === id);
  if (!n) return;
  editingId = id;
  neSnapshot = {
    label: n.label || "",
    color: n.color,
    details: (n.details || []).slice(),
    outlineWidth: n.outlineWidth ?? null,
    outlineDash: n.outlineDash ?? null,
  };
  neLabel.value = n.label || "";
  neDetails.value = (n.details || []).join("\n");
  renderNodeControls(n);
  showEditor(clientX, clientY);
}

// "+ Node": create immediately with defaults, then live-edit it (mirrors the
// edge editor — there's no Save anymore, so the node must exist to be edited).
async function openNewNodeEditor() {
  try {
    const id = "n" + Math.random().toString(36).slice(2, 7);
    const maxRow = diagramState.nodes.reduce(
      (m, n) => Math.max(m, n.row || 0),
      0,
    );
    await postNode({
      action: "add",
      node: {
        id,
        label: "New Node",
        color: validColors()[0],
        details: [],
        row: maxRow + 1,
        col: 0,
      },
    });
    await mergeReload();
    openNodeEditor(id, window.innerWidth / 2 - 130, 130);
  } catch (e) {
    setStatus("add failed: " + e.message);
  }
}

function closeNodeEditor() {
  nodeEditor.style.display = "none";
  editingId = null;
  neSnapshot = null;
}

neLabel.addEventListener("change", () => {
  if (editingId) {
    applyNodeFields(editingId, { label: neLabel.value.trim() || "Untitled" }, {
      reflow: true,
    });
  }
});
neDetails.addEventListener("change", () => {
  if (editingId) {
    applyNodeFields(editingId, {
      details: neDetails.value.split("\n").map((s) => s.trim()).filter(Boolean),
    }, { reflow: true });
  }
});
document.getElementById("neLabelClear").onclick = () => {
  neLabel.value = "";
  if (editingId) {
    applyNodeFields(editingId, { label: "Untitled" }, { reflow: true });
  }
  neLabel.focus();
};
document.getElementById("neReset").onclick = async () => {
  if (!editingId || !neSnapshot) return;
  const s = neSnapshot;
  await applyNodeFields(editingId, {
    label: s.label || "Untitled",
    color: s.color,
    details: s.details,
    outlineWidth: s.outlineWidth,
    outlineDash: s.outlineDash,
  }, { reflow: true });
  neLabel.value = s.label || "";
  neDetails.value = (s.details || []).join("\n");
  const n = diagramState.nodes.find((x) => x.id === editingId);
  if (n) renderNodeControls(n);
};

// Shared by the editor's Delete and the box context menu.
async function deleteNode(id, { keepEdges = false } = {}) {
  try {
    const conns = diagramState.edges.filter((e) =>
      e.from === id || e.to === id
    ).length;
    // Pin the dangling ends at the deleted node's centre so they render as
    // draggable free handles instead of vanishing.
    let orphanPos = null;
    if (keepEdges) {
      const b = BOXES.find((x) => x.id === id);
      if (b) {
        orphanPos = {
          x: Math.round((b.col + b.w / 2) * CELL),
          y: Math.round((b.row + b.h / 2) * CELL),
        };
      }
    }
    await postNode({ action: "remove", id, keepEdges, orphanPos });
    setStatus(
      keepEdges && conns
        ? `removed '${id}' — ${conns} connector(s) now loose (drag a free end onto a box to reconnect) (rev ${lastRev})`
        : "removed (rev " + lastRev + ")",
    );
    await mergeReload();
  } catch (e) {
    setStatus("delete failed: " + e.message);
  }
}
neDelete.onclick = () => {
  if (!editingId) return;
  const id = editingId;
  closeNodeEditor();
  deleteNode(id);
};
document.getElementById("neClose").onclick = closeNodeEditor;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && nodeEditor.style.display !== "none") {
    closeNodeEditor();
  }
});

document.getElementById("bAddNode").onclick = openNewNodeEditor;

// Double-click a note to edit its text, or a node to edit its text/color.
cvs.addEventListener("dblclick", (e) => {
  const hit = hitTest(canvasCoords(e));
  if (hit.kind === "note") {
    openNoteEditor(hit.note.id, e.clientX, e.clientY);
    return;
  }
  if (hit.kind === "box" || hit.kind === "pin") {
    openNodeEditor(hit.box.id, e.clientX, e.clientY);
    return;
  }
  if (hit.kind === "label" || hit.kind === "edge" || hit.kind === "endpoint") {
    openEdgeEditor(
      hit.edge.from,
      hit.edge.to,
      e.clientX,
      e.clientY,
      false,
      hit.edge.id,
    );
    return;
  }
  if (hit.kind === "empty") {
    zoomAtClient(e.clientX, e.clientY, 1.5);
    render();
  } // dbl-click empty canvas → zoom in at cursor (repeatable)
});

// ── Edge editor: live edits of style axes / label / placement; Reset / Delete ──
// A brand-new connector is created immediately (with defaults) so the live
// controls have a target; Delete removes an unwanted one (replacing the old
// "Cancel discards an uncreated edge" flow).
const edgeEditor = document.getElementById("edgeEditor");
const eeLabel = document.getElementById("eeLabel");
const eeRoute = document.getElementById("eeRoute");
const eeDelete = document.getElementById("eeDelete");
let eeId = null, eeSnapshot = null; // eeId is the edited edge's identity

// POST a content op through the CAS-guarded /edge endpoint.
async function postEdge(payload) {
  payload.baseRev = lastRev;
  payload.nonce = newNonce();
  const r = await fetch(API + "/edge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || ("HTTP " + r.status));
  }
  const j = await r.json();
  lastRev = j.rev;
  return j; // { rev, result } — result carries the new edge id on `add`
}

// Board-resize ops (anchor/translate). The server does the content shift (incl.
// dividers); mergeReload pulls the authoritative result back.
async function postCanvas(payload) {
  payload.baseRev = lastRev;
  payload.nonce = newNonce();
  const r = await fetch(API + "/canvas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || ("HTTP " + r.status));
  }
  lastRev = (await r.json()).rev;
}

// Apply edge fields live: mutate the state edge (EDGES_DEF aliases it), repaint,
// then persist (nonce-suppressed). No mergeReload — edge edits don't move boxes.
async function applyEdgeFields(id, fields) {
  const edge = diagramState.edges.find((e) => e.id === id);
  if (!edge) return;
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) delete edge[k];
    else edge[k] = v;
  }
  rebuild();
  render();
  try {
    await postEdge({ action: "update", id, fields });
    setStatus("edge updated (rev " + lastRev + ")");
  } catch (e) {
    setStatus("edge save failed: " + e.message);
  }
}

// Build a labelPos {side?, offset?} from a side chip choice + current offset, or
// null when neither is set. side chips: auto / lead (↖) / trail (↘); lead/trail
// resolve to concrete above|below|left|right via the wire's orientation.
function edgeLabelPos(chip, offset) {
  const lp = {};
  if (chip && chip !== "auto") {
    const o = edgeHostOrientation(eeId);
    lp.side = chip === "lead"
      ? (o === "h" ? "above" : "left")
      : (o === "h" ? "below" : "right");
  }
  if (Number.isFinite(offset)) lp.offset = offset;
  return Object.keys(lp).length ? lp : null;
}
const sideToChip = (s) =>
  (s === "above" || s === "left")
    ? "lead"
    : (s === "below" || s === "right")
    ? "trail"
    : "auto";
const SIDE_OPTS = [{ value: "auto", label: "Auto" }, {
  value: "lead",
  label: "↖",
}, { value: "trail", label: "↘" }];

function renderEdgeControls(edge) {
  mount(
    "eeWidth",
    buildChipGroup(
      WIDTH_OPTS,
      edge.width ?? "medium",
      (v) => applyEdgeFields(eeId, { width: v }),
    ),
  );
  mount(
    "eeDash",
    buildChipGroup(
      DASH_OPTS,
      edge.dash ?? "solid",
      (v) => applyEdgeFields(eeId, { dash: v }),
    ),
  );
  mount(
    "eeColor",
    buildColorPicker(
      edge.color ?? "",
      (t) => applyEdgeFields(eeId, { color: t }),
      { allowDefault: true },
    ),
  );
  mount(
    "eeLabelSide",
    buildChipGroup(
      SIDE_OPTS,
      sideToChip(edge.labelPos?.side),
      (chip) =>
        applyEdgeFields(eeId, {
          labelPos: edgeLabelPos(chip, edge.labelPos?.offset),
        }),
    ),
  );
  mount(
    "eeLabelOffset",
    buildStepper(
      edge.labelPos?.offset ?? null,
      4,
      0,
      (off) =>
        applyEdgeFields(eeId, {
          labelPos: edgeLabelPos(sideToChip(edge.labelPos?.side), off),
        }),
    ),
  );
}

// isNew = a deferred create (connect-mode / click). Parallel edges are allowed, so
// this always adds a fresh edge; the server returns its id, which becomes eeId so
// live edits target it. Existing edges pass their id in.
async function openEdgeEditor(from, to, clientX, clientY, isNew, id) {
  eeId = id ?? null;
  if (isNew) {
    const placeholder = { from, to, style: "default" };
    diagramState.edges.push(placeholder); // optimistic — gives live edits a target
    rebuild();
    render();
    try {
      const { result: newId } = await postEdge({
        action: "add",
        edge: { from, to, style: "default" },
      });
      placeholder.id = newId;
      eeId = newId;
      setStatus("edge added (rev " + lastRev + ")");
    } catch (e) {
      setStatus("edge add failed: " + e.message);
    }
  }
  const edge = diagramState.edges.find((e) => e.id === eeId);
  if (!edge) return;
  eeSnapshot = {
    width: edge.width ?? null,
    dash: edge.dash ?? null,
    color: edge.color ?? null,
    label: edge.label ?? "",
    labelPos: edge.labelPos ? { ...edge.labelPos } : null,
    style: edge.style ?? "default",
  };
  eeLabel.value = edge.label || "";
  eeRoute.textContent = from + " → " + to;
  renderEdgeControls(edge);
  placePopover(edgeEditor, clientX, clientY);
  eeLabel.focus();
  eeLabel.select();
}

function closeEdgeEditor() {
  edgeEditor.style.display = "none";
  eeId = null;
  eeSnapshot = null;
}

eeLabel.addEventListener("change", () => {
  if (eeId) applyEdgeFields(eeId, { label: eeLabel.value.trim() });
});
document.getElementById("eeLabelClear").onclick = () => {
  eeLabel.value = "";
  if (eeId) applyEdgeFields(eeId, { label: "" });
  eeLabel.focus();
};
document.getElementById("eeReset").onclick = async () => {
  if (!eeId || !eeSnapshot) return;
  const s = eeSnapshot;
  await applyEdgeFields(eeId, {
    width: s.width,
    dash: s.dash,
    color: s.color,
    label: s.label,
    labelPos: s.labelPos,
    style: s.style,
  });
  eeLabel.value = s.label || "";
  const edge = diagramState.edges.find((e) => e.id === eeId);
  if (edge) renderEdgeControls(edge);
};
// Shared by the editor's Delete and the edge context menu.
async function deleteEdge(id) {
  try {
    await postEdge({ action: "remove", id });
    setStatus("edge removed (rev " + lastRev + ")");
    await mergeReload();
  } catch (e) {
    setStatus("edge delete failed: " + e.message);
  }
}
eeDelete.onclick = () => {
  if (!eeId) return;
  const id = eeId;
  closeEdgeEditor();
  deleteEdge(id);
};
document.getElementById("eeClose").onclick = closeEdgeEditor;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && edgeEditor.style.display !== "none") {
    closeEdgeEditor();
  }
});

// ── Note editor: edit title/text, plus drag-to-move + re-anchor via menu ──
const noteEditor = document.getElementById("noteEditor");
const noteTitle = document.getElementById("noteTitle");
const noteText = document.getElementById("noteText");
const noteDelete = document.getElementById("noteDelete");
let editingNoteId = null;

// POST a note op through the CAS-guarded /note endpoint (content region).
async function postNote(payload) {
  payload.baseRev = lastRev;
  payload.nonce = newNonce();
  const r = await fetch(API + "/note", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || ("HTTP " + r.status));
  }
  lastRev = (await r.json()).rev;
}

function openNoteEditor(id, clientX, clientY) {
  const n = (diagramState.notes || []).find((x) => x.id === id);
  if (!n) return;
  editingNoteId = id;
  noteTitle.value = n.title || "";
  noteText.value = (Array.isArray(n.text) ? n.text : [n.text]).filter(Boolean)
    .join("\n");
  placePopover(noteEditor, clientX, clientY);
  noteText.focus();
}
function closeNoteEditor() {
  noteEditor.style.display = "none";
  editingNoteId = null;
}

document.getElementById("noteSave").onclick = async () => {
  const fields = {
    title: noteTitle.value.trim(),
    text: noteText.value.split("\n").map((s) => s.replace(/\s+$/, "")).filter(
      Boolean,
    ),
  };
  try {
    await postNote({ action: "update", id: editingNoteId, fields });
    setStatus("note updated (rev " + lastRev + ")");
    closeNoteEditor();
    await mergeReload();
  } catch (e) {
    setStatus("note save failed: " + e.message);
  }
};
noteDelete.onclick = () => {
  const id = editingNoteId;
  closeNoteEditor();
  deleteNote(id);
};
document.getElementById("noteCancel").onclick = closeNoteEditor;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && noteEditor.style.display !== "none") {
    closeNoteEditor();
  }
});

async function deleteNote(id) {
  try {
    await postNote({ action: "remove", id });
    setStatus("note removed (rev " + lastRev + ")");
    await mergeReload();
  } catch (e) {
    setStatus("note delete failed: " + e.message);
  }
}

// Re-anchor a note to the nearest box: compute the closest side + offset from the
// note's current resolved position, store it as the authoring hint, and drop the
// drag override so the note rides that box through re-layout (the note's analogue
// of returning a node to auto-layout).
async function reanchorNote(id) {
  const cur = NOTES.find((n) => n.id === id);
  if (!cur || !BOXES.length) {
    setStatus("no box to anchor to");
    return;
  }
  let best = null;
  for (const b of BOXES) {
    const bx = b.col * CELL,
      by = b.row * CELL,
      bw = b.w * CELL,
      bh = b.h * CELL;
    const sides = {
      N: { x: bx + bw / 2, y: by },
      E: { x: bx + bw, y: by + bh / 2 },
      S: { x: bx + bw / 2, y: by + bh },
      W: { x: bx, y: by + bh / 2 },
    };
    for (const side of ["N", "E", "S", "W"]) {
      const d = Math.hypot(cur.x - sides[side].x, cur.y - sides[side].y);
      if (!best || d < best.d) {
        best = {
          d,
          to: b.id,
          side,
          dx: Math.round(cur.x - sides[side].x),
          dy: Math.round(cur.y - sides[side].y),
        };
      }
    }
  }
  try {
    await postNote({
      action: "anchor",
      id,
      anchor: { to: best.to, side: best.side, dx: best.dx, dy: best.dy },
    });
    await postNote({ action: "free", id }); // drop the drag override so the anchor takes over (server-side delete)
    delete noteLayoutLocal[id];
    noteDirty = false;
    setStatus(`anchored to "${best.to}" (${best.side})`);
    await mergeReload();
  } catch (e) {
    setStatus("re-anchor failed: " + e.message);
  }
}

async function freeNoteOverride(id) {
  try {
    await postNote({ action: "free", id }); // server-side delete of noteLayout[id]
    delete noteLayoutLocal[id];
    noteDirty = false;
    setStatus("note freed");
    await mergeReload();
  } catch (e) {
    setStatus("free failed: " + e.message);
  }
}

function openNoteMenu(id, x, y) {
  const overridden = noteLayoutLocal[id] !== undefined;
  const items = [
    { label: "Edit…", action: () => openNoteEditor(id, x, y) },
    { label: "Re-anchor to nearest box", action: () => reanchorNote(id) },
  ];
  if (overridden) {
    items.push({
      label: "Free (drop pinned position)",
      action: () => freeNoteOverride(id),
    });
  }
  items.push(null, {
    label: "Delete",
    danger: true,
    action: () => deleteNote(id),
  });
  openCtxMenu(x, y, items);
}

// ── Context menu: right-click affordances for boxes and edges ──
const ctxMenu = document.getElementById("ctxMenu");
const ctxOpen = () => ctxMenu.style.display !== "none";
function closeCtxMenu() {
  ctxMenu.style.display = "none";
  ctxMenu.innerHTML = "";
}

// items: [{label, danger?, disabled?, action}] | null (null = separator).
function openCtxMenu(clientX, clientY, items) {
  ctxMenu.innerHTML = "";
  for (const item of items) {
    if (!item) {
      const s = document.createElement("div");
      s.className = "ctx-sep";
      ctxMenu.appendChild(s);
      continue;
    }
    if (item.type === "swatches") {
      ctxMenu.appendChild(buildSwatchRow(item));
      continue;
    }
    const b = document.createElement("button");
    b.textContent = item.label;
    if (item.danger) b.classList.add("danger");
    if (item.disabled) b.disabled = true;
    else {b.onclick = () => {
        closeCtxMenu();
        item.action();
      };}
    ctxMenu.appendChild(b);
  }
  // Render to measure, then clamp into the viewport (like showEditor). Cap the
  // height to the viewport first: a tall menu (many items / short window) must
  // scroll rather than run off the bottom with its lower items unreachable —
  // capping keeps `innerHeight - h - 8` ≥ 8 so the bottom stays on screen.
  ctxMenu.style.maxHeight = (window.innerHeight - 16) + "px";
  ctxMenu.style.left = "0px";
  ctxMenu.style.top = "0px";
  ctxMenu.style.display = "flex";
  const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
  ctxMenu.style.left =
    Math.max(8, Math.min(clientX, window.innerWidth - w - 8)) + "px";
  ctxMenu.style.top =
    Math.max(8, Math.min(clientY, window.innerHeight - h - 8)) + "px";
}

// Non-closing color-dot row: apply on click, move the ring, keep the menu open
// for comparison (it closes on outside click like everything else).
function buildSwatchRow(item) {
  const row = document.createElement("div");
  row.className = "ctx-swatches";
  let current = item.current;
  const dots = new Map();
  for (const c of item.colors) {
    const d = document.createElement("button");
    d.className = "ctx-swatch";
    d.style.background = item.colorOf(c);
    d.title = c;
    d.classList.toggle("current", c === current);
    d.onclick = () => {
      item.action(c);
      current = c;
      for (const [name, dot] of dots) {
        dot.classList.toggle("current", name === current);
      }
    };
    dots.set(c, d);
    row.appendChild(d);
  }
  return row;
}

// Dismiss on any outside pointer interaction; capture phase beats other handlers.
document.addEventListener("pointerdown", (e) => {
  if (ctxOpen() && !ctxMenu.contains(e.target)) closeCtxMenu();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ctxOpen()) closeCtxMenu();
});

// ── Confirm modal (promise-based) ───────────────────────────────
const confirmModalEl = document.getElementById("confirmModal");
const cmMsg = document.getElementById("cmMsg");
const cmOk = document.getElementById("cmOk");
const cmCancel = document.getElementById("cmCancel");
let cmResolve = null;
const confirmOpen = () =>
  confirmModalEl.style.display !== "" &&
  confirmModalEl.style.display !== "none";
function askConfirm(message) {
  cmMsg.textContent = message;
  confirmModalEl.style.display = "flex";
  cmOk.focus();
  return new Promise((res) => {
    cmResolve = res;
  });
}
function closeConfirm(val) {
  confirmModalEl.style.display = "none";
  const r = cmResolve;
  cmResolve = null;
  if (r) r(val);
}
cmOk.onclick = () => closeConfirm(true);
cmCancel.onclick = () => closeConfirm(false);
confirmModalEl.onclick = (e) => {
  if (e.target === confirmModalEl) closeConfirm(false);
}; // backdrop
document.addEventListener("keydown", (e) => {
  if (!confirmOpen()) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeConfirm(false);
  } else if (e.key === "Enter") {
    e.preventDefault();
    closeConfirm(true);
  }
}, true);

// ── Keyboard delete of the hovered node ─────────────────────────
// Backspace/Delete removes the node under the cursor but KEEPS its connectors
// (they orphan → hidden until reconnected). Shift+Backspace is a distinct,
// destructive mode: confirm, then delete the node AND its connectors.
const isTypingTarget = (el) =>
  el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
const overlaysOpen = () =>
  nodeEditor.style.display !== "none" || edgeEditor.style.display !== "none" ||
  noteEditor.style.display !== "none" || ctxOpen() || confirmOpen();
document.addEventListener("keydown", (e) => {
  if (e.key !== "Backspace" && e.key !== "Delete") return;
  if (isTypingTarget(e.target) || overlaysOpen()) return; // let fields/overlays own the key
  if (hoverBoxId === null) return; // act only on a hovered node
  e.preventDefault(); // Backspace would navigate back
  const id = hoverBoxId;
  if (e.shiftKey) {
    const n = diagramState.edges.filter((x) =>
      x.from === id || x.to === id
    ).length;
    askConfirm(
      `Delete node "${id}"${
        n ? ` and its ${n} connector(s)` : ""
      }? This can't be undone.`,
    )
      .then((ok) => {
        if (ok) deleteNode(id, { keepEdges: false });
      });
  } else {
    deleteNode(id, { keepEdges: true });
  }
});

// Click outside an open editor popover dismisses it — same as its Close button
// (edits apply live, so nothing is discarded). The opening click is a separate,
// earlier gesture, so this never closes an editor as it opens.
document.addEventListener("pointerdown", (e) => {
  if (nodeEditor.style.display !== "none" && !nodeEditor.contains(e.target)) {
    closeNodeEditor();
  }
  if (edgeEditor.style.display !== "none" && !edgeEditor.contains(e.target)) {
    closeEdgeEditor();
  }
  if (noteEditor.style.display !== "none" && !noteEditor.contains(e.target)) {
    closeNoteEditor();
  }
}, true);

// Shared by right-click (desktop) and touch long-press (mobile): hit-test the
// point and open the matching menu. clientX/clientY are all canvasCoords needs.
function openContextMenuFor(clientX, clientY) {
  closeCtxMenu();
  if (connectMode && connectSourceId) { // backs out of an armed connect
    connectSourceId = null;
    connectCursor = null;
    setStatus("connect cancelled");
    render();
    return;
  }
  const p = canvasCoords({ clientX, clientY });
  const hit = hitTest(p, { includeNub: false });
  if (hit.kind === "note") return openNoteMenu(hit.note.id, clientX, clientY);
  if (hit.kind === "box" || hit.kind === "pin") {
    return openBoxMenu(hit.box.id, clientX, clientY);
  }
  if (hit.kind === "label" || hit.kind === "edge" || hit.kind === "endpoint") {
    return openEdgeMenu(hit.edge, clientX, clientY);
  }
  // Empty canvas → offer to drop a note at the point.
  openCtxMenu(clientX, clientY, [
    {
      label: "Add note here",
      action: () =>
        addNoteAt(Math.round(p.x), Math.round(p.y), clientX, clientY),
    },
  ]);
}

cvs.addEventListener("contextmenu", (e) => {
  e.preventDefault(); // no browser menu anywhere on the canvas
  if (didDrag) {
    didDrag = false;
    closeCtxMenu();
    return;
  } // tail of a drag, not a click
  openContextMenuFor(e.clientX, e.clientY);
});

// Touch long-press → the same context menu (mobile parity for right-click).
// Driven from the unified pointer handlers: a touch held still for LP_MS opens
// the menu; moving past LP_MOVE first cancels it (the gesture became a drag/pan).
// On fire we null any drag the pointerdown started and set lpFired so the compat
// click is swallowed.
let lpTimer = null, lpStart = null, lpFired = false, activePointerId = null;
const LP_MS = 500, LP_MOVE = 12;
const activePointers = new Map(); // touch pointerId -> {x,y}; two of them → pinch
let pinch = null; // { dist } between the two fingers, last frame
// A drag mutates nothing until the pointer travels DRAG_SLOP from where it went
// down: a tap (or the first finger of a pinch) no longer nudges a box, and a
// pinch that starts before any movement leaves layout untouched.
let dragDownX = 0, dragDownY = 0, dragMoved = false;
const DRAG_SLOP = coarsePointer ? 8 : 3;
const ptDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function dropPointer(e) {
  if (activePointers.delete(e.pointerId) && activePointers.size < 2) {
    pinch = null;
  }
}
function cancelLongPress() {
  if (lpTimer) clearTimeout(lpTimer);
  lpTimer = null;
  lpStart = null;
}
function startLongPress(e) {
  cancelLongPress();
  lpFired = false;
  lpStart = { x: e.clientX, y: e.clientY };
  lpTimer = setTimeout(() => {
    lpTimer = null;
    lpFired = true;
    drag = null; // we're opening a menu, not dragging
    selectedBoxId = selectedEdgeId = null; // and not inspecting
    navigator.vibrate?.(15); // haptic nudge where supported
    updateCursor();
    render();
    openContextMenuFor(lpStart.x, lpStart.y);
    setTimeout(() => {
      lpFired = false;
    }, 700); // clear after the compat click has passed
  }, LP_MS);
}

// Create a note at a canvas point, then open the editor to fill in its text.
async function addNoteAt(x, y, clientX, clientY) {
  try {
    const id = "note" + Math.random().toString(36).slice(2, 7);
    await postNote({ action: "add", note: { id, x, y, text: ["note"] } });
    setStatus("note added (rev " + lastRev + ")");
    await mergeReload();
    openNoteEditor(id, clientX, clientY);
  } catch (e) {
    setStatus("add note failed: " + e.message);
  }
}

// Recolor a box: optimistic local update + render, then persist. postNode's
// nonce suppresses the SSE echo so the open menu isn't torn down by a reload.
async function setBoxColor(id, color) {
  const node = diagramState.nodes.find((n) => n.id === id);
  const box = BOXES.find((b) => b.id === id);
  if (node) node.color = color;
  if (box) box.color = color;
  rebuild();
  render();
  try {
    await postNode({ action: "update", id, fields: { color } });
    setStatus("color: " + color + " (rev " + lastRev + ")");
  } catch (e) {
    setStatus("color save failed: " + e.message);
  }
}

const SIDE_NAME = { N: "top", E: "right", S: "bottom", W: "left" };

// Group a box's edges by which of its sides they touch (core pass-1 sides).
// Map<side, [{edge, end}]>; end is 'from' (box is the source) or 'to'.
function boxSideEdges(boxId) {
  const sides = edgeSides(EDGES_DEF, BOXES);
  const m = new Map();
  const push = (s, entry) => {
    (m.get(s) || m.set(s, []).get(s)).push(entry);
  };
  EDGES_DEF.forEach((edge, i) => {
    if (edge.from === boxId) push(sides[i].srcEdge, { edge, end: "from" });
    if (edge.to === boxId) push(sides[i].tgtEdge, { edge, end: "to" });
  });
  return m;
}

// Collapse (pin every edge on the side to the center connector 'C', one shared
// trunk) or spread (clear those pins → auto barycentric distribution). Applied
// as N sequential CAS-guarded /edge updates — commutative and N is small.
async function setSideConnectors(list, value) {
  try {
    for (const { edge, end } of list) {
      const field = end === "from" ? "fromConn" : "toConn";
      await postEdge({
        action: "update",
        id: edge.id,
        fields: { [field]: value },
      });
    }
    setStatus((value ? "collapsed" : "spread") + " (rev " + lastRev + ")");
    await mergeReload();
  } catch (e) {
    setStatus("connector update failed: " + e.message);
  }
}

// Drill-in submenu: only sides hosting ≥2 edges; each toggles collapse/spread.
function openConnectorLayoutMenu(boxId, x, y) {
  const groups = boxSideEdges(boxId);
  const items = [];
  for (const side of ["N", "E", "S", "W"]) {
    const list = groups.get(side);
    if (!list || list.length < 2) continue;
    const collapsed = list.every(({ edge, end }) =>
      (end === "from" ? edge.fromConn : edge.toConn) === "C"
    );
    items.push({
      label: `${collapsed ? "Spread" : "Collapse"} ${
        SIDE_NAME[side]
      } (${list.length} edges)`,
      action: () => setSideConnectors(list, collapsed ? null : "C"),
    });
  }
  if (!items.length) {
    items.push({ label: "No side has ≥2 edges", disabled: true });
  }
  items.push(null, { label: "‹ Back", action: () => openBoxMenu(boxId, x, y) });
  openCtxMenu(x, y, items);
}

function openBoxMenu(id, x, y) {
  const box = BOXES.find((b) => b.id === id);
  openCtxMenu(x, y, [
    {
      label: "Connect from here",
      action: () => {
        setMode("connect");
        connectSourceId = id; // pre-pick the source, skipping the first click
        setStatus("connect: now pick a target");
        render();
      },
    },
    { label: "Edit…", action: () => openNodeEditor(id, x, y) },
    {
      type: "swatches",
      colors: validColors(),
      current: box?.color,
      colorOf: (c) => PAL.colors[c]?.border || "#58a6ff",
      action: (c) => setBoxColor(id, c),
    },
    {
      label: "Connector layout ▸",
      action: () => openConnectorLayoutMenu(id, x, y),
    },
    pinnedSet.has(id)
      ? {
        label: "Unpin",
        action: () => {
          pinnedSet.delete(id);
          resolveAuto(new Set([id]));
          setStatus("unpinned — re-laid out");
        },
      }
      : {
        label: "Pin",
        action: () => {
          pinnedSet.add(id);
          pinsDirty = true;
          render();
          schedulePersist();
          setStatus("pinned");
        },
      },
    null,
    { label: "Delete", danger: true, action: () => deleteNode(id) },
  ]);
}

// Atomic flip on the server (see Diagram.reverseEdge) — a remove+add pair could
// be torn by a concurrent writer.
async function reverseEdge(id) {
  try {
    await postEdge({ action: "reverse", id });
    setStatus("edge reversed (rev " + lastRev + ")");
    await mergeReload();
  } catch (e) {
    setStatus("edge reverse failed: " + e.message);
  }
}

function openEdgeMenu(edge, x, y) {
  openCtxMenu(x, y, [
    {
      label: "Edit…",
      action: () => openEdgeEditor(edge.from, edge.to, x, y, false, edge.id),
    },
    { label: "Reverse direction", action: () => reverseEdge(edge.id) },
    null,
    { label: "Delete", danger: true, action: () => deleteEdge(edge.id) },
  ]);
}

// Routing-params dock: collapse/expand
document.getElementById("tuningToggle").onclick = function () {
  const collapsed = document.getElementById("tuningDock").classList.toggle(
    "collapsed",
  );
  this.classList.toggle("on", !collapsed);
};

// Info-icon toggle
document.querySelectorAll(".info-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const desc = document.getElementById(btn.dataset.info);
    const open = desc.classList.toggle("show");
    btn.classList.toggle("open", open);
  });
});

// Tuning sliders. Each row: [sliderId, displayId, costKey, legendId].
const SLIDERS = [
  ["sStep", "vStep", "step", "legStep"],
  ["sTurn", "vTurn", "turn", "legTurn"],
  ["sNear", "vNear", "near", "legNear"],
  ["sOver", "vOver", "overlap", "legOver"],
];

function setSliderDisplay(displayId, legendId, v) {
  document.getElementById(displayId).textContent = v;
  const legend = legendId ? document.getElementById(legendId) : null;
  if (legend) legend.textContent = (legendId === "legStep") ? v : "+" + v;
}

// Push current `costs` into the slider positions + labels (used on load).
function initSliders() {
  for (const [sliderId, displayId, costKey, legendId] of SLIDERS) {
    document.getElementById(sliderId).value = costs[costKey];
    setSliderDisplay(displayId, legendId, costs[costKey]);
  }
}

function bindSlider(sliderId, displayId, costKey, legendId) {
  const slider = document.getElementById(sliderId);
  slider.addEventListener("input", () => {
    const v = Number(slider.value);
    setSliderDisplay(displayId, legendId, v);
    costs[costKey] = v;
    rebuild();
    render();
    schedulePersistCosts();
  });
}
for (const [sliderId, displayId, costKey, legendId] of SLIDERS) {
  bindSlider(sliderId, displayId, costKey, legendId);
}

// Debounced persist of routing costs through the CAS-guarded /costs endpoint.
let costsPersistTimer;
function schedulePersistCosts() {
  clearTimeout(costsPersistTimer);
  costsPersistTimer = setTimeout(persistCosts, 400);
}
async function persistCosts() {
  newNonce();
  try {
    const r = await fetch(API + "/costs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ costs, baseRev: lastRev, nonce: lastSentNonce }),
    });
    if (r.ok) {
      lastRev = (await r.json()).rev;
      setStatus("routing saved (rev " + lastRev + ")");
    } else setStatus("routing save rejected: HTTP " + r.status);
  } catch (e) {
    setStatus("routing save failed: " + e.message);
  }
}

// DPR change handler
window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
  .addEventListener("change", () => {
    initCanvas();
    render();
  });

// Viewport width at the last fit — used to refit on *real* resizes (window
// resize, orientation flip) while ignoring mobile URL-bar show/hide, which
// changes only height as you scroll and shouldn't yank the view.
let lastFitW = 0;
function refitToStage() {
  initCanvas();
  lastFitW = VIEW_W;
  zoomToFit();
  render();
}
window.addEventListener("resize", () => {
  initCanvas();
  if (Math.abs(VIEW_W - lastFitW) > 4) {
    lastFitW = VIEW_W;
    zoomToFit();
  } // width changed → resize/rotate
  render();
});

// ================================================================
// VIEW: pan + zoom input
// ================================================================
// Trackpad/wheel: scroll to pan, ctrl/⌘ (or pinch — the browser reports pinch as
// ctrl+wheel) to zoom at the cursor.
cvs.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    zoomAtClient(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  } else {
    view.panX += e.deltaX / view.zoom;
    view.panY += e.deltaY / view.zoom;
  }
  render();
}, { passive: false });

// HUD: zoom controls + the board/content size readout.
const zoomPctEl = document.getElementById("zoomPct");
const sizeReadoutEl = document.getElementById("sizeReadout");
function zoomViewportCenter(factor) {
  const r = cvs.getBoundingClientRect();
  zoomAtClient(r.left + r.width / 2, r.top + r.height / 2, factor);
  render();
}
document.getElementById("zoomIn").onclick = () => zoomViewportCenter(1.2);
document.getElementById("zoomOut").onclick = () => zoomViewportCenter(1 / 1.2);
document.getElementById("zoomFit").onclick = () => {
  zoomToFit();
  render();
};
zoomPctEl.onclick = () => {
  zoomToFit();
  render();
};

// Sidebar dock toggle. Collapsing frees the full width for the canvas (matters
// most on phones). The stage resizes but no 'resize' event fires for a class
// change, so re-measure and refit the board into the reclaimed space.
function setNavCollapsed(collapsed) {
  document.body.classList.toggle("nav-collapsed", collapsed);
  try {
    localStorage.setItem("wb-nav-collapsed", collapsed ? "1" : "0");
  } catch { /* storage blocked — the dock choice just won't persist */ }
  refitToStage();
}
document.getElementById("navCollapse").onclick = () => setNavCollapsed(true);
document.getElementById("navExpand").onclick = () => setNavCollapsed(false);
// Restore last dock choice before init() takes the first stage measurement.
try {
  if (localStorage.getItem("wb-nav-collapsed") === "1") {
    document.body.classList.add("nav-collapsed");
  }
} catch { /* storage blocked — start with the dock expanded */ }

// Content extents (E): the bbox of all boxes + notes, in board px. Drives the
// readout (and, in Phase 2, Auto-fit).
function contentExtent() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of BOXES) {
    x0 = Math.min(x0, b.col * CELL);
    y0 = Math.min(y0, b.row * CELL);
    x1 = Math.max(x1, (b.col + b.w) * CELL);
    y1 = Math.max(y1, (b.row + b.h) * CELL);
  }
  for (const n of NOTES) {
    x0 = Math.min(x0, n.rect.x);
    y0 = Math.min(y0, n.rect.y);
    x1 = Math.max(x1, n.rect.x + n.rect.w);
    y1 = Math.max(y1, n.rect.y + n.rect.h);
  }
  if (!isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function updateZoomLabel() {
  zoomPctEl.textContent = Math.round(view.zoom * 100) + "%";
  const e = contentExtent();
  sizeReadoutEl.textContent = e
    ? `board ${CSS_W}×${CSS_H} · content ${Math.round(e.w)}×${Math.round(e.h)}`
    : `board ${CSS_W}×${CSS_H}`;
}

// ================================================================
// STARTUP
// ================================================================
async function init() {
  setStatus("Loading diagram-state.json...");
  try {
    const resp = await fetch(API + "/diagram-state.json", {
      cache: "no-store",
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    diagramState = await resp.json();
  } catch (e) {
    setStatus("Failed to load diagram-state.json: " + e.message);
    return;
  }
  noteLayoutLocal = { ...(diagramState.noteLayout || {}) };
  noteDirty = false;

  // Build the palette this state implies (theme + custom overrides)
  const themeName = rebuildPalette(diagramState);
  document.getElementById("themeSelect").value = themeName;

  // Board picker — from the server's registry. On a plain static server the
  // fetch fails; keep just the current board in the list.
  const boardSel = document.getElementById("boardSelect");
  boardSel.innerHTML = "";
  let boardList = [{ name: BOARD, title: null }];
  try {
    const r = await fetch("/diagrams", { cache: "no-store" });
    if (r.ok) boardList = await r.json();
  } catch { /* static server — no registry */ }
  for (const b of boardList) {
    const o = document.createElement("option");
    o.value = b.name;
    o.textContent = b.title ? `${b.name} — ${b.title}` : b.name;
    boardSel.appendChild(o);
  }
  boardSel.value = BOARD;
  boardSel.onchange = () => {
    location.search = boardSel.value === "default"
      ? ""
      : "?d=" + boardSel.value;
  };

  setDiagramTitle(diagramState.title);

  ensureEdgeIds(diagramState.edges);
  EDGES_DEF = diagramState.edges;
  pinnedSet = new Set(diagramState.pinned || []); // empty on legacy boards — pins accrue as you drag
  lastRev = diagramState.rev ?? 0;

  // Seed routing costs + sliders from persisted state (else they'd always start
  // at DEFAULT_COSTS and ignore prior tuning).
  costs = { ...DEFAULT_COSTS, ...(diagramState.costs || {}) };
  initSliders();
  fontSizeInput.value = diagramState.fontSize || "";
  centerConnectorsBox.checked = diagramState.connectorAnchor === "center";

  // Need canvas context for text measurement
  initCanvas();

  // Load the diagram font BEFORE the first measureText — otherwise box widths
  // are computed with a fallback font and can drift from the PNG renderer.
  const diagramFont = diagramState.font === "sans"
    ? "DiagramSans"
    : "DiagramMono";
  try {
    await Promise.all([
      document.fonts.load(`bold 13px ${diagramFont}`),
      document.fonts.load(`10px ${diagramFont}`),
    ]);
  } catch { /* fallback font — measurements may drift slightly */ }

  // Compute layout from JSON
  BOXES = computeLayout(ctx, diagramState, diagramState.width || 1500);
  fitGridToBoxes();
  if (!restoreView()) zoomToFit(); // restore last view, else fit the whole board
  lastFitW = VIEW_W; // baseline for resize/rotate refit
  snapshotBaseline();
  updateCursor();

  rebuild();
  render();

  const failCount = routes.filter((r) => r.path === null).length;
  setStatus(
    `Loaded ${BOXES.length} boxes, ${EDGES_DEF.length} edges (rev ${lastRev})` +
      (failCount > 0 ? ` (${failCount} route failures)` : ""),
  );
}

// Size the grid + canvas + A* state to fit the current BOXES extents.
// Mirrors the PNG renderer's sizing (diagram-api render()): floor at the authored
// width/height, then grow only to encompass boxes that exceed it (+40px right for
// margin, +50px bottom for the legend/footer band). This keeps the editor frame
// identical to the exported PNG (WYSIWYG) instead of the old fixed 100x60 grid,
// which padded the canvas well beyond the output and showed dead space.
function fitGridToBoxes() {
  const { W, H, COLS: nextCols, ROWS: nextRows } = boardExtent(
    BOXES,
    diagramState.width || 1500,
    diagramState.height || 900,
  );
  // B tracks content (auto-grow, monotonic up). Written back so the board bounds
  // are authoritative; the next layout save persists them. Never shrinks here —
  // contraction is the explicit Auto-fit / resize ops.
  diagramState.width = W;
  diagramState.height = H;
  COLS = nextCols;
  ROWS = nextRows;
  astarState = createAstarState(COLS, ROWS);
  initCanvas();
}

init();

// Local dev/testing hook — a no-op unless the page is opened with ?test=1.
// Exposes a couple of internal handles so Playwright can drive the editors
// without screen-coordinate math; has zero effect in normal use.
if (new URLSearchParams(location.search).has("test")) {
  window.__wb = {
    openEdgeEditor,
    openNodeEditor,
    state: () => diagramState,
    // Client-space center of an edge's label chip, for drag tests.
    labelCenter: (from, to) => {
      const lr = labelRects.find((l) =>
        l.edge.from === from && l.edge.to === to
      );
      if (!lr) return null;
      const rect = cvs.getBoundingClientRect();
      const bx = lr.rect.x + lr.rect.w / 2, by = lr.rect.y + lr.rect.h / 2; // board px
      return {
        x: rect.left + (bx - view.panX) * view.zoom * (rect.width / VIEW_W),
        y: rect.top + (by - view.panY) * view.zoom * (rect.height / VIEW_H),
      };
    },
    // View-transform test handles (pan/zoom validation).
    getView: () => ({ ...view }),
    boardSize: () => ({ w: CSS_W, h: CSS_H }),
    viewport: () => ({ w: VIEW_W, h: VIEW_H }),
    // Client-space center of a box, via the live view transform (forward map).
    boxClientCenter: (id) => {
      const b = BOXES.find((x) => x.id === id);
      if (!b) return null;
      const rect = cvs.getBoundingClientRect();
      const bx = (b.col + b.w / 2) * CELL, by = (b.row + b.h / 2) * CELL;
      return {
        x: rect.left + (bx - view.panX) * view.zoom * (rect.width / VIEW_W),
        y: rect.top + (by - view.panY) * view.zoom * (rect.height / VIEW_H),
      };
    },
    // Client-space SE corner of a box (the resize handle), for drag tests.
    boxClientSE: (id) => {
      const b = BOXES.find((x) => x.id === id);
      if (!b) return null;
      const rect = cvs.getBoundingClientRect();
      const bx = (b.col + b.w) * CELL, by = (b.row + b.h) * CELL;
      return {
        x: rect.left + (bx - view.panX) * view.zoom * (rect.width / VIEW_W),
        y: rect.top + (by - view.panY) * view.zoom * (rect.height / VIEW_H),
        cells: { w: b.w, h: b.h },
      };
    },
    pinClientCenter: (id) => {
      const b = BOXES.find((x) => x.id === id);
      if (!b) return null;
      const { px, py } = pinMarkerPos(b);
      const rect = cvs.getBoundingClientRect();
      return {
        x: rect.left + (px - view.panX) * view.zoom * (rect.width / VIEW_W),
        y: rect.top + (py + 2 - view.panY) * view.zoom * (rect.height / VIEW_H),
      };
    },
    endpointClientCenter: (from, to, role, id) => {
      const edge = routes.find((r) =>
        id != null
          ? r.edge.id === id
          : (r.edge.from === from && r.edge.to === to)
      )?.edge;
      if (!edge) return null;
      const p = edgeEndpoints(edge)?.[role === "src" ? "src" : "tgt"];
      if (!p) return null;
      const rect = cvs.getBoundingClientRect();
      return {
        x: rect.left + (p.x - view.panX) * view.zoom * (rect.width / VIEW_W),
        y: rect.top + (p.y - view.panY) * view.zoom * (rect.height / VIEW_H),
      };
    },
    nubClientCenter: (id, side, idx) => {
      const b = BOXES.find((x) => x.id === id);
      if (!b) return null;
      const slots = boxNubs(b)?.[side];
      if (!slots || !slots.length) return null;
      const p = slots[idx == null ? Math.floor((slots.length - 1) / 2) : idx]; // default: center slot
      if (!p) return null;
      const rect = cvs.getBoundingClientRect();
      return {
        x: rect.left + (p.x - view.panX) * view.zoom * (rect.width / VIEW_W),
        y: rect.top + (p.y - view.panY) * view.zoom * (rect.height / VIEW_H),
      };
    },
    // Box id under a client point (inverse map → hit-test). Validates that the
    // forward/inverse transforms agree under pan/zoom.
    boxIdAtClient: (clientX, clientY) =>
      nodeAt({ clientX, clientY })?.id ?? null,
    hitKindAtClient: (clientX, clientY) =>
      hitTest(canvasCoords({ clientX, clientY })).kind,
  };
}

// ================================================================
// COLLABORATION: outbound layout persistence + inbound live merge.
//
// Content (nodes/edges) and layout (positions) are disjoint regions, so an
// agent's content edit and the human's layout edit merge silently. Only a true
// same-region conflict (both moved the SAME node) surfaces the banner.
// ================================================================

// Conflict banner (only shown for genuine same-region conflicts).
const banner = document.createElement("div");
banner.style.cssText =
  "position:fixed;top:12px;right:12px;z-index:50;display:none;" +
  "background:#1f6feb;color:#fff;font:12px monospace;padding:8px 12px;" +
  "border-radius:6px;cursor:pointer;box-shadow:0 2px 8px #0008";
banner.textContent =
  "edited on disk while you moved the same box — click to take the disk version";
banner.onclick = () => {
  banner.style.display = "none";
  init();
};
document.body.appendChild(banner);

function snapshotBaseline() {
  baseline = new Map(BOXES.map((b) => [b.id, { col: b.col, row: b.row }]));
}

// ids the human has moved since the last sync (unpersisted layout deltas).
function movedIds() {
  return BOXES.filter((b) => {
    const base = baseline.get(b.id);
    return base && (b.col !== base.col || b.row !== base.row);
  }).map((b) => b.id);
}

// Persist only the boxes the human actually moved (keeps untouched nodes auto-laid).
let persistInFlight = false;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistLayout, 300);
}
async function persistLayout() {
  if (persistInFlight) {
    schedulePersist();
    return;
  }
  if (movedIds().length === 0 && !pinsDirty && !noteDirty && !dimsDirty) return; // nothing changed (positions, pins, notes, or board size)
  // Persist ALL boxes (full snapshot), so the render uses overrides for every
  // node and matches the editor exactly. Auto-placed nodes otherwise drift
  // because the renderer re-solves the spring layout on every render. `pinned`
  // rides along as a subset of these keys (the manually-placed markers).
  const layout = {};
  for (const b of BOXES) layout[b.id] = { x: b.col * CELL, y: b.row * CELL };
  const pinned = [...pinnedSet];
  newNonce();
  persistInFlight = true;
  try {
    const r = await fetch(API + "/layout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        layout,
        pinned,
        noteLayout: noteLayoutLocal,
        width: diagramState.width,
        height: diagramState.height,
        baseRev: lastRev,
        nonce: lastSentNonce,
      }),
    });
    if (r.ok) {
      const j = await r.json();
      lastRev = j.rev;
      pinsDirty = false;
      noteDirty = false;
      dimsDirty = false;
      snapshotBaseline(); // all boxes now in sync
      setStatus("saved (rev " + j.rev + ")");
    } else if (r.status === 409) {
      // Our view was stale — resync to disk (keeps this drag) then re-persist
      // against the fresh rev, so we merge instead of clobbering unseen positions.
      setStatus("layout out of date — syncing…");
      await mergeReload();
      schedulePersist(); // retry the drag; finally{} clears persistInFlight before the timer fires
    } else {
      setStatus("save rejected: HTTP " + r.status);
    }
  } catch (e) {
    setStatus("save failed: " + e.message);
  } finally {
    persistInFlight = false;
  }
}

// Merge an inbound change: take fresh content + positions, but RETAIN the
// human's unpersisted drags. Drop boxes whose node was deleted. Flag genuine
// same-region conflicts.
async function mergeReload() {
  closeCtxMenu(); // its box/edge target may vanish in the rebuild
  let fresh;
  try {
    fresh =
      await (await fetch(API + "/diagram-state.json", { cache: "no-store" }))
        .json();
  } catch (e) {
    setStatus("reload failed: " + e.message);
    return;
  }

  const tName = rebuildPalette(fresh);
  document.getElementById("themeSelect").value = tName;
  setDiagramTitle(fresh.title);
  ensureEdgeIds(fresh.edges);
  diagramState = fresh;
  EDGES_DEF = fresh.edges;
  pinnedSet = new Set(fresh.pinned || []);
  pinsDirty = false; // adopt disk's pin set
  // Adopt disk's note overrides; if we have unpersisted note drags, keep them on
  // top (mirrors how box drags are retained below) until the next persist lands.
  noteLayoutLocal = noteDirty
    ? { ...(fresh.noteLayout || {}), ...noteLayoutLocal }
    : { ...(fresh.noteLayout || {}) };
  fontSizeInput.value = fresh.fontSize || "";
  centerConnectorsBox.checked = fresh.connectorAnchor === "center";

  const moved = new Set(movedIds());
  const curById = new Map(BOXES.map((b) => [b.id, b]));
  const freshBoxes = computeLayout(ctx, fresh, fresh.width || 1500);

  let conflict = false;
  for (const fb of freshBoxes) {
    if (moved.has(fb.id)) {
      const base = baseline.get(fb.id);
      if (base && (fb.col !== base.col || fb.row !== base.row)) conflict = true; // both moved it
      const cur = curById.get(fb.id);
      if (cur) {
        fb.col = cur.col;
        fb.row = cur.row;
      } // keep the human's drag
    }
  }
  BOXES = freshBoxes; // ids absent from fresh are dropped (no orphans)
  lastRev = fresh.rev ?? lastRev;

  // New baseline: fresh positions, except keep the OLD baseline for retained deltas.
  const nb = new Map();
  for (const b of BOXES) {
    nb.set(
      b.id,
      (moved.has(b.id) && baseline.has(b.id))
        ? baseline.get(b.id)
        : { col: b.col, row: b.row },
    );
  }
  baseline = nb;

  fitGridToBoxes();
  rebuild();
  render();
  if (conflict) {
    banner.style.display = "block";
    setStatus("conflict — review (rev " + lastRev + ")");
  } else setStatus("updated (rev " + lastRev + ")");
}

const es = new EventSource("/events");
es.addEventListener("reload", (ev) => {
  let data = {};
  try {
    data = JSON.parse(ev.data);
  } catch { /* legacy empty */ }
  if ((data.diagram || "default") !== BOARD) return; // another board's change
  if (data.nonce && sentNonces.has(data.nonce)) { // our own echo (any in-flight nonce)
    if (typeof data.rev === "number") lastRev = data.rev;
    return;
  }
  if (drag) {
    pendingReload = true;
    return;
  } // mid-drag: defer, don't drop
  mergeReload();
});
