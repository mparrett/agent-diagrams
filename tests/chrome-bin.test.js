import { assert } from "@std/assert";
import { headlessShell } from "./chrome-bin.js";

// Lay out a fake Playwright cache: each revision is [dir, binary path within
// it, whether the install finished].
function fakeCache(revisions) {
  const cache = Deno.makeTempDirSync({ prefix: "agent-diagrams-pwcache-" });
  for (const [rev, bin, complete] of revisions) {
    const dir = `${cache}/chromium_headless_shell-${rev}`;
    const path = `${dir}/${bin}`;
    Deno.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    Deno.writeTextFileSync(path, "");
    if (complete) Deno.writeTextFileSync(`${dir}/INSTALLATION_COMPLETE`, "");
  }
  return cache;
}

Deno.test("headlessShell takes the newest complete install", () => {
  const cache = fakeCache([
    [1200, "chrome-headless-shell-mac-arm64/chrome-headless-shell", true],
    [1250, "chrome-headless-shell-mac-arm64/chrome-headless-shell", true],
    // Newest, but the unpack never finished.
    [1300, "chrome-headless-shell-mac-arm64/chrome-headless-shell", false],
  ]);
  try {
    const bin = headlessShell(cache);
    assert(bin?.includes("chromium_headless_shell-1250/"), `got ${bin}`);
  } finally {
    Deno.removeSync(cache, { recursive: true });
  }
});

Deno.test("headlessShell finds the older chrome-mac/headless_shell layout", () => {
  const cache = fakeCache([[1181, "chrome-mac/headless_shell", true]]);
  try {
    const bin = headlessShell(cache);
    assert(bin?.endsWith("chrome-mac/headless_shell"), `got ${bin}`);
  } finally {
    Deno.removeSync(cache, { recursive: true });
  }
});

Deno.test("headlessShell returns null without a usable cache", () => {
  assert(headlessShell(null) === null);
  assert(headlessShell("/nonexistent/ms-playwright") === null);
});
