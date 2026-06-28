# 🔐 EverVault

> **Your Personal Memory AI**

One container. One domain. Web + API behind nginx. 🐳

```
        🌐 Cloudflare  (TLS)
              │  http
              ▼
   ┌─────────────────────────────┐   one docker container
   │   nginx  :38378  (public)   │
   │     ├── /api/* ─▶ ⚙️  :38372 │   .NET 10  (served under /api)
   │     └── /*     ─▶ 🖥️  :38373 │   Next.js 16
   └─────────────────────────────┘
```

## 📦 Codebases

| Folder | Stack | |
|---|---|---|
| [`app/`](app/) | Expo SDK 56 · React Native | 📱 mobile |
| [`backend/`](backend/) | .NET 10 (LTS) Web API | ⚙️ api |
| [`web/`](web/) | Next.js 16 · App Router | 🖥️ website |

## 🔌 Ports

| Port | Service | Exposed |
|---|---|---|
| **38378** | nginx (public entry) | ✅ host |
| 38373 | Next.js (web) | 🔒 internal |
| 38372 | .NET (backend) | 🔒 internal |

## 🚀 Make CLI

| Command | What it does |
|---|---|
| `make dev` | 🔥 Run with **hot reload** — edit & save, no rebuild |
| `make up` | 🚀 Build + run the **prod** image (detached) on `:38378` |
| `make down` | 🛑 Stop & remove the container |
| `make logs` | 📜 Tail logs |
| `make build` | 🔨 Build the prod image only |
| `make sh` | 🐚 Shell into the running container |
| `make clean` | 🧹 Tear down + drop volumes/images (fresh install) |
| `make help` | ❓ List all commands |

## ⚡ First run

```bash
make dev          # then open 👉 http://localhost:38378

cp .env.example .env   # 🧩 OPTIONAL — only to override defaults (e.g. HOST_PORT=80)
```

> ✅ **No `.env` needed** — sensible defaults are built in. Copy it only to tweak a knob.
> 🔁 In `make dev`, code changes hot-reload — you only rebuild when **dependencies** or the **Dockerfile** change.

## 🛠️ Run a single codebase (without Docker)

```bash
dotnet run --project backend/Evervault.Api   # ⚙️  api  → :38372
cd web && pnpm dev                            # 🖥️  web  → :38373
cd app && pnpm start                          # 📱  expo → QR / w·i·a
```
