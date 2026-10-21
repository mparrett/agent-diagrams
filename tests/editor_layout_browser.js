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
// The server snaps frame edges to the 15px grid, so each side can land a cell off.
const FIT_TOL = 2 * 15;
// Auto Layout asks before clearing pins; the modal opens synchronously in the
// click. Fails the run if it did not ask, so the guard itself stays tested.
async function autoLayout(page) {
  const asked = await page.evaluate(`(() => {
    document.getElementById("bAutoLayout").click();
    const open = document.getElementById("confirmModal").style.display === "flex";
    document.getElementById("cmOk").click();
    return open;
  })()`);
  check("Auto Layout asks before clearing pins", asked);
}
// Relative pins as "group/id" strings.
const innerPins = (s) =>
  Object.entries(s.innerLayout ?? {})
    .flatMap(([g, pins]) => Object.keys(pins).map((id) => `${g}/${id}`));
async function solved() {
  const o = await cli("status", "--json");
  const j = JSON.parse(new TextDecoder().decode(o.stdout));
  return Object.fromEntries(
    Object.entries(j.positions).map(([k, v]) => [k, { x: v.x, y: v.y }]),
  );
}

const server = new Deno.Command(Deno.execPath(), {
  args: [
    ...RUN,
    `${root}dev-server.js`,
    `--port=${port}`,
    `--state=${S}`,
    `--diagrams-dir=${dir}/boards`,
  ],
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
  const at = async (hook, id) =>
    JSON.parse(
      await page.evaluate(
        `JSON.stringify(window.__wb.${hook}(${JSON.stringify(id)}))`,
      ),
    );
  const drag = (id, dx, dy) => dragFrom(at("boxCenter", id), dx, dy);
  const dragFrom = async (point, dx, dy) => {
    const c = await point;
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

  await autoLayout(page);
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
  await page.evaluate(`document.getElementById("zoomFit").click()`);
  await wait(200);
  await drag("b", 60, 0);
  s = read();
  check(
    "dragging a member pins it relative to its group",
    same(innerPins(s), ["g/b"]) && !s.layout.b && s.pinned.includes("b"),
    JSON.stringify({ layout: s.layout, innerLayout: s.innerLayout }),
  );
  check(
    "editor matches renderer with an inner group",
    same(await editorBoxes(), await solved()),
  );

  const before = read();
  await page.evaluate(`document.getElementById("bGrowCanvas").click()`);
  await wait(1500);
  s = read();
  check(
    "Expand adds 60px per side without pinning",
    s.width === before.width + 120 && s.height === before.height + 120 &&
      same(s.layout, before.layout) &&
      same(s.innerLayout, before.innerLayout),
    `${before.width}x${before.height} -> ${s.width}x${s.height}`,
  );
  check(
    "editor matches renderer after growing the canvas",
    same(await editorBoxes(), await solved()),
  );

  // Double-clicking the SE handle extends the frame to the view's SE corner.
  // Zoom out until the view reaches past the board's SE corner.
  for (let i = 0; i < 40; i++) {
    const v = JSON.parse(
      await page.evaluate(`(() => {
        const v = window.__wb.getView(), b = window.__wb.boardSize(),
          vp = window.__wb.viewport();
        return JSON.stringify({
          dx: v.panX + vp.w / v.zoom - b.w,
          dy: v.panY + vp.h / v.zoom - b.h,
        });
      })()`),
    );
    if (v.dx > 200 && v.dy > 200) break;
    await page.evaluate(`document.getElementById("zoomOut").click()`);
    await wait(150);
  }
  const se = JSON.parse(
    await page.evaluate(`(() => {
      const v = window.__wb.getView(), b = window.__wb.boardSize(),
        vp = window.__wb.viewport(),
        r = document.getElementById("c").getBoundingClientRect();
      return JSON.stringify({
        x: r.left + (b.w - v.panX) * v.zoom * (r.width / vp.w),
        y: r.top + (b.h - v.panY) * v.zoom * (r.height / vp.h),
        viewW: v.panX + vp.w / v.zoom, viewH: v.panY + vp.h / v.zoom,
      });
    })()`),
  );
  const grown = read();
  // Astral's click({ count: 2 }) sends no dblclick, so dispatch one.
  await page.evaluate(`document.getElementById("c").dispatchEvent(
    new MouseEvent("dblclick", {
      bubbles: true, clientX: ${se.x}, clientY: ${se.y},
    }),
  )`);
  await wait(1500);
  s = read();
  check(
    "double-clicking a corner extends the frame to the view",
    s.width > grown.width && s.height > grown.height &&
      s.width <= se.viewW && s.height <= se.viewH &&
      same(s.layout, grown.layout),
    `${grown.width}x${grown.height} -> ${s.width}x${s.height}, view ${
      Math.round(se.viewW)
    }x${Math.round(se.viewH)}`,
  );

  const center = async () =>
    JSON.parse(
      await page.evaluate(`JSON.stringify(window.__wb.boxCenter("a"))`),
    );
  const zoom = async () =>
    JSON.parse(
      await page.evaluate(`JSON.stringify(window.__wb.getView().zoom)`),
    );
  const big = read(), c0 = await center(), z0 = await zoom();
  await page.evaluate(`document.getElementById("bTrimCanvas").click()`);
  await wait(1500);
  s = read();
  const c1 = await center();
  check(
    "Fit to content trims the frame and leaves the view alone",
    s.width < big.width && await zoom() === z0 &&
      Math.abs(c1.x - c0.x) < 1 && Math.abs(c1.y - c0.y) < 1,
    `${big.width}x${big.height} -> ${s.width}x${s.height}, box ${c0.x},${c0.y} -> ${c1.x},${c1.y}`,
  );

  // Zoomed out past the trimmed board, Fit to view sets the frame to the view.
  const trimmed = read();
  const viewSize = JSON.parse(
    await page.evaluate(`(() => {
      const v = window.__wb.getView(), vp = window.__wb.viewport();
      return JSON.stringify({ w: vp.w / v.zoom, h: vp.h / v.zoom });
    })()`),
  );
  await page.evaluate(`document.getElementById("bExpandCanvas").click()`);
  await wait(1500);
  s = read();
  check(
    "Fit to view sets the frame to the view",
    s.width > trimmed.width && s.height > trimmed.height &&
      Math.abs(s.width - viewSize.w) <= FIT_TOL &&
      Math.abs(s.height - viewSize.h) <= FIT_TOL &&
      same(s.layout, trimmed.layout) &&
      same(await editorBoxes(), await solved()),
    `${trimmed.width}x${trimmed.height} -> ${s.width}x${s.height}, view ${
      Math.round(viewSize.w)
    }x${Math.round(viewSize.h)}`,
  );

  const z = await page.evaluate(
    `JSON.stringify(window.__wb.getView().zoom)`,
  );
  const off = async () =>
    JSON.parse(
      await page.evaluate(`(() => {
        const v = window.__wb.getView(), b = window.__wb.boardSize(),
          vp = window.__wb.viewport();
        return JSON.stringify(Math.hypot(
          v.panX + vp.w / (2 * v.zoom) - b.w / 2,
          v.panY + vp.h / (2 * v.zoom) - b.h / 2,
        ));
      })()`),
    );
  await page.evaluate(`window.__wb.pan(400, -250)`);
  const offBefore = await off();
  await page.evaluate(`document.getElementById("zoomCenter").click()`);
  await wait(200);
  const mid = JSON.parse(
    await page.evaluate(`(() => {
      const v = window.__wb.getView(), b = window.__wb.boardSize(),
        vp = window.__wb.viewport();
      return JSON.stringify({
        dx: v.panX + vp.w / (2 * v.zoom) - b.w / 2,
        dy: v.panY + vp.h / (2 * v.zoom) - b.h / 2,
        zoom: JSON.stringify(v.zoom),
      });
    })()`),
  );
  check(
    "center puts the board frame in the middle of the view",
    offBefore > 100 && Math.abs(mid.dx) < 0.5 && Math.abs(mid.dy) < 0.5 &&
      mid.zoom === z,
    `${Math.round(offBefore)}px off before; after ${JSON.stringify(mid)}`,
  );

  // Stage 2a: a member two levels down is placed by its innermost group.
  await cli("add-group", "low", "Low", "e", "--inner", "--row=0", "--col=0");
  await cli(
    "add-group",
    "mid",
    "Mid",
    "d",
    "low",
    "--inner",
    "--row=6",
    "--col=0",
  );
  await wait(2000);
  await open();
  check(
    "editor matches renderer with nested groups",
    same(await editorBoxes(), await solved()),
  );

  // Stage 2b: members and groups are dragged and pinned.
  await page.evaluate(`document.getElementById("zoomFit").click()`);
  await wait(200);
  const parity = async (name) => {
    const ed = await editorBoxes(), rd = await solved();
    check(
      name,
      same(ed, rd),
      same(ed, rd)
        ? ""
        : `editor ${JSON.stringify(ed)} renderer ${JSON.stringify(rd)}`,
    );
  };
  let prev = read();
  await drag("e", 40, 40);
  s = read();
  check(
    "dragging a member two levels deep pins it under its innermost group",
    same(innerPins(s), [...innerPins(prev), "low/e"]) &&
      same(s.layout, prev.layout),
    JSON.stringify({ layout: s.layout, innerLayout: s.innerLayout }),
  );
  await parity("editor matches renderer after a member drag");

  prev = read();
  await dragFrom(at("groupLabelCenter", "g"), 240, 0);
  s = read();
  check(
    "dragging a root group by its label pins it on the board",
    same(Object.keys(s.layout), [...Object.keys(prev.layout), "g"]) &&
      same(s.innerLayout, prev.innerLayout) && s.pinned.includes("g"),
    JSON.stringify({ layout: s.layout, innerLayout: s.innerLayout }),
  );
  await parity("editor matches renderer after a group drag");

  prev = read();
  await dragFrom(at("groupBorderPoint", "low"), 60, 0);
  s = read();
  check(
    "dragging a child group by its border pins it in its parent",
    same(innerPins(s), [...innerPins(prev), "mid/low"]) &&
      same(s.layout, prev.layout) && s.pinned.includes("low"),
    JSON.stringify({ layout: s.layout, innerLayout: s.innerLayout }),
  );
  await parity("editor matches renderer after a child group drag");

  // A drag still pending when an agent changes the same relative pin.
  await page.evaluate(`window.__wb.holdSaves(true)`);
  await drag("e", 0, 40);
  prev = read();
  prev.innerLayout.low.e = { x: 15, y: 15 };
  prev.rev += 1;
  Deno.writeTextFileSync(S, JSON.stringify(prev, null, 2));
  await wait(2000);
  check(
    "a concurrent change to the same relative pin is a conflict",
    JSON.parse(await page.evaluate(`JSON.stringify(window.__wb.conflicted())`)),
  );
  await page.evaluate(`window.__wb.holdSaves(false)`);
  await wait(1500);

  await autoLayout(page);
  await wait(1500);
  s = read();
  check(
    "Auto Layout clears relative pins too",
    same(s.layout, {}) && innerPins(s).length === 0 && same(s.pinned, []),
    JSON.stringify({ layout: s.layout, innerLayout: s.innerLayout }),
  );
  await parity("editor matches renderer after Auto Layout");

  const dots = async () => {
    await page.evaluate(`document.getElementById("startMarkers").click()`);
    await wait(800);
    return read().startMarkers;
  };
  check(
    "Start markers off saves startMarkers: false",
    await dots() === false,
  );
  check("Start markers on clears it", await dots() === undefined);

  // Untangle: a→f and c→d cross b→e as routed. The search runs on the server;
  // a second request while it runs is turned away.
  const node = (id, row, col) => ({ id, label: id, color: "blue", row, col });
  Deno.writeTextFileSync(
    S,
    JSON.stringify({
      ...read(),
      nodes: [
        node("a", 0, 0),
        node("b", 0, 1),
        node("c", 0, 2),
        node("d", 1, 0),
        node("e", 1, 1),
        node("f", 1, 2),
      ],
      edges: [{ from: "a", to: "f" }, { from: "c", to: "d" }, {
        from: "b",
        to: "e",
      }],
      groups: [],
      layout: {},
      innerLayout: {},
      pinned: [],
      rev: read().rev + 1,
    }),
  );
  const rev0 = read().rev;
  for (let i = 0; i < 50; i++) {
    if (await page.evaluate(`window.__wb.state().rev`) === rev0) break;
    await wait(100);
  }
  // The editor declines while a save is in flight (a reload can start one),
  // so press until the button turns into Stop.
  const busy = await page.evaluate(`(async () => {
    const b = document.getElementById("bUntangle");
    for (let i = 0; i < 50 && b.textContent !== "Stop"; i++) {
      b.click();
      await new Promise((r) => setTimeout(r, 100));
    }
    const r = await fetch("/untangle", {
      method: "POST",
      body: JSON.stringify({ baseRev: ${rev0} }),
    });
    return r.status;
  })()`);
  check("a second untangle while one runs is refused", busy === 409, busy);
  let status = "";
  for (let i = 0; i < 300 && !status.startsWith("untangle"); i++) {
    await wait(200);
    status = await page.evaluate(
      `document.getElementById("status").textContent`,
    );
  }
  check(
    "Untangle removes the crossings in one write",
    status.includes("→ 0 crossings") && read().rev === rev0 + 1,
    `${status}; rev ${read().rev}`,
  );
  await parity("editor matches renderer after Untangle");

  // View: drags pan, Delete does nothing, and the board is never written. A
  // drag made just before switching still saves, rather than waiting in View.
  {
    const c = await at("boxCenter", "b");
    const revBefore = read().rev;
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(c.x + i * 90 / 8, c.y);
      await wait(30);
    }
    await page.mouse.up();
    await page.evaluate(`document.getElementById("bView").click()`);
    await wait(1500);
    check(
      "a drag just before View still saves",
      read().rev > revBefore && "b" in read().layout,
      `rev ${revBefore} -> ${read().rev}`,
    );
  }
  const viewed = read();
  await drag("a", 90, 60);
  await page.keyboard.press("Delete");
  await wait(1500);
  check(
    "View leaves the board alone through a drag and Delete",
    same(read(), viewed),
    `rev ${viewed.rev} -> ${read().rev}`,
  );
  const inertOf = (id) =>
    page.evaluate(`!!document.getElementById("${id}").closest("[inert]")`);
  check(
    "View disables the editing controls but not the UI-only ones",
    await inertOf("bAutoLayout") && await inertOf("themeSelect") &&
      !await inertOf("uiTheme") && !await inertOf("bDrag"),
  );
  await open();
  check(
    "View survives a reload",
    await page.evaluate(
      `document.getElementById("bView").classList.contains("on")`,
    ),
  );
  await page.evaluate(`document.getElementById("bDrag").click()`);
  await drag("a", 90, 0);
  check("Select edits again after View", read().rev > viewed.rev);

  // A repo board opens locked in View, without that becoming this browser's
  // tool, and copies out into the boards directory to edit.
  await page.goto(
    `http://127.0.0.1:${port}/whiteboard-live.html?test=1&d=examples/deps`,
    { waitUntil: "networkidle2" },
  );
  await wait(1200);
  check(
    "an example opens read-only, in View",
    await page.evaluate(`(() => {
      const $ = (id) => document.getElementById(id);
      return $("bView").classList.contains("on") && $("bDrag").disabled &&
        !$("readOnlyNote").hidden && localStorage.getItem("wb.tool") !== "view";
    })()`),
  );
  await page.evaluate(`document.getElementById("bCopyBoard").click()`);
  await wait(2500);
  check(
    "Copy to my boards opens a writable copy",
    await page.evaluate(
      `location.search === "?d=deps" && !document.getElementById("bDrag").disabled`,
    ) && Deno.statSync(`${dir}/boards/deps/diagram-state.json`).isFile,
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
