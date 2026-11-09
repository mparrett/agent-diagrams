import { assert } from "@std/assert";

function assertEquals(actual, expected, msg = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, msg || `Expected ${e}, got ${a}`);
}

// Runs bin/import-python.js end to end over tests/fixtures/python-app, which
// needs python3 on PATH (CI's ubuntu and macOS runners have it).

const IMPORTER = new URL("../bin/import-python.js", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/python-app", import.meta.url).pathname;

async function importBoard(args, root = FIXTURE) {
  const dir = await Deno.makeTempDir({ prefix: "agent-diagrams-pyimport-" });
  try {
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        "--allow-net",
        "--allow-ffi",
        "--unstable-ffi",
        IMPORTER,
        root,
        `--out=${dir}`,
        ...args,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const err = new TextDecoder().decode(stderr);
    assertEquals(code, 0, err);
    const state = JSON.parse(
      await Deno.readTextFile(`${dir}/diagram-state.json`),
    );
    return { state, out: new TextDecoder().decode(stdout), err };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const byId = (state) => Object.fromEntries(state.nodes.map((n) => [n.id, n]));
const edgeSet = (state) =>
  new Set(state.edges.map((e) => `${e.from} -> ${e.to}`));

Deno.test("import-python: local modules, imports and entry points", async () => {
  const { state, err } = await importBoard([]);
  const nodes = byId(state);

  assertEquals(Object.keys(nodes).sort(), [
    "myapp",
    "myapp.__main__",
    "myapp.api",
    "myapp.api.routes",
    "myapp.api.util",
    "myapp.broken",
    "myapp.cli",
    "myapp.core",
    "myapp.env",
    "myapp.legacy",
    "scripts.helpers",
    "scripts.manage",
    "settings",
  ]);
  // myapp.env is a real subpackage although "env" is a skipped name;
  // scripts.manage reaches its neighbour helpers with a bare `import helpers`;
  // myapp.legacy's `from .. import settings` climbs past the top package, so
  // it draws nothing.
  assertEquals([...edgeSet(state)].sort(), [
    "myapp -> myapp.core",
    "myapp.__main__ -> myapp.cli",
    "myapp.api.routes -> myapp.core",
    "myapp.api.util -> myapp.api.routes",
    "myapp.api.util -> myapp.env",
    "myapp.cli -> myapp.api.routes",
    "myapp.cli -> myapp.core",
    "scripts.manage -> myapp.cli",
    "scripts.manage -> scripts.helpers",
  ]);
  // Two statements in cli.py reach core: a heavier edge, labelled with the count.
  const heavy = state.edges.find((e) =>
    e.from === "myapp.cli" && e.to === "myapp.core"
  );
  assertEquals(heavy.label, "2");

  // Entry points: routes, click commands capped at 4, argparse, __main__.
  assertEquals(nodes["myapp.api.routes"].details, [
    "GET /items",
    "POST /items",
  ]);
  assertEquals(nodes["myapp.cli"].details, [
    "cli",
    "show-config",
    "serve",
    "check",
    "+2 more",
  ]);
  assertEquals(nodes["scripts.manage"].details, [
    "__main__",
    "migrate",
    "seed",
  ]);
  assertEquals(nodes["myapp.__main__"].details, ["__main__"]);
  // Written the other way round: "__main__" == __name__.
  assertEquals(nodes["scripts.helpers"].details, ["__main__"]);
  assertEquals(nodes["myapp.cli"].color, "amber");
  assertEquals(nodes["myapp.core"].color, "blue");

  // Entry modules sit on the top row; what they import sits below.
  assertEquals(nodes["myapp.cli"].row, 0);
  assert(nodes["myapp.core"].row > 0);

  // The syntax error is reported and drawn, not fatal.
  assertEquals(nodes["myapp.broken"].color, "red");
  assert(err.includes("myapp/broken.py:1"), err);

  // External imports stay hidden without --external.
  assert(!state.nodes.some((n) => n.id.startsWith("ext:")));
});

Deno.test("import-python: --external draws stdlib and third-party", async () => {
  const { state } = await importBoard(["--external"]);
  const nodes = byId(state);
  for (const name of ["os", "json", "pathlib", "argparse"]) {
    assertEquals(nodes[`ext:${name}`]?.color, "green", name);
  }
  for (const name of ["click", "fastapi", "yaml"]) {
    assertEquals(nodes[`ext:${name}`]?.color, "purple", name);
  }
  // __future__ is a compiler directive, not a dependency; a script's
  // neighbour is local, not third-party.
  assert(!nodes["ext:__future__"]);
  assert(!nodes["ext:helpers"]);
  const edges = edgeSet(state);
  assert(edges.has("myapp.core -> ext:yaml"));
  assert(edges.has("myapp.api.routes -> ext:fastapi"));
});

Deno.test("import-python: a package root names modules after itself", async () => {
  const { state } = await importBoard([], `${FIXTURE}/myapp`);
  const ids = state.nodes.map((n) => n.id);
  assert(ids.includes("myapp.api.routes"), ids.join(", "));
  assert(!ids.some((id) => id.startsWith("scripts")));
  assert(edgeSet(state).has("myapp.cli -> myapp.core"));
});

Deno.test("import-python: a subpackage root keeps its full name", async () => {
  const { state } = await importBoard(["--external"], `${FIXTURE}/myapp/api`);
  const ids = state.nodes.map((n) => n.id);
  assertEquals(ids.filter((id) => !id.startsWith("ext:")).sort(), [
    "myapp.api",
    "myapp.api.routes",
    "myapp.api.util",
  ]);
  // `from myapp.api import routes` resolves inside the root. myapp.env lies
  // outside it, so it shows as an import of the enclosing package.
  assert(edgeSet(state).has("myapp.api.util -> myapp.api.routes"));
  assert(!ids.includes("ext:routes"));
});

Deno.test("import-python: --max keeps the most-connected modules", async () => {
  const { state } = await importBoard(["--max=3"]);
  assertEquals(state.nodes.map((n) => n.id).sort(), [
    "myapp.api.routes",
    "myapp.cli",
    "myapp.core",
  ]);
  assert(state.edges.every((e) => e.from !== "scripts.manage"));
});

Deno.test("import-python: --skip ignores a directory", async () => {
  const { state } = await importBoard(["--skip=scripts"]);
  assert(!state.nodes.some((n) => n.id.startsWith("scripts")));
});

Deno.test("import-python: a missing interpreter fails clearly", async () => {
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-net",
      "--allow-ffi",
      "--unstable-ffi",
      IMPORTER,
      FIXTURE,
      "--python=no-such-python-interpreter",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(code, 1);
  assert(new TextDecoder().decode(stderr).includes("not found"));
});
