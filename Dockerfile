# syntax=docker/dockerfile:1.7
#
# Single-container image: nginx + Next.js (web) + .NET (backend), run by supervisord.
# Targets:
#   web-build  -> builds the Next.js standalone bundle
#   api-build  -> publishes the .NET Web API
#   prod       -> slim runtime (aspnet) + node + nginx + supervisor (built artifacts)
#   dev        -> SDK + node + pnpm + nginx + supervisor (hot reload, source bind-mounted)

############################################
# Stage: web-build  (Next.js standalone)
############################################
FROM node:24-bookworm-slim AS web-build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /src/web

# Install deps first (better layer caching). Lockfile lives in web/.
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Build the standalone output.
COPY web/ ./
RUN pnpm build
# Produces:
#   .next/standalone/  (server.js + pruned node_modules)
#   .next/static/      (must be copied into standalone/.next/static)
#   public/            (must be copied into standalone/public)

############################################
# Stage: api-build  (.NET publish)
############################################
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS api-build
WORKDIR /src
# Restore against just the project/solution first for caching.
COPY backend/Evervault.slnx ./backend/
COPY backend/Evervault.Api/Evervault.Api.csproj ./backend/Evervault.Api/
RUN dotnet restore backend/Evervault.Api/Evervault.Api.csproj
# Then the rest of the source.
COPY backend/ ./backend/
RUN dotnet publish backend/Evervault.Api/Evervault.Api.csproj \
        -c Release -o /app/api /p:UseAppHost=false

############################################
# Stage: runtime-base  (aspnet + node 24 + nginx + supervisor)
############################################
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg nginx supervisor \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/nginx/sites-enabled/default

############################################
# Stage: prod
############################################
FROM runtime-base AS prod
ENV ASPNETCORE_ENVIRONMENT=Production \
    ASPNETCORE_URLS=http://127.0.0.1:38372 \
    NODE_ENV=production \
    PORT=38373 \
    HOSTNAME=127.0.0.1

WORKDIR /app

# .NET API artifacts.
COPY --from=api-build /app/api /app/api

# Next.js standalone: copy the bundle, then graft static/ and public/ back in
# (standalone intentionally omits both).
COPY --from=web-build /src/web/.next/standalone ./web
COPY --from=web-build /src/web/.next/static ./web/.next/static
COPY --from=web-build /src/web/public ./web/public

# Proxy + process supervisor config.
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/supervisord.prod.conf /etc/supervisor/conf.d/app.conf

EXPOSE 38378
CMD ["supervisord", "-c", "/etc/supervisor/supervisord.conf"]

############################################
# Stage: dev  (SDK + node + pnpm + nginx + supervisor; hot reload)
############################################
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS dev
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates gnupg nginx supervisor \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && rm -f /etc/nginx/sites-enabled/default

ENV ASPNETCORE_ENVIRONMENT=Development \
    ASPNETCORE_URLS=http://127.0.0.1:38372 \
    DOTNET_USE_POLLING_FILE_WATCHER=1 \
    DOTNET_WATCH_RESTART_ON_RUDE_EDIT=1 \
    NODE_ENV=development \
    WATCHPACK_POLLING=true \
    CHOKIDAR_USEPOLLING=true \
    PORT=38373 \
    HOSTNAME=127.0.0.1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /workspace
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/supervisord.dev.conf /etc/supervisor/conf.d/app.conf
COPY docker/dev-entrypoint.sh /usr/local/bin/dev-entrypoint.sh
RUN chmod +x /usr/local/bin/dev-entrypoint.sh

# Source is bind-mounted at runtime (./web, ./backend).
EXPOSE 38378
ENTRYPOINT ["/usr/local/bin/dev-entrypoint.sh"]
CMD ["supervisord", "-c", "/etc/supervisor/supervisord.conf"]
