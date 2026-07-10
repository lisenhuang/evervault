# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Rules

- **Do not commit or push to `main` automatically.** Leave committing and pushing
  to `main` for a human to do. You may stage changes, draft commit messages, and
  prepare work, but the human performs the actual commit/push to `main`. If a
  commit or push is needed, ask first.

- **Do not create git branches unless a human explicitly tells you to.** Work on the
  current branch; stage and prepare changes there. Never run `git checkout -b`,
  `git branch`, `git switch -c`, or `git worktree add` on your own initiative — if you
  think a new branch is warranted, ask first and let the human decide. Creating,
  switching, or deleting branches is a human action unless explicitly requested.

- **Production is live — keep every change deploy-compatible.** Prod is published and
  serving real users. A deploy rolls a new app version onto the already-running database
  while the previous version may still be handling requests, so each change must work
  against both the old and new state. Don't break existing API contracts, request/
  response shapes, persisted data formats, or client expectations. Add new fields/
  endpoints rather than changing or removing existing ones; make new parameters optional
  with safe defaults.
  - **DB migrations must be backward compatible (expand → migrate → contract).** A
    migration has to be safe for the *currently deployed* code to run against. Ship only
    additive/widening changes alongside the code that needs them. Do **not**
    `DropColumn`/`DropTable`/`RenameColumn`/`RenameTable` or narrow an `AlterColumn` in the
    same release that stops using it — split it across releases: first deploy code that no
    longer reads/writes the column, then drop it in a *later* migration.
  - If a breaking change is genuinely unavoidable, flag it and propose a migration path
    (versioning, dual-write, or a deprecation window) instead of breaking current clients.

- **Keep READMEs concise.** Documentation — especially README files — must stay short and
  skimmable. Prefer tables, diagrams, and one-liners over prose; don't pad with redundant
  explanation. Add a line only when it earns its place.

- **Minimize human effort; prefer zero-config and automation.** This project is meant to be
  developed and maintained largely by AI with minimal human action. Favor sane defaults and
  automation over steps a human must perform (hand-editing `.env`, managing secrets/passwords,
  SSHing to the server). When choosing an approach, pick the one that needs the least manual
  action. Runtime configuration (e.g. storage credentials) goes through the app UI into the
  DB — not `.env`. Secrets are encrypted in the DB (Data Protection), not stored on disk.

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
