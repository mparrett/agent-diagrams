#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi
// Render a diagram-state.json to PNG.
// State file: --state <path> (or --state=<path>) > DIAGRAM_STATE env >
// ./diagram-state.json in the cwd > the bundled diagrams/basic board.
import { Diagram, resolveStatePath } from "./diagram-api.js";
const stateArg = Deno.args.find((a) => a.startsWith("--state="))?.slice(8) ??
  (Deno.args[0] === "--state" || Deno.args[0] === "-s"
    ? Deno.args[1]
    : undefined);
Diagram.load(resolveStatePath(stateArg)).render();
