import { assert } from "@std/assert";

// Fonts registered by an isolate that has since ended must still draw (#34).
// The first registration of a family wins for the whole process, so a Worker
// or test file that registered first used to leave every later render drawing
// from freed memory. Each run is a fresh process: within this one, some other
// test file has already registered the fonts.
const probe = async (mode) => {
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--unstable-ffi",
      new URL("./font-lifetime-probe.js", import.meta.url).pathname,
      mode,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout).trim();
  assert(out.success, new TextDecoder().decode(out.stderr));
  return Number(text);
};

Deno.test("fonts registered by an ended Worker still draw", async () => {
  const alone = await probe("main");
  assert(alone > 0, "the probe draws at all");
  for (let i = 0; i < 3; i++) {
    const after = await probe("worker");
    assert(
      after === alone,
      `run ${
        i + 1
      }: DiagramMono drew ${after} px after the Worker ended, ${alone} without it`,
    );
  }
});
