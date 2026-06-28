# EverVault

EverVault — Your Personal Memory AI

## Codebases

This repository contains three independent codebases:

| Folder | Stack | Description |
|---|---|---|
| [`app/`](app/) | Expo (SDK 56, React Native 0.85, React 19.2) | Mobile app |
| [`backend/`](backend/) | .NET 10 (LTS) Web API, controllers | Backend API |
| [`web/`](web/) | Next.js 16 (App Router, React 19.2) | Website |

JavaScript projects use **pnpm**; Node is pinned to **24 LTS** via [`.nvmrc`](.nvmrc).

## Dev commands

```bash
# backend  (.NET 10 Web API)
dotnet run --project backend/Evervault.Api

# web      (Next.js)
cd web && pnpm dev          # http://localhost:3000

# app      (Expo)
cd app && pnpm start        # press w / i / a, or scan the QR with Expo Go
```
