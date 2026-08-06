#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-ffi --unstable-ffi
/**
 * import-filetree — turn a directory tree into a board.
 *
 * Directories become boxes; with `--files` so do the files under them, colored
 * by extension. Edges are containment, so depth is tree depth. Where
 * import-depgraph exercises the wide-and-shallow shape, this one is
 * deep-and-narrow.
 *
 *   deno task import:tree . --out=diagrams/tree --depth=2 --files
 *
 * Flags:
 *   --out=<dir>            where to write diagram-state.json (default: cwd)
 *   --force                overwrite an existing board there
 *   --depth=<n>            how deep to descend (default: 3)
 *   --files                draw files, not just directories
 *   --per-row=<n>          nodes per row band before wrapping (default: 8)
 *   --skip=a,b,c           extra names to ignore
 *   --width= / --height=   canvas size (default 1600x1400)
 *   --title=
 *
 * Directory boxes are annotated with whatever is not drawn — the file count in
 * dirs-only mode, files hidden at the depth frontier, and the entry count for a
 * directory past `--depth` — so nothing is silently dropped from the picture.
 */

import { basename, resolve } from "@std/path";
import {
  assignBands,
  boolFlag,
  intFlag,
  parseArgs,
  resolveOut,
  seedBoard,
} from "./import-util.js";

const { flags, positional } = parseArgs(Deno.args);
const root = positional[0];

if (!root) {
  console.error("usage: import-filetree <dir> [--out=dir] [flags]");
  console.error(
    "       see the header of bin/import-filetree.js for all flags",
  );
  Deno.exit(1);
}

const maxDepth = intFlag(flags, "depth", 3, { min: 0 });
const perRow = intFlag(flags, "per-row", 8);
const withFiles = boolFlag(flags, "files");

const SKIP = new Set([
  ".git",
  "node_modules",
  "vendor",
  "artifacts",
  ".DS_Store",
  ...(typeof flags.skip === "string" ? flags.skip.split(",") : []),
]);

const COLOR_BY_EXT = {
  ".js": "blue",
  ".ts": "blue",
  ".json": "amber",
  ".jsonc": "amber",
  ".md": "gray",
  ".html": "teal",
  ".css": "teal",
  ".ttf": "purple",
  ".otf": "purple",
  ".png": "pink",
  ".svg": "pink",
};

const nodes = [];
const edges = [];

function walk(dir, id, depth) {
  let entries;
  try {
    entries = [...Deno.readDirSync(dir)].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  } catch (e) {
    console.error(`skipping ${dir}: ${e.message}`);
    return;
  }

  // Past the requested depth the directory box is still drawn (it marks the
  // boundary), so say how much is behind it rather than leaving it looking
  // empty. One extra readDir, and only for frontier directories.
  if (depth > maxDepth) {
    const n = entries.filter((e) => !SKIP.has(e.name)).length;
    if (n) {
      const self = nodes.find((x) => x.id === id);
      if (self) {
        self.details = [`${n} entr${n === 1 ? "y" : "ies"}, not expanded`];
      }
    }
    return;
  }

  const subdirs = [];
  let fileCount = 0;
  let drewFiles = 0;
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    if (e.isDirectory) {
      subdirs.push(e);
      continue;
    }
    fileCount++;
    if (withFiles && depth < maxDepth) {
      drewFiles++;
      const dot = e.name.lastIndexOf(".");
      const ext = dot > 0 ? e.name.slice(dot) : "";
      const kidId = `${id}/${e.name}`;
      nodes.push({
        id: kidId,
        label: e.name,
        color: COLOR_BY_EXT[ext] ?? "gray",
        details: [],
        depth: depth + 1,
      });
      edges.push([id, kidId]);
    }
  }

  // Say what we chose not to draw, so a sparse box isn't mistaken for an empty
  // directory. `--files` still hides files at the depth frontier (they would be
  // one level too deep), so count what went undrawn rather than keying off
  // withFiles — otherwise a frontier directory shows neither children nor a
  // tally, which is exactly the silent drop this line exists to prevent.
  const undrawn = fileCount - drewFiles;
  if (undrawn > 0) {
    const self = nodes.find((n) => n.id === id);
    if (self) self.details = [`${undrawn} file${undrawn === 1 ? "" : "s"}`];
  }

  for (const e of subdirs) {
    const kidId = `${id}/${e.name}`;
    nodes.push({
      id: kidId,
      label: `${e.name}/`,
      color: "green",
      details: [],
      depth: depth + 1,
    });
    edges.push([id, kidId]);
    walk(`${dir}/${e.name}`, kidId, depth + 1);
  }
}

const rootPath = root.replace(/\/+$/, "");
// Resolve before taking the basename: `.` and `..` are the common way to
// invoke this, and naming the root box "." tells the reader nothing.
const rootId = basename(resolve(rootPath)) || rootPath;
nodes.push({
  id: rootId,
  label: `${rootId}/`,
  color: "green",
  details: [],
  depth: 0,
});
walk(rootPath, rootId, 0);

const bands = assignBands(nodes, (n) => n.depth, perRow);

const statePath = resolveOut(flags);
const d = seedBoard(statePath, {
  title: flags.title ??
    `File tree — ${rootId}/ (depth ≤ ${maxDepth}, ${
      withFiles ? "files" : "dirs only"
    })`,
  footer:
    `${nodes.length} nodes · ${edges.length} containment edges · ${bands} rows`,
  theme: "afterglow",
  width: intFlag(flags, "width", 1600, { min: 100 }),
  height: intFlag(flags, "height", 1400, { min: 100 }),
});

for (const n of nodes) {
  d.addNode(n.id, {
    label: n.label,
    color: n.color,
    details: n.details,
    row: n.row,
    col: n.col,
  });
}
for (const [f, t] of edges) d.addEdge(f, t, "thin");

d.save();
console.log(
  `${statePath}: ${nodes.length} nodes, ${edges.length} edges, ${bands} rows`,
);
console.log(`render it with:  deno task cli --state ${statePath} render`);
