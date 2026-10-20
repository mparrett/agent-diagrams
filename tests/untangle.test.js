import { assert } from "@std/assert";
import { Diagram } from "../diagram-api.js";
import { isBandDivider } from "../diagram-core.js";

function assertEquals(actual, expected, msg = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  assert(a === e, `${msg ? msg + ": " : ""}expected ${e}, got ${a}`);
}

function load(state) {
  const dir = Deno.makeTempDirSync({ prefix: "untangle-test-" });
  const path = `${dir}/diagram-state.json`;
  Deno.writeTextFileSync(
    path,
    JSON.stringify({ nodes: [], edges: [], rev: 0, ...state }),
  );
  return Diagram.load(path);
}
const node = (id, row, col) => ({ id, label: id.toUpperCase(), row, col });
// a→f and c→d cross over b→e as routed: two crossings.
const CROSSED = {
  nodes: [
    node("a", 0, 0),
    node("b", 0, 1),
    node("c", 0, 2),
    node("d", 1, 0),
    node("e", 1, 1),
    node("f", 1, 2),
  ],
  edges: [
    { from: "a", to: "f" },
    { from: "c", to: "d" },
    { from: "b", to: "e" },
  ],
};
const at = (d) =>
  Object.fromEntries(d.nodes.map((n) => [n.id, [n.row, n.col]]));

Deno.test("untangle removes a crossing and, without bands, keeps every row", () => {
  const d = load(structuredClone(CROSSED));
  const r = d.untangle({ budget: 200 });
  assert(r.before.crossings > 0, `starts crossed: ${r.before.crossings}`);
  assert(r.after.crossings === 0, `ends uncrossed: ${r.after.crossings}`);
  const p = at(d);
  assertEquals(
    ["a", "b", "c", "d", "e", "f"].map((id) => p[id][0]),
    [0, 0, 0, 1, 1, 1],
    "rows",
  );
});

Deno.test("untangle leaves pinned boxes where they are", () => {
  const d = load({
    ...structuredClone(CROSSED),
    layout: { a: { x: 60, y: 60 } },
    pinned: ["a"],
  });
  d.untangle({ budget: 200 });
  assertEquals(at(d).a, [0, 0]);
  assertEquals(d.layout.a, { x: 60, y: 60 });
});

Deno.test("untangle keeps each box in its band and re-anchors the bands", () => {
  // a→c has to go round b in their shared row; splitting the row helps, so
  // the band gains a sub-row and its divider has to move down with it.
  const d = load({
    nodes: [
      node("a", 0, 0),
      node("b", 0, 1),
      node("c", 0, 2),
      node("x", 1, 0),
      node("y", 1, 1),
      node("z", 1, 2),
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "c" },
      { from: "a", to: "z" },
      { from: "c", to: "x" },
      { from: "b", to: "y" },
    ],
    dividerBands: true,
    dividers: [{ id: "t", orient: "h", at: 0, after: 0 }],
  });
  const bandOf = (n) =>
    d._state.dividers.filter((v) =>
      isBandDivider(v, d._state) && v.after < n.row
    ).length;
  const before = Object.fromEntries(d.nodes.map((n) => [n.id, bandOf(n)]));
  const r = d.untangle({ budget: 400 });
  const rows = new Set(d.nodes.map((n) => n.row)).size;
  assert(rows > 2, `a sub-row was added (${rows} rows)`);
  assertEquals(
    Object.fromEntries(d.nodes.map((n) => [n.id, bandOf(n)])),
    before,
  );
  assert(r.after.crossings < r.before.crossings, "fewer crossings");
});

Deno.test("untangle hands back a board it cannot improve unchanged", () => {
  const d = load({
    nodes: [node("a", 0, 0), node("b", 2, 0)], // skipped row 1: air
    edges: [{ from: "a", to: "b" }],
  });
  const r = d.untangle({ budget: 100 });
  assertEquals(r.moved, []);
  assertEquals(at(d), { a: [0, 0], b: [2, 0] });
});

Deno.test("untangle --unpin keeps a hand layout it only matches", () => {
  // Pin every box where the untangled layout puts it, under the crossed rows
  // and columns: the auto layout is crossed, the board on screen is not.
  const solved = load(structuredClone(CROSSED));
  solved.untangle({ budget: 200 });
  solved.persistGridBoxes(solved.renderToCanvas().gridBoxes);
  const layout = structuredClone(solved.layout);
  const d = load({
    ...structuredClone(CROSSED),
    layout,
    pinned: Object.keys(layout),
  });
  const r = d.untangle({ budget: 200, unpin: true });
  assertEquals(r.moved, []);
  assert(r.before.crossings === 0, `scored as pinned: ${r.before.crossings}`);
  assertEquals(d.layout, layout, "pins kept");
});

Deno.test("untangle is deterministic", () => {
  const one = load(structuredClone(CROSSED));
  const two = load(structuredClone(CROSSED));
  one.untangle({ budget: 150 });
  two.untangle({ budget: 150 });
  assertEquals(at(one), at(two));
});

Deno.test("untangle drops hand-placed labels on wires whose ends moved", () => {
  const s = structuredClone(CROSSED);
  s.edges[0].label = "x";
  s.edges[0].labelPos = { side: "left", offset: 40 };
  const d = load(s);
  const r = d.untangle({ budget: 200 });
  assert(r.moved.length > 0, "something moved");
  assert(!("labelPos" in d.edges[0]), "stale label position dropped");
});

// The sub-row fixture from above, with two bands whose dividers are stored
// bottom-first.
const SPLITTABLE = {
  nodes: [
    node("a", 0, 0),
    node("b", 0, 1),
    node("c", 0, 2),
    node("x", 1, 0),
    node("y", 1, 1),
    node("z", 1, 2),
    node("p", 2, 0),
    node("q", 2, 1),
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "a", to: "c" },
    { from: "a", to: "z" },
    { from: "c", to: "x" },
    { from: "b", to: "y" },
    { from: "x", to: "q" },
    { from: "z", to: "p" },
  ],
  dividerBands: true,
  dividers: [
    { id: "low", orient: "h", at: 0, after: 1, label: "low" },
    { id: "high", orient: "h", at: 0, after: 0, label: "high" },
  ],
};

Deno.test("untangle keeps each band divider in its own place, whatever the stored order", () => {
  const d = load(structuredClone(SPLITTABLE));
  const r = d.untangle({ budget: 400 });
  assert(r.moved.length > 0, "something moved");
  const by = Object.fromEntries(d._state.dividers.map((v) => [v.id, v.after]));
  assert(by.high < by.low, `high above low: ${JSON.stringify(by)}`);
  const top = d.nodes.filter((n) => n.row <= by.high).map((n) => n.id).sort();
  assertEquals(top, ["a", "b", "c"], "the top band holds what it held");
});

Deno.test("untangle never puts two boxes in one cell", () => {
  for (const seed of [1, 2, 3]) {
    const d = load(structuredClone(SPLITTABLE));
    d.untangle({ budget: 300, seed });
    const cells = d.nodes.map((n) => `${n.row},${n.col}`);
    assertEquals(new Set(cells).size, cells.length, `seed ${seed}: ${cells}`);
  }
});

Deno.test("untangle never stacks a box whose column band is full", () => {
  // B wants column 2, across the band line, and A has already taken column 1.
  const d = load({
    nodes: [node("a", 0, 0), node("b", 0, 1), node("x", 1, 1), node("y", 1, 2)],
    edges: [{ from: "a", to: "x" }, { from: "b", to: "y" }],
    dividers: [{ id: "v", orient: "v", at: 0, band: true, after: 1 }],
    pinned: ["x", "y"],
  });
  d.untangle({ budget: 60 });
  const cells = d.nodes.map((n) => `${n.row}/${n.col}`);
  assertEquals(new Set(cells).size, cells.length, `cells ${cells}`);
});

Deno.test("untangle scores the board as given, not a compacted copy", () => {
  // Row 1 is air; with bands on, a candidate closes it up. "before" must
  // still describe the board on disk.
  const state = {
    nodes: [node("a", 0, 0), node("b", 2, 0)],
    edges: [{ from: "a", to: "b" }],
    dividerBands: true,
    dividers: [{ id: "t", orient: "h", at: 0, after: 0 }],
  };
  const r = load(structuredClone(state)).untangle({ budget: 20 });
  const asIs = load(structuredClone(state)).renderToCanvas().routes;
  const cells = asIs.reduce((n, rt) => n + (rt.path?.length ?? 0), 0);
  assertEquals(r.before.length, cells, "wire length as drawn");
});
