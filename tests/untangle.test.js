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
