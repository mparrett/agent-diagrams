import { assert } from "@std/assert";
import { Diagram } from "../diagram-api.js";
import { checkRaster } from "../raster-check.js";

// Rasterization guard — the half `just parity` doesn't cover.
//
// The measurement harness asserts the browser and the renderer agree on
// {col,row,w,h}. These assert something it cannot see: that text the layout
// allotted space for was actually drawn into the PNG. A rasterization fault
// produces perfect geometry and blank boxes, so measurement parity stays
// green while the artifact is unreadable.
//
// Details used to drop out of renders at random; the fresh-process test below
// guards the fix. The rest asserts that the *instrument* is sound and that
// labels keep rendering.
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

// ─── Fresh-process renders ────────────────────────────────────────────────
// Detail text used to vanish from about half of all renders, in a different
// place each time, because the font buffers were freed under Skia (see
// docs/project_notes/upstream-defects.md, fault 1). Each render here is a
// separate process (canary-render.js), since fonts are registered once per
// process. Ten renders that all draw would have happened about once in a
// thousand runs with the bug present.
async function freshRenders(n) {
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
      ],
    }).output();
    if (new TextDecoder().decode(stdout).includes("drew")) drew++;
  }
  return drew;
}

Deno.test("every fresh-process render draws the canary board's details", async () => {
  const N = 10;
  const drew = await freshRenders(N);
  assert(drew === N, `details drew in only ${drew}/${N} renders`);
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
