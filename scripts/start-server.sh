#!/bin/bash
# 稳健启动：清理旧进程、等端口释放、再启动（避免 EADDRINUSE 竞态）
set -e
cd "$(dirname "$0")/.."

PORT="${SERVER_PORT:-8902}"
PIDS=$(lsof -ti ":$PORT" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "[start-server] 停止旧进程: $PIDS"
  kill $PIDS 2>/dev/null || true
  for _ in $(seq 1 10); do
    lsof -ti ":$PORT" >/dev/null 2>&1 || break
    sleep 1
  done
  lsof -ti ":$PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
  sleep 1
fi

exec pnpm --filter @everyone/server start
