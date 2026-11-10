// Which browser binary the headless test drivers launch.
//
// Order: CHROME_BIN, then the newest Playwright chrome-headless-shell, then an
// installed Google Chrome. The headless shell comes first because it is a
// plain executable. Google Chrome on macOS copies its .app bundle at every
// launch and deletes the copy only on a clean exit, and astral's
// Browser.close() (0.5.3) sends SIGTERM straight after the CDP close, so each
// run against Google Chrome leaves a copy behind.
//
// Install the shell with `npx playwright install chromium-headless-shell`
// (or `uvx playwright install chromium`, which includes it).

import { join } from "@std/path";

const GOOGLE_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Playwright's browser cache, per its own defaults. */
function playwrightCache() {
  const override = Deno.env.get("PLAYWRIGHT_BROWSERS_PATH");
  // "0" keeps browsers inside each project's node_modules: no shared cache.
  if (override === "0") return null;
  if (override) return override;
  const home = Deno.env.get("HOME");
  if (Deno.build.os === "darwin") {
    return home ? join(home, "Library", "Caches", "ms-playwright") : null;
  }
  const xdg = Deno.env.get("XDG_CACHE_HOME") ||
    (home ? join(home, ".cache") : null);
  return xdg ? join(xdg, "ms-playwright") : null;
}

// Binary paths inside one revision directory: the current layout, then the
// one older Playwright releases used (chrome-mac/, chrome-linux/).
const SHELL_LAYOUTS = [
  [/^chrome-headless-shell-/, "chrome-headless-shell"],
  [/^chrome-(mac|linux)$/, "headless_shell"],
];

const exists = (path) => {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Newest chrome-headless-shell in the Playwright cache, or null. */
export function headlessShell(cache = playwrightCache()) {
  if (!cache) return null;
  let entries;
  try {
    entries = [...Deno.readDirSync(cache)];
  } catch {
    return null;
  }
  // Directories are named chromium_headless_shell-<revision>; newest first.
  const revs = entries
    .map((e) => e.name.match(/^chromium_headless_shell-(\d+)$/))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const [dirName] of revs) {
    const dir = join(cache, dirName);
    // Playwright writes this marker last; without it the unpack was cut short
    // and the binary may be there while its resources are not.
    if (!exists(join(dir, "INSTALLATION_COMPLETE"))) continue;
    let platforms;
    try {
      platforms = [...Deno.readDirSync(dir)];
    } catch {
      continue;
    }
    for (const p of platforms) {
      for (const [pattern, name] of SHELL_LAYOUTS) {
        if (!pattern.test(p.name)) continue;
        const bin = join(dir, p.name, name);
        if (exists(bin)) return bin;
      }
    }
  }
  return null;
}

/** The binary to launch, with a note on stderr when it will leak a copy. */
export function chromeBin() {
  const env = Deno.env.get("CHROME_BIN");
  if (env) return env;
  const shell = headlessShell();
  if (shell) return shell;
  if (Deno.build.os === "darwin") {
    console.error(
      "note: no Playwright chrome-headless-shell found, using Google Chrome, " +
        "which leaves a copy of its app bundle behind on each run. " +
        "Install the shell with `npx playwright install chromium-headless-shell`.",
    );
  }
  return GOOGLE_CHROME;
}
