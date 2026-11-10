import { assert } from "@std/assert";
import { join } from "@std/path";
import { boardsDir, boardStatePath, REPO_DIAGRAMS } from "../diagram-api.js";

function assertEquals(actual, expected, msg = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  assert(a === e, `${msg ? msg + ": " : ""}expected ${e}, got ${a}`);
}

Deno.test("boardStatePath maps examples/ to the repo and the rest to the boards dir", () => {
  assertEquals(
    boardStatePath("examples/basic", "/b"),
    join(REPO_DIAGRAMS, "basic", "diagram-state.json"),
  );
  assertEquals(
    boardStatePath("team/flow", "/b"),
    "/b/team/flow/diagram-state.json",
  );
  let threw = false;
  try {
    boardStatePath("../elsewhere", "/b");
  } catch {
    threw = true;
  }
  assert(threw, "a name climbing out of the boards dir is refused");
});

Deno.test("boardsDir prefers its argument, then AGENT_DIAGRAMS_DIR, then XDG", () => {
  const saved = ["AGENT_DIAGRAMS_DIR", "XDG_DATA_HOME"].map((k) => [
    k,
    Deno.env.get(k),
  ]);
  try {
    Deno.env.set("XDG_DATA_HOME", "/xdg");
    Deno.env.delete("AGENT_DIAGRAMS_DIR");
    assertEquals(boardsDir(), "/xdg/agent-diagrams");
    Deno.env.set("AGENT_DIAGRAMS_DIR", "/env");
    assertEquals(boardsDir(), "/env");
    assertEquals(boardsDir("/arg"), "/arg");
  } finally {
    for (const [k, v] of saved) {
      v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
  }
});

Deno.test("the server keeps the repo's boards read-only and copies them out", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const dir = Deno.makeTempDirSync({ prefix: "agent-diagrams-boards-" });
  const port = 8093;
  // A board linked in from the repo is still the repo's.
  Deno.symlinkSync(join(REPO_DIAGRAMS, "adv-bands"), join(dir, "linked"));
  // Names that sort differently by bytes, by case and by number.
  for (
    const n of [
      "zeta",
      "café",
      "Alpha",
      "board10",
      "cafe",
      "board2",
      "team/flow",
    ]
  ) {
    Deno.mkdirSync(join(dir, n), { recursive: true });
    Deno.writeTextFileSync(
      join(dir, n, "diagram-state.json"),
      JSON.stringify({ nodes: [], edges: [], rev: 0 }),
    );
  }
  const env = { ...Deno.env.toObject() };
  delete env.DIAGRAM_STATE;
  const server = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--unstable-ffi",
      `${root}dev-server.js`,
      `--port=${port}`,
      `--diagrams-dir=${dir}`,
    ],
    cwd: root,
    env,
    clearEnv: true,
    stdout: "null",
    stderr: "null",
  }).spawn();
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const post = (p, body) =>
    fetch(url(p), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const list = async () =>
    Object.fromEntries(
      (await (await fetch(url("/diagrams"))).json()).map((b) => [
        b.name,
        b.readOnly,
      ]),
    );
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await (await fetch(url("/diagrams"))).body?.cancel();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const boards = await list();
    assertEquals(
      Object.keys(boards),
      [
        "default",
        "Alpha",
        "board2",
        "board10",
        "cafe", // before café: equal to the collator, so bytes decide
        "café",
        "linked",
        "team/flow",
        "zeta",
        // diagrams/basic is the zero-config default, listed once as "default".
        "examples/adv-bands",
      ],
      "default, then your boards by name (case-blind, numbers by value), then examples",
    );
    assertEquals(boards["examples/adv-bands"], true, "examples are read-only");
    assertEquals(boards.default, true, "so is the zero-config default");
    assertEquals(boards.linked, true, "and so is one linked in from the repo");

    const repoState = join(REPO_DIAGRAMS, "adv-bands", "diagram-state.json");
    const before = Deno.readTextFileSync(repoState);
    const refused = await post("/d/examples/adv-bands/theme", {
      theme: "dawnfox",
    });
    assertEquals(refused.status, 403, "a write to an example");
    assertEquals(Deno.readTextFileSync(repoState), before, "repo file");

    assertEquals((await post("/d/examples/adv-bands/copy")).body, {
      name: "adv-bands",
    });
    assertEquals((await post("/d/examples/adv-bands/copy")).body, {
      name: "adv-bands-2",
    });
    assertEquals(
      (await post("/d/examples/adv-bands/copy", { name: "adv-bands" })).status,
      409,
      "a name asked for that is taken",
    );
    assertEquals(
      (await post("/d/examples/adv-bands/copy", { name: "../out" })).status,
      400,
      "a name outside the boards dir",
    );
    assertEquals(
      Deno.readTextFileSync(join(dir, "adv-bands", "diagram-state.json")),
      before,
      "the copy is the board as it was",
    );
    assertEquals(
      (await fetch(url("/d/examples/adv-bands/copy"), {
        method: "POST",
        body: "null",
      }))
        .status,
      200,
      "a null body is an empty one",
    );
    assertEquals((await list())["adv-bands"], false, "the copy is writable");

    const made = await post("/new", { name: "team/fresh" });
    assertEquals(made.body, { name: "team/fresh" });
    const fresh = JSON.parse(
      Deno.readTextFileSync(join(dir, "team", "fresh", "diagram-state.json")),
    );
    assertEquals(
      [fresh.title, fresh.nodes, fresh.edges],
      ["fresh", [], []],
      "an empty board titled after its name",
    );
    assertEquals((await list())["team/fresh"], false, "listed and writable");
    assertEquals(
      (await post("/new", { name: "team/fresh" })).status,
      409,
      "a new board never lands on an existing one",
    );
    assertEquals((await post("/new")).status, 400, "a new board needs a name");
    assertEquals(
      (await post("/new", { name: "examples/x" })).status,
      400,
      "nor can it shadow the examples",
    );
    const cli = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--unstable-ffi",
        `${root}diagram-cli.js`,
        `--diagrams-dir=${dir}`,
        "--board",
        "adv-bands",
        "status",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(
      cli.success && new TextDecoder().decode(cli.stdout).startsWith("rev "),
      `the CLI finds the copy by name: ${new TextDecoder().decode(cli.stderr)}`,
    );
    const wrote = await post("/d/adv-bands/theme", {
      theme: "dawnfox",
      baseRev: JSON.parse(before).rev,
    });
    assertEquals(wrote.status, 200, `a write to the copy: ${wrote.body.error}`);
  } finally {
    server.kill();
    await server.status;
    Deno.removeSync(dir, { recursive: true });
  }
});
