# EverVault app (Expo)

Native client for the EverVault chat — same features as `web/webapp`, but **keyless**: Google login runs
in an in-app browser and all Gemini calls go through the backend proxy on the system keys (with failover).
Users never enter an AI Studio key.

## Features → how they run

| Feature | Mechanism |
|---|---|
| Google login | In-app browser (`expo-web-browser`) → backend OAuth → `evervault://auth?token=` deep link → bearer token in `expo-secure-store` |
| Streaming chat | SSE from `POST /api/chat/ai/generate` (system keys, failover); tool loop runs client-side |
| Attachments | `expo-image-picker` / `expo-document-picker` → inline base64 / extracted text |
| Voice message (PTT) | `expo-audio` record → `/api/chat/ai/transcribe` → streamed reply + `/api/chat/ai/tts` |
| Live voice call | `react-native-audio-api` (mic + gapless playback) ⇄ `WS /api/chat/ai/live` relay ⇄ Gemini Live |
| Memory / “knows you” | `/api/chat/ai/embed` + the unchanged `/api/chat/memories` & `/api/chat/profile` endpoints |

## Requirements

- **A development build is required** (not Expo Go) — the live-call audio libraries are native modules.
- Backend running with **system Gemini keys** configured (admin → AI keys) and **Google login enabled with a
  client id *and secret*** (admin → Google). The server-side OAuth code flow needs the secret.

## One-time backend/Google setup

1. In the Google Cloud console, on the **same OAuth 2.0 Web client** used for web login, add an authorized
   **redirect URI**: `https://<your-host>/api/auth/google/callback`.
2. Make sure the client **secret** is saved in admin → Google (the web ID-token flow didn’t need it; the app’s
   code flow does).

## Run

```bash
# 1. point the app at a reachable backend (Google requires https or http://localhost for the callback)
export EXPO_PUBLIC_API_BASE="https://<your-host>/api"     # or http://<LAN-ip>:38378/api for local

# 2. build & install the dev client once (managed/CNG — no native code committed)
eas build --profile development --platform ios      # or android
# then:
pnpm start        # open the dev build (not Expo Go) via the QR
```

`EXPO_PUBLIC_API_BASE` defaults to `http://localhost:38378/api` (iOS simulator). Android emulator uses
`http://10.0.2.2:38378/api`; a physical device needs your LAN IP or an https tunnel.
