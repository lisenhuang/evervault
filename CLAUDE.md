# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Rules

- **Do not commit or push to `main` automatically.** Leave committing and pushing
  to `main` for a human to do. You may stage changes, draft commit messages, and
  prepare work, but the human performs the actual commit/push to `main`. If a
  commit or push is needed, ask first or create a separate branch.

## Project structure

Three independent codebases live at the repo root (no shared monorepo tooling).
JavaScript projects use **pnpm**; Node is pinned to **24 LTS** via `.nvmrc`.

| Folder | Stack | Version |
|---|---|---|
| `app/` | Expo / React Native | SDK 56, RN 0.85, React 19.2, Expo Router + TS |
| `backend/` | .NET Web API (controllers) | .NET 10 (LTS), TFM `net10.0` |
| `web/` | Next.js | 16.x, App Router, React 19.2, TS, Tailwind |

### Dev commands

| Codebase | Command | Notes |
|---|---|---|
| backend | `dotnet run --project backend/Evervault.Api` | Solution: `backend/Evervault.slnx`. CORS allows the web/app dev origins. |
| web | `cd web && pnpm dev` | http://localhost:3000 |
| app | `cd app && pnpm start` | Expo dev server; press `w`/`i`/`a` or scan the QR. `app/.npmrc` sets `node-linker=hoisted` (required for pnpm + Metro). |
