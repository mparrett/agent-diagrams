#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-run --allow-ffi --unstable-ffi
/**
 * import-python — turn a Python package or project directory into a board.
 *
 * One box per local module; wires are imports between them. Modules with entry
 * points are colored apart and list them: click/typer commands and groups,
 * FastAPI/Flask routes, argparse subcommands, `if __name__ == "__main__"` and
 * `__main__.py`. Depth is BFS distance from those modules (or, with none, from
 * modules nothing imports), so the board reads from what you run to what it
 * leans on.
 *
 *   deno task import:python myapp/ --out=$HOME/.local/share/agent-diagrams/myapp
 *   deno task import:python . --external --max=30
 *
 * Flags:
 *   --out=<dir>            where to write diagram-state.json (default: cwd)
 *   --force                overwrite an existing board there
 *   --external             also draw stdlib and third-party imports as boxes
 *   --max=<n>              keep only the n most-connected local modules
 *   --skip=a,b,c           extra directory names to ignore
 *   --python=<path>        interpreter that parses the code (default: python3)
 *   --per-row=<n>          nodes per row band before wrapping (default: 8)
 *   --width= / --height=   canvas size (default 1600x1000)
 *   --title=
 *   --no-untangle          keep the depth-band layout instead of untangling it
 *
 * Each box lists its entry points and its line count. An empty `__init__.py`
 * that nothing imports is left out: it only marks a directory as a package,
 * and would draw as a box with no wires.
 *
 * Parsing uses Python's own `ast` module in an isolated interpreter
 * (`python3 -I`): the target code is read, never imported or executed. A file
 * that fails to parse is still drawn, in red, and reported on stderr.
 *
 * Module names follow what an import would use: a root with `__init__.py` is
 * itself the package, and a `src/` layout is named from `src/`. Hidden
 * directories and virtualenvs are skipped.
 */

import {
  assignBands,
  boolFlag,
  intFlag,
  parseArgs,
  resolveOut,
  seedBoard,
  settleLayout,
  WIRE_KEY,
  wireStyle,
} from "./import-util.js";

const { flags, positional } = parseArgs(Deno.args);
const [root] = positional;

if (!root) {
  console.error("usage: import-python <dir> [--out=dir] [flags]");
  console.error("       see the header of bin/import-python.js for all flags");
  Deno.exit(1);
}

let isDir = false;
try {
  isDir = Deno.statSync(root).isDirectory;
} catch {
  // reported below
}
if (!isDir) {
  console.error(`${root}: not a directory`);
  Deno.exit(1);
}

const perRow = intFlag(flags, "per-row", 8);
const max = intFlag(flags, "max", Infinity);
const withExternal = boolFlag(flags, "external");
const python = typeof flags.python === "string" ? flags.python : "python3";
const skip = typeof flags.skip === "string" ? flags.skip : "";

// How many entry points a box lists before collapsing the rest into "+N more".
const ENTRY_CAP = 4;

const COLOR = {
  module: "blue",
  entry: "amber",
  unparsed: "red",
  stdlib: "green",
  "third-party": "purple",
};
const LEGEND = {
  entry: "entry point",
  module: "module",
  unparsed: "syntax error",
  stdlib: "stdlib",
  "third-party": "third-party",
};

// ─── Scan ──────────────────────────────────────────────────────
// Runs under the target's interpreter rather than a JS parser: decorators and
// relative imports are exactly where regex and grammar ports go wrong. Kept
// compatible with Python 3.8, since that is what some systems still ship as
// python3. Prints {modules, edges, external, errors} as JSON.
const SCAN = String.raw`
import ast, json, os, sys

SKIP = {"__pycache__", "node_modules", "venv", "env", "build", "dist", "site-packages"}
ROUTE = {"get", "post", "put", "patch", "delete", "head", "options", "route", "api_route", "websocket"}
CLI = {"command", "group"}

root = os.path.abspath(sys.argv[1])
extra_skip = {s for s in (sys.argv[2] if len(sys.argv) > 2 else "").split(",") if s}

def is_pkg_dir(d):
    return os.path.isfile(os.path.join(d, "__init__.py"))

# Where module names are counted from, as sys.path would see it. A root that is
# itself a package names its modules after itself, and after every enclosing
# package (myapp/api/ is myapp.api); a src/ layout is named from src/, so its
# modules match the names other files import them by.
if is_pkg_dir(root):
    prefix, d = [], root
    while is_pkg_dir(d):
        prefix.insert(0, os.path.basename(d))
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    bases = [(root, prefix)]
else:
    bases = [(root, [])]
    src = os.path.join(root, "src")
    if os.path.isdir(src) and not is_pkg_dir(src):
        bases.insert(0, (src, []))

files = {}
for dirpath, dirnames, filenames in os.walk(root):
    # Hidden dirs and virtualenvs (marked by pyvenv.cfg) hold other people's code.
    # The built-in names only skip plain directories: myapp/build/ with an
    # __init__.py is a real subpackage, not build output.
    dirnames[:] = sorted(
        d for d in dirnames
        if d not in extra_skip and not d.startswith(".")
        and not (d in SKIP and not is_pkg_dir(os.path.join(dirpath, d)))
        and not os.path.isfile(os.path.join(dirpath, d, "pyvenv.cfg"))
    )
    # A script run from a plain directory has that directory on sys.path, so
    # its bare imports can name its neighbours.
    script_dir = not is_pkg_dir(dirpath)
    for f in sorted(filenames):
        if not f.endswith(".py"):
            continue
        full = os.path.join(dirpath, f)
        base, prefix = next((b, p) for b, p in bases if full.startswith(b + os.sep))
        parts = os.path.relpath(full, base)[:-3].split(os.sep)
        is_pkg = parts[-1] == "__init__"
        if is_pkg:
            parts = parts[:-1]
        name = ".".join(prefix + parts)
        # A file no import statement could name (my-script.py) has no module name.
        if name and all(p.isidentifier() for p in prefix + parts):
            files[name] = (full, is_pkg, os.path.relpath(full, root), script_dir)

def local(dotted):
    """Longest local module that dotted names or lies inside."""
    parts = dotted.split(".")
    for i in range(len(parts), 0, -1):
        cand = ".".join(parts[:i])
        if cand in files:
            return cand
    return None

def resolve(dotted, relative, near):
    """Local module for an import, trying the importer's own directory second."""
    hit = local(dotted)
    if hit or relative or not near:
        return hit
    hit = local(near + "." + dotted)
    # Only a neighbour counts; falling back to a parent package would be wrong.
    return hit if hit and hit.startswith(near + ".") else None

def const_str(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None

def route_label(attr, call):
    if attr in ("route", "api_route"):
        methods = next((k.value for k in call.keywords if k.arg == "methods"), None)
        names = [const_str(e) for e in getattr(methods, "elts", [])]
        # Flask's route defaults to GET; FastAPI's api_route to every method.
        method = "/".join(n.upper() for n in names if n) or ("GET" if attr == "route" else "ANY")
    elif attr == "websocket":
        method = "WS"
    else:
        method = attr.upper()
    return method + " " + const_str(call.args[0])

def entries_of(tree, name):
    out = []
    if name.split(".")[-1] == "__main__":
        out.append("__main__")
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for dec in node.decorator_list:
                call = dec if isinstance(dec, ast.Call) else None
                func = call.func if call else dec
                if not isinstance(func, ast.Attribute):
                    continue
                attr = func.attr
                path = const_str(call.args[0]) if call and call.args else None
                # The leading "/" is what tells a route from cache.get("key").
                if attr in ROUTE and path and path.startswith("/"):
                    out.append(route_label(attr, call))
                elif attr in CLI:
                    given = path or next(
                        (const_str(k.value) for k in (call.keywords if call else []) if k.arg == "name"), None)
                    # click and typer both name an unnamed command after its function, dashed.
                    out.append(given or node.name.replace("_", "-"))
        elif isinstance(node, ast.If):
            t = node.test
            if isinstance(t, ast.Compare) and len(t.comparators) == 1 and "__main__" not in out:
                # Either way round: __name__ == "__main__" or "__main__" == __name__.
                sides = (t.left, t.comparators[0])
                if (any(isinstance(n, ast.Name) and n.id == "__name__" for n in sides)
                        and any(const_str(n) == "__main__" for n in sides)):
                    out.append("__main__")
        elif isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Attribute) and f.attr == "add_parser" and node.args:
                sub = const_str(node.args[0])
                if sub:
                    out.append(sub)
    return out

# sys.stdlib_module_names arrived in 3.10. Older interpreters locate the module
# instead: find_spec on a top-level name finds it without importing it.
STDLIB = getattr(sys, "stdlib_module_names", None)
if STDLIB is None:
    import importlib.util, sysconfig
    STDLIB_DIR = os.path.realpath(sysconfig.get_paths()["stdlib"])

def is_stdlib(top):
    if STDLIB is not None:
        return top in STDLIB
    if top in sys.builtin_module_names:
        return True
    try:
        spec = importlib.util.find_spec(top)
    except (ImportError, ValueError):
        return False
    origin = os.path.realpath(spec.origin) if spec and spec.origin else ""
    return origin.startswith(STDLIB_DIR) and "site-packages" not in origin

modules, edges, external, errors = [], {}, {}, []
for name, (path, is_pkg, rel, script_dir) in sorted(files.items()):
    try:
        with open(path, "rb") as fh:
            src = fh.read()
        lines = src.count(b"\n") + (1 if src and not src.endswith(b"\n") else 0)
        tree = ast.parse(src, filename=rel)
    except SyntaxError as e:
        errors.append(rel + ":" + str(e.lineno) + ": " + str(e.msg))
        modules.append({"id": name, "path": rel, "entries": [], "lines": lines, "unparsed": True})
        continue
    except (ValueError, RecursionError, OSError) as e:
        errors.append(rel + ": " + str(e))
        modules.append({"id": name, "path": rel, "entries": [], "lines": None, "unparsed": True})
        continue
    # Nothing but an optional docstring: the file only marks a package.
    body = tree.body[1:] if tree.body and isinstance(tree.body[0], ast.Expr) and const_str(tree.body[0].value) is not None else tree.body
    modules.append({"id": name, "path": rel, "entries": entries_of(tree, name), "lines": lines,
                    "empty": is_pkg and not body})
    package = name if is_pkg else name.rpartition(".")[0]
    near = package if script_dir and not is_pkg else ""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            targets = [(a.name, False) for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = package.split(".") if package else []
                # Each level past the first drops one package; dropping the
                # top one too is the error Python raises for climbing too far.
                if node.level - 1 >= len(base):
                    continue
                base = base[: len(base) - (node.level - 1)]
                mod = ".".join(base + ([node.module] if node.module else []))
            else:
                mod = node.module or ""
            if mod == "__future__":
                continue
            # "from pkg import sub" may name a submodule rather than an
            # attribute; local() falls back to pkg itself when it does not.
            targets = [(mod + "." + a.name if mod else a.name, bool(node.level)) for a in node.names]
        else:
            continue
        # One statement counts once per module it reaches, however many names it lists.
        resolved = [(d, relative, resolve(d, relative, near)) for d, relative in targets]
        for to in {to for _, _, to in resolved} - {None, name}:
            edges[(name, to)] = edges.get((name, to), 0) + 1
        # An unresolved relative import is a local file we skipped, not a dependency.
        for top in {d.split(".")[0] for d, relative, to in resolved if not relative and not to}:
            key = (name, top)
            if key not in external:
                external[key] = ["stdlib" if is_stdlib(top) else "third-party", 0]
            external[key][1] += 1

json.dump({
    "modules": modules,
    "edges": [{"from": f, "to": t, "count": c} for (f, t), c in sorted(edges.items())],
    "external": [{"from": f, "name": n, "kind": k, "count": c} for (f, n), (k, c) in sorted(external.items())],
    "errors": errors,
}, sys.stdout)
`;

async function scan() {
  let out;
  try {
    // -I: ignore PYTHON* env vars and keep the cwd and user site off sys.path,
    // so nothing in the target tree can shadow a module the scanner imports.
    out = await new Deno.Command(python, {
      args: ["-I", "-c", SCAN, root, skip],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      console.error(
        `${python} not found — install Python 3, or point --python=<path> at an interpreter`,
      );
      Deno.exit(1);
    }
    throw e;
  }
  if (out.code !== 0) {
    console.error(`${python} failed to scan ${root}:`);
    console.error(new TextDecoder().decode(out.stderr).trim());
    Deno.exit(1);
  }
  return JSON.parse(new TextDecoder().decode(out.stdout));
}

const result = await scan();

if (result.errors.length) {
  console.error(
    `could not parse ${result.errors.length} file${
      result.errors.length === 1 ? "" : "s"
    } (drawn in red):`,
  );
  for (const e of result.errors) console.error(`  ${e}`);
}
if (!result.modules.length) {
  console.error(`no Python modules found under ${root}`);
  Deno.exit(1);
}

// ─── Pick the modules to draw ──────────────────────────────────
const degree = new Map(result.modules.map((m) => [m.id, 0]));
for (const e of result.edges) {
  degree.set(e.from, degree.get(e.from) + 1);
  degree.set(e.to, degree.get(e.to) + 1);
}
// An empty __init__.py with no wires says only "this is a package", which the
// dotted names of its modules already say. Keep it when it is all there is.
const marker = (m) => m.empty && degree.get(m.id) === 0;
const dropped = result.modules.filter(marker);
if (dropped.length === result.modules.length) dropped.length = 0;
const droppedIds = new Set(dropped.map((m) => m.id));
const modules = new Map(
  result.modules.filter((m) => !droppedIds.has(m.id)).map((m) => [m.id, m]),
);

let keep = [...modules.keys()];
if (keep.length > max) {
  keep = keep.sort((a, b) =>
    degree.get(b) - degree.get(a) || a.localeCompare(b)
  )
    .slice(0, max);
}
const keepIds = new Set(keep);

// ─── Depth = BFS level from the entry points ───────────────────
// BFS, not longest path, for the same reason as import-depgraph: import cycles
// are common and would drive longest-path depth up to the module count.
const adj = new Map();
for (const e of result.edges) {
  if (!adj.has(e.from)) adj.set(e.from, []);
  adj.get(e.from).push(e.to);
}
const imported = new Set(result.edges.map((e) => e.to));
let frontier = [...modules.values()].filter((m) => m.entries.length).map((m) =>
  m.id
);
if (!frontier.length) {
  frontier = [...modules.keys()].filter((id) => !imported.has(id));
}
const depth = new Map(frontier.map((id) => [id, 0]));
for (let level = 0; frontier.length; level++) {
  const next = [];
  for (const f of frontier) {
    for (const t of adj.get(f) ?? []) {
      if (depth.has(t)) continue;
      depth.set(t, level + 1);
      next.push(t);
    }
  }
  frontier = next;
}
// Unreachable modules sit past the last level; external boxes below those.
const maxDepth = depth.size ? Math.max(...depth.values()) : 0;
for (const id of modules.keys()) {
  if (!depth.has(id)) depth.set(id, maxDepth + 1);
}

// A size cue, so a 2,000-line module doesn't read the same as a 40-line one.
const linesLabel = (n) =>
  `${n.toLocaleString("en-US")} line${n === 1 ? "" : "s"}`;

const nodes = keep.map((id) => {
  const m = modules.get(id);
  const entries = m.entries.length > ENTRY_CAP
    ? [
      ...m.entries.slice(0, ENTRY_CAP),
      `+${m.entries.length - ENTRY_CAP} more`,
    ]
    : m.entries;
  return {
    id,
    label: id,
    color: m.unparsed
      ? COLOR.unparsed
      : m.entries.length
      ? COLOR.entry
      : COLOR.module,
    details: [
      ...(m.unparsed ? ["syntax error"] : entries),
      ...(m.lines == null ? [] : [linesLabel(m.lines)]),
    ],
    depth: depth.get(id),
  };
});

// External boxes are keyed apart from local ids, which could share a name
// (a local `json.py` and the stdlib json).
const extEdges = [];
if (withExternal) {
  const ext = new Map();
  for (const e of result.external) {
    if (!keepIds.has(e.from)) continue;
    const id = `ext:${e.name}`;
    if (!ext.has(id)) {
      ext.set(id, {
        id,
        label: e.name,
        color: COLOR[e.kind],
        details: [e.kind],
        depth: maxDepth + 2,
      });
    }
    extEdges.push({ from: e.from, to: id, count: e.count });
  }
  nodes.push(...[...ext.values()].sort((a, b) => a.id.localeCompare(b.id)));
}

const bands = assignBands(nodes, (n) => n.depth, perRow);

// ─── Emit ──────────────────────────────────────────────────────
const statePath = resolveOut(flags);
const rootName = Deno.realPathSync(root).split("/").pop();
const entryCount = keep.filter((id) => modules.get(id).entries.length).length;
const d = seedBoard(statePath, {
  title: flags.title ?? `Python imports — ${rootName}`,
  footer:
    `${modules.size} modules → ${keepIds.size} drawn · ${entryCount} with entry points · ${WIRE_KEY}`,
  theme: "afterglow",
  width: intFlag(flags, "width", 1600, { min: 100 }),
  height: intFlag(flags, "height", 1000, { min: 100 }),
});

// Name what each color means; the default legend would just say "amber".
const usedColors = new Set(nodes.map((n) => n.color));
d.setLegend(
  Object.entries(LEGEND)
    .filter(([kind]) => usedColors.has(COLOR[kind]))
    .map(([kind, label]) => ({ color: COLOR[kind], label })),
);

for (const n of nodes) {
  d.addNode(n.id, {
    label: n.label,
    color: n.color,
    details: n.details,
    row: n.row,
    col: n.col,
  });
}

let drawn = 0;
for (const e of [...result.edges, ...extEdges]) {
  if (!keepIds.has(e.from)) continue;
  if (!keepIds.has(e.to) && !e.to.startsWith("ext:")) continue;
  d.addEdge(
    e.from,
    e.to,
    wireStyle(e.count),
    e.count > 1 ? String(e.count) : undefined,
  );
  drawn++;
}

const settled = settleLayout(d, flags);
d.save();
console.log(
  `${statePath}: ${nodes.length} nodes, ${drawn} edges, ${bands} rows`,
);
if (dropped.length) {
  console.log(
    `left out ${dropped.length} empty __init__.py with no imports: ${
      dropped.map((m) => m.id).join(", ")
    }`,
  );
}
console.log(settled);
console.log(`render it with:  deno task cli --state ${statePath} render`);
