#!/usr/bin/env bash
set -e

# The dev compose mounts the source but overlays anonymous volumes on node_modules /
# bin / obj, so those start empty on a fresh volume. Populate them on first run.

if [ ! -d /workspace/web/node_modules/next ]; then
  echo "[dev-entrypoint] installing web deps (pnpm install)..."
  cd /workspace/web && pnpm install --frozen-lockfile
fi

echo "[dev-entrypoint] restoring backend (dotnet restore)..."
cd /workspace/backend && dotnet restore Evervault.Api/Evervault.Api.csproj

# Hand off to CMD (supervisord).
exec "$@"
