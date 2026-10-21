# agent-diagrams — notes for agents

## Serving

**Bind `0.0.0.0` when serving for LAN testing** — the default `127.0.0.1` is
loopback-only, so nothing else on the network (phone, tablet, another machine)
can reach the editor or viewer.

```bash
just serve-lan                  # 0.0.0.0, current board
just serve-lan path/to/diagram-state.json
just host=0.0.0.0 serve         # the same thing, spelled out
```

The write endpoints are **unauthenticated** — anyone who can reach the port can
edit the board. That is the accepted tradeoff on a trusted network; do not use it
on one you do not control.

After editing `diagram-core.js`, `diagram-api.js`, `dev-server.js` or
`themes.js`, run `just restart` — Deno caches modules at process start, so a
running server keeps rendering with the old engine. Editing the `.html`/`.js`
front-end files only needs a browser refresh.

## Your boards vs shipped boards

**Experiment in the boards directory**, outside the repo: `--diagrams-dir` >
`AGENT_DIAGRAMS_DIR` > `$XDG_DATA_HOME/agent-diagrams` >
`~/.local/share/agent-diagrams`. Boards there are named by subpath
(`?d=<name>`, `diagram-cli --board <name>`), and the editor can write them
freely.

Boards under the repo's `diagrams/` are shipped artifacts: they change through
a PR, not through an editor session. The server mounts them read-only as
`examples/<name>`: writes get a 403, the editor opens them in View, and the
server never re-renders their PNGs. To change one, edit it with the CLI
(`--board examples/<name>` or `--state`) or serve it explicitly with
`--state`, which makes that one board writable. "Copy to my boards" in the
editor (`POST /d/<name>/copy`) starts an experiment from one.

This exists because the editor writes whatever it serves. With shipped boards
writable, a human exploring a board and an agent changing the engine were
editing the same files, and board churn stopped being attributable: you could
not tell a real layout change from someone's drag, or from the unstable PNG
output of #10. `diagrams/scratch/` is the older convention for this, still
gitignored, and now served read-only like any other repo board.

## A stale server will re-render a board you serve with `--state`

**Check for other dev servers before trusting a PNG under `diagrams/`:**
`pgrep -fl dev-server.js`. A server started with `--state` on a repo board
re-renders that board's PNG whenever its `diagram-state.json` changes, using
the engine it loaded at startup. After an engine change, a server left running
from an earlier session overwrites a fresh render a moment later with the old
engine's output. `just restart` fixes your own server; for one started by
someone else, build test boards outside `diagrams/` instead.

## Stop the server before git operations that touch boards

**`just stop` first, then rebase / checkout / `gh stack sync`** when the
server was started with `--state` on a repo board. It re-renders that board's
PNG whenever its `diagram-state.json` changes on disk. A `git checkout` of
that board's file counts, so the watcher writes the PNG straight back and the
working tree is dirty again — git reports
`cannot rebase: You have unstaged changes`, you clean it, and the same files
reappear with no indication why.

Restart with `just serve` afterwards.

Related: when a board has uncommitted edits you need to keep across a rebase,
copy the files aside and checksum them rather than reaching for `git stash` —
the stash stack is shared across every worktree of the repo, so a pop can pick
up an entry from another session.
