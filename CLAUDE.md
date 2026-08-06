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

## Stop the server before git operations that touch boards

**`just stop` first, then rebase / checkout / `gh stack sync`.** The server
watches every board and re-renders its PNG whenever a `diagram-state.json`
changes on disk. A `git checkout` of a board file counts, so the watcher writes
the PNG straight back and the working tree is dirty again — git reports
`cannot rebase: You have unstaged changes`, you clean it, and the same files
reappear with no indication why.

Restart with `just serve` afterwards.

Related: when a board has uncommitted edits you need to keep across a rebase,
copy the files aside and checksum them rather than reaching for `git stash` —
the stash stack is shared across every worktree of the repo, so a pop can pick
up an entry from another session.
