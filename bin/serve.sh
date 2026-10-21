#!/usr/bin/env bash
# Serve agent-diagrams over HTTP (with live reload) in a dedicated tmux session.
# Idempotent: reuses the session if it already exists, otherwise starts it.
#
# Config via env (the justfile sets these):
#   SESSION   tmux session name   (default: agent-diagrams)
#   PORT      listen port         (default: 8000)
#   HOST      bind address        (default: 127.0.0.1; 0.0.0.0 for LAN — unauthenticated!)
#   STATE     diagram-state.json path (default: repo example) — may be out-of-repo
#   AGENT_DIAGRAMS_DIR  boards directory (default: ~/.local/share/agent-diagrams)
set -euo pipefail

SESSION="${SESSION:-agent-diagrams}"
PORT="${PORT:-8000}"
HOST="${HOST:-127.0.0.1}"
STATE="${STATE:-}"
BOARDS_DIR="${AGENT_DIAGRAMS_DIR:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if tmux has-session -t="$SESSION" 2>/dev/null; then
  echo "Already serving (tmux session '$SESSION')."
else
  STATE_FLAG=""
  [ -n "$STATE" ] && STATE_FLAG="--state=$STATE"
  # Passed as a flag: a tmux session takes the tmux server's environment, not this shell's.
  DIR_FLAG=""
  [ -n "$BOARDS_DIR" ] && DIR_FLAG="--diagrams-dir=$BOARDS_DIR"
  tmux new-session -d -s "$SESSION" -c "$ROOT" \
    "deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi dev-server.js --port=$PORT --host=$HOST $STATE_FLAG $DIR_FLAG"
  echo "Started tmux session '$SESSION' → serving $ROOT on $HOST:$PORT (live reload)${STATE:+, state: $STATE}"
  [ "$HOST" != "127.0.0.1" ] && echo "WARNING: bound to $HOST — write endpoints are unauthenticated; anyone on the network can edit." || true
fi

cat <<EOF
  Editor: http://localhost:$PORT/whiteboard-live.html
  Viewer: http://localhost:$PORT/whiteboard.html
  Attach: tmux attach -t=$SESSION   (Ctrl-b d to detach)   |   Stop: just stop
EOF
