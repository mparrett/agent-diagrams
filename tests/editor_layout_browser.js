// Headless check that the editor saves only what a person placed, and that what
// it shows matches what the renderer computes from the saved file.
//
// Starts its own dev server on a temporary board, so it never touches a running
// server or a real board. Exits non-zero on any failure.
//
// Run:  just editor-check
//   or  deno run -A --unstable-ffi tests/editor_layout_browser.js [port]
//
// CHROME_BIN overrides the browser binary (defaults to macOS Google Chrome).

import { launch } from "@astral/astral";

const port = Number(Deno.args[0] ?? 8011);
const root = new URL("..", import.meta.url).pathname;
const chrome = Deno.env.get("CHROME_BIN") ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Left unresolved on purpose: on macOS the temp dir is behind a symlink, which
// is how the dev server's live reload was found to miss such boards.
const dir = Deno.makeTempDirSync({ prefix: "agent-diagrams-editor-" });
const S = `${dir}/diagram-state.json`;
Deno.writeTextFileSync(
  S,
  JSON.stringify({
    title: "editor layout check",
    nodes: [
      { id: "a", label: "Alpha", color: "blue", row: 0, col: 0 },
      { id: "b", label: "Beta", color: "green", row: 0, col: 1 },
      { id: "c", label: "Gamma", color: "amber", row: 1, col: 0 },
      { id: "d", label: "Delta", color: "teal", row: 1, col: 1 },
    ],
    edges: [{ from: "a", to: "d", style: "solid" }],
    layout: {},
    rev: 0,
  }),
);

const RUN = ["run", "-A", "--unstable-ffi"];
const cli = (...a) =>
  new Deno.Command(Deno.execPath(), {
    args: [...RUN, `${root}diagram-cli.js`, "--state", S, ...a],
    stdout: "piped",
    stderr: "piped",
  }).output();
const read = () => JSON.parse(Deno.readTextFileSync(S));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function solved() {
  const o = await cli("status", "--json");
  const j = JSON.parse(new TextDecoder().decode(o.stdout));
  return Object.fromEntries(
    Object.entries(j.positions).map(([k, v]) => [k, { x: v.x, y: v.y }]),
  );
}

const server = new Deno.Command(Deno.execPath(), {
  args: [...RUN, `${root}dev-server.js`, `--port=${port}`, `--state=${S}`],
  cwd: root,
  stdout: "null",
  stderr: "null",
}).spawn();

let failed = 0;
function check(name, ok, detail = "") {
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`,
  );
  if (!ok) failed++;
}

const browser = await launch({ path: chrome, headless: true });
try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/diagram-state.json`).then((r) =>
        r.body?.cancel()
      );
      break;
    } catch {
      await wait(100);
    }
  }
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  page.addEventListener("pageerror", (e) => {
    console.log(`[pageerror] ${e.detail.message ?? e.detail}`);
    failed++;
  });
  const open = async () => {
    await page.goto(`http://127.0.0.1:${port}/whiteboard-live.html?test=1`, {
      waitUntil: "networkidle2",
    });
    await wait(1200);
  };
  const drag = async (id, dx, dy) => {
    const c = JSON.parse(
      await page.evaluate(
        `JSON.stringify(window.__wb.boxCenter(${JSON.stringify(id)}))`,
      ),
    );
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(c.x + i * dx / 8, c.y + i * dy / 8);
      await wait(30);
    }
    await page.mouse.up();
    await wait(1500); // debounced save + server write
  };
  const editorBoxes = async () =>
    JSON.parse(await page.evaluate(`JSON.stringify(window.__wb.boxes())`));

  await open();
  // Gamma leaves column 0's auto set when pinned, so its neighbours can shift.
  await drag("c", 300, 0);
  let s = read();
  check(
    "a drag saves only the dragged box",
    same(Object.keys(s.layout), ["c"]) && same(s.pinned, ["c"]),
    `layout ${Object.keys(s.layout)}`,
  );
  check("editor matches renderer", same(await editorBoxes(), await solved()));

  await cli("add-node", "e", "Epsilon", "gray", "2", "0");
  await wait(2000);
  s = read();
  check(
    "an agent's edit keeps the placement",
    same(Object.keys(s.layout), ["c"]) && s.nodes.length === 5,
  );
  {
    const ed = await editorBoxes(), rd = await solved();
    check(
      "editor matches renderer after the edit",
      same(ed, rd),
      same(ed, rd)
        ? ""
        : `editor ${JSON.stringify(ed)} renderer ${JSON.stringify(rd)}`,
    );
  }

  // A board saved before this change has a position for every box.
  const frozen = read();
  frozen.layout = await solved();
  frozen.pinned = [];
  frozen.rev += 1;
  Deno.writeTextFileSync(S, JSON.stringify(frozen, null, 2));
  await wait(1500);
  await open();
  await drag("a", 0, 60);
  s = read();
  check(
    "a drag on a frozen board leaves the rest as they were",
    Object.keys(s.layout).length === 5 && same(s.pinned, ["a"]),
  );
  await page.evaluate(`document.getElementById("bAutoLayoutKeep").click()`);
  await wait(1500);
  s = read();
  check(
    "Auto Layout (keep pins) releases everything but the pin",
    same(Object.keys(s.layout), ["a"]) && same(s.pinned, ["a"]),
    `layout ${Object.keys(s.layout)}`,
  );
  check(
    "editor matches renderer after release",
    same(await editorBoxes(), await solved()),
  );

  await page.evaluate(`document.getElementById("bAutoLayout").click()`);
  await wait(1500);
  s = read();
  check(
    "Auto Layout clears every override",
    same(s.layout, {}) && same(s.pinned, []),
  );

  // Stage 1: an inner group's members are placed by the group.
  await cli(
    "add-group",
    "g",
    "Inner",
    "a",
    "b",
    "--inner",
    "--row=3",
    "--col=0",
  );
  await wait(2000);
  await open();
  await drag("a", 200, 100);
  s = read();
  check("a box in an inner group cannot be dragged", !s.layout.a);
  check(
    "editor matches renderer with an inner group",
    same(await editorBoxes(), await solved()),
  );

  const before = read();
  await page.evaluate(`document.getElementById("bGrowCanvas").click()`);
  await wait(1500);
  s = read();
  check(
    "Grow all sides adds 60px per side without pinning",
    s.width === before.width + 120 && s.height === before.height + 120 &&
      same(s.layout, before.layout),
    `${before.width}x${before.height} -> ${s.width}x${s.height}`,
  );
  check(
    "editor matches renderer after growing the canvas",
    same(await editorBoxes(), await solved()),
  );
} finally {
  await browser.close();
  server.kill();
  await server.status;
  Deno.removeSync(dir, { recursive: true });
}
if (failed) {
  console.log(`${failed} check(s) failed`);
  Deno.exit(1);
}
console.log("all editor layout checks passed");
