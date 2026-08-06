/**
 * Measures the @gfx/canvas shadowBlur displacement — how far a box's drop
 * shadow lands from the box that cast it.
 *
 * Shared by the canary in shadow-canary.test.js and by `just upstream-check`,
 * which runs this file as a CLI inside a worktree pinned to a newer release:
 *
 *   deno run --allow-read --allow-write --allow-env --allow-ffi \
 *     --unstable-ffi tests/shadow-probe.js [--dpr1]   # prints JSON
 *
 * One implementation so the canary and the upstream report can never disagree
 * about what "displaced" means.
 */
import { Diagram } from "../diagram-api.js";
import { decodePng } from "../raster-check.js";
import { CELL } from "../diagram-core.js";

export const SHADOW_BLUR = 12; // must match drawBoxes
// A correctly drawn shadow is a blur around its box, so its ink cannot land
// further than a few blur radii from the box edge. Anything beyond this is the
// displacement. Generous on purpose: the phantom lands hundreds of px away.
export const HALO_RADII = 3;

function canaryBoard(dir, extra = {}) {
  const path = `${dir}/diagram-state.json`;
  Deno.writeTextFileSync(
    path,
    JSON.stringify({
      width: 700,
      height: 500,
      output: "out.png",
      // A light theme, so shadow ink contrasts with the background and the
      // measurement has plenty of signal. (Before withAlpha() this was load
      // bearing for a worse reason: the default palette's 3-digit borders made
      // the shadow colour invalid, so nothing was drawn at all.)
      theme: "dawnfox",
      nodes: [{ id: "a", label: "Alpha", color: "blue", row: 0, col: 0 }],
      // Pinned near the origin so the displaced phantom lands ON the canvas.
      // Placed to the right or bottom it falls outside the bitmap entirely and
      // the fault becomes invisible — which is how it hid from an earlier probe.
      layout: { a: { x: 60, y: 45 } },
      edges: [],
      rev: 0,
      ...extra,
    }),
  );
  return path;
}

/**
 * Renders the fixture with shadows off and on and compares the two. Working on
 * the DIFFERENCE means nothing else on the canvas — label, border, background —
 * can be mistaken for shadow ink.
 *
 * Returns { changed, beyond }: pixels the shadow altered, and how many of those
 * landed further than HALO_RADII blur radii from the box. `beyond` is the
 * displacement; on a correct renderer it is 0.
 */
export async function shadowInkOutsideHalo(extra = {}) {
  const dir = Deno.makeTempDirSync({ prefix: "agent-diagrams-shadow-" });
  try {
    const path = canaryBoard(dir, extra);
    const off = Diagram.load(path).renderToCanvas({ shadows: false });
    const on = Diagram.load(path).renderToCanvas({ shadows: true });
    const a = await decodePng(off.canvas.encode("png"));
    const b = await decodePng(on.canvas.encode("png"));

    const box = on.gridBoxes[0];
    const s = on.scale;
    const pad = HALO_RADII * SHADOW_BLUR * s;
    const hx0 = box.col * CELL * s - pad;
    const hy0 = box.row * CELL * s - pad;
    const hx1 = (box.col + box.w) * CELL * s + pad;
    const hy1 = (box.row + box.h) * CELL * s + pad;

    let changed = 0, beyond = 0;
    for (let y = 0; y < a.height; y++) {
      for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 4;
        if (
          a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] &&
          a.data[i + 2] === b.data[i + 2]
        ) continue;
        changed++;
        if (x < hx0 || x > hx1 || y < hy0 || y > hy1) beyond++;
      }
    }
    return { changed, beyond };
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

if (import.meta.main) {
  const dpr1 = Deno.args.includes("--dpr1");
  console.log(
    JSON.stringify(await shadowInkOutsideHalo(dpr1 ? { dpr: 1 } : {})),
  );
}
