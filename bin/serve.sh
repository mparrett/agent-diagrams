#!/usr/bin/env bash
# Serve agent-diagrams over HTTP (with live reload) in a dedicated tmux session.
# Idempotent: reuses the session if it already exists, otherwise starts it.
#
# Config via env (the justfile sets these):
#   SESSION   tmux session name   (default: agent-diagrams)
#   PORT      listen port         (default: 8000)
#   HOST      bind address        (default: 127.0.0.1; 0.0.0.0 for LAN — unauthenticated!)
#   STATE     diagram-state.json path (default: repo example) — may be out-of-repo
set -euo pipefail

SESSION="${SESSION:-agent-diagrams}"
PORT="${PORT:-8000}"
HOST="${HOST:-127.0.0.1}"
STATE="${STATE:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if tmux has-session -t="$SESSION" 2>/dev/null; then
  echo "Already serving (tmux session '$SESSION')."
else
  STATE_FLAG=""
  [ -n "$STATE" ] && STATE_FLAG="--state=$STATE"
  tmux new-session -d -s "$SESSION" -c "$ROOT" \
    "deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi dev-server.js --port=$PORT --host=$HOST $STATE_FLAG"
  echo "Started tmux session '$SESSION' → serving $ROOT on $HOST:$PORT (live reload)${STATE:+, state: $STATE}"
  [ "$HOST" != "127.0.0.1" ] && echo "WARNING: bound to $HOST — write endpoints are unauthenticated; anyone on the network can edit." || true
fi

cat <<EOF
  Editor: http://localhost:$PORT/whiteboard-live.html
  Viewer: http://localhost:$PORT/whiteboard.html
  Attach: tmux attach -t=$SESSION   (Ctrl-b d to detach)   |   Stop: just stop
EOF
