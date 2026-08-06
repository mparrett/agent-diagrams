// Headless driver for the cross-engine parity check. Loads parity-page.html in
// a real browser, waits for it to compare browser metrics against
// tests/parity-deno.json, prints the result, and exits non-zero on mismatch.
//
// Prereqs: dev server running, and `deno run ... tests/parity_deno.js` already
// generated tests/parity-deno.json.
//
// Run:  deno run --allow-net --allow-read --allow-write --allow-env --allow-run \
//         tests/parity_browser.js [url]
//
// CHROME_BIN overrides the browser binary (defaults to macOS Google Chrome).

import { launch } from "@astral/astral";

const url = Deno.args[0] ?? "http://127.0.0.1:8000/tests/parity-page.html";
const path = Deno.env.get("CHROME_BIN") ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await launch({ path, headless: true });
try {
  const page = await browser.newPage();

  // Surface page-side diagnostics so a module/import failure doesn't look like
  // a silent hang.
  page.addEventListener(
    "console",
    (e) => console.error(`[page:${e.detail.type}] ${e.detail.text}`),
  );
  page.addEventListener(
    "pageerror",
    (e) => console.error(`[pageerror] ${e.detail.message ?? e.detail}`),
  );

  await page.goto(url, { waitUntil: "networkidle2" });

  // Poll for the result ourselves with a hard deadline (don't trust an
  // implicit waiter to time out). Round-trip via JSON string — astral serializes
  // a returned object inconsistently, but a string is always faithful.
  const deadline = Date.now() + 25000;
  let result = null;
  while (Date.now() < deadline) {
    const json = await page.evaluate(() =>
      globalThis.__PARITY_RESULT__
        ? JSON.stringify(globalThis.__PARITY_RESULT__)
        : ""
    );
    if (json) {
      result = JSON.parse(json);
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!result) {
    console.error("TIMEOUT: page never set window.__PARITY_RESULT__");
    Deno.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
  Deno.exit(result.pass ? 0 : 1);
} finally {
  await browser.close();
}
