#!/usr/bin/env bash
set -e

# The dev compose mounts the source but overlays anonymous volumes on node_modules /
# bin / obj, so those start empty on a fresh volume. Populate them on first run.

# Keep pnpm's content store INSIDE the node_modules anonymous volume, not at the
# project root. Otherwise it lands in /workspace/web/.pnpm-store, which is bind-mounted
# to the host and leaks ~600MB of cache files into web/.
STORE_DIR=/workspace/web/node_modules/.pnpm-store

if [ ! -d /workspace/web/node_modules/next ]; then
  echo "[dev-entrypoint] installing web deps (pnpm install)..."
  cd /workspace/web && pnpm install --frozen-lockfile --store-dir "$STORE_DIR"
fi

echo "[dev-entrypoint] restoring backend (dotnet restore)..."
cd /workspace/backend && dotnet restore Evervault.Api/Evervault.Api.csproj

# Hand off to CMD (supervisord).
exec "$@"
