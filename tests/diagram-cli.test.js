import { assert } from "@std/assert";

function assertEquals(actual, expected, msg = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, msg || `Expected ${e}, got ${a}`);
}

// End-to-end CLI tests: spawn diagram-cli.js as a subprocess (needs --allow-run,
// see the `test` task) and assert on the persisted state. Covers the edge `--id`
// forms that pure-API tests can't reach — the argument parsing lives in the CLI.

const CLI = new URL("../diagram-cli.js", import.meta.url).pathname;
const PERMS = [
  "--allow-read",
  "--allow-write",
  "--allow-net",
  "--allow-env",
  "--allow-ffi",
  "--unstable-ffi",
];

async function runCli(statePath, args) {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...PERMS, CLI, "--state", statePath, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code,
    out: new TextDecoder().decode(stdout),
    err: new TextDecoder().decode(stderr),
  };
}

async function withTempDir(fn) {
  const dir = await Deno.makeTempDir({ prefix: "agent-diagrams-cli-test-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function writeState(path, state) {
  Deno.writeTextFileSync(
    path,
    JSON.stringify({ rev: 0, ...state }, null, 2) + "\n",
  );
}

// Labeled/colored nodes so the post-mutation PNG render succeeds (a label-less
// node makes fillText throw — unrelated to the CLI logic under test).
const NODES = [
  { id: "a", label: "A", color: "blue", row: 0, col: 0 },
  { id: "b", label: "B", color: "green", row: 0, col: 2 },
  { id: "c", label: "C", color: "red", row: 1, col: 2 },
];

Deno.test("CLI: parallel edges + --id targets the right one", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      nodes: NODES,
      edges: [{ from: "a", to: "b", style: "solid", label: "first" }],
    });

    // A second a->b edge is allowed; it gets id a~b~2.
    let r = await runCli(path, ["add-edge", "a", "b", "dashed", "second"]);
    assert(r.code === 0, `add-edge exit ${r.code}: ${r.err}`);

    // The regression: --id with NO positional from/to must parse the flags.
    r = await runCli(path, ["update-edge", "--id=a~b~2", "--label=renamed"]);
    assert(r.code === 0, `update-edge --id exit ${r.code}: ${r.err}`);

    // Move only the target end by id (the other end is kept).
    r = await runCli(path, ["retarget-edge", "--id=a~b~2", "--newTo=c"]);
    assert(r.code === 0, `retarget-edge --id exit ${r.code}: ${r.err}`);

    const st = JSON.parse(Deno.readTextFileSync(path));
    const e1 = st.edges.find((e) => e.id === "a~b");
    const e2 = st.edges.find((e) => e.id === "a~b~2");
    assert(e1 && e1.label === "first" && e1.to === "b", "first edge untouched");
    assert(
      e2 && e2.label === "renamed" && e2.from === "a" && e2.to === "c",
      `--id edits hit only the second edge, got ${JSON.stringify(e2)}`,
    );
  }));

Deno.test("CLI: remove-edge --id removes only the named parallel edge", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      nodes: NODES,
      edges: [
        { from: "a", to: "b", style: "solid", label: "keep", id: "a~b" },
        { from: "a", to: "b", style: "dashed", label: "drop", id: "a~b~2" },
      ],
    });
    const r = await runCli(path, ["remove-edge", "--id=a~b~2"]);
    assert(r.code === 0, `remove-edge --id exit ${r.code}: ${r.err}`);
    const st = JSON.parse(Deno.readTextFileSync(path));
    assert(
      st.edges.length === 1 && st.edges[0].id === "a~b",
      "only a~b~2 removed",
    );
  }));

// ─── Argument validation ─────────────────────────────────────────────────────
// The CLI is the agent-facing surface, and an agent can't see the rendered
// result — it only sees the exit code. So a bad argument MUST fail loudly rather
// than persist garbage and report success. Before this, `add-node c C blue two
// three` wrote row/col as NaN (serialized to null), placed the box arbitrarily,
// bumped rev, and exited 0.

const BASE = {
  nodes: [{ id: "a", label: "A", color: "blue", row: 0, col: 0 }],
  edges: [],
  layout: {},
};

Deno.test("add-node rejects non-integer row/col instead of persisting null", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, BASE);
    const r = await runCli(path, [
      "add-node",
      "c",
      "C",
      "blue",
      "two",
      "three",
    ]);
    assert(r.code === 1, `expected exit 1, got ${r.code}\n${r.out}${r.err}`);
    assert(
      /must be an integer/.test(r.err),
      `error should explain the problem: ${r.err}`,
    );
    assert(/<row>/.test(r.err), `error should name the argument: ${r.err}`);
    const s = JSON.parse(Deno.readTextFileSync(path));
    assert(s.nodes.length === 1, "no node should have been added");
    assert(s.rev === 0, `state must be untouched, rev is ${s.rev}`);
  }));

Deno.test("numeric flags reject garbage across the mutating commands", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    const cases = [
      ["move-node", "a", "1", "x"],
      ["update-node", "a", "--row=abc"],
      ["update-node", "a", "--w=1.5"],
      ["update-node", "a", "--minW=-3"],
      ["add-divider", "h", "12px"],
      ["set-font-size", "big"],
      ["set-canvas", "900", "tall"],
      ["expand-canvas", "--left=lots"],
    ];
    for (const args of cases) {
      writeState(path, BASE);
      const r = await runCli(path, args);
      assert(r.code === 1, `${args.join(" ")}: expected exit 1, got ${r.code}`);
      const s = JSON.parse(Deno.readTextFileSync(path));
      assert(
        s.rev === 0,
        `${args.join(" ")}: state was modified (rev ${s.rev})`,
      );
    }
  }));

Deno.test("a typo'd flag errors instead of silently applying nothing", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, BASE);
    // --lable is a typo; the label must NOT be silently dropped while --color
    // applies and the command reports success.
    const r = await runCli(path, [
      "update-node",
      "a",
      "--lable=Typo",
      "--color=red",
    ]);
    assert(r.code === 1, `expected exit 1, got ${r.code}\n${r.out}${r.err}`);
    assert(
      /unknown flag "--lable"/.test(r.err),
      `should name the flag: ${r.err}`,
    );
    const s = JSON.parse(Deno.readTextFileSync(path));
    assert(s.nodes[0].color === "blue", "no field should have been applied");
    assert(s.rev === 0, `state must be untouched, rev is ${s.rev}`);
  }));

Deno.test("valid integer arguments still work (guard isn't over-strict)", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, BASE);
    const add = await runCli(path, ["add-node", "c", "C", "blue", "2", "3"]);
    assert(add.code === 0, `add-node failed: ${add.err}`);
    // Negative offsets and 0 (the "clear it" sentinel) must both survive.
    const up = await runCli(path, ["update-node", "c", "--row=-1", "--w=0"]);
    assert(up.code === 0, `update-node failed: ${up.err}`);
    const s = JSON.parse(Deno.readTextFileSync(path));
    const c = s.nodes.find((n) => n.id === "c");
    assert(c.row === -1 && c.col === 3, `got row=${c.row} col=${c.col}`);
    assert(!("w" in c), "--w=0 should clear the explicit width");
  }));

Deno.test("set-title / set-footer round-trip through the CLI, and clear with no argument", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      nodes: [{ id: "a", label: "A", row: 0, col: 0 }],
      edges: [],
    });

    // Multi-word text arrives as separate argv entries and must be rejoined.
    const set = await runCli(path, ["set-title", "Request", "flow"]);
    assertEquals(set.code, 0, set.err);
    assertEquals(JSON.parse(Deno.readTextFileSync(path)).title, "Request flow");

    const foot = await runCli(path, ["set-footer", "solid = sync"]);
    assertEquals(foot.code, 0, foot.err);
    assertEquals(
      JSON.parse(Deno.readTextFileSync(path)).footer,
      "solid = sync",
    );

    // No argument clears the key rather than setting an empty string, which
    // would otherwise reserve the title band in the render.
    const cleared = await runCli(path, ["set-title"]);
    assertEquals(cleared.code, 0, cleared.err);
    const state = JSON.parse(Deno.readTextFileSync(path));
    assert(!("title" in state), "title should be absent after clearing");
    assertEquals(
      state.footer,
      "solid = sync",
      "clearing one must not touch the other",
    );
  }));

Deno.test("render warns on stderr when the raster cap downscales the board", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    // A row far wider than the 4096px raster cap. The render still "succeeds",
    // which is the whole problem the warning exists to surface.
    const nodes = [];
    for (let i = 0; i < 24; i++) {
      nodes.push({
        id: `n${i}`,
        label: `service-number-${i}`,
        color: "blue",
        row: 0,
        col: i,
        w: 20,
        h: 5,
      });
    }
    writeState(path, { width: 1200, height: 400, nodes, edges: [] });

    const wide = await runCli(path, ["render"]);
    assertEquals(wide.code, 0, "a capped render still exits 0");
    assert(
      wide.out.includes("capped"),
      `stdout should note the cap: ${wide.out}`,
    );
    assert(
      wide.err.includes("warning:") && wide.err.includes("raster cap"),
      `expected a stderr warning, got: ${wide.err}`,
    );

    // A board that fits must stay quiet — otherwise the warning is noise.
    writeState(path, {
      width: 600,
      height: 300,
      nodes: [{ id: "a", label: "A", color: "blue", row: 0, col: 0 }],
      edges: [],
    });
    const small = await runCli(path, ["render"]);
    assertEquals(small.code, 0, small.err);
    assert(
      !small.err.includes("raster cap"),
      `unexpected warning: ${small.err}`,
    );
  }));
