import { assert } from "@std/assert";
import {
  fieldFn,
  flowPlace,
  flowSides,
  flowSpine,
  flowStepCost,
} from "../flow-field.js";

function assertEquals(actual, expected, msg = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, msg || `Expected ${e}, got ${a}`);
}

Deno.test("fields resolve presets and a>b, and reject the rest", () => {
  assertEquals(fieldFn("right")(0.3, 0.3), [1, 0]);
  const rd = fieldFn("right>down");
  assertEquals(rd(0.1, 0.5), [1, 0]);
  assertEquals(rd(0.9, 0.5), [0, 1]);
  assertEquals(fieldFn("sideways"), null);
  assertEquals(fieldFn("right>down>up"), null);
  const [x, y] = fieldFn("swirl")(0.9, 0.5);
  assert(y > 0.9 && Math.abs(Math.hypot(x, y) - 1) < 1e-9, "clockwise");
});

Deno.test("snake runs right, turns down at the end, then runs left", () => {
  const f = fieldFn("snake");
  assertEquals(f(0.5, 0.1), [1, 0]);
  assertEquals(f(0.95, 0.1), [0, 1]);
  assertEquals(f(0.5, 0.5), [-1, 0]);
  assertEquals(f(0.95, 0.9), [1, 0], "the last band never turns down");
});

Deno.test("flowSides follows the field between diagonal boxes", () => {
  const a = { col: 0, row: 0, w: 4, h: 2 };
  const b = { col: 10, row: 8, w: 4, h: 2 };
  assertEquals(flowSides(a, b, () => [1, 0]), {
    srcSide: "right",
    tgtSide: "left",
  });
  assertEquals(flowSides(a, b, () => [0, 1]), {
    srcSide: "bottom",
    tgtSide: "top",
  });
  const under = { col: 1, row: 8, w: 4, h: 2 };
  assertEquals(
    flowSides(a, under, () => [1, 0]),
    { srcSide: "bottom", tgtSide: "top" },
    "a straight wire wins",
  );
});

Deno.test("step cost is free along the field and never negative", () => {
  const c = flowStepCost(() => [1, 0], 6);
  assertEquals(c(0, 0, 1, 0), 0);
  assertEquals(c(0, 0, 0, 1), 3);
  assertEquals(c(0, 0, -1, 0), 9);
  const s = flowStepCost((x, y) => fieldFn("swirl")(x / 40, y / 30), 6);
  for (let x = 0; x < 40; x++) {
    for (let y = 0; y < 30; y++) assert(s(x, y, 0, -1) >= 0);
  }
});

Deno.test("flowSpine takes the longest chain; branches sit by a neighbour", () => {
  const nodes = ["a", "b", "c", "d", "x"].map((id) => ({ id }));
  const edges = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "d" },
    { from: "x", to: "c" },
    { from: "d", to: "a" }, // a cycle back to the start
  ];
  const { spine, side } = flowSpine(nodes, edges);
  assertEquals(spine, ["a", "b", "c", "d"]);
  assertEquals(side, [{ id: "x", near: "c" }]);
});

Deno.test("flowPlace lays boxes without overlap, snapped to cells", () => {
  const box = (id) => ({ id, w: 150, h: 90 });
  for (const spec of ["right", "snake", "swirl", "right>down"]) {
    const spine = ["a", "b", "c", "d", "e", "f", "g", "h"].map(box);
    const side = [{ ...box("x"), near: "c" }];
    const at = flowPlace(spine, side, spec, 1200, 900, { gap: 45 });
    const rs = Object.entries(at).map(([id, p]) => ({
      id,
      ...p,
      w: 150,
      h: 90,
    }));
    assertEquals(rs.length, 9);
    for (const r of rs) assert(r.x % 15 === 0 && r.y % 15 === 0, spec);
    for (const p of rs) {
      for (const q of rs) {
        if (p === q) continue;
        const apart = p.x + p.w <= q.x || q.x + q.w <= p.x ||
          p.y + p.h <= q.y || q.y + q.h <= p.y;
        assert(apart, `${spec}: ${p.id} overlaps ${q.id}`);
      }
    }
  }
});
