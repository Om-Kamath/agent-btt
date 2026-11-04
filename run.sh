#!/usr/bin/env bash
# Installs what's needed, builds the app, and serves it at http://127.0.0.1:8000
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
(cd frontend && { [ -d node_modules ] || npm install; } && npm run build)
cd backend && exec uv run uvicorn margin.main:app --host 127.0.0.1 --port "${PORT:-8000}"
