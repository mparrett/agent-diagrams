#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-run --allow-ffi --unstable-ffi
/**
 * upstream-check — can we delete any @gfx/canvas workarounds yet?
 *
 * Every workaround in docs/project_notes/upstream-defects.md exists because the
 * library is broken in some way we could not fix or, in most cases, even report
 * (no standalone reproduction). They are therefore invisible debt: nothing about
 * a new release announces "the thing you worked around is fixed now".
 *
 * This answers that question on demand. It resolves the latest version on JSR,
 * builds a throwaway git worktree pinned to it, and re-runs the glyph-drop
 * canary probe there — both through the faulty path (which should still lose
 * text) and the production path (which should not). Your working tree is never
 * touched: the pin and the vendor setting are only ever edited inside the
 * worktree.
 *
 * Exit code is 0 whatever it finds — this is a report, not a gate. The gate is
 * the canary in `deno task test`, which fails when the fault disappears.
 *
 *   just upstream-check
 */

const PKG = "@gfx/canvas";
const RENDERS = 10; // matches the canary; the fault is intermittent

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

async function run(cmd, args, cwd) {
  const { code, stdout, stderr } = await new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code, out: dec.decode(stdout), err: dec.decode(stderr) };
}

function pinnedVersion() {
  const cfg = JSON.parse(Deno.readTextFileSync(`${repoRoot}/deno.json`));
  const spec = cfg.imports?.[PKG] ?? "";
  return spec.split("@").pop();
}

async function latestVersion() {
  const res = await fetch(`https://jsr.io/${PKG}/meta.json`);
  if (!res.ok) throw new Error(`JSR metadata lookup failed: ${res.status}`);
  return (await res.json()).latest;
}

/**
 * A git worktree's registration outlives its directory: `rm -rf` leaves it
 * registered and the next `add` at that path dies with "missing but already
 * registered". Always remove + prune before adding, or the second run of this
 * command fails for reasons that look nothing like the real cause.
 */
async function makeWorktree(path) {
  await run("git", ["worktree", "remove", "--force", path], repoRoot);
  try {
    Deno.removeSync(path, { recursive: true });
  } catch { /* not there */ }
  await run("git", ["worktree", "prune"], repoRoot);
  const r = await run(
    "git",
    ["worktree", "add", "--detach", path, "HEAD"],
    repoRoot,
  );
  if (r.code !== 0) throw new Error(`git worktree add failed:\n${r.err}`);
}

async function dropWorktree(path) {
  await run("git", ["worktree", "remove", "--force", path], repoRoot);
  await run("git", ["worktree", "prune"], repoRoot);
}

/** Count how many of N fresh-process renders drew their detail text. */
async function probe(cwd, aliases) {
  let drew = 0;
  for (let i = 0; i < RENDERS; i++) {
    const r = await run(Deno.execPath(), [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-ffi",
      "--unstable-ffi",
      `${cwd}/tests/canary-render.js`,
      ...(aliases ? ["--aliases"] : []),
    ], cwd);
    if (r.out.includes("drew")) drew++;
  }
  return drew;
}

/**
 * How far the box drop shadow lands from its box, at the render DPR and at DPR
 * 1. DPR 1 is the control: the fault is specific to ctx.scale(DPR), so if the
 * control ever reports displacement the probe is broken, not the library.
 */
async function shadowProbe(cwd) {
  const runProbe = async (args) => {
    const r = await run(Deno.execPath(), [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-ffi",
      "--unstable-ffi",
      `${cwd}/tests/shadow-probe.js`,
      ...args,
    ], cwd);
    try {
      return JSON.parse(r.out.trim().split("\n").pop());
    } catch {
      return null;
    }
  };
  return { scaled: await runProbe([]), control: await runProbe(["--dpr1"]) };
}

const pinned = pinnedVersion();
const latest = await latestVersion();
console.log(`${PKG}: pinned ${pinned}, latest on JSR ${latest}`);
if (pinned === latest) {
  console.log(
    "Already on the latest release — re-testing it for the record.\n",
  );
} else {
  console.log(`Testing ${latest} in a throwaway worktree.\n`);
}

const wt = `${repoRoot}/.upstream-check-worktree`;
await makeWorktree(wt);
let report;
try {
  // Pin to latest and un-vendor, so the worktree actually fetches the new
  // release instead of reusing the vendored copy of the old one.
  const cfgPath = `${wt}/deno.json`;
  const cfg = JSON.parse(Deno.readTextFileSync(cfgPath));
  cfg.imports[PKG] = `jsr:${PKG}@${latest}`;
  cfg.vendor = false;
  Deno.writeTextFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  try {
    Deno.removeSync(`${wt}/deno.lock`);
  } catch { /* none */ }

  const faulty = await probe(wt, false);
  const production = await probe(wt, true);
  report = { faulty, production, shadow: await shadowProbe(wt) };
} finally {
  await dropWorktree(wt);
}

const { faulty, production } = report;
console.log("glyph drop — details lost when the layout pass measures with the");
console.log("             same font descriptor the render then draws with");
console.log(`  unaliased (faulty) path : ${faulty}/${RENDERS} renders drew`);
console.log(
  `  production path         : ${production}/${RENDERS} renders drew`,
);
console.log("");

if (faulty === RENDERS) {
  console.log(`VERDICT: the glyph-drop fault looks FIXED in ${latest}.`);
  console.log(
    "  Bump the pin, then delete MEASURE_SUFFIX and its aliases from",
  );
  console.log(
    "  diagram-api.js, the measureFamily branch in computeLayout, the",
  );
  console.log("  measureAliases option, and the canary. Update the README and");
  console.log("  docs/project_notes/upstream-defects.md.");
} else if (production < RENDERS) {
  console.log(
    `VERDICT: the workaround is NOT holding on ${latest} ` +
      `(${production}/${RENDERS}).`,
  );
  console.log("  Do not bump the pin until that is understood.");
} else {
  console.log(
    `VERDICT: still broken in ${latest}; the workaround still works.`,
  );
  console.log(
    "  Nothing to remove. Record the date checked in the ledger.",
  );
}

console.log("");
console.log("shadowBlur displacement — the drop shadow drawn far from its box");
console.log("                          instead of around it, under ctx.scale");
const { scaled, control } = report.shadow;
if (!scaled || !control) {
  console.log(
    "  probe failed to run. The worktree is built from HEAD, so uncommitted",
  );
  console.log(
    "  changes to tests/shadow-probe.js aren't in it — commit them and retry.",
  );
} else {
  console.log(
    `  at render DPR : ${scaled.beyond} px beyond the halo ` +
      `(of ${scaled.changed} the shadow touched)`,
  );
  console.log(
    `  at DPR 1 (ctl): ${control.beyond} px beyond the halo ` +
      `(of ${control.changed})`,
  );
  console.log("");
  if (control.beyond > 0 || control.changed === 0) {
    console.log(
      `VERDICT: the shadow probe is unsound on ${latest} — the DPR 1 control ` +
        `should show a shadow hugging its box. Investigate before trusting ` +
        `the line above.`,
    );
  } else if (scaled.beyond > 500) {
    console.log(
      `VERDICT: still broken in ${latest}; keep { shadow: false }.`,
    );
  } else {
    console.log(`VERDICT: the shadow displacement looks FIXED in ${latest}.`);
    console.log(
      "  Bump the pin, then drop { shadow: false } from the drawBoxes call in",
    );
    console.log(
      "  diagram-api.js, the `shadows` option, and the shadow canary.",
    );
  }
}

console.log("");
console.log("NOT COVERED — no automated canary, needs a human:");
console.log(
  "  * getImageData not reflecting the canvas — raster-check decodes the PNG",
);
console.log(
  "    (nothing depends on it working, so there is nothing to retire)",
);
console.log(
  "  See docs/project_notes/upstream-defects.md for the full ledger.",
);
