# 🔐 EverVault

> **Your Personal Memory AI**

One stack. One domain. Web + API behind nginx, with Postgres + pgvector. 🐳

```
        🌐 Cloudflare  (TLS)
              │  http
              ▼
   ┌─────────────────────────────┐         ┌─────────────────────────┐
   │   nginx  :38378  (public)   │         │ 🐘 db  pgvector/pg18     │
   │     ├── /api/* ─▶ ⚙️  :38372 │──5432──▶│   trust auth · not       │
   │     └── /*     ─▶ 🖥️  :38373 │         │   exposed · pgdata vol   │
   └─────────────────────────────┘         └─────────────────────────┘
        app container (nginx+web+.NET)            db container
```

> 💡 **Why `db` is its own container:** the app container is disposable — `make up` swaps it for each new version while the DB keeps running, so data survives redeploys and app updates stay ~zero-downtime.

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
| 38377 | Postgres + pgvector | 🔒 `127.0.0.1` only (dev) · prod: not published |

## 🔐 Admin & data

- **`/admin`** — first visit creates the admin account (email + password); after that it's the
  login. Then a dashboard to configure **storage**.
- **Cloudflare R2** is configured from the dashboard (no `.env`) — the form tells you where to
  find each value; the secret is **encrypted** in the DB.
- **Data persists** in the `pgdata` volume across `make up`/`make down`. ⚠️ `make clean` (`-v`)
  **wipes the database**; `make down` is the safe stop.
- Zero secrets to manage: passwordless DB (`trust`, never exposed) + admin cookies/keys auto-stored
  in the DB.

### Key API routes (under `/api`)

| Route | Purpose |
|---|---|
| `GET /api/health/db` | DB + pgvector health |
| `POST /api/admin/setup` · `POST /api/admin/login` | First-run create / login |
| `GET/POST/DELETE /api/memories` · `GET /api/memories/search?q=` | Memories (mutations require admin) |
| `GET/PUT /api/admin/storage` · `POST /api/admin/storage/test` | R2 storage config |

## 🚀 Make CLI

| Command | What it does |
|---|---|
| `make dev` | 🔥 Run with **hot reload** — edit & save, no rebuild |
| `make up` | 🚀 Build + run **prod**, auto-drop old versions, wait, print the 🔗 URL |
| `make down` | 🛑 Stop & remove the container |
| `make logs` | 📜 Tail logs |
| `make build` | 🔨 Build the prod image only |
| `make sh` | 🐚 Shell into the running container |
| `make clean` | 🧹 Tear down + drop volumes/images (fresh install) |
| `make prune` | ♻️ Reclaim disk — dangling images + all build cache |
| `make reset-admin` | 🔑 Delete the admin account → `/admin` shows first-run setup again |
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
