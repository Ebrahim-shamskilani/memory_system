#!/usr/bin/env bash
# Start all Manfred V2 services
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$ROOT/menfred_V2_backend"
FRONTEND_DIR="$ROOT/menfred-v2-frontend"
LOG_DIR="$ROOT/logs"

mkdir -p "$LOG_DIR"

# ── Pre-flight: kill anything on our ports ──
echo "Cleaning up stale processes..."
"$ROOT/stop.sh" 2>/dev/null || true
sleep 1

# ── 1. Check prerequisites ──
echo ""
echo "Checking prerequisites..."

# Neo4j
if curl -s http://localhost:7474 >/dev/null 2>&1; then
  echo "  Neo4j ........... OK"
else
  echo "  Neo4j ........... NOT RUNNING (expected on :7474)"
  echo "  Start it with: neo4j start"
  exit 1
fi

# Ollama
if curl -s http://localhost:11434/api/version >/dev/null 2>&1; then
  echo "  Ollama .......... OK"
else
  echo "  Ollama .......... NOT RUNNING (expected on :11434)"
  echo "  Start it with: ollama serve"
  exit 1
fi

# ── 2. Build backend ──
echo ""
echo "Building backend..."
cd "$BACKEND_DIR"
npm run build 2>&1 | tail -1

# ── 3. Start backend (ChromaDB auto-starts in managed mode) ──
echo "Starting backend (NestJS + ChromaDB)..."
node dist/src/main.js > "$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
echo "  Backend PID: $BACKEND_PID"

# Wait for backend to be ready
echo "  Waiting for backend on :3000..."
for i in $(seq 1 30); do
  if curl -s http://localhost:3000 >/dev/null 2>&1; then
    echo "  Backend ......... OK"
    break
  fi
  if ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo "  Backend failed to start. Check $LOG_DIR/backend.log"
    exit 1
  fi
  sleep 1
done

if ! curl -s http://localhost:3000 >/dev/null 2>&1; then
  echo "  Backend timed out after 30s. Check $LOG_DIR/backend.log"
  exit 1
fi

# ── 4. Start frontend ──
echo ""
echo "Starting frontend (Angular)..."
cd "$FRONTEND_DIR"
npx ng serve > "$LOG_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!
echo "  Frontend PID: $FRONTEND_PID"

echo "  Waiting for frontend on :4200..."
for i in $(seq 1 30); do
  if curl -s http://localhost:4200 >/dev/null 2>&1; then
    echo "  Frontend ........ OK"
    break
  fi
  if ! kill -0 $FRONTEND_PID 2>/dev/null; then
    echo "  Frontend failed to start. Check $LOG_DIR/frontend.log"
    exit 1
  fi
  sleep 1
done

if ! curl -s http://localhost:4200 >/dev/null 2>&1; then
  echo "  Frontend timed out after 30s. Check $LOG_DIR/frontend.log"
  exit 1
fi

# ── Done ──
echo ""
echo "====================================="
echo "  Manfred V2 is running!"
echo "  Frontend:  http://localhost:4200"
echo "  Backend:   http://localhost:3000"
echo "  Logs:      $LOG_DIR/"
echo "====================================="
echo ""
echo "To stop:  ./stop.sh"
echo "Logs:     tail -f $LOG_DIR/backend.log"
echo "          tail -f $LOG_DIR/frontend.log"
