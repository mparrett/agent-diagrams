// Flow fields: a direction at every point of the board. A field steers three
// things: which sides a wire leaves and enters by, the cost A* pays for a step
// against the field, and (flow-place) where a chain of nodes goes, laid
// along one streamline.
//
// A field is named by a preset, or by two presets joined with ">" for a field
// that changes partway across the board ("right>down": right on the left 55%,
// down after it).

const norm = ([x, y]) => {
  const l = Math.hypot(x, y);
  return l ? [x / l, y / l] : [0, 0];
};

// Snake bands: rows of the board alternately run right and left, and turn
// down at the ends. `bands` is how many rows.
const snake = (bands) => (u, v) => {
  const b = Math.min(bands - 1, Math.floor(v * bands));
  const right = b % 2 === 0;
  // Past the end of a band, turn down into the next one, and keep going down
  // until that band's centre line, so the bands sit a full band apart.
  const atEnd = right ? u > 0.88 : u < 0.12;
  if (atEnd && b < bands - 1) return [0, 1];
  const atStart = right ? u < 0.12 : u > 0.88;
  if (atStart && b > 0 && v < (b + 0.5) / bands) return [0, 1];
  return right ? [1, 0] : [-1, 0];
};

const PRESETS = {
  right: () => [1, 0],
  left: () => [-1, 0],
  down: () => [0, 1],
  up: () => [0, -1],
  // Clockwise round the centre, drifting outward: a spiral from the middle.
  swirl: (u, v) => {
    const rx = u - 0.5, ry = v - 0.5;
    return norm([-ry + 0.22 * rx, rx + 0.22 * ry]);
  },
  snake: snake(3),
  snake2: snake(2),
  snake4: snake(4),
};

/**
 * Resolve a field spec to `(u, v) → [dx, dy]`, a unit vector at normalised
 * board coordinates (0..1 each, y down). Returns null for an unknown spec.
 */
export function fieldFn(spec) {
  if (!spec) return null;
  if (PRESETS[spec]) return PRESETS[spec];
  const parts = String(spec).split(">");
  if (parts.length !== 2 || !parts.every((p) => PRESETS[p])) return null;
  const [a, b] = parts.map((p) => PRESETS[p]);
  // Split across the first field's own axis: a horizontal field hands over
  // partway across, a vertical one partway down.
  const [ax, ay] = a(0.25, 0.25);
  const split = 0.55;
  return Math.abs(ax) >= Math.abs(ay)
    ? (u, v) => (ax > 0 ? u < split : u > 1 - split) ? a(u, v) : b(u, v)
    : (u, v) => (ay > 0 ? v < split : v > 1 - split) ? a(u, v) : b(u, v);
}

/** Where a streamline starts for a field: the seed for flow-place. */
export function fieldSeed(spec) {
  const head = String(spec).split(">")[0];
  return {
    right: [0.04, 0.12],
    left: [0.96, 0.12],
    down: [0.12, 0.04],
    up: [0.12, 0.96],
    swirl: [0.53, 0.5],
    snake: [0.04, 1 / 6],
    snake2: [0.04, 1 / 4],
    snake4: [0.04, 1 / 8],
  }[head] ?? [0.05, 0.05];
}

const SIDES = [
  { side: "top", n: [0, -1] },
  { side: "right", n: [1, 0] },
  { side: "bottom", n: [0, 1] },
  { side: "left", n: [-1, 0] },
];

/**
 * Sides for a wire under a field. The wire leaves by a side facing the target
 * and, among those, the one the field at the source points out of; it enters
 * by a side facing the source that the field at the target points into.
 * Boxes that overlap on one axis keep the straight wire. Boxes are in grid
 * cells; `at(x, y)` gives the field at a cell.
 */
export function flowSides(src, tgt, at) {
  const overlapX = src.col < tgt.col + tgt.w && tgt.col < src.col + src.w;
  const overlapY = src.row < tgt.row + tgt.h && tgt.row < src.row + src.h;
  const sc = [src.col + src.w / 2, src.row + src.h / 2];
  const tc = [tgt.col + tgt.w / 2, tgt.row + tgt.h / 2];
  const d = [tc[0] - sc[0], tc[1] - sc[1]];
  if (overlapX !== overlapY) {
    const v = overlapX ? [0, Math.sign(d[1])] : [Math.sign(d[0]), 0];
    const out = SIDES.find((s) => s.n[0] === v[0] && s.n[1] === v[1]);
    const inn = SIDES.find((s) => s.n[0] === -v[0] && s.n[1] === -v[1]);
    return { srcSide: out.side, tgtSide: inn.side };
  }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const fs = at(...sc), ft = at(...tc);
  const best = (cands, f) =>
    cands.reduce((a, b) => dot(b.n, f) > dot(a.n, f) ? b : a);
  const out = best(SIDES.filter((s) => dot(s.n, d) > 0), fs);
  const inn = best(
    SIDES.filter((s) => dot(s.n, d) < 0),
    [-ft[0], -ft[1]],
  );
  return { srcSide: out.side, tgtSide: inn.side };
}

/**
 * The A* step penalty under a field: `weight` per unit of the step that runs
 * against the field, and half that across it. Never negative, so the router's
 * distance heuristic stays admissible.
 */
export function flowStepCost(at, weight) {
  return (x, y, dx, dy) => {
    const [fx, fy] = at(x, y);
    const along = dx * fx + dy * fy;
    return along >= 0 ? (1 - along) * weight * 0.5 : weight * (0.5 - along);
  };
}

/**
 * Lay boxes along one streamline of the field, inside a `W` x `H` px frame.
 * `spine` ({id, w, h} in px, in order) goes down the line: each box at the
 * first point where it clears every box already placed by `gap`. `side`
 * ({id, w, h, near}) goes beside its `near` box, across the field there.
 * Returns {id: {x, y}} top-left px, snapped to `cell`.
 */
export function flowPlace(
  spine,
  side,
  spec,
  W,
  H,
  { gap = 45, cell = 15 } = {},
) {
  const f = fieldFn(spec);
  if (!f) throw new Error(`unknown field "${spec}"`);
  const at = (x, y) => f(x / W, y / H);
  const snap = (n) => Math.round(n / cell) * cell;
  const placed = new Map();
  const clear = (r) =>
    [...placed.values()].every((p) =>
      r.x + r.w + gap <= p.x || p.x + p.w + gap <= r.x ||
      r.y + r.h + gap <= p.y || p.y + p.h + gap <= r.y
    );
  const boxAt = (b, x, y) => ({
    x: snap(x - b.w / 2),
    y: snap(y - b.h / 2),
    w: b.w,
    h: b.h,
  });
  const step = 4;

  let [x, y] = fieldSeed(spec).map((t, i) => t * (i ? H : W));
  for (const b of spine) {
    let r = boxAt(b, x, y);
    for (let i = 0; i < 20000 && !clear(r); i++) {
      const [dx, dy] = at(x, y);
      x += dx * step, y += dy * step;
      r = boxAt(b, x, y);
    }
    placed.set(b.id, r);
  }

  // Beside the neighbour, across the field: try both normals, nearest clear
  // spot wins; ties go to the left of the flow (above a rightward line).
  for (const b of side) {
    const n = placed.get(b.near);
    const cx = n ? n.x + n.w / 2 : x, cy = n ? n.y + n.h / 2 : y;
    const [fx, fy] = at(cx, cy);
    let best = null;
    for (const [px, py] of [[fy, -fx], [-fy, fx]]) {
      for (let d = 0; d < 4000; d += step) {
        const r = boxAt(b, cx + px * d, cy + py * d);
        if (clear(r)) {
          if (!best || d < best.d) best = { d, r };
          break;
        }
      }
    }
    placed.set(b.id, best ? best.r : boxAt(b, cx, cy));
  }

  // Start at the frame's corner.
  const all = [...placed.values()];
  const minX = Math.min(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y));
  const out = {};
  for (const [id, p] of placed) {
    out[id] = { x: p.x - minX + 4 * cell, y: p.y - minY + 4 * cell };
  }
  return out;
}

/**
 * Split nodes into the spine (the longest chain of edges, in order) and the
 * rest, each with the spine-side neighbour it should sit beside. Cycles are
 * broken at the first back edge in authoring order.
 */
export function flowSpine(nodes, edges) {
  const ids = nodes.map((n) => n.id);
  const has = new Set(ids);
  const es = (edges || []).filter((e) =>
    has.has(e.from) && has.has(e.to) && e.from !== e.to
  );
  // Topological order by DFS finish, authoring order first.
  const outs = new Map(ids.map((id) => [id, []]));
  for (const e of es) outs.get(e.from).push(e.to);
  const state = new Map();
  const post = [];
  const back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const t of outs.get(id)) {
      if (state.get(t) === 1) back.add(`${id}\0${t}`);
      else if (!state.has(t)) visit(t);
    }
    state.set(id, 2);
    post.push(id);
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  const topo = post.reverse();
  // Longest path.
  const len = new Map(ids.map((id) => [id, 0]));
  const prev = new Map();
  for (const id of topo) {
    for (const t of outs.get(id)) {
      if (back.has(`${id}\0${t}`)) continue;
      if (len.get(id) + 1 > len.get(t)) {
        len.set(t, len.get(id) + 1);
        prev.set(t, id);
      }
    }
  }
  let end = topo[0];
  for (const id of topo) if (len.get(id) > len.get(end)) end = id;
  const spine = [];
  for (let p = end; p !== undefined; p = prev.get(p)) spine.unshift(p);
  // The rest, nearest the spine first, each beside a neighbour placed before it.
  const placed = new Set(spine);
  const side = [];
  const nbrs = (id) =>
    es.flatMap((e) => e.from === id ? [e.to] : e.to === id ? [e.from] : []);
  let left = ids.filter((id) => !placed.has(id));
  while (left.length) {
    const i = left.findIndex((id) => nbrs(id).some((n) => placed.has(n)));
    const id = left[i === -1 ? 0 : i];
    side.push({ id, near: nbrs(id).find((n) => placed.has(n)) ?? null });
    placed.add(id);
    left = left.filter((x) => x !== id);
  }
  return { spine, side };
}

/**
 * Draw the field as faint arrows every `every` cells over a `cols` x `rows`
 * grid, sampled as the router samples it. Nothing for an unknown spec.
 */
export function drawFlowField(ctx, spec, cols, rows, cell, every = 3) {
  const f = fieldFn(spec);
  if (!f) return;
  const len = cell * every * 0.32, head = cell * 0.32;
  ctx.save();
  ctx.strokeStyle = "rgba(0,140,160,0.55)";
  ctx.fillStyle = "rgba(0,140,160,0.55)";
  ctx.lineWidth = 1.2;
  for (let y = Math.floor(every / 2); y < rows; y += every) {
    for (let x = Math.floor(every / 2); x < cols; x += every) {
      const [dx, dy] = f(x / cols, y / rows);
      if (!dx && !dy) continue;
      const cx = (x + 0.5) * cell, cy = (y + 0.5) * cell;
      const tx = cx + dx * len, ty = cy + dy * len;
      ctx.beginPath();
      ctx.moveTo(cx - dx * len, cy - dy * len);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tx + dx * head, ty + dy * head);
      ctx.lineTo(tx - dy * head * 0.6, ty + dx * head * 0.6);
      ctx.lineTo(tx + dy * head * 0.6, ty - dx * head * 0.6);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}
