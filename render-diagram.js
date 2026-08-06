#!/usr/bin/env -S deno run --allow-write --allow-read --allow-env=DIAGRAM_STATE
// Render a diagram-state.json to PNG.
// State file: --state <path> (or --state=<path>) > DIAGRAM_STATE env >
// ./diagram-state.json in the cwd > the bundled diagrams/example board.
import { Diagram, resolveStatePath } from "./diagram-api.js";
const stateArg = Deno.args.find((a) => a.startsWith("--state="))?.slice(8) ??
  (Deno.args[0] === "--state" || Deno.args[0] === "-s"
    ? Deno.args[1]
    : undefined);
Diagram.load(resolveStatePath(stateArg)).render();
