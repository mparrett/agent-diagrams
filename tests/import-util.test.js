import { assert } from "@std/assert";
import {
  assignBands,
  boolFlag,
  classifySpecifier,
  intFlag,
  makeCanon,
  parseArgs,
} from "../bin/import-util.js";

function assertEquals(actual, expected, msg = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, msg || `Expected ${e}, got ${a}`);
}

Deno.test("parseArgs splits flags from positionals and keeps '=' in values", () => {
  const { flags, positional } = parseArgs([
    "dev-server.js",
    "--out=diagrams/deps",
    "--files",
    "--title=a=b",
    "extra",
  ]);
  assertEquals(positional, ["dev-server.js", "extra"]);
  assertEquals(flags.out, "diagrams/deps");
  assertEquals(flags.files, true);
  // Splitting on every "=" would truncate this to "a" — titles and URLs
  // legitimately contain one.
  assertEquals(flags.title, "a=b");
});

Deno.test("boolFlag reads --x=false as off, not as a truthy string", () => {
  assertEquals(boolFlag({}, "force"), false);
  assertEquals(boolFlag({ force: true }, "force"), true);
  assertEquals(boolFlag({ force: "true" }, "force"), true);
  assertEquals(boolFlag({ force: "1" }, "force"), true);
  // The bug: `!flags.force` on the string "false" is false, so --force=false
  // switched the overwrite guard off.
  assertEquals(boolFlag({ force: "false" }, "force"), false);
  assertEquals(boolFlag({ force: "0" }, "force"), false);
  assertEquals(boolFlag({ force: "no" }, "force"), false);
});

Deno.test("intFlag returns the fallback when absent and parses valid values", () => {
  assertEquals(intFlag({}, "per-row", 8), 8);
  assertEquals(intFlag({ "per-row": "12" }, "per-row"), 12);
  assertEquals(intFlag({ depth: "0" }, "depth", 3, { min: 0 }), 0);
  // A bare `--per-row` with no value falls back rather than becoming NaN.
  assertEquals(intFlag({ "per-row": true }, "per-row", 8), 8);
});

Deno.test("assignBands wraps a wide level into bands and stacks levels", () => {
  const items = [
    { id: "root", d: 0 },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, d: 1 })),
  ];
  const bands = assignBands(items, (it) => it.d, 2);

  // depth 0 → one band; depth 1 → ceil(5/2) = 3 bands.
  assertEquals(bands, 4);
  assertEquals(items[0].row, 0);
  assertEquals(items[0].col, 0);
  // The five depth-1 items land 2 per row, starting at the band after depth 0.
  assertEquals(items.slice(1).map((i) => [i.row, i.col]), [
    [1, 0],
    [1, 1],
    [2, 0],
    [2, 1],
    [3, 0],
  ]);
});

Deno.test("assignBands keeps every item inside the requested row width", () => {
  const items = Array.from(
    { length: 30 },
    (_, i) => ({ id: `n${i}`, d: i % 3 }),
  );
  assignBands(items, (it) => it.d, 4);
  assert(items.every((i) => i.col < 4), "no column may exceed per-row");
  assert(
    items.every((i) => Number.isInteger(i.row) && Number.isInteger(i.col)),
    "row/col must be integers — NaN serializes to null and breaks the board",
  );
});

Deno.test("makeCanon follows a redirect chain to its resolved specifier", () => {
  const canon = makeCanon({
    "jsr:/@std/path@^0.217.0/join": "https://jsr.io/@std/path/0.217.0/join.ts",
    "https://jsr.io/@std/path/0.217.0/join.ts":
      "https://jsr.io/@std/path/0.217.0/posix/join.ts",
  });
  assertEquals(
    canon("jsr:/@std/path@^0.217.0/join"),
    "https://jsr.io/@std/path/0.217.0/posix/join.ts",
  );
  // Unmapped specifiers pass through untouched.
  assertEquals(canon("https://example.com/a.ts"), "https://example.com/a.ts");
});

Deno.test("makeCanon terminates on a cyclic redirect map", () => {
  // The map is data from an external tool; without the `seen` guard a cycle
  // spins forever and the importer hangs with no output.
  const canon = makeCanon({ a: "b", b: "c", c: "a" });
  const out = canon("a");
  assertEquals(["a", "b", "c"].includes(out), true, `got ${out}`);
});

Deno.test("classifySpecifier assigns one color per ecosystem", () => {
  const cwd = "file:///repo/";
  const cases = [
    ["file:///repo/dev-server.js", "blue", "dev-server.js"],
    ["file:///elsewhere/other.js", "blue", "other.js"],
    ["node:fs", "gray", "node:fs"],
    ["https://deno.land/std@0.224.0/http/file_server.ts", "green", "std/http"],
    ["https://jsr.io/@gfx/canvas/0.5.6/mod.ts", "purple", "@gfx/canvas"],
    ["https://deno.land/x/astral@0.5.3/mod.ts", "teal", "x/astral"],
    ["https://example.com/deep/path/mod.ts", "amber", "path/mod.ts"],
  ];
  for (const [spec, color, label] of cases) {
    const got = classifySpecifier(spec, cwd);
    assertEquals(got.color, color, `${spec} color`);
    assertEquals(got.label, label, `${spec} label`);
  }
});

Deno.test("classifySpecifier keeps a repo-local path relative to the cwd", () => {
  const got = classifySpecifier(
    "file:///repo/bin/import-util.js",
    "file:///repo/",
  );
  assertEquals(got.id, "bin/import-util.js");
  assertEquals(got.label, "bin/import-util.js");
});

// resolveOut exits the process on refusal, so it can only be exercised out of
// band. This is the guard that stands between a re-run and a hand-tuned board,
// which makes it the one path here with data-loss consequences.
Deno.test("the importer refuses to clobber an existing board without --force", async () => {
  const dir = await Deno.makeTempDir({ prefix: "agent-diagrams-import-" });
  try {
    const IMPORTER =
      new URL("../bin/import-filetree.js", import.meta.url).pathname;
    const run = async (extra) => {
      const { code, stderr } = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          "--allow-env",
          "--allow-net",
          "--allow-ffi",
          "--unstable-ffi",
          IMPORTER,
          dir,
          `--out=${dir}`,
          "--depth=0",
          ...extra,
        ],
        stdout: "null",
        stderr: "piped",
      }).output();
      return { code, err: new TextDecoder().decode(stderr) };
    };

    const first = await run([]);
    assertEquals(first.code, 0, `first run should succeed: ${first.err}`);
    const board = Deno.readTextFileSync(`${dir}/diagram-state.json`);

    const second = await run([]);
    assertEquals(second.code, 1, "second run must refuse");
    assert(second.err.includes("refusing to overwrite"), second.err);
    assertEquals(
      Deno.readTextFileSync(`${dir}/diagram-state.json`),
      board,
      "the existing board must be left byte-identical",
    );

    // --force is the documented escape hatch and must still work.
    const forced = await run(["--force"]);
    assertEquals(forced.code, 0, `--force should overwrite: ${forced.err}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
