# CLAUDE.md — backend (.NET 10 Web API)

Guidance for Claude Code when working in the `backend/` codebase.

## Rules

- **After finishing any code change, make sure the build succeeds.** Run
  `dotnet build backend/Evervault.slnx` (or `dotnet build` from `backend/`) and confirm
  it completes without errors. If it fails, read the error log and fix the code until
  the build passes — do not leave the change in a broken state.
