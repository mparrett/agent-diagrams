import { assert } from "@std/assert";
import {
  embedPngMeta,
  PNG_META_KEYWORD,
  PngMetaError,
  readPngMeta,
} from "../png-meta.js";

// The board travels inside the PNG (issue #48): render embeds the full state,
// read-png and init --from-png get it back. These spawn the CLI, so they cover
// the argument handling as well as the chunk itself.

function assertEquals(actual, expected, msg = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, msg || `Expected ${e}, got ${a}`);
}

// Throws, and (when given) with an error of that class whose message
// includes `text`.
function assertThrows(fn, ErrorClass, text) {
  try {
    fn();
  } catch (e) {
    if (ErrorClass) assert(e instanceof ErrorClass, `wrong error: ${e}`);
    if (text) assert(e.message.includes(text), `message: ${e.message}`);
    return;
  }
  throw new Error("expected a throw");
}

const CLI = new URL("../diagram-cli.js", import.meta.url).pathname;
const PERMS = [
  "--allow-read",
  "--allow-write",
  "--allow-net",
  "--allow-env",
  "--allow-ffi",
  "--unstable-ffi",
];

async function cli(args, cwd) {
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...PERMS, CLI, ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: r.code,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}

async function withTempDir(fn) {
  const dir = await Deno.makeTempDir({ prefix: "agent-diagrams-png-meta-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const BOARD = {
  title: "Checkout → fulfilment",
  rev: 3,
  nodes: [
    { id: "a", label: "Front → door", color: "blue", row: 0, col: 0 },
    {
      id: "b",
      label: "Orders",
      color: "amber",
      details: ["Postgres"],
      shape: "cylinder",
      row: 1,
      col: 0,
    },
  ],
  edges: [{ from: "a", to: "b", style: "dashed", label: "écrit" }],
  groups: [{ id: "g", label: "Core", nodes: ["b"] }],
  notes: [{ x: 300, y: 40, title: "why", text: ["one", "two"] }],
  legend: [{ color: "amber", label: "store" }],
};

// Write BOARD (plus `extra`) into dir and render it; returns the state path.
async function renderBoard(dir, extra = {}, renderArgs = []) {
  const state = `${dir}/diagram-state.json`;
  Deno.writeTextFileSync(state, JSON.stringify({ ...BOARD, ...extra }));
  const r = await cli(["--state", state, "render", ...renderArgs]);
  assert(r.code === 0, r.err);
  return state;
}

Deno.test("read-png prints what export prints, full and structure-only", async () =>
  await withTempDir(async (dir) => {
    const state = await renderBoard(dir);
    for (const mode of [[], ["--structure-only"]]) {
      const exp = await cli(["--state", state, "export", ...mode]);
      const read = await cli(["read-png", `${dir}/diagram.png`, ...mode]);
      assert(exp.code === 0, exp.err);
      assert(read.code === 0, read.err);
      assertEquals(read.out, exp.out, `mode ${mode.join(" ") || "full"}`);
    }
  }));

Deno.test("the structure keeps non-ASCII text and the legend's color names", async () =>
  await withTempDir(async (dir) => {
    await renderBoard(dir);
    const r = await cli([
      "read-png",
      `${dir}/diagram.png`,
      "--structure-only",
    ]);
    assert(r.code === 0, r.err);
    const s = JSON.parse(r.out);
    assertEquals(s.schema, 1);
    assertEquals(s.title, "Checkout → fulfilment");
    assertEquals(s.nodes[0].label, "Front → door");
    assertEquals(s.edges, [
      { from: "a", to: "b", style: "dashed", label: "écrit" },
    ]);
    assertEquals(s.legend, [{ color: "amber", label: "store" }]);
    assertEquals(s.groups, [{ id: "g", label: "Core", nodes: ["b"] }]);
    assertEquals(s.notes, [{ title: "why", lines: ["one", "two"] }]);
    assert(!("layout" in s) && !("rev" in s), "no layout fields");
  }));

Deno.test('"embedMetadata": false leaves no chunk, and read-png exits 1', async () =>
  await withTempDir(async (dir) => {
    await renderBoard(dir, { embedMetadata: false });
    const png = Deno.readFileSync(`${dir}/diagram.png`);
    assertEquals(readPngMeta(png), null);
    const r = await cli(["read-png", `${dir}/diagram.png`]);
    assertEquals(r.code, 1);
    assert(r.err.includes(`no ${PNG_META_KEYWORD} board`), r.err);
    assert(r.err.includes("export"), "points at export: " + r.err);
  }));

Deno.test("render --preview carries the chunk too", async () =>
  await withTempDir(async (dir) => {
    await renderBoard(dir, {}, ["--preview"]);
    const meta = readPngMeta(Deno.readFileSync(`${dir}/diagram.preview.png`));
    assertEquals(meta?.title, BOARD.title);
  }));

Deno.test("init --from-png reproduces the board, and won't overwrite", async () =>
  await withTempDir(async (dir) => {
    const state = await renderBoard(dir);
    const boards = `${dir}/boards`;
    const cwd = `${dir}/cwd`;
    Deno.mkdirSync(cwd);
    const png = `${dir}/diagram.png`;
    const init = (...a) =>
      cli([`--diagrams-dir=${boards}`, ...a, "init", "--from-png", png], cwd);

    let r = await init("--board", "copy");
    assert(r.code === 0, r.err);
    const copy = `${boards}/copy/diagram-state.json`;
    const a = await cli(["--state", state, "export"]);
    const b = await cli(["--state", copy, "export"]);
    assertEquals(b.out, a.out);
    assertEquals([...Deno.readDirSync(cwd)].length, 0, "nothing in the cwd");

    r = await init("--board", "copy");
    assert(r.code !== 0 && r.err.includes("refusing to overwrite"), r.err);
    r = await init("--board", "examples/basic");
    assert(r.code !== 0 && r.err.includes("shipped example"), r.err);
  }));

Deno.test("init --from-png drops an output path that leaves the board", async () =>
  await withTempDir(async (dir) => {
    await renderBoard(dir);
    const png = embedPngMeta(Deno.readFileSync(`${dir}/diagram.png`), {
      ...BOARD,
      output: "../escape.png",
    });
    Deno.writeFileSync(`${dir}/hostile.png`, png);
    const target = `${dir}/new/diagram-state.json`;
    Deno.mkdirSync(`${dir}/new`);
    const r = await cli([
      "--state",
      target,
      "init",
      "--from-png",
      `${dir}/hostile.png`,
    ]);
    assert(r.code === 0, r.err);
    assert(r.err.includes('dropping "output"'), r.err);
    const s = JSON.parse(Deno.readTextFileSync(target));
    assert(!("output" in s), "output removed");
  }));

Deno.test("export and the embedded state leave out rev", async () =>
  await withTempDir(async (dir) => {
    const state = await renderBoard(dir);
    const meta = readPngMeta(Deno.readFileSync(`${dir}/diagram.png`));
    assert(meta && !("rev" in meta), "no rev in the PNG");
    const r = await cli(["--state", state, "export"]);
    assert(!("rev" in JSON.parse(r.out)), "no rev in export");
  }));

Deno.test("init --from-png on a PNG without a board writes nothing", async () =>
  await withTempDir(async (dir) => {
    await renderBoard(dir, { embedMetadata: false });
    const target = `${dir}/new/diagram-state.json`;
    const r = await cli([
      "--state",
      target,
      "init",
      `--from-png=${dir}/diagram.png`,
    ]);
    assertEquals(r.code, 1);
    assertThrows(() => Deno.statSync(`${dir}/new`));
  }));

Deno.test("a chunk with a bad CRC is rejected, not misread", async () =>
  await withTempDir(async (dir) => {
    await renderBoard(dir);
    const png = Deno.readFileSync(`${dir}/diagram.png`);
    // Flip a byte inside our chunk's compressed text.
    const at = new TextDecoder("latin1").decode(png).indexOf(PNG_META_KEYWORD);
    assert(at > 0);
    png[at + PNG_META_KEYWORD.length + 8] ^= 0xff;
    assertThrows(() => readPngMeta(png), PngMetaError, "CRC");
    Deno.writeFileSync(`${dir}/bad.png`, png);
    const r = await cli(["read-png", `${dir}/bad.png`]);
    assertEquals(r.code, 1);
    assert(r.err.includes("CRC"), r.err);
  }));

Deno.test("embedding twice replaces the chunk rather than adding one", async () =>
  await withTempDir(async (dir) => {
    await renderBoard(dir);
    const png = Deno.readFileSync(`${dir}/diagram.png`);
    const again = embedPngMeta(png, { title: "second" });
    assertEquals(readPngMeta(again), { title: "second" });
    const count = (buf) =>
      new TextDecoder("latin1").decode(buf).split(PNG_META_KEYWORD).length - 1;
    assertEquals(count(again), 1);
  }));

Deno.test("readPngMeta rejects input that is not a PNG", () => {
  assertThrows(
    () => readPngMeta(new TextEncoder().encode("not a png")),
    PngMetaError,
  );
});
