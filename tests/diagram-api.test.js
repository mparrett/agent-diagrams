import { assert } from "@std/assert";
import { Diagram, LockBusy } from "../diagram-api.js";

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
    // proves nothing. This label measures to a non-multiple of CELL, which is
    // the only case that separates the two.
    writeState(path, {
      nodes: [{ id: "a", label: "Payment Reconciliation", row: 0, col: 0 }],
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
