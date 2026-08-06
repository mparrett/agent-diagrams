import { assert } from "@std/assert";
import {
  boardExtent,
  boardExtentForContent,
  buildGrid,
  CELL,
  computeBridgeBreaks,
  computeLayout,
  createAstarState,
  DEFAULT_COSTS,
  fontFamily,
  Grid,
  MIN_BOX_H,
  nodeBoxHeight,
  routeEdges,
  simplifyPath,
  snapAlign,
  T_BLOCKED,
  withAlpha,
  wrapLabel,
} from "../diagram-core.js";

function assertEquals(actual, expected, msg = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, msg || `Expected ${e}, got ${a}`);
}

function assertRouteClear(route, grid) {
  assert(route.path, "expected route to have a path");
  for (const p of route.path) {
    assert(grid.ok(p.x, p.y), `route left grid at ${p.x},${p.y}`);
    assert(
      grid.get(p.x, p.y) !== T_BLOCKED,
      `route entered blocked cell ${p.x},${p.y}`,
    );
  }
}

function measureContext() {
  return {
    _font: "",
    set font(value) {
      this._font = value;
    },
    get font() {
      return this._font;
    },
    measureText(text) {
      const px = Number(this._font.match(/(\d+)px/)?.[1] ?? 13);
      const bold = this._font.includes("bold");
      return { width: String(text).length * px * (bold ? 0.64 : 0.55) };
    },
  };
}

function routeOnce(boxes, edges, cols = 44, rows = 24, opts = undefined) {
  const grid = new Grid(cols, rows);
  const costs = { ...DEFAULT_COSTS };
  const connMap = buildGrid(grid, boxes, costs);
  const routes = routeEdges(
    createAstarState(cols, rows),
    grid,
    edges,
    boxes,
    connMap,
    costs,
    undefined,
    opts,
  );
  return { grid, routes };
}

Deno.test("computeLayout round-trips a full persisted layout snapshot", () => {
  const ctx = measureContext();
  const state = {
    width: 900,
    nodes: [
      { id: "client", label: "Client", color: "blue", row: 0, col: 0 },
      {
        id: "api",
        label: "API Gateway",
        color: "green",
        details: ["auth", "routing"],
        row: 0,
        col: 1,
      },
      { id: "db", label: "Database", color: "purple", row: 1, col: 1 },
    ],
    edges: [
      { from: "client", to: "api" },
      { from: "api", to: "db" },
    ],
  };

  const first = computeLayout(ctx, state, state.width);
  const layout = Object.fromEntries(
    first.map((b) => [b.id, { x: b.col * CELL, y: b.row * CELL }]),
  );
  const second = computeLayout(ctx, { ...state, layout }, state.width);

  assertEquals(
    second.map((b) => ({ id: b.id, col: b.col, row: b.row, w: b.w, h: b.h })),
    first.map((b) => ({ id: b.id, col: b.col, row: b.row, w: b.w, h: b.h })),
  );
});

Deno.test("fontFamily uses bundled faces for both diagram font modes", () => {
  assertEquals(fontFamily({}), "DiagramMono");
  assertEquals(fontFamily({ font: "mono" }), "DiagramMono");
  assertEquals(fontFamily({ font: "sans" }), "DiagramSans");
});

Deno.test("withAlpha expands every hex form to rgba()", () => {
  // The 3-digit case is the bug this replaced: the default palette's borders
  // are 3-digit, and `"#68f" + "bb"` produced "#68fbb", which is not a colour,
  // so every box border drew black. Expansion must double each nibble.
  assert(
    withAlpha("#68f", 0.5) === "rgba(102, 136, 255, 0.5)",
    withAlpha("#68f", 0.5),
  );
  assert(
    withAlpha("#6688ff", 0.5) === "rgba(102, 136, 255, 0.5)",
    withAlpha("#6688ff", 0.5),
  );
  // An existing alpha is replaced, not multiplied — callers pass what they want.
  assert(
    withAlpha("#6688ff80", 0.5) === "rgba(102, 136, 255, 0.5)",
    withAlpha("#6688ff80", 0.5),
  );
  assert(
    withAlpha("#68F", 1) === "rgba(102, 136, 255, 1)",
    withAlpha("#68F", 1),
  );
  assert(withAlpha("  #68f  ", 1) === "rgba(102, 136, 255, 1)");
});

Deno.test("withAlpha leaves anything it can't parse alone", () => {
  // Returning the colour unchanged loses the alpha but still renders. Returning
  // a malformed string is what caused the black borders in the first place.
  for (
    const c of ["red", "rgb(1,2,3)", "rgba(1,2,3,0.5)", "#68fbb", "#1234567"]
  ) {
    assert(withAlpha(c, 0.5) === c, `${c} -> ${withAlpha(c, 0.5)}`);
  }
  assert(withAlpha(null, 0.5) === null);
  assert(withAlpha(undefined, 0.5) === undefined);
});

Deno.test("boardExtent applies renderer margins and base canvas floors", () => {
  const boxes = [
    { col: 2, row: 3, w: 4, h: 2 },
    { col: 12, row: 5, w: 3, h: 4 },
  ];

  assertEquals(boardExtent(boxes), {
    W: (12 + 3) * CELL + 40,
    H: (5 + 4) * CELL + 50,
    COLS: Math.floor(((12 + 3) * CELL + 40) / CELL),
    ROWS: Math.floor(((5 + 4) * CELL + 50) / CELL),
  });
  assertEquals(boardExtent(boxes, 500, 400), {
    W: 500,
    H: 400,
    COLS: Math.floor(500 / CELL),
    ROWS: Math.floor(400 / CELL),
  });
});

Deno.test("boardExtentForContent applies pixel-content margins", () => {
  assertEquals(boardExtentForContent({ x: 15, y: 30, w: 120, h: 80 }), {
    W: 175,
    H: 160,
    COLS: Math.floor(175 / CELL),
    ROWS: Math.floor(160 / CELL),
  });
});

Deno.test("computeLayout floors sparse boxes to the card minimum, lets content grow past it", () => {
  const ctx = measureContext();
  const boxes = computeLayout(ctx, {
    nodes: [
      { id: "sparse", label: "Hi", color: "blue", row: 0, col: 0 },
      {
        id: "rich",
        label: "Rich",
        color: "green",
        row: 1,
        col: 0,
        details: ["one", "two", "three", "four", "five"],
      },
    ],
    edges: [],
  }, 600);

  const sparse = boxes.find((b) => b.id === "sparse");
  const rich = boxes.find((b) => b.id === "rich");
  // A short single-label box is padded up to the card floor...
  assertEquals(sparse.pixH, MIN_BOX_H);
  // ...while a tall, detail-heavy box keeps its (larger) content height.
  assert(
    rich.pixH > MIN_BOX_H,
    `expected content-driven height, got ${rich.pixH}`,
  );
  assertEquals(
    rich.pixH,
    nodeBoxHeight(["one", "two", "three", "four", "five"]),
  );
});

Deno.test("wrapLabel: infinite budget never wraps; a finite budget wraps to <=2 lines and ellipsizes overflow", () => {
  const ctx = measureContext();
  // No budget → single line, verbatim (the auto-size path, byte-identical).
  assertEquals(wrapLabel(ctx, "Payment Reconciliation Service", Infinity), [
    "Payment Reconciliation Service",
  ]);
  // Narrow budget → wraps; at most 2 lines.
  const wrapped = wrapLabel(ctx, "Payment Reconciliation Service", 130);
  assert(
    wrapped.length === 2,
    `expected 2 lines, got ${JSON.stringify(wrapped)}`,
  );
  // Title too long for 2 lines at this width → last line ellipsized.
  const tight = wrapLabel(ctx, "One Two Three Four Five Six Seven Eight", 80);
  assert(tight.length <= 2, "capped at 2 lines");
  assert(
    tight[tight.length - 1].endsWith("…"),
    `expected ellipsis, got ${JSON.stringify(tight)}`,
  );
  // A single unbreakable word is never split (it overflows its one line).
  assertEquals(wrapLabel(ctx, "Supercalifragilistic", 40), [
    "Supercalifragilistic",
  ]);
});

Deno.test("computeLayout honors explicit w/h (cells), clamped up to content", () => {
  const ctx = measureContext();
  const sized = computeLayout(ctx, {
    nodes: [{ id: "a", label: "Hi", row: 0, col: 0, w: 18, h: 10 }],
    edges: [],
  }, 600).find((b) => b.id === "a");
  assertEquals([sized.w, sized.h], [18, 10]);

  // An undersized explicit request can't shrink below the content/card floor.
  const clamped = computeLayout(ctx, {
    nodes: [{ id: "a", label: "Hi", row: 0, col: 0, w: 1, h: 1 }],
    edges: [],
  }, 600).find((b) => b.id === "a");
  const auto = computeLayout(ctx, {
    nodes: [{ id: "a", label: "Hi", row: 0, col: 0 }],
    edges: [],
  }, 600).find((b) => b.id === "a");
  assertEquals([clamped.w, clamped.h], [auto.w, auto.h]);
});

// Boxes are drawn on the cell grid, so overlap has to be judged there — pixW is
// up to a cell narrower than the width that actually gets painted.
function rowOverlaps(boxes) {
  const rows = new Map();
  for (const b of boxes) {
    if (!rows.has(b.row)) rows.set(b.row, []);
    rows.get(b.row).push(b);
  }
  const bad = [];
  for (const rowBoxes of rows.values()) {
    rowBoxes.sort((a, b) => a.col - b.col);
    for (let i = 1; i < rowBoxes.length; i++) {
      const prev = rowBoxes[i - 1], curr = rowBoxes[i];
      const gap = (curr.col - (prev.col + prev.w)) * CELL;
      if (gap < 0) bad.push(`${prev.id}/${curr.id} overlap ${-gap}px`);
    }
  }
  return bad;
}

const DENSE_ROW = [
  "shadow-canary-probe.test.js",
  "diagram-core-router.test.js",
  "parity-browser-runner.js",
  "raster-parity-corpus.test.js",
  "upstream-defect-canary.js",
  "whiteboard-live-editor.js",
];

Deno.test("computeLayout never draws two boxes in a row on top of each other", () => {
  const ctx = measureContext();
  const nodes = [{ id: "root", label: "root", color: "green", row: 0, col: 0 }];
  const edges = [];
  DENSE_ROW.forEach((label, i) => {
    nodes.push({ id: `n${i}`, label, color: "blue", row: 1, col: i });
    edges.push({ from: "root", to: `n${i}` });
  });

  // A canvas narrower than the row needs is the trigger: the pixel-space packing
  // gets clamped at the right edge, and the snap to cells eats what gap is left.
  const boxes = computeLayout(ctx, { nodes, edges }, 900);
  assertEquals(rowOverlaps(boxes), []);
});

Deno.test("computeLayout keeps rows separated with uniformWidth on", () => {
  const ctx = measureContext();
  const nodes = DENSE_ROW.map((label, i) => ({
    id: `n${i}`,
    label,
    color: "blue",
    row: 0,
    col: i,
  }));
  // uniformWidth sizes every box to the widest, which is what leaves a dense
  // row no gap budget at all.
  const boxes = computeLayout(
    ctx,
    { nodes, edges: [], uniformWidth: true },
    900,
  );
  assertEquals(rowOverlaps(boxes), []);
});

Deno.test("the separation pass leaves human-placed boxes where they were put", () => {
  const ctx = measureContext();
  const nodes = DENSE_ROW.map((label, i) => ({
    id: `n${i}`,
    label,
    color: "blue",
    row: 0,
    col: i,
  }));
  // Two boxes dragged into an overlap on purpose: an override is a decision, so
  // the pass must not "correct" it. Coordinates are cell-aligned, since an
  // override still snaps through Math.round on the way to a column.
  const layout = { n1: { x: 300, y: 105 }, n2: { x: 315, y: 105 } };
  const boxes = computeLayout(ctx, { nodes, edges: [], layout }, 900);
  const at = (id) => boxes.find((b) => b.id === id);
  assertEquals([at("n1").col * CELL, at("n1").row * CELL], [300, 105]);
  assertEquals([at("n2").col * CELL, at("n2").row * CELL], [315, 105]);
  // ...and that pair is the *only* thing still overlapping. Asserting merely
  // "something overlaps" passes without the fix at all, satisfied by the
  // auto/auto collisions this pass is supposed to remove.
  const overlaps = rowOverlaps(boxes);
  assertEquals(overlaps.length, 1, JSON.stringify(overlaps));
  assert(overlaps[0].startsWith("n1/n2"), overlaps[0]);
});

Deno.test("the separation pass routes auto boxes around a pinned one", () => {
  const ctx = measureContext();
  const nodes = DENSE_ROW.map((label, i) => ({
    id: `n${i}`,
    label,
    color: "blue",
    row: 0,
    col: i,
  }));

  // A pinned box is skipped as a *mover* but must still count as an obstacle.
  // Without that, clearing the left neighbour walks an auto box straight into
  // the pin — which is worse than the bug this pass fixes, because the human
  // put it there. `y: 60` is one cell row below the auto row, so it also covers
  // a pin whose vertical span straddles the row rather than matching it.
  for (const y of [45, 60]) {
    const layout = { n5: { x: 900, y } };
    const boxes = computeLayout(ctx, { nodes, edges: [], layout }, 900);
    assertEquals(rowOverlaps(boxes), [], `pin at y=${y}`);
    const pin = boxes.find((b) => b.id === "n5");
    assertEquals([pin.col * CELL, pin.row * CELL], [900, y], `pin at y=${y}`);
  }
});

Deno.test("a pin only displaces boxes that share its rows", () => {
  const ctx = measureContext();
  // `tall` spans rows 3..13 and `pinned` sits at rows 9..14, so the pin is
  // inside the *row's* tallest span but nowhere near `short` (rows 3..7).
  // Matching obstacles against the row maximum rather than each box's own span
  // shoved `short` 285px to the right of a box it can never touch.
  const boxes = computeLayout(ctx, {
    nodes: [
      {
        id: "tall",
        label: "Tall",
        color: "blue",
        row: 0,
        col: 0,
        w: 12,
        h: 10,
      },
      {
        id: "short",
        label: "Short",
        color: "green",
        row: 0,
        col: 1,
        w: 12,
        h: 4,
      },
      { id: "pinned", label: "Pin", color: "red", row: 0, col: 9, w: 12, h: 4 },
    ],
    edges: [],
    layout: { pinned: { x: 50 * CELL, y: 9 * CELL } },
  }, 900);

  const at = (id) => boxes.find((b) => b.id === id);
  const short = at("short"), pin = at("pinned");
  assert(
    short.row + short.h <= pin.row,
    `fixture is wrong: short (${short.row}..${
      short.row + short.h
    }) must clear the pin (${pin.row})`,
  );
  assert(
    short.col < pin.col,
    `short was pushed past a pin it does not overlap: col ${short.col} vs pin col ${pin.col}`,
  );
});

Deno.test("the row-overlap fixture from #1 lays out clean", () => {
  const state = JSON.parse(
    Deno.readTextFileSync(
      new URL("./fixtures/row-overlap.json", import.meta.url),
    ),
  );
  const boxes = computeLayout(measureContext(), state, state.width);
  assertEquals(rowOverlaps(boxes), []);
});

Deno.test("computeLayout stacks automatic rows by measured box height", () => {
  const ctx = measureContext();
  const boxes = computeLayout(ctx, {
    nodes: [
      {
        id: "tall",
        label: "Tall service",
        color: "blue",
        row: 0,
        col: 0,
        details: ["one", "two", "three", "four", "five"],
      },
      { id: "below", label: "Below", color: "green", row: 1, col: 0 },
    ],
    edges: [],
  }, 600);

  const tall = boxes.find((b) => b.id === "tall");
  const below = boxes.find((b) => b.id === "below");
  assert(tall && below, "expected both boxes");
  const gapPx = below.row * CELL - (tall.row * CELL + tall.pixH);
  assert(gapPx >= 30, `expected visible row gap, got ${gapPx}px`);
});

Deno.test("routeEdges is deterministic and avoids blocked cells", () => {
  const boxes = [
    { id: "a", col: 3, row: 8, w: 5, h: 3 },
    { id: "obstacle", col: 15, row: 6, w: 5, h: 7 },
    { id: "b", col: 31, row: 8, w: 5, h: 3 },
  ];
  const edges = [{ from: "a", to: "b", fromEdge: "E", toEdge: "W" }];

  const first = routeOnce(boxes, edges);
  const second = routeOnce(boxes, edges);
  assertRouteClear(first.routes[0], first.grid);
  assertEquals(
    simplifyPath(first.routes[0].path),
    simplifyPath(second.routes[0].path),
  );
});

Deno.test("connectorAnchor center fans symmetrically; align clusters toward sources", () => {
  // Two sources up-and-left of a wide target, both forced onto the target's N
  // side → two connectors share one side (w=14 → center index 6).
  const boxes = [
    { id: "wide", col: 6, row: 12, w: 14, h: 3 },
    { id: "s1", col: 0, row: 0, w: 3, h: 2 },
    { id: "s2", col: 3, row: 0, w: 3, h: 2 },
  ];
  const edges = [
    { from: "s1", to: "wide", toEdge: "N" },
    { from: "s2", to: "wide", toEdge: "N" },
  ];
  const entryCol = (routes, from) => {
    const r = routes.find((x) => x.edge.from === from);
    return r.path[r.path.length - 1].x - 6; // cell offset into wide's N span
  };

  const align = routeOnce(boxes, edges).routes;
  const center =
    routeOnce(boxes, edges, 44, 24, { centerConnectors: true }).routes;

  // align: overlap-aligned → both clustered at the left (toward the sources).
  assertEquals([entryCol(align, "s1"), entryCol(align, "s2")], [0, 1]);
  // center: symmetric straddle of the side center (index 6).
  assertEquals([entryCol(center, "s1"), entryCol(center, "s2")], [6, 7]);
});

Deno.test("explicit fromConn/toConn pin endpoints to the exact slot cell", () => {
  // a's E side has h=3 slots (idx 0..2) at gy = row+idx, gx = col+w (one cell out).
  // b's W side likewise at gx = col-1. Pin source slot 0 (top) and target slot 2
  // (bottom) — the editor's drag-to-slot writes exactly these fields.
  const boxes = [
    { id: "a", col: 3, row: 8, w: 5, h: 3 },
    { id: "b", col: 31, row: 8, w: 5, h: 3 },
  ];
  const edges = [{
    from: "a",
    to: "b",
    fromEdge: "E",
    fromConn: 0,
    toEdge: "W",
    toConn: 2,
  }];

  const { grid, routes } = routeOnce(boxes, edges);
  const route = routes[0];
  assertRouteClear(route, grid);
  const src = route.path[0], tgt = route.path[route.path.length - 1];
  assertEquals([src.x, src.y], [8, 8], "source pinned to E slot 0");
  assertEquals([tgt.x, tgt.y], [30, 10], "target pinned to W slot 2");
});

Deno.test("routeEdges falls back when a requested connector side has no open exit", () => {
  const boxes = [
    { id: "a", col: 5, row: 7, w: 4, h: 4 },
    { id: "east-blocker", col: 10, row: 7, w: 4, h: 4 },
    { id: "target", col: 28, row: 7, w: 4, h: 4 },
  ];
  const edges = [{ from: "a", to: "target", fromEdge: "E", toEdge: "W" }];

  const { grid, routes } = routeOnce(boxes, edges);
  const route = routes[0];
  assertRouteClear(route, grid);
  assert(
    !(route.path[0].x === 9 && route.path[0].y >= 7 && route.path[0].y <= 10),
    "expected source connector to fall back from the blocked east side",
  );
});

// ── Crossing bridges (subway/circuit over-under) ──
const hWire = (x0, x1, y, width) => ({
  route: { width },
  pts: [{ x: x0, y }, { x: x1, y }],
});
const vWire = (x, y0, y1, width) => ({
  route: { width },
  pts: [{ x, y: y0 }, { x, y: y1 }],
});

Deno.test("computeBridgeBreaks: the earlier (lower-z) wire dips under at an H×V crossing", () => {
  const drawn = [hWire(0, 400, 100), vWire(200, 0, 300)]; // under, over
  const breaks = computeBridgeBreaks(drawn, 20);
  assertEquals(breaks[0].length, 1, "under wire gets one gap");
  assertEquals(breaks[1].length, 0, "over wire is untouched");
  assertEquals(breaks[0][0].x, 200);
  assertEquals(breaks[0][0].y, 100);
  assertEquals(breaks[0][0].gap, 4, "gap = over width/2 + 3 (default width 2)");
});

Deno.test("computeBridgeBreaks: z is draw order, not orientation — swapping flips who passes under", () => {
  const breaks = computeBridgeBreaks(
    [vWire(200, 0, 300), hWire(0, 400, 100)],
    20,
  );
  assertEquals(breaks[0].length, 1, "now the vertical (index 0) dips under");
  assertEquals(breaks[1].length, 0);
});

Deno.test("computeBridgeBreaks: T-junctions and shared endpoints don't gap", () => {
  // Vertical starts exactly on the horizontal — a junction, not a crossing.
  const tee = computeBridgeBreaks(
    [hWire(0, 400, 100), vWire(200, 100, 300)],
    20,
  );
  assertEquals(tee.flat().length, 0, "endpoint-on-segment is not a crossing");
  // Crossing within half a cell of the horizontal's end is a connector, skip it.
  const nearEnd = computeBridgeBreaks(
    [hWire(0, 400, 100), vWire(5, 0, 300)],
    20,
  );
  assertEquals(
    nearEnd.flat().length,
    0,
    "crossing hugging an endpoint is skipped",
  );
});

Deno.test("computeBridgeBreaks: parallel and non-touching wires produce no gaps", () => {
  const parallel = computeBridgeBreaks(
    [hWire(0, 400, 100), hWire(0, 400, 140)],
    20,
  );
  assertEquals(parallel.flat().length, 0);
  const apart = computeBridgeBreaks(
    [hWire(0, 100, 100), vWire(300, 0, 300)],
    20,
  );
  assertEquals(apart.flat().length, 0);
});

// ── snapAlign: adaptive lane detection ────────────────────────────
const mkBox = (id, col, row, w = 4, h = 3) => ({ id, col, row, w, h });

Deno.test("snapAlign('h') snaps a near-column to a shared column (median)", () => {
  // Centers (col + w/2 = col+2): 12, 13, 11 — gaps of 1, well under 0.5×width(=2),
  // so one lane. Median center 12 → col 10.
  const boxes = [mkBox("a", 10, 2), mkBox("b", 11, 8), mkBox("c", 9, 14)];
  const changed = snapAlign("h", boxes, 100, 100);
  assert(changed, "expected a change");
  for (const b of boxes) {
    assertEquals(b.col, 10, `${b.id} should land on col 10`);
  }
});

Deno.test("snapAlign keeps clearly separate columns apart (no false merge)", () => {
  // Centers 7 and 32 — gap 25 ≫ 0.5×width, so two singleton lanes: nothing aligns.
  const boxes = [mkBox("a", 5, 2), mkBox("b", 30, 2)];
  const before = boxes.map((b) => b.col);
  const changed = snapAlign("h", boxes, 100, 100);
  assert(!changed, "separate columns must not be merged");
  assertEquals(boxes.map((b) => b.col), before);
});

Deno.test("snapAlign('v') aligns a near-row to a shared row", () => {
  const boxes = [mkBox("a", 2, 10), mkBox("b", 9, 11), mkBox("c", 16, 9)];
  const changed = snapAlign("v", boxes, 100, 100);
  assert(changed, "expected a change");
  for (const b of boxes) {
    assertEquals(b.row, 10, `${b.id} should land on row 10`);
  }
});

Deno.test("snapAlign leaves a lone off-axis box untouched", () => {
  // Two aligned + one far outlier: the pair snaps, the outlier (its own lane) stays.
  const boxes = [mkBox("a", 10, 2), mkBox("b", 10, 8), mkBox("out", 50, 14)];
  snapAlign("h", boxes, 100, 100);
  assertEquals(
    boxes.find((b) => b.id === "out").col,
    50,
    "outlier must not move",
  );
});
