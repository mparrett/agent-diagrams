# agent-diagrams — task runner

port    := "7787"
host    := "127.0.0.1"
session := "agent-diagrams"

# List recipes
default:
    @just --list

# Lint source (vendored deps excluded automatically)
lint:
    deno task lint

# Type-check source + tests (the test task runs with --no-check)
check:
    deno task check

# Format source JS in place (scoped via deno.json fmt.include)
fmt:
    deno task fmt

# Verify formatting without writing
fmt-check:
    deno task fmt:check

# Render diagram-state.json -> diagram.png
render:
    deno task render

# Editor↔renderer measurement-parity check. Needs the dev server running
# (`just serve`) and a Chrome (override binary with CHROME_BIN=...).
parity:
    deno task parity:gen
    deno task parity:browser

# Editor saves only what a person placed, and shows what the renderer computes.
# Starts its own server on a temporary board. Needs a Chrome (CHROME_BIN=...).
editor-check:
    deno run -A --unstable-ffi tests/editor_layout_browser.js

# Did the text actually rasterize? Complements `parity`, which only checks
# geometry — a render can solve perfect boxes and draw none of their text.
# No browser or server needed. Exits non-zero if any box lost text.
raster-check state="":
    deno task raster-check {{ if state == "" { "" } else { "--state=" + state } }}

# Can we delete any @gfx/canvas workarounds yet? Pins a throwaway worktree to
# the latest release and re-runs the shadow probe against it. Reports only
# — never touches your tree. See docs/project_notes/upstream-defects.md.
upstream-check:
    deno task upstream-check

# Draw a Deno module graph. Takes an entrypoint or a `deno info --json` dump.
# e.g. `just import-deps dev-server.js "--out=$HOME/.local/share/agent-diagrams/deps"`
import-deps entry args="":
    deno task import:deps {{entry}} {{args}}

# Draw a directory tree. e.g. `just import-tree . "--depth=2 --files"`
import-tree dir args="":
    deno task import:tree {{dir}} {{args}}

# Snapshot diagram.png + state into artifacts/<timestamp>[-label]
capture label="":
    deno task cli capture {{label}}

# Print diagram rev + node/edge/override counts
diagram-status:
    deno task cli status

# Serve the editor + viewer in a dedicated tmux session. Idempotent: if an
# agent-diagrams server already answers on the port, it says so and starts
# nothing; if something else holds the port, or the server fails to start, it
# exits non-zero.
# Optional: `just serve path/to/diagram-state.json` to drive an out-of-repo diagram.
# LAN access (write endpoints are unauthenticated — trusted networks only):
#   just host=0.0.0.0 serve     (or: just serve-lan [state])
serve state="":
    @PORT={{port}} HOST={{host}} SESSION={{session}} STATE={{state}} ./bin/serve.sh

# Serve on all interfaces for LAN access (trusted networks only)
serve-lan state="":
    @just host=0.0.0.0 serve {{state}}

# Stop the serving tmux session; fails if a server started another way still answers
stop:
    @PORT={{port}} HOST={{host}} SESSION={{session}} ./bin/serve.sh stop

# Restart the server (stop, then start fresh)
restart: stop serve

# Attach to the server's tmux session (Ctrl-b d to detach)
attach:
    tmux attach -t={{session}}

# Is the server running? Asks the port, so it finds a server however it was
# started. Exits 1 when nothing answers.
status:
    @PORT={{port}} HOST={{host}} SESSION={{session}} ./bin/serve.sh status

# Tail the server's recent output
logs:
    tmux capture-pane -p -t "={{session}}:" -S -200
