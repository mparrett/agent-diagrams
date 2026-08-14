# agent-diagrams — task runner

port    := "8000"
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

# Did the text actually rasterize? Complements `parity`, which only checks
# geometry — a render can solve perfect boxes and draw none of their text.
# No browser or server needed. Exits non-zero if any box lost text.
raster-check state="":
    deno task raster-check {{ if state == "" { "" } else { "--state=" + state } }}

# Can we delete any @gfx/canvas workarounds yet? Pins a throwaway worktree to
# the latest release and re-runs the glyph-drop canary against it. Reports only
# — never touches your tree. See docs/project_notes/upstream-defects.md.
upstream-check:
    deno task upstream-check
    # The glyph-drop canary asserts an upstream bug still exists, so it is opt-in
    # rather than a CI gate (it does not reproduce on the GitHub runners). This is
    # where it belongs: with the rest of the retest tooling.
    UPSTREAM_CANARY=1 deno test --no-check --allow-all tests/raster-parity.test.js --filter "glyph-drop"

# Draw a Deno module graph. Takes an entrypoint or a `deno info --json` dump.
# e.g. `just import-deps dev-server.js "--out=diagrams/deps"`
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

# Serve the editor + viewer in a dedicated tmux session (idempotent).
# Optional: `just serve path/to/diagram-state.json` to drive an out-of-repo diagram.
# LAN access (write endpoints are unauthenticated — trusted networks only):
#   just host=0.0.0.0 serve     (or: just serve-lan [state])
serve state="":
    @PORT={{port}} HOST={{host}} SESSION={{session}} STATE={{state}} ./bin/serve.sh

# Serve on all interfaces for LAN access (trusted networks only)
serve-lan state="":
    @just host=0.0.0.0 serve {{state}}

# Stop the serving tmux session
stop:
    -tmux kill-session -t={{session}}

# Restart the server (stop, then start fresh)
restart: stop serve

# Attach to the server's tmux session (Ctrl-b d to detach)
attach:
    tmux attach -t={{session}}

# Is the server running?
status:
    @tmux has-session -t={{session}} 2>/dev/null \
        && echo "running -> http://localhost:{{port}}/whiteboard-live.html" \
        || echo "not running"

# Tail the server's recent output
logs:
    tmux capture-pane -p -t "={{session}}:" -S -200
