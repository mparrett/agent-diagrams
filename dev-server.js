#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net
/**
 * dev-server.js — static file server + live reload + write endpoints.
 *
 * SSE pattern borrowed from misc-tools/mdfeed: an /events stream the pages
 * subscribe to, plus a file watcher that pushes a "reload" event when the
 * diagram changes. The server is a *participant* (a file-writer for the GUI),
 * not the source of truth — the file is.
 *
 *   - Serves the repo over HTTP.
 *   - Watches each board's diagram-state.json; on change re-renders its
 *     diagram.png IN-PROCESS and notifies clients. Also watches diagram.png
 *     (external CLI renders push too).
 *   - POST /layout  : the GUI persists drags / layout passes (CAS via withRetry).
 *   - POST /capture : snapshot diagram.png + state into artifacts/.
 *   - Broadcasts carry {diagram, source, nonce, rev} so a client can ignore
 *     other boards and its own echo.
 *
 * MULTIPLE WHITEBOARDS — a "board" is one diagram-state.json. The server is
 * stateless about content (the file is the source of truth; rev-CAS + lockfile
 * are per-file), so boards are just a name → path registry:
 *   - "default" = the --state file (or, with no --state, a cwd diagram-state.json,
 *     else the bundled diagrams/example board).
 *   - every diagram-state.json under the repo's diagrams/ tree, named by subpath
 *     (e.g. "letgo-io", "letgo-io-phases/1-current"). Rescanned on demand.
 * Board-scoped routes: /d/<name>/{diagram-state.json,diagram.png,layout,node,
 * edge,theme,costs,capture}; GET /diagrams lists boards. Unprefixed routes
 * keep operating on the default board (agents/back-compat). Names are mapped
 * to paths server-side ONLY — clients can never supply a file path.
 *
 * Usage: deno run --allow-read --allow-write --allow-net --allow-env=DIAGRAM_STATE \
 *          dev-server.js [--port=8000] [--host=127.0.0.1] [--state=<path>]
 *
 * State file: --state= > DIAGRAM_STATE env > ./diagram-state.json (cwd) > example.
 * The state file may live OUTSIDE the tool repo: static assets (editor/viewer
 * HTML, JS) are always served from the repo, but each board's state/PNG are
 * served from — and watched in — that board's directory.
 */

import { serveDir } from "@std/http/file-server";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  captureArtifacts,
  Diagram,
  LockBusy,
  resolveStatePath,
  RevConflict,
} from "./diagram-api.js";
import { SCHEMES } from "./themes.js";

const ROOT = dirname(fromFileUrl(import.meta.url));
const PORT = Number(
  (Deno.args.find((a) => a.startsWith("--port=")) || "--port=8000").slice(7),
);
// Unauthenticated write endpoints → loopback by default; opt into LAN exposure
// explicitly with --host=0.0.0.0.
const HOST =
  (Deno.args.find((a) => a.startsWith("--host=")) || "--host=127.0.0.1").slice(
    7,
  );
const STATE_PATH = resolveStatePath(
  Deno.args.find((a) => a.startsWith("--state="))?.slice(8),
);
const STATE_DIR = dirname(STATE_PATH);
const DIAGRAMS_DIR = join(ROOT, "diagrams");

// ─── Board registry ──────────────────────────────────────────────
// name → { name, statePath, stateDir, outputPath, lastRev, suppressPngUntil,
//          pendingNonce }  (the last three are per-board watcher/echo state)
const boards = new Map();

// The PNG filename a board renders to. render() honors state.output, so the
// server must resolve the same path or it serves/watches a stale diagram.png.
function outputNameFor(statePath) {
  try {
    return JSON.parse(Deno.readTextFileSync(statePath)).output || "diagram.png";
  } catch {
    return "diagram.png";
  }
}

function makeBoard(name, statePath) {
  const stateDir = dirname(statePath);
  return {
    name,
    statePath,
    stateDir,
    outputPath: join(stateDir, outputNameFor(statePath)),
    lastRev: 0,
    suppressPngUntil: 0,
    pendingNonce: null,
  };
}

/** (Re)discover boards: the default + every diagram-state.json under diagrams/.
 *  Existing entries are kept (they hold live watcher state). */
function scanBoards() {
  if (!boards.has("default")) {
    boards.set("default", makeBoard("default", STATE_PATH));
  }
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory) {
        walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile && e.name === "diagram-state.json" && rel) {
        const path = join(dir, e.name);
        if (path === STATE_PATH) continue; // that's the default board
        if (!boards.has(rel)) boards.set(rel, makeBoard(rel, path));
      }
    }
  };
  walk(DIAGRAMS_DIR, "");
}

/** Board list for GET /diagrams (rescans so new boards show up live). */
function listBoards() {
  scanBoards();
  return [...boards.values()].map((b) => {
    let title = null, rev = null;
    try {
      const s = JSON.parse(Deno.readTextFileSync(b.statePath));
      title = s.title ?? null;
      rev = s.rev ?? null;
    } catch { /* missing/unreadable — list it anyway */ }
    return { name: b.name, title, rev };
  });
}

const enc = new TextEncoder();
const jsonResp = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// ─── SSE client registry ─────────────────────────────────────────
const clients = new Set();

function broadcast(data = {}) {
  const chunk = enc.encode(`event: reload\ndata: ${JSON.stringify(data)}\n\n`);
  for (const c of clients) {
    try {
      c.enqueue(chunk);
    } catch {
      clients.delete(c);
    }
  }
}

// Keep-alive comment so proxies/browsers don't drop idle streams.
setInterval(() => {
  const ping = enc.encode(": ping\n\n");
  for (const c of clients) {
    try {
      c.enqueue(ping);
    } catch {
      clients.delete(c);
    }
  }
}, 15_000);

// ─── Watch + re-render (per board) ───────────────────────────────
function rerender(board) {
  try {
    const d = Diagram.load(board.statePath);
    d.render(); // reads state, writes png
    board.outputPath = d.outputPath; // state.output may have changed
    board.lastRev = d.rev;
    board.suppressPngUntil = performance.now() + 1000;
  } catch (e) {
    console.error(
      `render failed (${board.name}):`,
      e instanceof Error ? e.message : e,
    );
  }
}

/** Which board does a changed file belong to, and is it state or png? */
function boardForPath(p) {
  for (const b of boards.values()) {
    if (p === b.statePath) return { board: b, kind: "state" };
    if (p === b.outputPath) return { board: b, kind: "png" };
  }
  return null;
}

async function watch() {
  // One watcher covers the default board's dir and the repo diagrams/ tree
  // (recursive, so boards created later are picked up automatically).
  const dirs = DIAGRAMS_DIR.startsWith(STATE_DIR)
    ? [STATE_DIR]
    : [STATE_DIR, DIAGRAMS_DIR];
  const watcher = Deno.watchFs(dirs);
  const pending = new Map(); // board name → Set("state"|"png")
  let timer = null;
  const flush = () => {
    for (const [name, kinds] of pending) {
      const board = boards.get(name);
      if (!board) continue;
      const data = {
        diagram: name,
        rev: board.lastRev,
        nonce: board.pendingNonce,
        source: board.pendingNonce ? "layout" : "file",
      };
      board.pendingNonce = null;
      if (kinds.has("state")) {
        rerender(board); // refreshes png + lastRev
        data.rev = board.lastRev;
        broadcast(data);
      } else if (kinds.has("png")) {
        if (performance.now() < board.suppressPngUntil) continue; // our own write
        broadcast(data); // external render (CLI / just render)
      }
    }
    pending.clear();
  };
  for await (const ev of watcher) {
    let relevant = false;
    for (const p of ev.paths) {
      let hit = boardForPath(p);
      if (
        !hit && p.endsWith("diagram-state.json") && p.startsWith(DIAGRAMS_DIR)
      ) {
        scanBoards(); // a brand-new board appeared — register, then re-match
        hit = boardForPath(p);
      }
      if (!hit) continue;
      if (!pending.has(hit.board.name)) pending.set(hit.board.name, new Set());
      pending.get(hit.board.name).add(hit.kind);
      relevant = true;
    }
    if (!relevant) continue;
    clearTimeout(timer);
    timer = setTimeout(flush, 150); // debounce write bursts
  }
}

// Clamp incoming layout coords to the canvas so a bad drag can't write absurd values.
function clampLayout(layout, d) {
  const { W, H } = d._dims;
  const out = {};
  for (const [id, p] of Object.entries(layout)) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    out[id] = {
      x: Math.max(0, Math.min(W, p.x)),
      y: Math.max(0, Math.min(H, p.y)),
    };
  }
  return out;
}

// ─── Write endpoints — one table, one generic CAS handler ────────
// Each op: validate(body) → error string | null; apply(d, body) mutates the
// freshly-loaded Diagram inside withRetry. Every write is stale-guarded: a
// baseRev older than the disk rev is rejected with 409 rather than applied.
// withRetry's CAS only stops a torn read/write — it does NOT stop a stale tab
// from overwriting a newer label/style/theme it never saw, since these apply
// absolute field values (last-write-wins). The client adopts each write's
// returned rev, so baseRev only lags under genuine concurrent edits.
// domainStatus is the HTTP code for non-concurrency errors (400 where the GUI
// sends user input).
const WRITE_OPS = {
  "/layout": {
    domainStatus: 500,
    validate: (b) =>
      (!b.layout || typeof b.layout !== "object")
        ? "layout (object) required"
        : (b.pinned !== undefined && !Array.isArray(b.pinned))
        ? "pinned (array) required"
        : (b.noteLayout !== undefined &&
            (typeof b.noteLayout !== "object" || b.noteLayout === null))
        ? "noteLayout (object) required"
        : ((b.width !== undefined && !(b.width > 0)) ||
            (b.height !== undefined && !(b.height > 0)))
        ? "width/height must be > 0"
        : null,
    apply: (dd, b) => {
      dd.mergeLayout(clampLayout(b.layout, dd));
      if (b.pinned !== undefined) dd.setPinned(b.pinned); // manual-placement markers ride with the snapshot
      if (b.noteLayout !== undefined) {
        dd.mergeNoteLayout(clampLayout(b.noteLayout, dd)); // note drags ride the same snapshot
      }
      if (b.width !== undefined || b.height !== undefined) {
        dd.setCanvasSize(b.width, b.height); // board bounds B ride the snapshot (auto-grow)
      }
    },
  },
  "/note": {
    domainStatus: 400,
    apply: (dd, b) => {
      if (b.action === "add") {
        const n = b.note || {};
        dd.addNote(n.x, n.y, n.text || [], {
          id: n.id,
          title: n.title,
          color: n.color,
          anchor: n.anchor,
        });
      } else if (b.action === "update") dd.updateNote(b.id, b.fields || {});
      else if (b.action === "remove") dd.removeNote(b.id);
      else if (b.action === "free") dd.freeNote(b.id);
      else if (b.action === "anchor") {
        dd.updateNote(b.id, { anchor: b.anchor ?? null });
      } else throw new Error(`unknown action "${b.action}"`);
    },
  },
  "/node": {
    domainStatus: 400,
    apply: (dd, b) => {
      if (b.action === "add") {
        const n = b.node || {};
        dd.addNode(n.id, {
          label: n.label,
          color: n.color,
          details: n.details || [],
          row: n.row,
          col: n.col,
        });
      } else if (b.action === "update") dd.updateNode(b.id, b.fields || {});
      else if (b.action === "remove") {
        dd.removeNode(b.id, {
          keepEdges: !!b.keepEdges,
          orphanPos: b.orphanPos || null,
        });
      } else throw new Error(`unknown action "${b.action}"`);
    },
  },
  "/edge": {
    domainStatus: 400,
    apply: (dd, b) => {
      if (b.action === "add") {
        const e = b.edge || {};
        return dd.addEdge(e.from, e.to, e.style || "default", e.label, e.id).id; // → new edge id
      } else if (b.action === "update") {
        dd.updateEdge(b.from, b.to, b.fields || {}, b.id);
      } else if (b.action === "remove") dd.removeEdge(b.from, b.to, b.id);
      else if (b.action === "reverse") dd.reverseEdge(b.from, b.to, b.id);
      else if (b.action === "retarget") {
        dd.retargetEdge(b.from, b.to, b.newFrom, b.newTo, b.id);
      } else throw new Error(`unknown action "${b.action}"`);
    },
  },
  "/canvas": {
    domainStatus: 400,
    apply: (dd, b) => {
      if (b.action === "set") dd.setCanvas(b.width, b.height, b.anchor || "nw");
      else if (b.action === "expand") {
        dd.expandCanvas({
          left: b.left,
          right: b.right,
          up: b.up,
          down: b.down,
        });
      } else if (b.action === "fit") dd.fitCanvasToContent(b.margin);
      else if (b.action === "fitRect") dd.fitCanvasToRect(b.rect, b.margin);
      else throw new Error(`unknown action "${b.action}"`);
    },
  },
  "/theme": {
    domainStatus: 500,
    validate: (b) => (!b.theme || !SCHEMES[b.theme]) ? "unknown theme" : null,
    apply: (dd, b) => dd.setTheme(b.theme),
  },
  "/costs": {
    domainStatus: 500,
    validate: (b) =>
      (!b.costs || typeof b.costs !== "object")
        ? "costs (object) required"
        : null,
    apply: (dd, b) => dd.setCosts(b.costs),
  },
  "/fontsize": {
    domainStatus: 400,
    apply: (dd, b) => dd.setFontSize(b.fontSize ?? null), // null/0 → default
  },
  "/connectoranchor": {
    domainStatus: 400,
    apply: (dd, b) => dd.setConnectorAnchor(b.mode ?? null), // "align"|"center"|null
  },
};

async function handleWrite(req, op, board) {
  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResp(400, { error: "invalid JSON" });
  }
  if (typeof body.baseRev !== "number") {
    return jsonResp(400, { error: "baseRev (number) required" });
  }
  const invalid = op.validate?.(body);
  if (invalid) return jsonResp(400, { error: invalid });
  const diskRev = Diagram.diskRev(board.statePath);
  if (body.baseRev < diskRev) {
    return jsonResp(409, {
      error: `stale baseRev ${body.baseRev} < current ${diskRev}`,
      rev: diskRev,
    });
  }
  try {
    let result;
    const d = Diagram.withRetry(board.statePath, (dd) => {
      result = op.apply(dd, body);
    });
    board.pendingNonce = body.nonce ?? null; // the watcher's reload broadcast carries this
    return jsonResp(200, { rev: d.rev, result }); // result: e.g. a new edge's id (edge add)
  } catch (e) {
    const code = (e instanceof RevConflict || e instanceof LockBusy)
      ? 503
      : op.domainStatus;
    return jsonResp(code, { error: String(e?.message ?? e) });
  }
}

// ─── HTTP handler ────────────────────────────────────────────────
async function handler(req) {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/diagrams") {
    return jsonResp(200, listBoards());
  }

  // Resolve the board: /d/<name>/<tail> is board-scoped (<name> may contain
  // slashes — nested dirs under diagrams/ — the tail is always one segment);
  // everything else operates on the default board.
  let board = boards.get("default");
  let tail = url.pathname;
  if (url.pathname.startsWith("/d/")) {
    const segs = url.pathname.slice(3).split("/");
    tail = "/" + (segs.pop() ?? "");
    const name = decodeURIComponent(segs.join("/"));
    board = boards.get(name);
    if (!board) {
      scanBoards(); // created since the last scan?
      board = boards.get(name);
    }
    if (!board) return jsonResp(404, { error: `unknown board "${name}"` });
  }

  if (req.method === "POST" && WRITE_OPS[tail]) {
    return handleWrite(req, WRITE_OPS[tail], board);
  }

  // Snapshot a shareable artifact (png + json).
  if (req.method === "POST" && tail === "/capture") {
    let body = {};
    try {
      body = await req.json();
    } catch { /* empty body ok */ }
    try {
      const out = captureArtifacts(
        board.stateDir,
        body.label,
        undefined,
        board.statePath,
        board.outputPath,
      );
      return jsonResp(200, out);
    } catch (e) {
      return jsonResp(500, { error: String(e?.message ?? e) });
    }
  }

  if (url.pathname === "/events") {
    let ref;
    const stream = new ReadableStream({
      start(controller) {
        ref = controller;
        clients.add(controller);
        controller.enqueue(enc.encode(": connected\n\n"));
      },
      cancel() {
        clients.delete(ref);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  // Solved layout read-back: agents/editor can ask "where did everything land"
  // without rendering a PNG. Mirrors `diagram-cli status --json`.
  if (req.method === "GET" && tail === "/positions") {
    try {
      return jsonResp(200, Diagram.load(board.statePath).solvePositions());
    } catch (e) {
      return jsonResp(500, { error: String(e?.message ?? e) });
    }
  }

  // The diagram itself is served from the board's directory (which may be
  // outside the repo for the default board), never from the repo root.
  if (tail === "/diagram-state.json" || tail === "/diagram.png") {
    const fsPath = tail === "/diagram.png" ? board.outputPath : board.statePath;
    try {
      const data = await Deno.readFile(fsPath);
      return new Response(data, {
        headers: {
          "Content-Type": fsPath.endsWith(".png")
            ? "image/png"
            : "application/json",
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return jsonResp(404, { error: `not found: ${fsPath}` });
    }
  }

  return serveDir(req, { fsRoot: ROOT, quiet: true });
}

scanBoards();
watch();
console.log(
  `agent-diagrams dev server → http://localhost:${PORT}/whiteboard.html (viewer, live)`,
);
console.log(
  `                            http://localhost:${PORT}/whiteboard-live.html (editor)`,
);
console.log(
  `boards: ${[...boards.keys()].join(", ")}  (default → ${STATE_PATH})`,
);
// Binds 127.0.0.1 by default — the write endpoints are unauthenticated. Pass
// --host=0.0.0.0 only if you understand anyone on the network can edit/clobber.
Deno.serve({ hostname: HOST, port: PORT }, handler);
