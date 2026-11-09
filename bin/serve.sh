#!/usr/bin/env bash
# Serve agent-diagrams over HTTP (with live reload) in a dedicated tmux session.
#
#   serve.sh [start]   start the server unless one already answers on PORT
#   serve.sh status    exit 0 if an agent-diagrams server answers on PORT
#   serve.sh stop      kill the tmux session, then report anything still serving
#
# Whether a server is up is decided by asking the port (GET /diagrams), never by
# the tmux session name: a server started some other way, or under another
# session name, is still the server, and a session whose server died is not.
#
# Config via env (the justfile sets these):
#   SESSION   tmux session name   (default: agent-diagrams)
#   PORT      listen port         (default: 7787)
#   HOST      bind address        (default: 127.0.0.1; 0.0.0.0 for LAN — unauthenticated!)
#   STATE     diagram-state.json path (default: repo example) — may be out-of-repo
#   AGENT_DIAGRAMS_DIR  boards directory (default: ~/.local/share/agent-diagrams)
set -euo pipefail

MODE="${1:-start}"
SESSION="${SESSION:-agent-diagrams}"
PORT="${PORT:-7787}"
HOST="${HOST:-127.0.0.1}"
STATE="${STATE:-}"
BOARDS_DIR="${AGENT_DIAGRAMS_DIR:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A wildcard bind answers on loopback; a specific address only on itself.
case "$HOST" in 0.0.0.0 | "::") PROBE_HOST=127.0.0.1 ;; *) PROBE_HOST="$HOST" ;; esac
URL="http://$PROBE_HOST:$PORT"
# Startup output outlives a server that dies at once (the tmux pane closes with it).
LOG="${TMPDIR:-/tmp}/agent-diagrams-$PORT.log"

# What is on the port: "ours" (an agent-diagrams server), "other" (something
# else accepted the connection), or "free".
probe() {
  local body code
  body="$(curl -s --max-time 2 -w '\n%{http_code}' "$URL/diagrams" 2>/dev/null)" || true
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ "$code" = "200" ] && [[ "$body" == \[* ]]; then
    echo ours
  elif [ -n "$code" ] && [ "$code" != "000" ]; then
    echo other
  else
    echo free
  fi
}

urls() {
  cat <<EOF
  Editor: http://localhost:$PORT/whiteboard-live.html
  Viewer: http://localhost:$PORT/whiteboard.html
EOF
}

case "$MODE" in
status)
  case "$(probe)" in
  ours)
    echo "running on :$PORT"
    urls
    tmux has-session -t="$SESSION" 2>/dev/null ||
      echo "  (not under tmux session '$SESSION': started another way, so 'just stop' won't stop it)"
    ;;
  other)
    echo "not running: port $PORT is held by something other than agent-diagrams" >&2
    exit 1
    ;;
  free)
    echo "not running on :$PORT"
    tmux has-session -t="$SESSION" 2>/dev/null &&
      echo "  tmux session '$SESSION' exists but nothing answers; see 'just logs'"
    exit 1
    ;;
  esac
  ;;

stop)
  tmux kill-session -t="$SESSION" 2>/dev/null && echo "stopped tmux session '$SESSION'"
  # Give the port a moment to close before deciding something else holds it.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ "$(probe)" = "ours" ] || break
    sleep 0.2
  done
  if [ "$(probe)" = "ours" ]; then
    echo "an agent-diagrams server still answers on :$PORT; it was not started by 'just serve' under tmux session '$SESSION'" >&2
    exit 1
  fi
  ;;

start)
  case "$(probe)" in
  ours)
    echo "Already serving on :$PORT."
    urls
    exit 0
    ;;
  other)
    echo "Error: port $PORT is in use by something other than agent-diagrams. Pick another: just port=7788 serve" >&2
    exit 1
    ;;
  esac
  if tmux has-session -t="$SESSION" 2>/dev/null; then
    echo "Error: tmux session '$SESSION' exists but nothing answers on :$PORT. 'just logs' shows why; 'just restart' starts fresh." >&2
    exit 1
  fi

  STATE_FLAG=""
  [ -n "$STATE" ] && STATE_FLAG="--state=$(printf %q "$STATE")"
  # Passed as a flag: a tmux session takes the tmux server's environment, not this shell's.
  DIR_FLAG=""
  [ -n "$BOARDS_DIR" ] && DIR_FLAG="--diagrams-dir=$(printf %q "$BOARDS_DIR")"
  : >"$LOG"
  tmux new-session -d -s "$SESSION" -c "$ROOT" \
    "deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi dev-server.js --port=$PORT --host=$HOST $STATE_FLAG $DIR_FLAG 2>&1 | tee $(printf %q "$LOG")"

  # Report started only once the server answers; a failed start says so.
  for _ in $(seq 1 60); do
    [ "$(probe)" = "ours" ] && break
    tmux has-session -t="$SESSION" 2>/dev/null || break
    sleep 0.5
  done
  if [ "$(probe)" != "ours" ]; then
    tmux kill-session -t="$SESSION" 2>/dev/null || true
    echo "Error: the server did not come up on :$PORT. Its output:" >&2
    tail -n 20 "$LOG" >&2
    exit 1
  fi
  echo "Started tmux session '$SESSION' → serving $ROOT on $HOST:$PORT (live reload)${STATE:+, state: $STATE}"
  [ "$HOST" != "127.0.0.1" ] && echo "WARNING: bound to $HOST — write endpoints are unauthenticated; anyone on the network can edit." || true
  urls
  echo "  Attach: tmux attach -t=$SESSION   (Ctrl-b d to detach)   |   Stop: just stop"
  ;;

*)
  echo "usage: serve.sh [start|status|stop]" >&2
  exit 2
  ;;
esac
