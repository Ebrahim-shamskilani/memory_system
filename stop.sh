#!/usr/bin/env bash
# Stop all Manfred V2 services
set -e

echo "Stopping Manfred V2 services..."

kill_port() {
  local PORT=$1
  local LABEL=$2
  local PIDS
  PIDS=$(lsof -ti :"$PORT" 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "Stopping $LABEL (port $PORT)..."
    echo "$PIDS" | xargs kill 2>/dev/null || true
    sleep 1
    # Force-kill anything still on the port
    PIDS=$(lsof -ti :"$PORT" 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
      echo "  Force-killing $LABEL..."
      echo "$PIDS" | xargs kill -9 2>/dev/null || true
    fi
  fi
}

# Stop in order: frontend, backend, chromadb
kill_port 4200 "frontend"
kill_port 3000 "backend"
kill_port 8000 "ChromaDB"

# Also kill any orphan chroma processes not bound to port yet
ORPHAN_CHROMA=$(pgrep -f "chromadb/dist/cli.mjs" 2>/dev/null || true)
if [ -n "$ORPHAN_CHROMA" ]; then
  echo "Killing orphan ChromaDB processes..."
  echo "$ORPHAN_CHROMA" | xargs kill -9 2>/dev/null || true
fi

sleep 1

# Verify
STILL=""
lsof -ti :4200 &>/dev/null && STILL="$STILL :4200"
lsof -ti :3000 &>/dev/null && STILL="$STILL :3000"
lsof -ti :8000 &>/dev/null && STILL="$STILL :8000"

if [ -n "$STILL" ]; then
  echo "WARNING: Ports still in use:$STILL"
else
  echo "All services stopped."
fi
