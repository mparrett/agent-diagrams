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
      ["set-canvas", "900xtall"],
      ["expand-canvas", "--by=10"],
      ["expand-canvas", "--by=10x10", "--left=5"],
      ["expand-canvas", "--anchor=c", "--left=5"],
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

Deno.test("CLI: set-legend parses entries, auto, and off", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, { nodes: NODES, edges: [] });
    const read = () => JSON.parse(Deno.readTextFileSync(path)).legend;

    let r = await runCli(path, [
      "set-legend",
      "blue=Services",
      "gray:dashed=owner = TBD",
    ]);
    assert(r.code === 0, r.err);
    assertEquals(read(), [
      { color: "blue", label: "Services" },
      { color: "gray", label: "owner = TBD", dash: "dashed" },
    ]);

    r = await runCli(path, ["set-legend", "off"]);
    assert(r.code === 0, r.err);
    assertEquals(read(), false);

    r = await runCli(path, ["set-legend", "auto"]);
    assert(r.code === 0, r.err);
    assertEquals(read(), undefined);

    r = await runCli(path, ["set-legend", "chartreuse=nope"]);
    assert(r.code !== 0, "an unknown color must fail");
    assert(r.err.includes("chartreuse"), r.err);
  }));

Deno.test("CLI: set-box-style and update-node --corners", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, { nodes: NODES, edges: [] });
    const read = () => JSON.parse(Deno.readTextFileSync(path));
    const board = () => {
      const s = read();
      return [s.outlineWidth, s.outlineDash, s.corners];
    };

    let r = await runCli(path, [
      "set-box-style",
      "--outlineWidth=thin",
      "--outlineDash=dashed",
      "--corners=square",
    ]);
    assert(r.code === 0, r.err);
    assertEquals(board(), ["thin", "dashed", "square"]);
    assert(r.out.includes("thin dashed square"), r.out);

    r = await runCli(path, ["set-box-style", "--reset", "--corners=square"]);
    assert(r.code === 0, r.err);
    assertEquals(board(), [undefined, undefined, "square"]);

    r = await runCli(path, ["set-box-style", "--corners=bevel"]);
    assert(r.code !== 0, "an unknown corners token must fail");
    assert(r.err.includes("round, square"), r.err);

    r = await runCli(path, ["set-box-style", "--corner=square"]);
    assert(r.code !== 0, "a typo'd flag must fail");

    r = await runCli(path, ["set-box-style"]);
    assert(r.code !== 0, "no flags must fail");

    r = await runCli(path, [
      "update-node",
      "a",
      "--corners=round",
      "--outlineDash=dotted",
    ]);
    assert(r.code === 0, r.err);
    let a = read().nodes.find((n) => n.id === "a");
    assertEquals([a.corners, a.outlineDash], ["round", "dotted"]);

    r = await runCli(path, ["update-node", "a", "--outlineReset"]);
    assert(r.code === 0, r.err);
    a = read().nodes.find((n) => n.id === "a");
    assertEquals([a.corners, a.outlineDash], [undefined, undefined]);
  }));

Deno.test("CLI: set-edge-style sets and resets the board edge width", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, { nodes: NODES, edges: [] });
    const read = () => JSON.parse(Deno.readTextFileSync(path)).edgeWidth;

    let r = await runCli(path, ["set-edge-style", "--width=thin"]);
    assert(r.code === 0, r.err);
    assertEquals(read(), "thin");
    assert(r.out.includes("edge style: thin"), r.out);

    r = await runCli(path, ["set-edge-style", "--width=hairline"]);
    assert(r.code !== 0, "an unknown width must fail");
    assertEquals(read(), "thin");

    r = await runCli(path, ["set-edge-style", "--widht=thin"]);
    assert(r.code !== 0, "a typo'd flag must fail");

    r = await runCli(path, ["set-edge-style"]);
    assert(r.code !== 0, "no flags must fail");

    r = await runCli(path, ["set-edge-style", "--reset"]);
    assert(r.code === 0, r.err);
    assertEquals(read(), undefined);
  }));

Deno.test("CLI: set-canvas WxH --grow and expand-canvas --by", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, { width: 2400, height: 600, nodes: NODES, edges: [] });
    const size = () => {
      const s = JSON.parse(Deno.readTextFileSync(path));
      return [s.width, s.height];
    };

    let r = await runCli(path, ["set-canvas", "1920x1080", "--grow"]);
    assert(r.code === 0, r.err);
    assertEquals(size(), [2400, 1080]);

    r = await runCli(path, ["set-canvas", "2000", "1000"]);
    assert(r.code === 0, r.err);
    assertEquals(size(), [2000, 1000]);

    r = await runCli(path, ["expand-canvas", "--by=100x200", "--anchor=c"]);
    assert(r.code === 0, r.err);
    assertEquals(size(), [2100, 1200]);
  }));

Deno.test("CLI: group label flags and set-group-style", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, { nodes: NODES, edges: [] });
    const read = () => JSON.parse(Deno.readTextFileSync(path));

    let r = await runCli(path, [
      "add-group",
      "g",
      "G",
      "a",
      "--labelPos=top-inside",
      "--labelSize=16",
    ]);
    assert(r.code === 0, r.err);
    const g = read().groups[0];
    assertEquals([g.labelPos, g.labelSize], ["top-inside", 16]);

    r = await runCli(path, ["update-group", "g", "--labelPos=none"]);
    assert(r.code === 0, r.err);
    assertEquals(read().groups[0].labelPos, undefined);

    r = await runCli(path, ["update-group", "g", "--labelSize=big"]);
    assert(r.code !== 0, "a non-numeric size must fail");

    r = await runCli(path, [
      "set-group-style",
      "--labelPos=bottom-outside",
      "--labelAlign=center",
    ]);
    assert(r.code === 0, r.err);
    assert(r.out.includes("bottom-outside center"), r.out);
    const s = read();
    assertEquals([s.groupLabelPos, s.groupLabelAlign], [
      "bottom-outside",
      "center",
    ]);

    r = await runCli(path, ["set-group-style", "--reset"]);
    assert(r.code === 0, r.err);
    assertEquals(read().groupLabelPos, undefined);

    r = await runCli(path, ["set-group-style"]);
    assert(r.code !== 0, "no flags must fail");
  }));

Deno.test("CLI: set-theme sets and resets the scheme", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, { nodes: NODES, edges: [] });
    const read = () => JSON.parse(Deno.readTextFileSync(path)).theme;

    let r = await runCli(path, ["set-theme", "dawnfox"]);
    assert(r.code === 0, r.err);
    assertEquals(read(), "dawnfox");

    r = await runCli(path, ["set-theme", "reset"]);
    assert(r.code === 0, r.err);
    assertEquals(read(), undefined);

    r = await runCli(path, ["set-theme", "nope"]);
    assert(r.code !== 0, "an unknown theme must fail");
    assert(r.err.includes("dawnfox"), "error should list the themes");
  }));

Deno.test("CLI: add-group / update-group / remove-group round-trip", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, { nodes: NODES, edges: [] });
    const read = () => JSON.parse(Deno.readTextFileSync(path)).groups;

    let r = await runCli(path, [
      "add-group",
      "g",
      "Two boxes",
      "a",
      "b",
      "--color=amber",
    ]);
    assert(r.code === 0, r.err);
    assertEquals(read(), [{
      id: "g",
      nodes: ["a", "b"],
      label: "Two boxes",
      color: "amber",
    }]);

    r = await runCli(path, ["update-group", "g", "--add=c", "--color=none"]);
    assert(r.code === 0, r.err);
    assertEquals(read()[0].nodes, ["a", "b", "c"]);
    assertEquals(read()[0].color, undefined);

    r = await runCli(path, ["add-group", "h", "Bad", "zzz"]);
    assert(r.code !== 0 && r.err.includes("zzz"), r.err);

    r = await runCli(path, ["remove-group", "g"]);
    assert(r.code === 0, r.err);
    assertEquals(read(), undefined);
  }));

Deno.test("CLI: init --empty writes a board with no sample nodes", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    const r = await runCli(path, ["init", "--empty"]);
    assert(r.code === 0, r.err);
    const s = JSON.parse(Deno.readTextFileSync(path));
    assertEquals([s.nodes.length, s.edges.length], [0, 0]);
  }));

// Run the render hint `init` prints, from the directory it was printed in.
async function initAndRunHint(cwd, initArgs) {
  const init = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...PERMS, CLI, ...initArgs, "init"],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(init.stdout);
  assert(init.code === 0, new TextDecoder().decode(init.stderr));
  const hint = out.trim().split("\n").at(-1).trim();
  const [deno, ...rest] = hint.split(/\s+/);
  assert(deno === "deno", `unexpected hint: ${hint}`);
  const run = await new Deno.Command(Deno.execPath(), {
    args: rest,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(run.code === 0, `${hint}\n${new TextDecoder().decode(run.stderr)}`);
  return hint;
}

Deno.test("CLI: init's render hint works from another directory", async () =>
  await withTempDir(async (dir) => {
    await initAndRunHint(dir, []);
    await Deno.stat(`${dir}/diagram.png`);
  }));

Deno.test("CLI: init's render hint in the tool repo keeps --state", async () =>
  await withTempDir(async (dir) => {
    const repo = new URL("..", import.meta.url).pathname;
    const hint = await initAndRunHint(repo, [
      "--state",
      `${dir}/diagram-state.json`,
    ]);
    assert(hint.startsWith("deno task render"), hint);
    await Deno.stat(`${dir}/diagram.png`);
  }));

Deno.test("CLI: node and group ids share one namespace", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      nodes: NODES,
      edges: [],
      groups: [{ id: "g", nodes: ["a"] }],
    });
    const before = Deno.readTextFileSync(path);
    let r = await runCli(path, ["add-node", "g", "G", "blue", "1", "1"]);
    assert(r.code !== 0 && r.err.includes('id "g" is already a group'), r.err);
    r = await runCli(path, ["add-group", "b", "B", "c"]);
    assert(r.code !== 0 && r.err.includes('id "b" is already a node'), r.err);
    assert(Deno.readTextFileSync(path) === before, "state must be unchanged");
  }));

Deno.test("CLI: nested inner groups validate and remove-group promotes", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, { nodes: NODES, edges: [] });
    const read = () => JSON.parse(Deno.readTextFileSync(path)).groups;
    let r = await runCli(path, [
      "add-group",
      "k",
      "K",
      "a",
      "b",
      "--inner",
      "--row=0",
      "--col=0",
    ]);
    assert(r.code === 0, r.err);
    r = await runCli(path, [
      "add-group",
      "ar",
      "AR",
      "k",
      "c",
      "--inner",
      "--row=0",
      "--col=0",
    ]);
    assert(r.code === 0, r.err);
    const before = Deno.readTextFileSync(path);
    r = await runCli(path, ["update-group", "k", "--add=ar"]);
    assert(
      r.code !== 0 && r.err.includes("inner groups form a cycle: k -> ar -> k"),
      r.err,
    );
    r = await runCli(path, ["update-group", "k", "--annotation"]);
    assert(r.code !== 0 && r.err.includes('listed by inner group "ar"'), r.err);
    assert(Deno.readTextFileSync(path) === before, "state must be unchanged");

    r = await runCli(path, ["remove-group", "k"]);
    assert(r.code === 0, r.err);
    assert(r.out.includes(`now read in "ar"'s grid`), r.out);
    assertEquals(read().map((g) => [g.id, g.nodes]), [["ar", ["a", "b", "c"]]]);
  }));

Deno.test("CLI: free-node releases a group pin and a member pin", async () =>
  await withTempDir(async (dir) => {
    const path = `${dir}/diagram-state.json`;
    writeState(path, {
      nodes: NODES,
      edges: [],
      groups: [{ id: "g", layout: "inner", row: 0, col: 0, nodes: ["a"] }],
      layout: { g: { x: 90, y: 90 } },
      innerLayout: { g: { a: { x: 30, y: 0 } } },
      pinned: ["g", "a"],
    });
    const read = () => JSON.parse(Deno.readTextFileSync(path));
    let r = await runCli(path, ["free-node", "g"]);
    assert(r.code === 0 && r.out.includes('Freed "g"'), r.err || r.out);
    r = await runCli(path, ["free-node", "a"]);
    assert(r.code === 0 && r.out.includes('Freed "a"'), r.err || r.out);
    const s = read();
    assertEquals([s.layout, s.innerLayout, s.pinned], [{}, undefined, []]);
  }));
