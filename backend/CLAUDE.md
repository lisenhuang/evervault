# CLAUDE.md — backend (.NET 10 Web API)

Guidance for Claude Code when working in the `backend/` codebase.

## Rules

- **After finishing any code change, make sure the build succeeds.** Run
  `dotnet build backend/Evervault.slnx` (or `dotnet build` from `backend/`) and confirm
  it completes without errors. If it fails, read the error log and fix the code until
  the build passes — do not leave the change in a broken state.

- **Migrations auto-apply on startup and MUST be backward compatible with the deployed
  prod version.** `Program.cs` runs `db.Database.Migrate()` when the app starts, so every
  EF migration is applied automatically on deploy. Because the new container and the
  currently-running (old) version overlap during rollout, **a migration must not break the
  version still serving traffic, nor existing data.** Follow the expand/contract pattern:
  - **Only additive changes** in a single release: add new tables/columns/indexes; make new
    columns nullable or give them a default; add new endpoints.
  - **Never** drop or rename a column/table, change a column type, or tighten a constraint
    that the deployed version still reads/writes in the same release.
  - To remove or rename something, do it across **two releases** (expand → migrate data/code →
    contract in a later release once the old version is gone).
  - Keep migrations **forward-only** (no destructive `Down` needed in prod); test that
    `make up` on top of an existing `pgdata` volume succeeds without data loss.
