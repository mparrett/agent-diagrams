import { assert } from "@std/assert";
import { Diagram, legendSwatchXs, LockBusy } from "../diagram-api.js";

function writeState(path, state = {}) {
  Deno.writeTextFileSync(
    path,
    JSON.stringify(
      {
        nodes: [],
        edges: [],
        rev: 0,
        ...state,
      },
      null,
      2,
    ) + "\n",
  );
}

function withTempDir(fn) {
  const dir = Deno.makeTempDirSync({ prefix: "agent-diagrams-test-" });
  try {
    return fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("auto-legend skips colorless nodes (no undefined label → no fillText crash)", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      nodes: [
        { id: "a", label: "No Color", row: 0, col: 0 }, // no color
        { id: "b", label: "Blue", color: "blue", row: 0, col: 1 },
      ],
    });
    const d = Diagram.load(path);
    const legend = d._legend();
    assert(legend.every((e) => e.label != null), "no undefined legend labels");
    assert(legend.some((e) => e.label === "blue"), "colored node still listed");
    assert(legend.length === 1, "colorless node contributes no entry");
    d.render(); // must not throw "failed to fill text"
  }));

// Render a board and return a hash of the PNG, so two dash spellings can be
// compared for "did this actually draw the same thing" rather than merely
// "did it survive". A crash shows up as the whole run dying: setLineDash
// faults inside Skia over FFI, so there is no exception to assert on.
// The vendored @std/assert does not carry assertThrows. Matching the message
// matters here: a bare "it threw" would also pass if the call failed for an
// unrelated reason, which is the failure mode this test exists to rule out.
function assertThrowsWith(fn, needle, what) {
  let msg = null;
  try {
    fn();
  } catch (e) {
    msg = String(e?.message ?? e);
  }
  assert(msg !== null, `${what}: expected a throw, got none`);
  assert(msg.includes(needle), `${what}: expected /${needle}/, got "${msg}"`);
}

function renderHash(state) {
  return withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, state);
    Diagram.load(path).render();
    const png = Deno.readFileSync(`${dir}/diagram.png`);
    let h = 0n;
    for (const b of png) h = (h * 31n + BigInt(b)) & 0xffffffffffffffffn;
    return h.toString(16);
  });
}

const NODE_A = { id: "a", label: "A", color: "blue", row: 0, col: 0 };
const NODE_B = { id: "b", label: "B", color: "green", row: 0, col: 1 };
const divider = (dash) => ({
  nodes: [NODE_A],
  dividers: [{ orient: "h", at: 60, dash }],
});

Deno.test("dash tokens resolve to their arrays, everywhere they are read", () => {
  // The token must draw the same as the array it stands for. Asserting only
  // that rendering survives would pass against a stub that ignored the value.
  assert(
    renderHash(divider("dotted")) === renderHash(divider([2, 3])),
    'divider "dotted" renders identically to [2, 3]',
  );
  assert(
    renderHash(divider("dotted")) !== renderHash(divider("dashed")),
    "different tokens are distinguishable (the comparison can fail)",
  );
  // Unknown values take the fallback rather than reaching the canvas. Inherited
  // Object members are the interesting case: they are array-like enough not to
  // crash, so a bare map lookup renders them silently wrong.
  assert(
    renderHash(divider("wobbly")) === renderHash(divider("constructor")),
    "unrecognised dash values all take the fallback",
  );

  // edgeStyles is merged straight from board JSON, so a custom style's dash is
  // attacker-shaped input to the same FFI call. This one still segfaulted after
  // the divider was fixed.
  const styled = (dash) => ({
    nodes: [NODE_A, NODE_B],
    edges: [{ from: "a", to: "b", style: "rpc" }],
    edgeStyles: { rpc: { color: "#6cf", dash } },
  });
  assert(
    renderHash(styled("dotted")) === renderHash(styled([2, 3])),
    'edgeStyles dash "dotted" renders identically to [2, 3]',
  );
});

Deno.test("addDivider rejects dash values that would draw wrong", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, { nodes: [NODE_A] });
    const d = Diagram.load(path);

    assertThrowsWith(
      () => d.addDivider("h", 90, { dash: "wobbly" }),
      "Invalid dash",
      "unknown token",
    );
    // Arrays are accepted, but not ones that would draw a NaN pattern.
    assertThrowsWith(
      () => d.addDivider("h", 90, { dash: ["a", "b"] }),
      "Invalid dash",
      "non-numeric array",
    );
    d.addDivider("h", 90, { dash: [4, 4] });
    assert(d.listDividers().length === 1, "the valid array form is kept");
  }));

Deno.test("parallel edges: same (from,to) coexist, addressed by id", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    // One legacy edge with no id — load must backfill it deterministically.
    writeState(path, {
      nodes: [{ id: "a", row: 0, col: 0 }, { id: "b", row: 0, col: 2 }],
      edges: [{ from: "a", to: "b", style: "solid", label: "first" }],
    });
    const d = Diagram.load(path);
    assert(d.edges[0].id === "a~b", "legacy edge backfilled to from~to");

    // A second a->b edge is now allowed (no duplicate guard) and gets a fresh id.
    const e2 = d.addEdge("a", "b", "dashed", "second");
    assert(e2.id === "a~b~2", `parallel edge got suffixed id, got ${e2.id}`);
    assert(d.edges.length === 2, "both a->b edges coexist");

    // Edits target the right edge by id — not the first match.
    d.updateEdge(null, null, { label: "renamed" }, "a~b~2");
    assert(
      d.getEdge(null, null, "a~b").label === "first",
      "first edge untouched",
    );
    assert(
      d.getEdge(null, null, "a~b~2").label === "renamed",
      "second edge updated by id",
    );

    // Remove by id removes only that one.
    assert(d.removeEdge(null, null, "a~b") === true);
    assert(
      d.edges.length === 1 && d.edges[0].id === "a~b~2",
      "only the id'd edge removed",
    );
  }));

Deno.test("retarget onto an already-connected pair makes a parallel edge (the snap-back case)", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      nodes: [{ id: "a", row: 0, col: 0 }, { id: "b", row: 0, col: 2 }, {
        id: "c",
        row: 1,
        col: 2,
      }],
      edges: [{ from: "a", to: "b", style: "solid" }, {
        from: "a",
        to: "c",
        style: "dashed",
      }],
    });
    const d = Diagram.load(path);
    // Move a->c's target end onto b, where a->b already exists. Pre-refactor this
    // threw "already exists" (the snap-back); now it's allowed.
    d.retargetEdge(null, null, "a", "b", "a~c");
    const ab = d.edges.filter((e) => e.from === "a" && e.to === "b");
    assert(ab.length === 2, `two a->b edges after retarget, got ${ab.length}`);
    assert(
      d.getEdge(null, null, "a~c").to === "b",
      "retargeted edge keeps its id, now points at b",
    );

    // A nullish new endpoint keeps that end (the CLI --id path moves one end
    // without naming the other): move only the source back to c.
    d.retargetEdge(null, null, "c", undefined, "a~c");
    const e = d.getEdge(null, null, "a~c");
    assert(
      e.from === "c" && e.to === "b",
      `kept the 'to' end, got ${e.from}->${e.to}`,
    );
  }));

Deno.test("Diagram.save recovers from stale lockfiles", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    const lockPath = `${path}.lock`;
    writeState(path);
    Deno.writeTextFileSync(lockPath, "stale\n");
    const old = new Date(Date.now() - 6000);
    Deno.utimeSync(lockPath, old, old);

    const d = Diagram.load(path);
    d.addNode("a", { label: "A", color: "blue", details: [], row: 0, col: 0 });
    d.save();

    const saved = JSON.parse(Deno.readTextFileSync(path));
    assert(saved.rev === 1, "expected save to advance rev");
    assert(saved.nodes.some((n) => n.id === "a"), "expected node to be saved");
    try {
      Deno.statSync(lockPath);
      assert(false, "expected stale lock to be removed");
    } catch (e) {
      assert(e instanceof Deno.errors.NotFound);
    }
  }));

Deno.test("Diagram.save does not steal fresh lockfiles", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    const lockPath = `${path}.lock`;
    writeState(path);
    Deno.writeTextFileSync(lockPath, "fresh\n");

    const d = Diagram.load(path);
    let err = null;
    try {
      d.save();
    } catch (e) {
      err = e;
    }
    assert(err instanceof LockBusy, `expected LockBusy, got ${err}`);
    Deno.removeSync(lockPath);
  }));

Deno.test("Diagram.render writes PNG through a temp file and cleans it up", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      width: 420,
      height: 260,
      output: "out.png",
      nodes: [
        { id: "a", label: "A", color: "blue", row: 0, col: 0 },
        { id: "b", label: "B", color: "green", row: 0, col: 1 },
      ],
      edges: [{ from: "a", to: "b", style: "solid" }],
    });

    Diagram.load(path).render();

    const out = `${dir}/out.png`;
    assert(Deno.statSync(out).size > 0, "expected rendered PNG");
    const tmp = [...Deno.readDirSync(dir)].filter((e) =>
      e.name.includes(".tmp")
    );
    assert(
      tmp.length === 0,
      `expected no leftover temp files, got ${
        tmp.map((e) => e.name).join(", ")
      }`,
    );
  }));

// setCanvas anchors. The bug this pins: `anchor` used to be decoded with
// a.includes("e") / a.includes("n"), and "center" contains BOTH — so it
// silently anchored north-east instead of centering. Table-driven now, so every
// token is checked against the fraction of the delta it should absorb.
//
// The 300px delta is deliberate: _resizeCanvas snaps the shift to whole CELLs,
// and 300 and 150 are both exact multiples of 15, so the snap is a no-op and the
// expected values stay legible.
Deno.test("setCanvas honors every anchor token (center centers, not NE)", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    const cases = [
      ["nw", 0, 0],
      ["n", 150, 0],
      ["ne", 300, 0],
      ["w", 0, 150],
      ["c", 150, 150],
      ["center", 150, 150], // the regression: must match "c", not "ne"
      ["e", 300, 150],
      ["sw", 0, 300],
      ["s", 150, 300],
      ["se", 300, 300],
    ];
    for (const [anchor, wantDx, wantDy] of cases) {
      // `layout` pins the node, so the applied shift is exactly readable.
      writeState(path, {
        width: 600,
        height: 400,
        nodes: [{ id: "a", label: "A", color: "blue", row: 0, col: 0 }],
        layout: { a: { x: 300, y: 195 } },
      });
      const d = Diagram.load(path);
      d.setCanvas(900, 700, anchor);
      const p = d.layout.a;
      assert(
        p.x === 300 + wantDx && p.y === 195 + wantDy,
        `anchor "${anchor}": expected shift (${wantDx},${wantDy}) → (${
          300 + wantDx
        },${195 + wantDy}), got (${p.x},${p.y})`,
      );
      assert(
        d._state.width === 900 && d._state.height === 700,
        `anchor "${anchor}": board should be 900x700, got ${d._state.width}x${d._state.height}`,
      );
    }
  }));

Deno.test("setCanvas rejects an unknown anchor and names the valid set", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      width: 600,
      height: 400,
      nodes: [{ id: "a", label: "A", color: "blue", row: 0, col: 0 }],
    });
    const d = Diagram.load(path);
    let msg = "";
    try {
      d.setCanvas(800, 600, "middle");
    } catch (e) {
      msg = e.message;
    }
    assert(msg.includes("middle"), `error should echo the bad token: ${msg}`);
    assert(msg.includes("nw"), `error should list valid anchors: ${msg}`);
  }));

// ─── State validation ────────────────────────────────────────────────────────
// The file is the source of truth and agents hand-edit it, so a bad field must
// be diagnosed, not absorbed. Before this, a missing "edges" surfaced as
// "this.edges is not iterable" (no path, no field) and a non-numeric layout
// coordinate silently produced NaN geometry with every command reporting success.

function loadErr(path, state) {
  Deno.writeTextFileSync(path, JSON.stringify(state, null, 2) + "\n");
  try {
    Diagram.load(path);
  } catch (e) {
    return e.message;
  }
  return "";
}

Deno.test("validateState rejects structurally broken files, naming path and field", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    const cases = [
      [{ title: "x", rev: 0 }, ["nodes", "edges"]],
      [{ nodes: {}, edges: [] }, ["nodes"]],
      [{
        nodes: [{ id: "a", row: 0, col: 0 }, { id: "a", row: 1, col: 0 }],
        edges: [],
      }, ["duplicate", "a"]],
      [{ nodes: [{ row: 0, col: 0 }], edges: [] }, ["id"]],
      [{ nodes: [{ id: "a", row: 0, col: "x" }], edges: [] }, ["a", "col"]],
      [{ nodes: [{ id: "a" }], edges: [] }, ["a", "row"]],
      [{
        nodes: [{ id: "a", row: 0, col: 0 }],
        edges: [],
        layout: { a: { x: "abc", y: 10 } },
      }, ["layout", "a"]],
      [{
        nodes: [{ id: "a", row: 0, col: 0 }],
        edges: [],
        dividers: [{ orient: "x", at: 5 }],
      }, ["orient"]],
      [{
        nodes: [{ id: "a", row: 0, col: 0 }],
        edges: [],
        notes: [{ text: ["hi"] }],
      }, ["notes", "anchor"]],
    ];
    for (const [state, needles] of cases) {
      const msg = loadErr(path, state);
      assert(msg, `expected a rejection for ${JSON.stringify(state)}`);
      assert(msg.includes(path), `error should name the file: ${msg}`);
      for (const n of needles) {
        assert(msg.includes(n), `error should mention "${n}": ${msg}`);
      }
    }
  }));

Deno.test("validateState reports every problem at once, not just the first", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    const msg = loadErr(path, {
      nodes: [{ id: "a", row: 0, col: "x" }, { id: "b", row: null, col: 0 }],
      edges: [],
      layout: { a: { x: 1 } },
    });
    assert(msg.includes('"a"') && msg.includes('"b"'), `both nodes: ${msg}`);
    assert(
      msg.split("\n").length >= 4,
      `expected a multi-line report:\n${msg}`,
    );
  }));

Deno.test("validateState accepts a node placed only by a layout override", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    // No row/col, but the override supplies both coordinates — legitimate.
    Deno.writeTextFileSync(
      path,
      JSON.stringify({
        nodes: [{ id: "a", label: "A", color: "blue" }],
        edges: [],
        layout: { a: { x: 100, y: 100 } },
        rev: 0,
      }) + "\n",
    );
    const d = Diagram.load(path);
    assert(d.nodes.length === 1, "node should load");
  }));

Deno.test("validateState only warns on free endpoints (delete-keep-edges is supported)", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    Deno.writeTextFileSync(
      path,
      JSON.stringify({
        nodes: [{ id: "a", label: "A", color: "blue", row: 0, col: 0 }],
        edges: [{
          from: "a",
          to: "gone",
          style: "solid",
          toPos: { x: 200, y: 200 },
        }],
        rev: 0,
      }) + "\n",
    );
    const d = Diagram.load(path); // must NOT throw
    assert(d.edges.length === 1, "orphan-ended edge should survive load");
    d.render(); // and still render (free end drawn as a handle)
  }));

Deno.test("invalid JSON names the file instead of a bare parse error", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    Deno.writeTextFileSync(path, "{ nodes: [ }\n");
    let msg = "";
    try {
      Diagram.load(path);
    } catch (e) {
      msg = e.message;
    }
    assert(msg.includes(path), `error should name the file: ${msg}`);
    assert(msg.includes("invalid JSON"), msg);
  }));

// ─── Render reproducibility ──────────────────────────────────────────────────
// "Deterministic, reviewable — same JSON → same PNG" is the core promise of the
// state-as-source-of-truth model, and diagram.png is meant to live in git. The
// generated-at stamp was the one wall-clock input to the render, so every titled
// diagram re-rendered to different bytes and churned the working tree.

function renderTwice(dir, extra = {}) {
  const path = `${dir}/diagram-state.json`;
  writeState(path, {
    title: "Titled Diagram",
    width: 420,
    height: 260,
    output: "out.png",
    nodes: [
      { id: "a", label: "A", color: "blue", row: 0, col: 0 },
      { id: "b", label: "B", color: "green", row: 1, col: 0 },
    ],
    edges: [{ from: "a", to: "b", style: "solid" }],
    ...extra,
  });
  const hash = () => {
    const buf = Deno.readFileSync(`${dir}/out.png`);
    let h = 0n;
    for (const b of buf) h = (h * 131n + BigInt(b)) & 0xffffffffffffffffn;
    return `${buf.length}:${h}`;
  };
  Diagram.load(path).render();
  const first = hash();
  Diagram.load(path).render();
  return [first, hash()];
}

Deno.test("a titled diagram renders byte-identically across runs", () =>
  withTempDir((dir) => {
    const [a, b] = renderTwice(dir);
    assert(a === b, `same state must produce the same PNG, got ${a} vs ${b}`);
  }));

Deno.test("timestamp:true opts back into the wall-clock stamp (and its churn)", () =>
  withTempDir((dir) => {
    // Rendering twice inside the same second would collide, so this asserts the
    // stamp is DRAWN (output differs from the stamp-free render), not that two
    // stamped renders differ — that's a clock race, not a property worth pinning.
    const [plain] = renderTwice(dir);
    const [stamped] = renderTwice(dir, { timestamp: true });
    assert(
      plain !== stamped,
      "timestamp:true should change the rendered output",
    );
  }));

Deno.test("setTitle/setFooter round-trip, and an empty value clears the key", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, { nodes: [{ id: "a", label: "A", row: 0, col: 0 }] });
    const d = Diagram.load(path);

    d.setTitle("Request flow");
    d.setFooter("solid = sync");
    d.save();
    const saved = JSON.parse(Deno.readTextFileSync(path));
    assert(saved.title === "Request flow", saved.title);
    assert(saved.footer === "solid = sync", saved.footer);

    // Cleared rather than left as an empty string — an empty title would
    // otherwise reserve its band in the render.
    const d2 = Diagram.load(path);
    d2.setTitle("");
    d2.setFooter(null);
    d2.save();
    const cleared = JSON.parse(Deno.readTextFileSync(path));
    assert(!("title" in cleared), "title should be absent");
    assert(!("footer" in cleared), "footer should be absent");
  }));

Deno.test("solvePositions reports the drawn box size, not the content size", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    // An auto-sized box, deliberately: with an explicit `w` in cells the content
    // and drawn widths coincide, so the assertion passes on the old code too and
    // proves nothing. The content must measure to a non-multiple of CELL.
    //
    // It has to be one unbreakable token. Auto widths are chosen from a ladder
    // of whole-cell rungs and padded out to the rung, so an ordinary label now
    // lands exactly on a cell boundary and closes the gap this test needs. A
    // word too long to wrap overflows its rung, and that overflow is the
    // remaining case where content and drawn width genuinely differ.
    writeState(path, {
      nodes: [
        {
          id: "a",
          label: "PaymentReconciliationServiceEndpoint",
          row: 0,
          col: 0,
        },
      ],
    });
    const p = Diagram.load(path).solvePositions().positions.a;

    // The drawn box is the content ceil'd up to whole cells.
    assert(p.w % 15 === 0, `drawn width must be whole cells, got ${p.w}`);
    assert(p.h % 15 === 0, `drawn height must be whole cells, got ${p.h}`);
    assert(
      p.w > p.pixW,
      `this fixture must exercise the gap: w ${p.w} vs pixW ${p.pixW}`,
    );
    assert(
      p.w - p.pixW < 15,
      `drawn width overshoots by <1 cell, got ${p.w - p.pixW}`,
    );
  }));

Deno.test("an anchored note sits against the drawn edge, not the content edge", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      nodes: [{ id: "api", label: "Payment Reconciliation", row: 0, col: 0 }],
      notes: [{
        id: "n1",
        anchor: { to: "api", side: "E", dx: 0, dy: 0 },
        text: ["caption"],
      }],
    });
    const solved = Diagram.load(path).solvePositions();
    const box = solved.positions.api;

    // Anchoring off pixW put the note inside the visible border, and disagreed
    // with the box geometry this same call reports.
    assert(
      solved.notes.n1.x === box.x + box.w,
      `note at ${solved.notes.n1.x}, drawn edge at ${
        box.x + box.w
      } (content edge ${box.x + box.pixW})`,
    );
  }));

Deno.test("W and N anchors place the note outside the box, not over it", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      width: 900,
      nodes: [{ id: "api", label: "API", row: 2, col: 3 }],
      notes: ["N", "E", "S", "W"].map((side) => ({
        id: side,
        anchor: { to: "api", side, dx: 0, dy: 0 },
        title: "TITLE",
        text: ["a longer caption line"],
      })),
    });
    const solved = Diagram.load(path).solvePositions();
    const b = solved.positions.api;
    const r = (id) => solved.notes[id].rect;
    const near = (a, e) => Math.abs(a - e) <= 1;

    assert(
      near(r("W").x + r("W").w, b.x),
      `W right edge ${r("W").x + r("W").w} vs box ${b.x}`,
    );
    assert(
      near(r("E").x, b.x + b.w),
      `E left edge ${r("E").x} vs box ${b.x + b.w}`,
    );
    assert(
      near(r("N").y + r("N").h, b.y),
      `N bottom ${r("N").y + r("N").h} vs box ${b.y}`,
    );
    assert(near(r("S").y, b.y + b.h), `S top ${r("S").y} vs box ${b.y + b.h}`);
    // Centered on the box along the other axis.
    for (const id of ["N", "S"]) {
      assert(near(r(id).x + r(id).w / 2, b.x + b.w / 2), `${id} not centered`);
    }
    for (const id of ["E", "W"]) {
      assert(near(r(id).y + r(id).h / 2, b.y + b.h / 2), `${id} not centered`);
    }
  }));

Deno.test("an anchor's dx/dy shift the note from its flush position", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    const note = (dx) => ({
      id: "n",
      anchor: { to: "api", side: "W", dx, dy: 0 },
      text: ["caption"],
    });
    writeState(path, {
      nodes: [{ id: "api", label: "API", row: 2, col: 4 }],
      notes: [note(0)],
    });
    const flush = Diagram.load(path).solvePositions().notes.n.x;
    writeState(path, {
      nodes: [{ id: "api", label: "API", row: 2, col: 4 }],
      notes: [note(-12)],
    });
    const gapped = Diagram.load(path).solvePositions().notes.n.x;
    assert(gapped === flush - 12, `expected ${flush - 12}, got ${gapped}`);
  }));

Deno.test("legend entries that name a palette color follow the theme", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      nodes: [{ id: "a", label: "A", color: "amber", row: 0, col: 0 }],
      legend: [
        { color: "amber", label: "builds" },
        { color: "#123456", label: "literal" },
      ],
    });
    const swatch = (theme) => {
      const d = Diagram.load(path);
      d.setTheme(theme);
      return { legend: d._legend(), amber: d.palette.colors.amber.border };
    };
    const light = swatch("dawnfox"), dark = swatch("afterglow");
    assert(light.legend[0].color === light.amber, "swatch is the box border");
    assert(dark.legend[0].color === dark.amber, "swatch is the box border");
    assert(light.amber !== dark.amber, "fixture needs themes that differ");
    assert(
      light.legend[1].color === "#123456" && dark.legend[1].color === "#123456",
      "hex entries pass through",
    );
  }));

Deno.test("a group frame wraps its members and names intruding non-members", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      nodes: [
        { id: "a", label: "A", color: "blue", row: 0, col: 0 },
        { id: "b", label: "B", color: "blue", row: 0, col: 2 },
        { id: "mid", label: "Mid", color: "gray", row: 0, col: 1 },
        { id: "far", label: "Far", color: "gray", row: 3, col: 0 },
      ],
      groups: [{ id: "g", label: "G", nodes: ["a", "b"] }],
    });
    const solved = Diagram.load(path).solvePositions();
    const g = solved.groups.g, p = solved.positions;
    for (const id of ["a", "b"]) {
      assert(
        g.x < p[id].x && g.y < p[id].y &&
          g.x + g.w > p[id].x + p[id].w && g.y + g.h > p[id].y + p[id].h,
        `frame must enclose ${id}`,
      );
    }
    assert(
      JSON.stringify(g.intruders) === '["mid"]',
      `intruders: ${JSON.stringify(g.intruders)}`,
    );
  }));

Deno.test("an enclosing group's frame clears the frame and label it encloses", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      nodes: [
        { id: "a", label: "A", color: "blue", row: 0, col: 0 },
        { id: "b", label: "B", color: "blue", row: 1, col: 0 },
      ],
      groups: [
        { id: "outer", label: "Outer", nodes: ["a", "b"] },
        { id: "inner", label: "Inner", nodes: ["a"] },
      ],
    });
    const { outer, inner } = Diagram.load(path).solvePositions().groups;
    assert(outer.x < inner.x, "outer frame starts left of the inner one");
    assert(outer.y < inner.y - 6, "outer frame clears the inner label");
  }));

Deno.test("group edits validate node ids, and removing a node prunes it", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      nodes: [
        { id: "a", label: "A", color: "blue", row: 0, col: 0 },
        { id: "b", label: "B", color: "blue", row: 0, col: 1 },
      ],
    });
    const d = Diagram.load(path);
    let msg = "";
    try {
      d.addGroup("g", "G", ["a", "nope"]);
    } catch (e) {
      msg = e.message;
    }
    assert(msg.includes("nope"), `should name the unknown node: ${msg}`);

    d.addGroup("g", "G", ["a", "b"], { color: "amber", dash: "dashed" });
    d.updateGroup("g", { remove: ["b"], label: "Only A" });
    assert(d.listGroups()[0].label === "Only A");
    assert(JSON.stringify(d.listGroups()[0].nodes) === '["a"]');

    d.updateGroup("g", { add: ["b"] });
    d.removeNode("b");
    assert(JSON.stringify(d.listGroups()[0].nodes) === '["a"]');

    assert(d.removeGroup("g") === true && d.removeGroup("g") === false);
    assert(d._state.groups === undefined, "empty groups key is dropped");
  }));

Deno.test("fit-canvas keeps notes and group frames on the board", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      width: 1500,
      height: 900,
      nodes: [
        { id: "a", label: "A", color: "blue", row: 1, col: 0 },
        { id: "b", label: "B", color: "blue", row: 1, col: 1 },
      ],
      groups: [{ id: "g", label: "Group", nodes: ["a", "b"] }],
      notes: [{
        id: "far",
        x: 1300,
        y: 700,
        text: ["a note well past the boxes"],
      }],
    });
    const d = Diagram.load(path);
    d.fitCanvasToContent();
    const sp = d.solvePositions();
    const r = sp.notes.far.rect, g = sp.groups.g;
    assert(
      r.x + r.w <= sp.canvas.width && r.y + r.h <= sp.canvas.height,
      `note ${
        JSON.stringify(r)
      } outside ${sp.canvas.width}x${sp.canvas.height}`,
    );
    assert(g.x >= 0 && g.y >= 0, `group frame clipped: ${JSON.stringify(g)}`);
    assert(sp.canvas.width < 1500, "it should still trim");
  }));

Deno.test("legend entries are spaced by their own widths", () => {
  const widths = [140, 40, 60, 160];
  const xs = legendSwatchXs(widths);
  // Gap from the end of one label (swatch 12 + 6 + width) to the next swatch.
  const gaps = widths.slice(0, -1).map((w, i) => xs[i + 1] - (xs[i] + 18 + w));
  assert(
    gaps.every((g) => g === gaps[0]) && gaps[0] > 0,
    `uneven legend gaps: ${gaps}`,
  );
});

Deno.test("the renderer honors the board's layout settings", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    const width = (label, extra) => {
      writeState(path, {
        nodes: [{ id: "a", label, details: ["Queue · MQS?"], row: 0, col: 0 }],
        ...extra,
      });
      return Diagram.load(path).solvePositions().positions.a.w;
    };
    const long = "A fairly long title that would wrap somewhere";
    assert(
      width(long, { maxNodeW: 0 }) > width(long, {}),
      "maxNodeW: 0 should let the box grow past the default ceiling",
    );
    // In sans: one line by default (180px), wrapped at the 105px rung
    // without slack.
    assert(
      width("Message history", { font: "sans", wrapSlack: 1 }) <
        width("Message history", { font: "sans" }),
      "wrapSlack: 1 should take the smaller, wrapped box",
    );
  }));

Deno.test("fit-canvas trims without pinning auto-placed boxes", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      width: 1500,
      height: 900,
      nodes: [
        { id: "a", label: "A", color: "blue", row: 0, col: 0 },
        { id: "b", label: "B", color: "blue", row: 1, col: 1 },
      ],
    });
    const d = Diagram.load(path);
    const before = d.solvePositions();
    d.fitCanvasToContent();
    const after = d.solvePositions();
    assert(Object.keys(d.layout).length === 0, "no box should be pinned");
    assert(after.canvas.width < 1500, "it should still trim");
    // Rigid move: both boxes shift by the same amount.
    const shift = (id) => [
      after.positions[id].x - before.positions[id].x,
      after.positions[id].y - before.positions[id].y,
    ];
    assert(
      JSON.stringify(shift("a")) === JSON.stringify(shift("b")),
      `boxes moved apart: ${shift("a")} vs ${shift("b")}`,
    );
  }));

Deno.test("a shifting resize moves pinned, auto and noted content together", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      width: 900,
      height: 600,
      nodes: [
        { id: "auto", label: "Auto", color: "blue", row: 0, col: 0 },
        { id: "pin", label: "Pinned", color: "green", row: 1, col: 1 },
      ],
      layout: { pin: { x: 450, y: 240 } },
      pinned: ["pin"],
      notes: [{ id: "n", x: 600, y: 400, text: ["note"] }],
    });
    const d = Diagram.load(path);
    const before = d.solvePositions();
    // Grows left and up by 300,200; the shift snaps to whole cells: 300,195.
    d.setCanvas(1200, 800, "se");
    const after = d.solvePositions();
    for (const id of ["auto", "pin"]) {
      const dx = after.positions[id].x - before.positions[id].x;
      const dy = after.positions[id].y - before.positions[id].y;
      assert(dx === 300 && dy === 195, `${id} moved ${dx},${dy}`);
    }
    assert(
      after.notes.n.x - before.notes.n.x === 300 &&
        after.notes.n.y - before.notes.n.y === 195,
      "note should move with the boxes",
    );
    assert(!d.layout.auto, "the auto box must not be pinned");
  }));

Deno.test("a resize with no shift leaves every box where it was", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      width: 900,
      height: 600,
      nodes: [{ id: "a", label: "A", color: "blue", row: 0, col: 0 }],
    });
    const d = Diagram.load(path);
    const before = d.solvePositions().positions.a;
    d.setCanvas(1400, 600, "nw"); // grow right only
    const after = d.solvePositions().positions.a;
    assert(
      after.x === before.x && after.y === before.y,
      `centring moved the box: ${before.x},${before.y} → ${after.x},${after.y}`,
    );
  }));

Deno.test("inner groups need a parent row/col and exclusive members", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      nodes: [
        { id: "a", label: "A", color: "blue", row: 0, col: 0 },
        { id: "b", label: "B", color: "blue", row: 0, col: 1 },
      ],
    });
    const d = Diagram.load(path);
    const err = (fn) => {
      try {
        fn();
      } catch (e) {
        return e.message;
      }
      return "";
    };
    assert(
      err(() => d.addGroup("g", "G", ["a"], { layout: "inner" }))
        .includes("row and col"),
      "an inner group without a parent row/col must be rejected",
    );
    d.addGroup("g", "G", ["a", "b"], { layout: "inner", row: 2, col: 3 });
    assert(
      err(() =>
        d.addGroup("h", "H", ["b"], { layout: "inner", row: 0, col: 0 })
      )
        .includes("only one inner group"),
      "a node in two inner groups must be rejected",
    );
    d.save();
    const sp = Diagram.load(path).solvePositions();
    assert(sp.positions.a.group === "g", "members report their inner group");
  }));

Deno.test("making a group inner drops its members' overrides and pins", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      nodes: [
        { id: "a", label: "A", color: "blue", row: 0, col: 0 },
        { id: "b", label: "B", color: "blue", row: 0, col: 1 },
        { id: "c", label: "C", color: "blue", row: 1, col: 0 },
      ],
      layout: { a: { x: 300, y: 300 }, c: { x: 60, y: 300 } },
      pinned: ["a", "c"],
    });
    const d = Diagram.load(path);
    d.addGroup("g", "G", ["a", "b"], { layout: "inner", row: 0, col: 0 });
    assert(!d.layout.a && d.layout.c, `layout: ${JSON.stringify(d.layout)}`);
    assert(
      JSON.stringify(d._state.pinned) === '["c"]',
      `pinned: ${JSON.stringify(d._state.pinned)}`,
    );
  }));

Deno.test("fit-canvas stores the size the PNG is drawn at", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      width: 1500,
      height: 900,
      nodes: [
        { id: "a", label: "Alpha", color: "blue", row: 0, col: 0 },
        { id: "b", label: "Beta gamma", color: "blue", row: 1, col: 2 },
      ],
      // A guard, not a reproduction: the mismatch showed on a larger board
      // (stored 1477, drawn 1480) and no small fixture tried here hit it.
      groups: [{ id: "g", label: "G", nodes: ["a", "b"] }],
    });
    const d = Diagram.load(path);
    d.fitCanvasToContent();
    const drawn = d.solvePositions().canvas;
    assert(
      d._state.width === drawn.width && d._state.height === drawn.height,
      `stored ${d._state.width}x${d._state.height}, drawn ${drawn.width}x${drawn.height}`,
    );
  }));

Deno.test("setBoxStyle sets, clears and validates the board-wide defaults", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, { nodes: [NODE_A] });
    const d = Diagram.load(path);
    const style = () => [
      d._state.outlineWidth,
      d._state.outlineDash,
      d._state.corners,
    ];

    d.setBoxStyle({ outlineWidth: "thin", corners: "square" });
    assert(
      JSON.stringify(style()) === JSON.stringify(["thin", undefined, "square"]),
      `set: ${style()}`,
    );
    d.setBoxStyle({ outlineDash: "dotted", corners: null });
    assert(
      JSON.stringify(style()) === JSON.stringify(["thin", "dotted", undefined]),
      `clear: ${style()}`,
    );

    // A bad token on one axis leaves every axis as it was.
    assertThrowsWith(
      () => d.setBoxStyle({ outlineWidth: "medium", corners: "bevel" }),
      'Invalid corners "bevel"',
      "unknown corners token",
    );
    assertThrowsWith(
      () => d.setBoxStyle({ outlineDash: "constructor" }),
      "Invalid outlineDash",
      "inherited Object member",
    );
    assert(
      JSON.stringify(style()) === JSON.stringify(["thin", "dotted", undefined]),
      `unchanged after a rejected call: ${style()}`,
    );
  }));

Deno.test("setEdgeStyle sets, clears and validates the board edge width", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, { nodes: [NODE_A] });
    const d = Diagram.load(path);
    d.setEdgeStyle({ width: "thin" });
    assert(d._state.edgeWidth === "thin", `set: ${d._state.edgeWidth}`);
    assertThrowsWith(
      () => d.setEdgeStyle({ width: "hairline" }),
      'Invalid width "hairline"',
      "unknown width token",
    );
    assert(d._state.edgeWidth === "thin", "unchanged after a rejected call");
    d.setEdgeStyle({ width: null });
    assert(!("edgeWidth" in d._state), "null clears it");
  }));

Deno.test("updateNode sets, clears and validates corners", () =>
  withTempDir((dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, { nodes: [{ ...NODE_A }] });
    const d = Diagram.load(path);
    const node = () => d.nodes.find((n) => n.id === "a");

    d.updateNode("a", { corners: "square" });
    assert(node().corners === "square", "set");
    assertThrowsWith(
      () => d.updateNode("a", { corners: "pointy" }),
      "Invalid corners",
      "unknown corners token",
    );
    assert(node().corners === "square", "a rejected token keeps the old one");
    d.updateNode("a", { corners: null });
    assert(!("corners" in node()), "null clears it");
  }));
