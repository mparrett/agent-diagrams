// Untangle: rearrange a board's boxes to cut wire crossings, inside the
// structure its author set up.
//
// Every candidate layout is scored on the engine's own routed wires, not on
// straight-line estimates, so "better" means better as drawn. In priority
// order: wires that fail to route, crossings, label defects (findIssues, plus
// wire labels on a band divider's label), wires sharing a track with an
// unrelated wire, then total wire length.
//
// What may move, and where:
// - Only top-level boxes that are not pinned. Pinned boxes keep their place,
//   and members of inner groups are placed by their group.
// - With horizontal band dividers, a box stays in its band but may change
//   sub-row inside it, including a new sub-row; the dividers are re-anchored
//   to the renumbered rows. Without them every row is kept, since a row is
//   the author's own layering.
// - A column move never takes a box across a vertical band divider.
//
// The search: barycenter sweeps (each row sorted by its neighbours' average
// column), then iterated local search. Greedy descent over swaps, column
// nudges and sub-row moves stops in the first local optimum, so after each
// descent a few random moves kick it somewhere nearby and it descends again.
// The random source is seeded, so a board always untangles the same way.

import { findIssues, innerGroups, isBandDivider } from "./diagram-core.js";

// Cost weights. A crossing outweighs any amount of wire length a typical
// board has; a label defect is nearly as bad, since it hides text.
const W_FAILED = 1e6;
const W_CROSSING = 1000;
const W_LABEL = 400;
const W_TRUNK = 60;
// Wires leaving or entering the same box may share track near it; that reads
// as a fan-out, not a merge, so it costs a fraction.
const KIN_TRUNK = 0.2;

// Polyline corners of a cell path, so crossings are tested per segment.
function corners(path) {
  const out = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const a = path[i - 1], b = path[i], c = path[i + 1];
    if (b.x - a.x !== c.x - b.x || b.y - a.y !== c.y - b.y) out.push(b);
  }
  out.push(path[path.length - 1]);
  return out;
}

// A proper crossing of a horizontal and a vertical segment; touching ends
// and collinear overlap are not crossings (overlap is the trunk term).
function crosses(p1, p2, p3, p4) {
  let H, V;
  if (p1.y === p2.y && p3.x === p4.x) [H, V] = [[p1, p2], [p3, p4]];
  else if (p1.x === p2.x && p3.y === p4.y) [H, V] = [[p3, p4], [p1, p2]];
  else return false;
  const hy = H[0].y, vx = V[0].x;
  return vx > Math.min(H[0].x, H[1].x) && vx < Math.max(H[0].x, H[1].x) &&
    hy > Math.min(V[0].y, V[1].y) && hy < Math.max(V[0].y, V[1].y);
}

const overlaps = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// Score one render (renderToCanvas's result). Lower is better.
export function scoreRender(res, dividerLabelRects = []) {
  const { routes } = res;
  const ok = routes.filter((r) => r.path?.length > 1);
  const polys = ok.map((r) => corners(r.path));
  const steps = ok.map((r) => {
    const s = new Set();
    for (let i = 0; i + 1 < r.path.length; i++) {
      const a = r.path[i], b = r.path[i + 1];
      const [p, q] = a.x < b.x || (a.x === b.x && a.y < b.y) ? [a, b] : [b, a];
      s.add(`${p.x},${p.y},${q.x},${q.y}`);
    }
    return s;
  });
  let crossings = 0, trunk = 0, length = 0;
  for (const r of routes) length += r.path ? r.path.length : 0;
  for (let i = 0; i < ok.length; i++) {
    for (let j = i + 1; j < ok.length; j++) {
      const a = polys[i], b = polys[j];
      for (let s = 0; s < a.length - 1; s++) {
        for (let t = 0; t < b.length - 1; t++) {
          if (crosses(a[s], a[s + 1], b[t], b[t + 1])) crossings++;
        }
      }
      let shared = 0;
      for (const k of steps[i]) if (steps[j].has(k)) shared++;
      const e1 = ok[i].edge ?? ok[i], e2 = ok[j].edge ?? ok[j];
      const kin = e1.from === e2.from || e1.to === e2.to ||
        e1.from === e2.to || e1.to === e2.from;
      trunk += shared * (kin ? KIN_TRUNK : 1);
    }
  }
  const failed = routes.filter((r) => !r.path).length;
  const labels = findIssues(res).filter((i) => i.kind !== "route-failed")
    .length +
    (res.labelRects || []).filter((l) =>
      l.label && dividerLabelRects.some((r) => overlaps(l.rect, r))
    ).length;
  trunk = Math.round(trunk);
  return {
    failed,
    crossings,
    labels,
    trunk,
    length,
    cost: failed * W_FAILED + crossings * W_CROSSING + labels * W_LABEL +
      trunk * W_TRUNK + length,
  };
}

// Mulberry32: small, fast, and the same sequence everywhere.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Untangle `state` (not modified). `render(state)` must return
 * { res, dividerLabelRects } for a candidate: renderToCanvas's result and the
 * px rects of band divider labels. Returns { state, before, after, evals }:
 * the untangled state and the scores either side.
 *
 * opts.budget caps candidate renders (each is one full layout and route);
 * opts.seed varies the search.
 */
export function untangle(state, render, opts = {}) {
  const budget = opts.budget ?? 1500;
  const rand = seeded(opts.seed ?? 0x9e3779b9);
  let evals = 0;
  const score = (s) => {
    evals++;
    const { res, dividerLabelRects } = render(s);
    return scoreRender(res, dividerLabelRects);
  };

  const hBands = (state.dividers || [])
    .filter((d) => d.orient === "h" && isBandDivider(d, state));
  const vAfters = (state.dividers || [])
    .filter((d) => d.orient === "v" && isBandDivider(d, state))
    .map((d) => d.after);
  const hAfters = hBands.map((d) => d.after);
  const rowBand = (row) => hAfters.filter((k) => k < row).length;
  const colBand = (col) => vAfters.filter((k) => k < col).length;
  const inner = innerGroups(state.groups, state.nodes);
  // Sub-rows renumber the board's rows. Inner groups sit on those rows too,
  // by their own authored row, so with any present only columns change.
  const subRows = hBands.length > 0 && inner.length === 0;

  const pinned = new Set([
    ...(Array.isArray(state.pinned) ? state.pinned : []),
    ...Object.keys(state.layout || {}),
  ]);
  // Members of an inner group sit at rows and columns local to their group,
  // so they are not on this grid at all.
  const grouped = new Set(inner.flatMap((g) => g.members));
  // Each node's place: band (fixed), sub (row order inside the band), col.
  const nodes = state.nodes.filter((n) => !grouped.has(n.id)).map((n) => ({
    id: n.id,
    band: rowBand(n.row),
    sub: n.row,
    row: n.row,
    col: n.col,
    colBand: colBand(n.col),
    free: !pinned.has(n.id),
  }));
  const free = nodes.filter((n) => n.free);
  if (!free.length) {
    const s = score(state);
    return { state, before: s, after: s, evals, moved: [] };
  }

  // The candidate as a state. With sub-rows, (band, sub) is compacted into
  // consecutive integer rows and each band divider re-anchored after the last
  // row of the band above it; without, every box keeps its own row number, so
  // a skipped row keeps its air. A box that moved loses its wire labels' hand
  // placement, and renumbered rows lose their rowY overrides: both belong to
  // the old layout, and scoring the candidate without them is scoring what
  // will be saved.
  function build() {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    let rowOf = null, dividers = state.dividers;
    if (subRows) {
      const keys = [...new Set(nodes.map((n) => `${n.band}:${n.sub}`))]
        .map((k) => k.split(":").map(Number))
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      rowOf = new Map(keys.map(([b, s], i) => [`${b}:${s}`, i]));
      // Last row at or above each band; an empty band takes the one above's.
      const lastUpTo = (b) => {
        let r = -1;
        for (const [kb, ks] of keys) {
          if (kb <= b) r = Math.max(r, rowOf.get(`${kb}:${ks}`));
        }
        return r;
      };
      // A divider bounds the band below as many band edges as sit above it.
      dividers = (state.dividers || []).map((d) =>
        hBands.includes(d)
          ? { ...d, after: lastUpTo(hAfters.filter((k) => k < d.after).length) }
          : d
      );
    }
    const moved = new Set();
    const out = state.nodes.map((n) => {
      const p = byId.get(n.id);
      if (!p) return n; // an inner-group member, placed by its group
      const row = rowOf ? rowOf.get(`${p.band}:${p.sub}`) : p.row;
      if (row !== n.row || p.col !== n.col) moved.add(n.id);
      return { ...n, row, col: p.col };
    });
    const edges = (state.edges || []).map((e) => {
      if (!e.labelPos || !(moved.has(e.from) || moved.has(e.to))) return e;
      const { labelPos: _, ...rest } = e;
      return rest;
    });
    const renumbered = out.some((n, i) => n.row !== state.nodes[i].row);
    return {
      ...state,
      nodes: out,
      edges,
      dividers,
      ...(renumbered && { rowY: {} }),
    };
  }

  const snap = () => nodes.map((n) => [n.sub, n.col]);
  const restore = (s) => nodes.forEach((n, i) => ([n.sub, n.col] = s[i]));
  const rowKey = (n) => `${n.band}:${n.sub}`;
  const inRow = (n) => nodes.filter((m) => m !== n && rowKey(m) === rowKey(n));
  const colOk = (n, c) =>
    c >= 0 && colBand(c) === n.colBand && !inRow(n).some((m) => m.col === c);
  const tidy = () => {
    for (const b of new Set(nodes.map((n) => n.band))) {
      const subs = [
        ...new Set(nodes.filter((n) => n.band === b).map((n) => n.sub)),
      ].sort((x, y) => x - y);
      for (const n of nodes) if (n.band === b) n.sub = subs.indexOf(n.sub);
    }
  };

  const before = score(build());
  let best = { ...before, s: snap() };

  // Stage 1: barycenter sweeps over the free boxes' columns.
  const nbrs = new Map(nodes.map((n) => [n.id, []]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of state.edges || []) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    nbrs.get(e.from).push(e.to);
    nbrs.get(e.to).push(e.from);
  }
  const rowOrder = () =>
    [...new Set(nodes.map(rowKey))].sort((a, b) => {
      const [x, y] = a.split(":").map(Number),
        [u, v] = b.split(":").map(Number);
      return x - u || y - v;
    });
  for (let i = 0; i < 6 && evals < budget; i++) {
    const order = i % 2 ? rowOrder().reverse() : rowOrder();
    for (const rk of order) {
      const row = free.filter((n) => rowKey(n) === rk);
      const want = new Map();
      for (const n of row) {
        let s = 0, w = 0;
        for (const m of nbrs.get(n.id)) {
          // Same-row neighbours want adjacency, not alignment.
          const k = rowKey(byId.get(m)) === rk ? 0.5 : 1;
          s += k * byId.get(m).col;
          w += k;
        }
        want.set(n.id, w ? s / w : n.col);
      }
      row.sort((a, b) => want.get(a.id) - want.get(b.id) || a.col - b.col);
      const fixed = new Set(
        nodes.filter((n) => !n.free && rowKey(n) === rk).map((n) => n.col),
      );
      let prev = -Infinity;
      for (const n of row) {
        let c = Math.max(Math.round(want.get(n.id)), prev + 1, 0);
        while (fixed.has(c) || colBand(c) !== n.colBand) {
          c++;
          if (colBand(c) > n.colBand) {
            c = n.col; // no room in its column band: leave it
            break;
          }
        }
        n.col = c;
        prev = c;
      }
    }
    const s = score(build());
    if (s.cost < best.cost) best = { ...s, s: snap() };
  }
  restore(best.s);

  // Stage 2: iterated local search. Moves are listed up front but applied one
  // at a time after others have been accepted, so each re-checks that it
  // still makes sense (same row, free cell) when it runs.
  function moves() {
    const out = [];
    for (const n of free) {
      for (const m of inRow(n)) {
        if (m.free && m.id > n.id && m.colBand === n.colBand) {
          out.push(() => {
            if (rowKey(m) !== rowKey(n)) return false;
            [n.col, m.col] = [m.col, n.col];
          });
        }
      }
      for (const d of [-1, 1]) {
        out.push(() => {
          if (!colOk(n, n.col + d)) return false;
          n.col += d;
        });
      }
      if (!subRows) continue;
      const subs = [
        ...new Set(nodes.filter((m) => m.band === n.band).map((m) => m.sub)),
      ].sort((a, b) => a - b);
      const targets = new Set([
        ...subs,
        subs[0] - 1,
        subs[subs.length - 1] + 1,
        n.sub - 0.5,
        n.sub + 0.5,
      ]);
      targets.delete(n.sub);
      for (const t of targets) {
        out.push(() => {
          const taken = nodes.some((m) =>
            m !== n && m.band === n.band && m.sub === t && m.col === n.col
          );
          if (taken) return false;
          n.sub = t;
        });
      }
    }
    return out;
  }
  function descend(cur) {
    let improved = true;
    while (improved && evals < budget) {
      improved = false;
      for (const mv of moves()) {
        if (evals >= budget) break;
        const undo = snap();
        if (mv() === false) continue;
        const s = score(build());
        if (s.cost < cur.cost) {
          cur = { ...s, s: snap() };
          improved = true;
        } else restore(undo);
      }
      restore(cur.s);
      tidy();
      cur.s = snap();
    }
    return cur;
  }
  best = descend(best);
  while (evals < budget) {
    restore(best.s);
    for (let k = 0; k < 3; k++) {
      const ms = moves();
      ms[Math.floor(rand() * ms.length)]();
    }
    tidy();
    const cur = descend({ ...score(build()), s: snap() });
    if (cur.cost < best.cost) best = cur;
  }
  // Nothing better found: hand the board back as it was. Rebuilding would
  // still renumber rows and drop any air the author left by skipping one.
  if (best.cost >= before.cost) {
    return { state, before, after: before, evals, moved: [] };
  }
  restore(best.s);
  tidy();

  const out = build();
  const moved = out.nodes
    .filter((n, i) =>
      n.row !== state.nodes[i].row || n.col !== state.nodes[i].col
    )
    .map((n) => n.id);
  const { s: _s, ...after } = best;
  return { state: out, before, after, evals, moved };
}
