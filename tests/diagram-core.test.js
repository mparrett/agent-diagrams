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
  DEFAULT_MAX_BOX_W,
  DEFAULT_SIZES,
  deriveTheme,
  drawBoxes,
  drawGroups,
  drawRoutes,
  fontFamily,
  fontSizes,
  FRAME_GAP,
  Grid,
  groupFrames,
  groupLabelStyle,
  MIN_BOX_H,
  MIN_BOX_W,
  nodeBoxHeight,
  routeEdges,
  simplifyPath,
  snapAlign,
  T_BLOCKED,
  withAlpha,
  wrapDetails,
  wrapLabel,
} from "../diagram-core.js";
import { SCHEMES } from "../themes.js";

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

// The point of the default ceiling: one long string used to set the column
// width for its whole row, so a single node could stretch the board past the
// 4096px raster cap. These pin that wrapping is what happens instead, and that
// every way of asking for a wide box still works.
const LONG =
  "Reconcile the fork and upstream ownership status before the release";

Deno.test("a long label wraps to the default ceiling instead of widening the box", () => {
  const ctx = measureContext();
  const boxOf = (state) =>
    computeLayout(ctx, { edges: [], ...state }, 4000).find((b) => b.id === "a");

  const wrapped = boxOf({ nodes: [{ id: "a", label: LONG, row: 0, col: 0 }] });
  assert(
    wrapped.pixW <= DEFAULT_MAX_BOX_W,
    `expected width <= ${DEFAULT_MAX_BOX_W}, got ${wrapped.pixW}`,
  );
  assert(
    wrapped.labelLines.length === 2,
    `expected the label to wrap, got ${JSON.stringify(wrapped.labelLines)}`,
  );

  // maxNodeW: 0 restores unbounded growth, so a board that wants the old
  // behaviour can still have it.
  const unbounded = boxOf({
    maxNodeW: 0,
    nodes: [{ id: "a", label: LONG, row: 0, col: 0 }],
  });
  assert(
    unbounded.pixW > DEFAULT_MAX_BOX_W,
    `expected an unbounded box to exceed the ceiling, got ${unbounded.pixW}`,
  );
  assertEquals(unbounded.labelLines, [LONG], "unbounded means unwrapped");

  // An explicit width is the manual override and beats the ceiling.
  const explicit = boxOf({
    nodes: [{ id: "a", label: LONG, row: 0, col: 0, w: 40 }],
  });
  assert(
    explicit.pixW === 40 * CELL,
    `explicit width wins, got ${explicit.pixW}`,
  );
});

Deno.test("detail lines wrap too — capping only the label cannot cap the box", () => {
  const ctx = measureContext();
  const box = computeLayout(ctx, {
    edges: [],
    nodes: [{ id: "a", label: "#653", details: [LONG], row: 0, col: 0 }],
  }, 4000).find((b) => b.id === "a");

  assert(
    box.pixW <= DEFAULT_MAX_BOX_W,
    `a long detail must not widen the box, got ${box.pixW}`,
  );
  assert(
    box.detailLines.length > 1,
    `expected the detail to wrap, got ${JSON.stringify(box.detailLines)}`,
  );

  // The trade itself: against the same node with the ceiling off, the wrapped
  // box is narrower and no shorter. Asserting a bare height floor would not
  // catch a change that widened the box again.
  const unbounded = computeLayout(ctx, {
    edges: [],
    maxNodeW: 0,
    nodes: [{ id: "a", label: "#653", details: [LONG], row: 0, col: 0 }],
  }, 4000).find((b) => b.id === "a");
  assert(
    box.pixW < unbounded.pixW,
    `wrapped box should be narrower: ${box.pixW} vs ${unbounded.pixW}`,
  );
  assert(
    box.pixH >= unbounded.pixH,
    `wrapped box should be no shorter: ${box.pixH} vs ${unbounded.pixH}`,
  );
});

Deno.test("wrapDetails: each source line wraps independently and keeps unbreakable words", () => {
  const ctx = measureContext();
  const sizes = fontSizes();

  // Two facts stay two facts — they are not reflowed into one paragraph.
  const two = wrapDetails(
    ctx,
    ["alpha beta gamma delta", "second"],
    90,
    "monospace",
    sizes,
  );
  assertEquals(two[two.length - 1], "second", "the last source line survives");
  assert(
    two.length > 2,
    `expected the first line to wrap, got ${JSON.stringify(two)}`,
  );

  // No budget → verbatim passthrough, so nothing changes for callers that
  // disable the ceiling.
  assertEquals(
    wrapDetails(ctx, ["a b c"], Infinity, "monospace", sizes),
    ["a b c"],
  );

  // An unbreakable token is never chopped: it overflows its line and widens the
  // box, which is what keeps module specifiers and ids readable.
  const long = wrapDetails(
    ctx,
    ["jsr:@std/path@0.224.0/posix"],
    40,
    "monospace",
    sizes,
  );
  assertEquals(long, ["jsr:@std/path@0.224.0/posix"]);
});

Deno.test("auto widths come from the ladder, so a board shares box edges", () => {
  const ctx = measureContext();
  // Titles of deliberately assorted lengths: free-growing boxes would take a
  // different width each, which is the incoherence the ladder exists to remove.
  const boxes = computeLayout(ctx, {
    edges: [],
    nodes: [
      "Alpha",
      "Alpha Beta",
      "Alpha Beta Gamma",
      "Alpha Beta Gamma Delta",
      "Alpha Beta Gamma Delta Epsilon",
      "Alpha Beta Gamma Delta Epsilon Zeta",
    ].map((label, i) => ({ id: `n${i}`, label, row: i, col: 0 })),
  }, 4000);

  for (const b of boxes) {
    assert(
      b.pixW % CELL === 0,
      `${b.id} width ${b.pixW} is not a whole number of cells`,
    );
  }
  const distinct = new Set(boxes.map((b) => b.pixW));
  assert(
    distinct.size <= 3,
    `expected a handful of shared widths, got ${[...distinct].join(", ")}`,
  );
});

Deno.test("a narrower box is not chosen by throwing text away", () => {
  const ctx = measureContext();
  // The line caps let a narrow candidate ellipsize instead of growing taller,
  // so on area alone it looks cheapest *because* it lost content. The chooser
  // has to rule that out before comparing area.
  const node = {
    id: "a",
    label: "#653",
    details: [
      "boxed override for typed-return fns across the AOT lowering path",
    ],
    row: 0,
    col: 0,
  };
  const box = computeLayout(ctx, { edges: [], nodes: [node] }, 4000)
    .find((b) => b.id === "a");

  const lines = [...box.labelLines, ...box.detailLines];
  assert(
    !lines.some((l) => l.endsWith("…")),
    `a wider rung holds this text, so nothing should be cut: ${
      JSON.stringify(lines)
    }`,
  );

  // When no rung holds it all, show as much as possible. Minimising area here
  // would pick the narrowest rung — the one that discards the most — so this
  // must beat what the smallest box would have shown.
  const huge = { ...node, details: [("word ").repeat(120).trim()] };
  const wide = computeLayout(ctx, { edges: [], nodes: [huge] }, 4000)
    .find((b) => b.id === "a");
  const shown = (b) =>
    [...b.labelLines, ...b.detailLines].join(" ").replace(/…/g, "").length;
  const narrow = computeLayout(ctx, {
    edges: [],
    maxNodeW: MIN_BOX_W,
    nodes: [huge],
  }, 4000).find((b) => b.id === "a");
  assert(
    shown(wide) > shown(narrow),
    `unavoidable clipping should still show more than the smallest box: ` +
      `${shown(wide)} vs ${shown(narrow)}`,
  );
});

Deno.test("box width never shrinks as its label grows", () => {
  const ctx = measureContext();
  // The property that catches the whole class. A label one word too long for
  // the widest rung used to fall through to "smallest area among candidates
  // that all clip" — which is the narrowest rung, the one discarding the most
  // text. The box got *smaller* as the label got longer, dropping three
  // quarters of it, which is worse than having no ceiling at all.
  //
  // One shrink is allowed: where the title gains a line. Text is kept
  // unwrapped while that costs at most wrapSlack times the area, so the word
  // that no longer fits on any affordable line wraps the title into a
  // narrower, taller box. No text is lost there, which the second assertion
  // holds.
  const words =
    "Reconcile the fork and upstream ownership status before the release goes out to the wider team"
      .split(" ");
  let prevW = 0, prevShown = 0, prevLines = 0;
  for (let n = 3; n <= words.length; n++) {
    const label = words.slice(0, n).join(" ");
    const b = computeLayout(ctx, {
      edges: [],
      nodes: [{ id: "a", label, row: 0, col: 0 }],
    }, 4000).find((x) => x.id === "a");
    assert(
      b.pixW >= prevW || b.labelLines.length > prevLines,
      `width shrank at ${n} words without the title gaining a line: ${b.pixW} after ${prevW}`,
    );
    const shown = b.labelLines.join(" ").replace(/…/g, "").length;
    assert(
      shown >= prevShown,
      `shown text shrank at ${n} words: ${shown} after ${prevShown}`,
    );
    prevW = b.pixW;
    prevShown = shown;
    prevLines = b.labelLines.length;
  }
});

Deno.test("the uniformity pass keeps boxes inside the aspect band", () => {
  const ctx = measureContext();
  // A short-labelled peer makes a narrow width popular. Nudging a detail-rich
  // box onto it passes the area test — narrower is smaller *and* taller — so
  // without an aspect check the pass reinstates the columns the chooser just
  // rejected.
  const boxes = computeLayout(ctx, {
    edges: [],
    nodes: [
      { id: "a", label: "Hi", row: 0, col: 0 },
      { id: "b", label: "Yo", row: 1, col: 0 },
      {
        id: "c",
        label: "Service",
        details: ["one two three four five six seven eight nine ten"],
        row: 2,
        col: 0,
      },
    ],
  }, 4000);

  for (const b of boxes) {
    const aspect = b.pixW / b.pixH;
    assert(
      aspect >= 4 / 3 - 1e-9,
      `${b.id} is a column: ${b.pixW}x${b.pixH} (aspect ${aspect.toFixed(2)})`,
    );
  }
});

Deno.test("minW and uniformWidth wrap to the width the box actually gets", () => {
  const ctx = measureContext();
  const detail = "one two three four five six seven eight nine ten eleven";

  // minW widens the box through contentWidth, so wrapping to the ladder rung
  // alone broke text to fit a box it never landed in.
  const wide = computeLayout(ctx, {
    edges: [],
    nodes: [{
      id: "a",
      label: "S",
      details: [detail],
      minW: 500,
      row: 0,
      col: 0,
    }],
  }, 4000).find((b) => b.id === "a");
  assert(wide.pixW >= 500, `minW honored, got ${wide.pixW}`);
  const narrow = computeLayout(ctx, {
    edges: [],
    nodes: [{ id: "a", label: "S", details: [detail], row: 0, col: 0 }],
  }, 4000).find((b) => b.id === "a");
  assert(
    wide.detailLines.length < narrow.detailLines.length,
    `a 500px box should need fewer lines than a laddered one: ` +
      `${wide.detailLines.length} vs ${narrow.detailLines.length}`,
  );

  // uniformWidth widens every auto box to the widest; the text must reflow.
  const uni = computeLayout(ctx, {
    edges: [],
    uniformWidth: true,
    nodes: [
      { id: "a", label: "S", details: [detail], row: 0, col: 0 },
      {
        id: "b",
        label: "A much longer label that forces a wide rung",
        row: 1,
        col: 0,
      },
    ],
  }, 4000);
  const [ua, ub] = ["a", "b"].map((id) => uni.find((x) => x.id === id));
  assertEquals(ua.pixW, ub.pixW, "uniformWidth homogenizes");
  assert(
    ua.detailLines.length <= narrow.detailLines.length,
    "the widened box re-wrapped rather than keeping its narrow lines",
  );
});

Deno.test("the same col resolves to the same x, whatever row it is in", () => {
  const ctx = measureContext();
  // Widths differ deliberately: the old per-row spread positioned a box by its
  // share of its own row's col range and then subtracted the box width, so a
  // wide box and a narrow box declaring the same col drifted apart. Nothing
  // here is pinned — alignment has to come out of the layout itself.
  const nodes = [
    { id: "wide", label: "A box with a much longer label", row: 0, col: 1 },
    { id: "narrow", label: "x", row: 1, col: 1 },
    { id: "mid", label: "middling label", row: 2, col: 1 },
    { id: "side", label: "sidecar", row: 1, col: 0 },
    { id: "far", label: "far", row: 2, col: 3 },
  ];
  const boxes = computeLayout(ctx, { nodes, edges: [], layout: {} }, 1200);
  const at = (id) => boxes.find((b) => b.id === id);
  // Centre, not left edge: boxes of different widths share a column by running
  // a line through their middles, which is what reads as aligned. Left edges
  // would only line up for boxes that happen to be the same width.
  const centreOf = (id) => at(id).col + at(id).w / 2;

  // Within half a cell, not exactly equal: boxes are emitted on the grid with
  // `w` rounded up to whole cells, so two boxes centred on the same pixel can
  // still report grid centres 0.5 apart. That residue is quantization. What it
  // replaced was a spread that put the same col 11 cells apart across rows.
  const colOne = ["wide", "narrow", "mid"].map(centreOf);
  const spread = Math.max(...colOne) - Math.min(...colOne);
  assert(
    spread <= 0.5,
    `col 1 should resolve to one centre within half a cell, got ${
      JSON.stringify(colOne)
    }`,
  );

  // Columns keep their declared order, and a skipped index (2) still buys air.
  assert(centreOf("side") < centreOf("wide"), "col 0 sits left of col 1");
  assert(centreOf("far") > centreOf("wide"), "col 3 sits right of col 1");
});

Deno.test("persisting a subset of nodes does not move the rows around them", () => {
  const ctx = measureContext();
  // The editor persists positions the moment a human drags a couple of boxes,
  // so this runs on ordinary use. Row 0 holding a single tall box is the sharp
  // case: pinning it used to drop the row out of the stack entirely, and rows 1
  // and 2 then slid up into the band it had vacated.
  const nodes = [
    {
      id: "root",
      label: "Root",
      details: ["a", "b", "c", "d", "e", "f"],
      row: 0,
      col: 0,
    },
    { id: "n1", label: "One", row: 1, col: 0 },
    { id: "n2", label: "Two", row: 1, col: 2 },
    { id: "n3", label: "Three", row: 2, col: 0 },
  ];

  const layoutOf = (bs, ids) =>
    Object.fromEntries(
      ids.map((id) => {
        const b = bs.find((x) => x.id === id);
        return [id, { x: b.col * CELL, y: b.row * CELL }];
      }),
    );
  const bands = (bs) =>
    bs.map((b) => `${b.id}@${b.row}h${b.h}`).sort().join(" ");
  const collide = (bs) => {
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        const dx = Math.min(a.col + a.w, b.col + b.w) - Math.max(a.col, b.col);
        const dy = Math.min(a.row + a.h, b.row + b.h) - Math.max(a.row, b.row);
        if (dx > 0 && dy > 0) return `${a.id}/${b.id}`;
      }
    }
    return null;
  };

  const base = computeLayout(ctx, { nodes, edges: [], layout: {} }, 1200);
  const want = bands(base);
  const ids = nodes.map((n) => n.id);

  // Every subset, pinned at the position the layout itself just produced.
  // Persisting where a box already is has to be a no-op.
  for (let mask = 0; mask < (1 << ids.length); mask++) {
    const pinned = ids.filter((_, i) => mask & (1 << i));
    const bs = computeLayout(
      ctx,
      { nodes, edges: [], layout: layoutOf(base, pinned) },
      1200,
    );
    // A backstop, not the symptom: the force pass pushes displaced boxes
    // sideways, so the reflow never actually drew one box over another — this
    // passed against the broken engine too. It is here to catch a future change
    // that removes that cushion, and it should be expected to stay quiet.
    const hit = collide(bs);
    assert(!hit, `pinning ${JSON.stringify(pinned)} made ${hit} overlap`);
    // The real assertion. Row bands, not exact pixels: pinning removes a node
    // from the force pass, so its neighbours may drift a cell horizontally.
    // That is by design.
    assertEquals(
      bands(bs),
      want,
      `pinning ${JSON.stringify(pinned)} moved the vertical stack`,
    );
  }
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

Deno.test("edge width resolves edge, then board, then medium", () => {
  const boxes = [
    { id: "a", col: 3, row: 8, w: 5, h: 3 },
    { id: "b", col: 31, row: 8, w: 5, h: 3 },
  ];
  const edges = [
    { from: "a", to: "b", fromEdge: "E", toEdge: "W" },
    { from: "b", to: "a", width: "thick" },
  ];
  const widths = (opts) =>
    routeOnce(boxes, edges, 44, 24, opts).routes
      .map((r) => r.width);
  assertEquals(widths({ edgeWidth: "thin" }), [1.25, 3.25]);
  assertEquals(widths(undefined), [2, 3.25]);
  assertEquals(widths({ edgeWidth: "bogus" }), [2, 3.25]);
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

// drawRoutes against a context that measures text and ignores drawing calls.
function labelPlacements(routes) {
  const m = measureContext();
  const ctx = new Proxy(m, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
  return drawRoutes(ctx, routes, CELL);
}
const wire = (id, cells, label, labelPos) => ({
  edge: { id, from: "a", to: "b", label, labelPos },
  path: cells.map(([x, y]) => ({ x, y })),
  color: "#888",
});
const px = (c) => c * CELL + CELL / 2;

Deno.test("an edge label sits on a horizontal run it fits, not beside a longer vertical one", () => {
  const [l] = labelPlacements([
    wire("e", [[2, 2], [2, 20], [12, 20]], "ingest"),
  ]);
  assert(l.horiz && l.seg === 1, `host seg ${l.seg}, horiz ${l.horiz}`);
});

Deno.test("an edge label moves off another edge's wire", () => {
  const ls = labelPlacements([
    wire("v", [[2, 2], [2, 20]], "abc"),
    wire("h", [[3, 11], [10, 11]]),
  ]);
  const l = ls.find((x) => x.edge.id === "v");
  assert(
    l.rect.x + l.rect.w < px(2),
    `label should flip left of its wire, got x=${l.rect.x}`,
  );
});

Deno.test("an explicit labelSide keeps a host of matching orientation", () => {
  const [l] = labelPlacements([
    wire("e", [[2, 2], [2, 20], [12, 20]], "ingest", {
      side: "right",
      offset: 8,
    }),
  ]);
  assert(!l.horiz && l.rect.x > px(2), `expected right of the vertical run`);
});

// CIE Lab for a hex color.
function lab(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  });
  const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

// Two node borders read as different categories when their hues differ, or
// when they are far apart overall. ΔE alone misses the failure that matters:
// dawnfox blue and cyan were ΔE 19 apart yet 8° apart in hue, and read as one
// color on a box. A low-chroma color (gray) has no usable hue, so it only
// needs distance.
function distinct(a, b) {
  const [p, q] = [lab(a), lab(b)];
  const dE = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const chroma = (c) => Math.hypot(c[1], c[2]);
  if (chroma(p) < 10 || chroma(q) < 10) return { ok: dE >= 15, dE, dh: NaN };
  const hue = (c) => Math.atan2(c[2], c[1]) * 180 / Math.PI;
  let dh = Math.abs(hue(p) - hue(q));
  if (dh > 180) dh = 360 - dh;
  return { ok: dh >= 12 || dE >= 25, dE, dh };
}

Deno.test("every color theme keeps its node colors apart", () => {
  // monolight is grayscale on purpose: categories differ by border darkness.
  for (const [name, scheme] of Object.entries(SCHEMES)) {
    if (name === "monolight") continue;
    const colors = Object.entries(deriveTheme(scheme).colors);
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const r = distinct(colors[i][1].border, colors[j][1].border);
        assert(
          r.ok,
          `${name}: ${colors[i][0]}/${colors[j][0]} borders ΔE ${
            r.dE.toFixed(1)
          }, hue ${r.dh.toFixed(0)}°`,
        );
      }
    }
  }
});

Deno.test("an edge label stays off a group frame's border", () => {
  // A horizontal run 6px above a frame's top edge: the default spot above it
  // is clear, so only the frame border can push it. Put a foreign wire above
  // to force the search, as on a real board.
  const frameTop = px(12) + 6;
  const m = measureContext();
  const ctx = new Proxy(m, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
  const ls = drawRoutes(
    ctx,
    [
      wire("e", [[2, 12], [20, 12]], "knowledge (R1.2)"),
      wire("other", [[2, 11], [20, 11]]),
    ],
    CELL,
    undefined,
    { frames: [{ x: 0, y: frameTop, w: 400, h: 200 }] },
  );
  const r = ls.find((l) => l.edge.id === "e").rect;
  const onBorder = r.y < frameTop && r.y + r.h > frameTop;
  assert(!onBorder, `label straddles the frame border: ${JSON.stringify(r)}`);
});

Deno.test("a short title stays on one line when the wider box costs little", () => {
  const ctx = measureContext();
  const box = (state) =>
    computeLayout(ctx, {
      edges: [],
      ...state,
      nodes: [{ id: "a", label: "Message history", row: 0, col: 0 }],
    }, 4000).find((b) => b.id === "a");
  // The stub measurer floors both boxes at the minimum height, so the
  // one-line box costs 180/105 = 1.71x here (1.43x with real fonts).
  const kept = box({ wrapSlack: 2 });
  assert(
    kept.labelLines.length === 1,
    `slack 2 should keep it whole: ${JSON.stringify(kept.labelLines)}`,
  );
  const wrapped = box({ wrapSlack: 1 });
  assert(
    wrapped.labelLines.length === 2 && wrapped.pixW < kept.pixW,
    `wrapSlack 1 is the old smallest-area pick: ${
      JSON.stringify(wrapped.labelLines)
    } at ${wrapped.pixW}`,
  );
});

Deno.test("the uniformity pass does not re-wrap a title kept on one line", () => {
  const ctx = measureContext();
  const peers = ["Alpha svc", "Beta svc", "Gamma svc"].map((label, i) => ({
    id: `p${i}`,
    label,
    row: 0,
    col: i,
  }));
  const boxes = computeLayout(ctx, {
    edges: [],
    wrapSlack: 2,
    nodes: [...peers, {
      id: "t",
      label: "Portal: Knowledge area",
      row: 1,
      col: 0,
    }],
  }, 4000);
  const t = boxes.find((b) => b.id === "t");
  assert(
    t.labelLines.length === 1,
    `title re-wrapped onto a popular width: ${JSON.stringify(t.labelLines)}`,
  );
});

Deno.test("a short detail line stays whole when the wider box costs little", () => {
  const ctx = measureContext();
  const box = (state) =>
    computeLayout(ctx, {
      edges: [],
      ...state,
      nodes: [{
        id: "a",
        label: "Customer",
        details: ["sales / help team"],
        row: 0,
        col: 0,
      }],
    }, 4000).find((b) => b.id === "a");
  const kept = box({ wrapSlack: 2 });
  assert(
    kept.detailLines.length === 1,
    `slack 2 should keep the detail whole: ${JSON.stringify(kept.detailLines)}`,
  );
  const wrapped = box({ wrapSlack: 1 });
  assert(
    wrapped.detailLines.length > 1 && wrapped.pixW < kept.pixW,
    `wrapSlack 1 is the smallest-area pick: ${
      JSON.stringify(wrapped.detailLines)
    } at ${wrapped.pixW}`,
  );
});

// ─── Stage 0 group spacing (docs/project_notes/group-layout.md) ───────────
const LABEL_BAND = Math.round(DEFAULT_SIZES.divider * 1.4);
const box = (id, row, col) => ({ id, label: id, row, col });
function framed(nodes, groups, extra = {}) {
  const ctx = measureContext();
  const boxes = computeLayout(
    ctx,
    { edges: [], nodes, groups, ...extra },
    4000,
  );
  const frames = new Map(groupFrames(groups, boxes).map((f) => [f.id, f]));
  const px = (id) => {
    const b = boxes.find((x) => x.id === id);
    return { x: b.col * CELL, y: b.row * CELL, w: b.w * CELL, h: b.h * CELL };
  };
  return { boxes, frames, px };
}
// Top of a frame including its label, which straddles the border.
const labelTop = (f) => f.rect.y - (f.label ? LABEL_BAND / 2 : 0);

Deno.test("stacked groups in consecutive rows keep FRAME_GAP between frames", () => {
  const { frames } = framed(
    [box("a", 0, 0), box("b", 0, 1), box("c", 1, 0), box("d", 1, 1)],
    [
      { id: "top", label: "Top", nodes: ["a", "b"] },
      { id: "low", label: "Low", nodes: ["c", "d"] },
    ],
  );
  const top = frames.get("top"), low = frames.get("low");
  const gap = labelTop(low) - (top.rect.y + top.rect.h);
  assert(gap >= FRAME_GAP, `frames ${gap}px apart, want ≥ ${FRAME_GAP}`);
});

Deno.test("a box above a labeled group clears its label", () => {
  const { frames, px } = framed(
    [box("above", 0, 0), box("a", 1, 0)],
    [{ id: "g", label: "Group", nodes: ["a"] }],
  );
  const above = px("above");
  const gap = labelTop(frames.get("g")) - (above.y + above.h);
  assert(gap >= FRAME_GAP, `label ${gap}px below the box, want ≥ ${FRAME_GAP}`);
});

Deno.test("an enclosing group's extra pad is spaced for", () => {
  const { frames, px } = framed(
    [box("above", 0, 0), box("a", 1, 0), box("b", 2, 0)],
    [
      { id: "outer", label: "Outer", nodes: ["a", "b"] },
      { id: "inner", label: "Inner", nodes: ["a"] },
    ],
  );
  const above = px("above");
  const gap = labelTop(frames.get("outer")) - (above.y + above.h);
  assert(gap >= FRAME_GAP, `outer label ${gap}px below the box`);
});

Deno.test("groups side by side in adjacent columns keep FRAME_GAP apart", () => {
  const { frames } = framed(
    [box("a", 0, 0), box("b", 0, 1)],
    [
      { id: "left", nodes: ["a"] },
      { id: "right", nodes: ["b"] },
    ],
  );
  const l = frames.get("left").rect, r = frames.get("right").rect;
  const gap = r.x - (l.x + l.w);
  assert(gap >= FRAME_GAP, `frames ${gap}px apart, want ≥ ${FRAME_GAP}`);
});

Deno.test("group spacing leaves skipped rows and explicit rowY alone", () => {
  const nodes = [box("a", 0, 0), box("b", 2, 0)];
  const groups = [
    { id: "g1", label: "One", nodes: ["a"] },
    { id: "g2", label: "Two", nodes: ["b"] },
  ];
  const ys = (extra, gs) =>
    framed(nodes, gs, extra).boxes.map((b) => [b.id, b.row]);
  // A skipped row already gives the frames more room than they need.
  assertEquals(ys({}, groups), ys({}, undefined));
  // An explicit rowY wins outright.
  const pinned = { rowY: { "2": 120 } };
  assertEquals(
    ys(pinned, groups).find(([id]) => id === "b"),
    ["b", Math.round(120 / CELL)],
  );
});

// ─── Stage 1 inner groups (docs/project_notes/group-layout-stage1.md) ─────
const inside = (outer, r) =>
  r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w &&
  r.y + r.h <= outer.y + outer.h;

Deno.test("an inner group lays out its members on their own grid", () => {
  const { boxes, frames, px } = framed(
    [box("a", 0, 0), box("b", 0, 1), box("c", 1, 0), box("out", 0, 0)],
    [{
      id: "g",
      label: "G",
      nodes: ["a", "b", "c"],
      layout: "inner",
      row: 1,
      col: 0,
    }],
  );
  const g = frames.get("g");
  for (const id of ["a", "b", "c"]) {
    assert(inside(g.rect, px(id)), `${id} outside its group frame`);
  }
  assert(g.intruders.length === 0, `intruders: ${g.intruders}`);
  // Local rows: a and b share a row, c sits below them.
  assert(px("a").y === px("b").y && px("c").y > px("a").y, "local rows");
  // The plain box at parent row 0 sits above the group (parent row 1).
  assert(px("out").y + px("out").h < labelTop(g), "parent rows");
  assert(boxes.length === 4, "every node is laid out once");
});

Deno.test("a neighbour of an inner group stays outside its frame", () => {
  // The group's members spread wide; its parent cell widens to hold them,
  // so the box in the next parent column is pushed clear rather than covered.
  const members = [0, 1, 2, 3].map((c) => box(`m${c}`, 0, c));
  const { frames, px } = framed(
    [...members, box("next", 0, 1)],
    [{
      id: "g",
      nodes: members.map((m) => m.id),
      layout: "inner",
      row: 0,
      col: 0,
    }],
  );
  const g = frames.get("g").rect, n = px("next");
  assert(n.x >= g.x + g.w, `next at ${n.x}, frame ends at ${g.x + g.w}`);
});

Deno.test("an annotation group around an inner group draws around it", () => {
  const { frames } = framed(
    [box("a", 0, 0), box("b", 0, 1), box("c", 1, 0)],
    [
      {
        id: "in",
        label: "In",
        nodes: ["a", "b"],
        layout: "inner",
        row: 0,
        col: 0,
      },
      { id: "all", label: "All", nodes: ["a", "b", "c"] },
    ],
  );
  const inR = frames.get("in").rect, all = frames.get("all").rect;
  assert(inside(all, inR), "the annotation frame should contain the inner one");
});

Deno.test("members' layout overrides are ignored inside an inner group", () => {
  const nodes = [box("a", 0, 0), box("b", 0, 1)];
  const groups = [{
    id: "g",
    nodes: ["a", "b"],
    layout: "inner",
    row: 0,
    col: 0,
  }];
  const free = framed(nodes, groups).px("a");
  const pinned = framed(nodes, groups, { layout: { a: { x: 900, y: 600 } } })
    .px("a");
  assert(
    free.x === pinned.x && free.y === pinned.y,
    "pinning inside an inner group waits for Stage 2",
  );
});

// ─── Stage 2a nested inner groups (docs/project_notes/group-layout-stage2.md)
const AR_NODES = [
  box("kb-docs", 0, 0),
  box("kb-index", 1, 0),
  box("style-guide", 0, 0),
  box("style-examples", 0, 1),
  box("tm-entities", 0, 0),
  box("ar-api", 1, 0),
  box("ar-cache", 1, 1),
  box("loose", 0, 0),
];
const arGroups = (child = {}) => [
  {
    id: "ar",
    label: "Agent Reference",
    layout: "inner",
    row: 1,
    col: 0,
    nodes: ["knowledge", "style", "topicmap", "ar-api", "ar-cache"],
  },
  {
    id: "knowledge",
    label: "Knowledge",
    layout: "inner",
    row: 0,
    col: 0,
    nodes: ["kb-docs", "kb-index"],
    ...child,
  },
  {
    id: "style",
    label: "Style Guide",
    layout: "inner",
    row: 0,
    col: 1,
    nodes: ["style-guide", "style-examples"],
  },
  {
    id: "topicmap",
    label: "Topic Map",
    layout: "inner",
    row: 0,
    col: 2,
    nodes: ["tm-entities"],
  },
];
const cellRect = (b) => ({
  x: b.col * CELL,
  y: b.row * CELL,
  w: b.w * CELL,
  h: b.h * CELL,
});
const disjoint = (a, b) =>
  a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y ||
  b.y + b.h <= a.y;
const drawnLabels = (frames) =>
  new Map(
    drawGroups(recordingContext().ctx, [...frames.values()]).map((l) => [
      [...frames.values()].find((f) => f.label === l.label).id,
      l,
    ]),
  );

Deno.test("nested inner groups sit inside their parent's frame", () => {
  const { boxes, frames, px } = framed(AR_NODES, arGroups());
  const ar = frames.get("ar");
  const kids = ["knowledge", "style", "topicmap"].map((id) => frames.get(id));
  for (const k of kids) {
    assert(inside(ar.rect, k.labelled), `${k.id} outside ar's frame`);
    assert(k.intruders.length === 0, `${k.id} intruders: ${k.intruders}`);
  }
  assert(ar.intruders.length === 0, `ar intruders: ${ar.intruders}`);
  for (const [a, b] of [[kids[0], kids[1]], [kids[1], kids[2]]]) {
    const gap = b.labelled.x - (a.labelled.x + a.labelled.w);
    assert(gap >= FRAME_GAP, `${a.id}–${b.id} ${gap}px apart`);
  }
  // ar-api shares col 0 of ar's grid with the knowledge group's box.
  const mid = (r) => r.x + r.w / 2;
  const kb = cellRect(boxes.groupBoxes.get("knowledge"));
  assert(
    Math.abs(mid(px("ar-api")) - mid(kb)) <= CELL,
    `ar-api centred at ${mid(px("ar-api"))}, knowledge at ${mid(kb)}`,
  );
  assert(px("ar-api").y > kb.y + kb.h, "ar-api sits below the child row");
  assert(px("loose").y + px("loose").h < labelTop(ar), "board rows");
  assert(boxes.length === AR_NODES.length, "every node is laid out once");
});

Deno.test("a child's frame and label stay inside its box for every labelPos", () => {
  // A short label: one wider than its frame overhangs it sideways, which
  // insets do not cover.
  for (
    const labelPos of [
      "top-border",
      "top-inside",
      "top-outside",
      "bottom-border",
      "bottom-inside",
      "bottom-outside",
    ]
  ) {
    const { boxes, frames } = framed(
      AR_NODES,
      arGroups({ label: "KB", labelPos, labelSize: 24 }),
    );
    const kb = frames.get("knowledge"), ar = frames.get("ar");
    const own = cellRect(boxes.groupBoxes.get("knowledge"));
    const labels = drawnLabels(frames);
    const label = labels.get("knowledge");
    assert(inside(own, kb.rect), `${labelPos}: frame outside its box`);
    assert(inside(own, label), `${labelPos}: label outside its box`);
    assert(inside(ar.rect, label), `${labelPos}: label outside ar's frame`);
    assert(
      disjoint(labels.get("ar"), label),
      `${labelPos}: ar's label overlaps the child's`,
    );
  }
});

Deno.test("three levels of inner groups nest", () => {
  const nodes = [box("a1", 0, 0), box("b1", 0, 0), box("c1", 0, 0)];
  const groups = [
    { id: "a", label: "A", layout: "inner", nodes: ["b", "a1"], row: 0 },
    {
      id: "b",
      label: "B",
      layout: "inner",
      nodes: ["c", "b1"],
      row: 0,
      col: 1,
    },
    { id: "c", label: "C", layout: "inner", nodes: ["c1"], row: 1 },
  ];
  const { boxes, frames } = framed(nodes, groups);
  const f = (id) => frames.get(id);
  assert(inside(f("b").rect, f("c").labelled), "c outside b");
  assert(inside(f("a").rect, f("b").labelled), "b outside a");
  assertEquals(f("a").members.toSorted(), ["a1", "b1", "c1"]);
  const g = (id) => cellRect(boxes.groupBoxes.get(id));
  assert(inside(g("a"), g("b")) && inside(g("b"), g("c")), "boxes nest");
  for (const id of ["a", "b", "c"]) {
    assert(f(id).intruders.length === 0, `${id}: ${f(id).intruders}`);
  }
});

Deno.test("reordering the groups array leaves positions unchanged", () => {
  const at = (groups) =>
    framed(AR_NODES, groups).boxes.map((b) => [b.id, b.col, b.row]).sort();
  assertEquals(at(arGroups().toReversed()), at(arGroups()));
});

Deno.test("an annotation group listing a nested group wraps and spaces it", () => {
  const nodes = [...AR_NODES, box("under", 1, 2)];
  const groups = [
    ...arGroups(),
    {
      id: "note",
      label: "Note",
      nodes: ["style"],
      labelPos: "bottom-outside",
      labelSize: 30,
    },
  ];
  groups[0].nodes.push("under");
  const { frames, px } = framed(nodes, groups);
  const note = frames.get("note"), ar = frames.get("ar");
  assert(inside(note.rect, frames.get("style").labelled), "note wraps style");
  assert(inside(ar.rect, note.labelled), "ar wraps note");
  const gap = px("ar-cache").y - (note.labelled.y + note.labelled.h);
  assert(gap >= FRAME_GAP, `note's label ${gap}px above ar's next row`);
});

Deno.test("an annotation group inside one inner group is spaced there", () => {
  const groups = [
    ...arGroups(),
    {
      id: "docs",
      label: "Docs",
      nodes: ["kb-docs"],
      labelPos: "bottom-outside",
      labelSize: 30,
    },
  ];
  const { boxes, frames, px } = framed(AR_NODES, groups);
  const docs = frames.get("docs"), kb = frames.get("knowledge");
  const gap = px("kb-index").y - (docs.labelled.y + docs.labelled.h);
  assert(gap >= FRAME_GAP, `docs' label ${gap}px above kb-index`);
  assert(inside(kb.rect, docs.labelled), "knowledge wraps docs");
  const own = cellRect(boxes.groupBoxes.get("knowledge"));
  assert(inside(own, kb.labelled), "knowledge's box holds its frame");
});

// ─── Box style defaults and corners ─────────────────────────────────

Deno.test("box style tokens resolve node, then board, then built-in", () => {
  const boxes = computeLayout(measureContext(), {
    outlineWidth: "thin",
    outlineDash: "dashed",
    corners: "square",
    edges: [],
    nodes: [
      { id: "plain", label: "Plain", color: "blue", row: 0, col: 0 },
      {
        id: "own",
        label: "Own",
        color: "blue",
        row: 0,
        col: 1,
        outlineWidth: "thick",
        outlineDash: "dotted",
        corners: "round",
      },
      { id: "member", label: "Member", color: "blue", row: 0, col: 0 },
    ],
    groups: [{
      id: "g",
      label: "G",
      nodes: ["member"],
      layout: "inner",
      row: 1,
      col: 0,
    }],
  }, 4000);
  const style = (id) => {
    const b = boxes.find((x) => x.id === id);
    return [b.outlineWidth, b.outlineDash, b.corners];
  };
  assertEquals(style("plain"), ["thin", "dashed", "square"]);
  assertEquals(style("own"), ["thick", "dotted", "round"]);
  assertEquals(style("member"), ["thin", "dashed", "square"]);

  const bare = computeLayout(measureContext(), {
    edges: [],
    nodes: [{ id: "a", label: "A", color: "blue", row: 0, col: 0 }],
  }, 4000)[0];
  assertEquals(
    [bare.outlineWidth, bare.outlineDash, bare.corners],
    [undefined, undefined, undefined],
    "no token anywhere leaves drawBoxes its built-in default",
  );
});

// Records every arcTo radius and the lineWidth/dash in force at each stroke.
function recordingContext() {
  const log = { radii: [], strokes: [] };
  let lineWidth = 1, dash = [];
  const ctx = measureContext();
  Object.assign(ctx, {
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    fill() {},
    fillText() {},
    arcTo(_x1, _y1, _x2, _y2, r) {
      log.radii.push(r);
    },
    setLineDash(d) {
      dash = d;
    },
    stroke() {
      log.strokes.push({ lineWidth, dash });
    },
  });
  Object.defineProperty(ctx, "lineWidth", {
    set(v) {
      lineWidth = v;
    },
    get() {
      return lineWidth;
    },
  });
  return { ctx, log };
}

Deno.test("drawBoxes draws square corners at radius 0 and round at 6", () => {
  const draw = (box) => {
    const { ctx, log } = recordingContext();
    drawBoxes(
      ctx,
      [{
        id: "a",
        label: "A",
        color: "blue",
        col: 1,
        row: 1,
        w: 8,
        h: 4,
        ...box,
      }],
      CELL,
      undefined,
      { shadow: false },
    );
    return log;
  };
  const square = draw({ corners: "square", outlineWidth: "thin" });
  assert(square.radii.length > 0, "the box outline was drawn");
  assert(square.radii.every((r) => r === 0), `radii ${square.radii}`);
  assertEquals(square.strokes[0], { lineWidth: 1, dash: [] });

  for (const corners of ["round", undefined, "constructor"]) {
    const log = draw({ corners });
    assert(
      log.radii.length > 0 && log.radii.every((r) => r === 6),
      `${corners}: radii ${log.radii}`,
    );
  }
});

// ─── Group label placement ──────────────────────────────────────────

// Frame and drawn label rect for one labeled group around "a", with boxes
// directly above and below it.
function labelled(groupFields, board = {}) {
  const nodes = [box("above", 0, 0), box("a", 1, 0), box("below", 2, 0)];
  const groups = [{ id: "g", label: "Group", nodes: ["a"], ...groupFields }];
  const boxes = computeLayout(
    measureContext(),
    { edges: [], nodes, groups, ...board },
    4000,
  );
  const frame = groupFrames(groups, boxes, undefined, board)[0];
  const { ctx } = recordingContext();
  const label = drawGroups(ctx, [frame])[0];
  const px = (id) => {
    const b = boxes.find((x) => x.id === id);
    return { x: b.col * CELL, y: b.row * CELL, w: b.w * CELL, h: b.h * CELL };
  };
  return { frame: frame.rect, label, px };
}

Deno.test("group labels clear neighbouring boxes in every position", () => {
  for (
    const pos of Object.keys({
      "top-border": 1,
      "top-inside": 1,
      "top-outside": 1,
      "bottom-border": 1,
      "bottom-inside": 1,
      "bottom-outside": 1,
    })
  ) {
    const { frame, label, px } = labelled({ labelPos: pos });
    const above = px("above"), a = px("a"), below = px("below");
    const top = Math.min(frame.y, label.y);
    const bottom = Math.max(frame.y + frame.h, label.y + label.h);
    assert(
      top - (above.y + above.h) >= FRAME_GAP &&
        below.y - bottom >= FRAME_GAP,
      `${pos}: ${top - (above.y + above.h)}px above, ${
        below.y - bottom
      }px below`,
    );
    const inside = pos.endsWith("inside");
    const within = label.y >= frame.y && label.y + label.h <= frame.y + frame.h;
    assert(within === inside, `${pos}: label inside the frame is ${within}`);
    const clear = label.y + label.h <= a.y || label.y >= a.y + a.h;
    assert(clear, `${pos}: label overlaps its member`);
    assert(
      pos.startsWith("top") ? label.y < a.y : label.y > a.y,
      `${pos}: label on the wrong side`,
    );
  }
});

Deno.test("group label alignment, weight and size", () => {
  const mid = (r) => r.x + r.w / 2;
  const c = labelled({ labelAlign: "center" });
  assert(Math.abs(mid(c.label) - mid(c.frame)) < 1, "center");
  const r = labelled({ labelAlign: "right" });
  const gap = r.frame.x + r.frame.w - (r.label.x + r.label.w);
  assert(gap > 0 && gap < 12, `right: ${gap}px from the frame's edge`);
  const big = labelled({ labelWeight: "normal", labelSize: 20 });
  assert(big.label.font.startsWith("normal 20px"), big.label.font);
});

Deno.test("group label style: group, then board, then built-in", () => {
  const board = { groupLabelPos: "top-inside", groupLabelSize: 18 };
  const own = groupLabelStyle(
    { label: "G", labelPos: "bottom-outside", labelAlign: "right" },
    board,
  );
  assert(
    own.side === "bottom" && own.mode === "outside" && own.align === "right" &&
      own.size === 18,
    JSON.stringify(own),
  );
  const bare = groupLabelStyle({ label: "G", labelPos: "sideways" });
  assert(
    bare.side === "top" && bare.mode === "border" && bare.weight === "bold" &&
      bare.size === DEFAULT_SIZES.divider,
    JSON.stringify(bare),
  );
  assert(groupLabelStyle({}).reach === 0, "no label, no reach");
});

Deno.test("an inner group pads for an inside label", () => {
  const nodes = [box("a", 0, 0), box("b", 0, 1)];
  for (const labelPos of ["top-inside", "bottom-inside"]) {
    const groups = [{
      id: "g",
      label: "Group",
      nodes: ["a", "b"],
      layout: "inner",
      row: 0,
      col: 0,
      labelPos,
      labelSize: 24,
    }];
    const boxes = computeLayout(
      measureContext(),
      { edges: [], nodes, groups },
      4000,
    );
    const frame = groupFrames(groups, boxes)[0];
    const { ctx } = recordingContext();
    const label = drawGroups(ctx, [frame])[0];
    for (const id of ["a", "b"]) {
      const b = boxes.find((x) => x.id === id);
      const y0 = b.row * CELL, y1 = y0 + b.h * CELL;
      assert(
        label.y + label.h <= y0 || label.y >= y1,
        `${labelPos}: label overlaps ${id}`,
      );
    }
  }
});

// ─── Stage 2b pins (docs/project_notes/group-layout-stage2.md) ──────────────
const at = (boxes, id) => {
  const b = boxes.find((x) => x.id === id) ?? boxes.groupBoxes.get(id);
  return [b.col, b.row];
};
const minus = (p, q) => [p[0] - q[0], p[1] - q[1]];
const AR_DESCENDANTS = [
  "kb-docs",
  "kb-index",
  "style-guide",
  "style-examples",
  "tm-entities",
  "ar-api",
  "ar-cache",
  "knowledge",
  "style",
  "topicmap",
];

Deno.test("a nested board without pins keeps its positions", () => {
  const { boxes } = framed(AR_NODES, arGroups());
  assertEquals(
    ["ar", ...AR_DESCENDANTS, "loose"].map((id) => [id, ...at(boxes, id)]),
    [
      ["ar", 107, 11],
      ["kb-docs", 109, 15],
      ["kb-index", 109, 23],
      ["style-guide", 122, 15],
      ["style-examples", 133, 15],
      ["tm-entities", 148, 15],
      ["ar-api", 110, 32],
      ["ar-cache", 129, 32],
      ["knowledge", 108, 13],
      ["style", 121, 13],
      ["topicmap", 147, 13],
      ["loose", 130, 3],
    ],
  );
});

Deno.test("pinning a root group moves all its descendants with it", () => {
  const free = framed(AR_NODES, arGroups()).boxes;
  const [c, r] = at(free, "ar");
  const pinned = framed(AR_NODES, arGroups(), {
    layout: { ar: { x: (c + 10) * CELL, y: (r + 5) * CELL } },
  }).boxes;
  assertEquals(at(pinned, "ar"), [c + 10, r + 5]);
  for (const id of AR_DESCENDANTS) {
    assertEquals(minus(at(pinned, id), at(free, id)), [10, 5], id);
  }
});

Deno.test("a group id pins only where it is a root", () => {
  const free = framed(AR_NODES, arGroups()).boxes;
  const pinned = framed(AR_NODES, arGroups(), {
    layout: { knowledge: { x: 900, y: 900 } },
  }).boxes;
  for (const id of ["ar", ...AR_DESCENDANTS]) {
    assertEquals(at(pinned, id), at(free, id), id);
  }
});

Deno.test("pinning a child group moves its members, not its siblings", () => {
  const rel = (boxes, id) => minus(at(boxes, id), at(boxes, "ar"));
  const pin = (x, y) =>
    framed(AR_NODES, arGroups(), {
      innerLayout: { ar: { topicmap: { x: x * CELL, y: y * CELL } } },
    }).boxes;
  const free = framed(AR_NODES, arGroups()).boxes;
  const a = pin(60, 10), b = pin(61, 12);
  assertEquals(minus(rel(b, "topicmap"), rel(a, "topicmap")), [1, 2]);
  assertEquals(
    minus(at(a, "tm-entities"), at(a, "topicmap")),
    minus(at(free, "tm-entities"), at(free, "topicmap")),
  );
  for (
    const id of [
      "knowledge",
      "kb-docs",
      "style",
      "style-guide",
      "ar-api",
      "ar-cache",
    ]
  ) {
    assertEquals(rel(a, id), rel(free, id), id);
  }
  const box = (id) => a.groupBoxes.get(id);
  const right = (g) => g.col + g.w;
  assert(right(box("ar")) >= right(box("topicmap")), "ar grows to hold it");
});

Deno.test("a member pin survives its group's row/col, its parent's pin, and labelPos", () => {
  const pins = {
    innerLayout: { knowledge: { "kb-docs": { x: 5 * CELL, y: 20 * CELL } } },
  };
  // kb-index is alone in local column 0, so it sits on the content origin's x.
  const offset = (child = {}, extra = {}) => {
    const { boxes } = framed(AR_NODES, arGroups(child), { ...pins, ...extra });
    return minus(at(boxes, "kb-docs"), at(boxes, "kb-index"));
  };
  const base = offset();
  assertEquals(base[0], 5);
  assertEquals(offset({ row: 1, col: 3 }), base, "row/col");
  assertEquals(
    offset({}, { layout: { ar: { x: 600, y: 900 } } }),
    base,
    "parent pin",
  );
  assertEquals(
    offset({ labelPos: "top-inside", labelSize: 24 }),
    base,
    "labelPos",
  );
});

Deno.test("a relative pin with negative coordinates is clamped to 0", () => {
  const pos = (p) =>
    framed(AR_NODES, arGroups(), {
      innerLayout: { knowledge: { "kb-docs": p } },
    })
      .boxes.map((b) => [b.id, b.col, b.row]);
  assertEquals(pos({ x: -90, y: -30 }), pos({ x: 0, y: 0 }));
});

Deno.test("a relative pin filed under a group that does not list the id is ignored", () => {
  const pos = (extra) =>
    framed(AR_NODES, arGroups(), extra).boxes.map((b) => [b.id, b.col, b.row]);
  assertEquals(
    pos({ innerLayout: { knowledge: { "ar-api": { x: 600, y: 600 } } } }),
    pos({}),
  );
});

Deno.test("groupBoxes reports the origin innerLayout pins are measured from", () => {
  const state = {
    edges: [],
    nodes: [box("a", 0, 0), box("b", 0, 1), box("c", 1, 0)],
    groups: [{
      id: "g",
      label: "G",
      layout: "inner",
      nodes: ["a", "b"],
      row: 0,
      col: 1,
      labelPos: "top-inside",
    }],
    innerLayout: { g: { b: { x: 0, y: 0 }, a: { x: 4 * CELL, y: 2 * CELL } } },
  };
  const boxes = computeLayout(measureContext(), state, 4000);
  const o = boxes.groupBoxes.get("g").origin;
  const at = (id) => boxes.find((x) => x.id === id);
  assert(
    at("b").col === o.col && at("b").row === o.row,
    `b at ${at("b").col},${at("b").row}, origin ${o.col},${o.row}`,
  );
  assert(at("a").col === o.col + 4 && at("a").row === o.row + 2, "a offset");
});

Deno.test("connectorDots off drops the start dot and starts at the box edge", () => {
  const boxes = [
    { id: "a", col: 3, row: 8, w: 5, h: 3 },
    { id: "b", col: 31, row: 8, w: 5, h: 3 },
  ];
  const { routes } = routeOnce(boxes, [
    { from: "a", to: "b", fromEdge: "E", toEdge: "W" },
  ]);
  const draw = (connectorDots) => {
    const log = { arcs: 0, starts: [] };
    const { ctx } = recordingContext();
    Object.assign(ctx, {
      arc() {
        log.arcs++;
      },
      moveTo(x, y) {
        log.starts.push({ x, y });
      },
      quadraticCurveTo() {},
      fillRect() {},
      strokeRect() {},
      rotate() {},
      translate() {},
    });
    drawRoutes(ctx, routes, CELL, undefined, { connectorDots });
    return log;
  };
  const on = draw(true), off = draw(false);
  assert(on.arcs === 1 && off.arcs === 0, `arcs ${on.arcs} / ${off.arcs}`);
  const edge = (3 + 5) * CELL;
  assert(on.starts[0].x === edge + CELL / 2, `dot start ${on.starts[0].x}`);
  assert(off.starts[0].x === edge, `edge start ${off.starts[0].x}`);
});

Deno.test("group frames follow the board's corners default", () => {
  const groups = [{ id: "g", label: "G", nodes: ["a"] }];
  const nodes = [box("a", 0, 0)];
  const radii = (board) => {
    const boxes = computeLayout(
      measureContext(),
      { edges: [], nodes, groups, ...board },
      4000,
    );
    const { ctx, log } = recordingContext();
    drawGroups(ctx, groupFrames(groups, boxes, undefined, board));
    return [...new Set(log.radii)];
  };
  assert(JSON.stringify(radii({})) === "[10]", JSON.stringify(radii({})));
  const sq = radii({ corners: "square" });
  assert(JSON.stringify(sq) === "[0]", JSON.stringify(sq));
});

Deno.test("wires route round group labels when they can", () => {
  const boxes = [
    { id: "a", col: 3, row: 8, w: 5, h: 3 },
    { id: "b", col: 31, row: 8, w: 5, h: 3 },
  ];
  const edges = [{ from: "a", to: "b", fromEdge: "E", toEdge: "W" }];
  // A label across the straight run between the two boxes.
  const label = { x: 15 * CELL, y: 9 * CELL, w: 6 * CELL, h: CELL };
  const route = (avoid) => {
    const grid = new Grid(44, 24);
    const costs = { ...DEFAULT_COSTS };
    const connMap = buildGrid(grid, boxes, costs, avoid);
    return routeEdges(
      createAstarState(44, 24),
      grid,
      edges,
      boxes,
      connMap,
      costs,
    )[0].path;
  };
  const crosses = (path) =>
    path.some((p) => p.x >= 15 && p.x < 21 && p.y === 9);
  assert(crosses(route([])), "without the label the wire runs straight");
  assert(!crosses(route([label])), "with it, the wire goes round");
});
