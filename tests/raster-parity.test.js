import { assert } from "@std/assert";
import { Diagram } from "../diagram-api.js";
import { checkRaster } from "../raster-check.js";

// Rasterization guard — the half `just parity` doesn't cover.
//
// The measurement harness asserts the browser and the renderer agree on
// {col,row,w,h}. These assert something it cannot see: that text the layout
// allotted space for was actually drawn into the PNG. The open @gfx/canvas
// bug produces perfect geometry and blank boxes, so measurement parity stays
// green while the artifact is unreadable.
//
// WHAT IS DELIBERATELY NOT ASSERTED HERE: that `details` render. They currently
// may or may not, on the same input, run to run — the failure was reproduced on
// a board with just two boxes, so there is no "small enough to be safe" corpus
// to anchor on. Asserting it would produce a flaky suite that fails for reasons
// no one changed. What IS asserted is that the *instrument* is sound and that
// labels — the reliable path, and the documented workaround — keep rendering.
//
// Diagnose a specific board with `just raster-check [state]`, which reports per
// box whether its text landed and exits non-zero if not.

function withTempDir(fn) {
  const dir = Deno.makeTempDirSync({ prefix: "agent-diagrams-raster-" });
  try {
    return fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

function board(dir, nodes, extra = {}) {
  const path = `${dir}/diagram-state.json`;
  Deno.writeTextFileSync(
    path,
    JSON.stringify({
      title: "raster",
      width: 900,
      height: 600,
      output: "out.png",
      nodes,
      edges: [],
      rev: 0,
      ...extra,
    }),
  );
  return Diagram.load(path);
}

Deno.test("the checker tells drawn text from blank space", async () =>
  await withTempDir(async (dir) => {
    // Discrimination is proved against the LABEL band (which renders reliably)
    // as the positive case and a details-free box's detail band as the negative.
    // Using the details band as the positive would make this test hostage to the
    // very bug it exists to detect.
    const d = board(dir, [
      { id: "a", label: "Alpha", color: "blue", row: 0, col: 0 },
      { id: "b", label: "Beta", color: "green", row: 0, col: 1 },
    ]);
    const r = await checkRaster(d);
    assert(r.checked === 2, `expected 2 boxes, got ${r.checked}`);
    for (const b of r.boxes) {
      assert(
        b.labelInk > 50,
        `${b.id}: label band should be inked (${b.labelInk})`,
      );
      assert(b.labelOk, `${b.id}: label should register as drawn`);
      assert(
        b.detailInk === 0,
        `${b.id}: a box with no details must read as blank (${b.detailInk})`,
      );
      assert(b.detailOk, `${b.id}: no details means nothing missing`);
    }
    assert(r.missing === 0, "a board of bare boxes has nothing missing");
  }));

Deno.test("box labels rasterize — the path the workaround depends on", async () =>
  await withTempDir(async (dir) => {
    // The documented workaround for the details bug is to carry text in `label`.
    // If labels ever start dropping too, that advice is void and this fails.
    const nodes = [];
    for (let i = 0; i < 9; i++) {
      nodes.push({
        id: `n${i}`,
        label: `Service ${i}`,
        color: "blue",
        row: Math.floor(i / 3),
        col: i % 3,
      });
    }
    const r = await checkRaster(board(dir, nodes));
    const lost = r.boxes.filter((b) => !b.labelOk).map((b) => b.id);
    assert(lost.length === 0, `labels failed to rasterize: ${lost.join(", ")}`);
  }));

Deno.test("checkRaster reports the board's actual structure", async () =>
  await withTempDir(async (dir) => {
    const d = board(dir, [
      {
        id: "withDetails",
        label: "A",
        color: "blue",
        details: ["one", "two", "three"],
        row: 0,
        col: 0,
      },
      { id: "bare", label: "B", color: "blue", row: 0, col: 1 },
    ]);
    const r = await checkRaster(d);
    const wd = r.boxes.find((b) => b.id === "withDetails");
    const bare = r.boxes.find((b) => b.id === "bare");
    assert(
      wd.detailLines === 3,
      `expected 3 detail lines, got ${wd.detailLines}`,
    );
    assert(
      bare.detailLines === 0,
      `expected 0 detail lines, got ${bare.detailLines}`,
    );
    // `missing` must agree with the per-box verdicts, whichever way they fell.
    const expected = r.boxes.filter((b) => !b.labelOk || !b.detailOk).length;
    assert(
      r.missing === expected,
      `missing=${r.missing} but ${expected} boxes flagged`,
    );
  }));

// ─── Canary ───────────────────────────────────────────────────────────────
// This asserts the bug is STILL THERE. It is meant to fail one day.
//
// The measurement aliases in diagram-api.js work around a @gfx/canvas fault we
// could not reproduce standalone and therefore could not report upstream. A
// workaround for an unfiled, unexplained fault is exactly the kind of thing that
// silently outlives its cause, so instead of a "remove me later" comment, this
// renders with the aliases OFF — the faulty path — and fails once the text
// starts drawing anyway. A failure here is good news: it means the fault is
// gone and MEASURE_SUFFIX and everything referencing it can be deleted.
//
// It renders N times because the fault is intermittent: roughly 1 render in 40
// draws the text regardless. Requiring ALL N renders to succeed before crying
// "fixed" puts a spurious failure somewhere around 1e-16, while a genuine
// upstream fix trips it on the first run.
//
// Each render is a SEPARATE PROCESS (canary-render.js). The fault only bites the
// first render in a process — loop in-process and every iteration after the
// first draws happily, which reports "fixed" every single time. That is not a
// detail worth rediscovering; it is why this test looks more expensive than it
// ought to.
async function canaryRenders(n, aliases) {
  const script = new URL("./canary-render.js", import.meta.url).pathname;
  let drew = 0;
  for (let i = 0; i < n; i++) {
    const { stdout } = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-ffi",
        "--unstable-ffi",
        script,
        ...(aliases ? ["--aliases"] : []),
      ],
    }).output();
    if (new TextDecoder().decode(stdout).includes("drew")) drew++;
  }
  return drew;
}

Deno.test("canary: the @gfx/canvas glyph-drop fault is still present", async () => {
  const N = 10;
  const drew = await canaryRenders(N, false);
  assert(
    drew < N,
    `All ${N} renders drew their details through the UNALIASED measurement ` +
      `path, so the @gfx/canvas glyph-drop fault looks fixed.\n` +
      `If so: delete MEASURE_SUFFIX and its aliases from diagram-api.js, the ` +
      `measureFamily branch in computeLayout, the measureAliases option, and ` +
      `this test. Confirm first with a version bump + \`just raster-check\`, ` +
      `and update docs/project_notes/upstream-defects.md, which lists ` +
      `everything to delete.`,
  );
});

Deno.test("the alias fix keeps the canary board's details on the page", async () => {
  // The other half of the canary: the same board, same fresh-process conditions,
  // through the production path must draw every time. Together the two pin the
  // workaround as both still necessary and still effective.
  const N = 10;
  const drew = await canaryRenders(N, true);
  assert(
    drew === N,
    `measurement aliases only kept details rendering in ${drew}/${N} renders`,
  );
});

Deno.test("the shipped example board keeps its labels", async () => {
  // Real committed artifact, not a fixture — a regression here would otherwise
  // only surface as an unreadable diagram in the repo.
  const path =
    new URL("../diagrams/example/diagram-state.json", import.meta.url)
      .pathname;
  const r = await checkRaster(Diagram.load(path));
  assert(r.checked > 0, "example board should have boxes");
  const lost = r.boxes.filter((b) => !b.labelOk).map((b) => b.id);
  assert(lost.length === 0, `example board lost labels: ${lost.join(", ")}`);
});
