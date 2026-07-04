// Runtime configuration for the EverVault app.
//
// API_BASE points at the .NET backend, served under "/api" (behind nginx). Override it per-environment
// with EXPO_PUBLIC_API_BASE — e.g. your deployed https host for real Google login (Google only allows
// https or http://localhost redirect URIs), or a dev tunnel / LAN IP so a physical device can reach it.
//
//   iOS simulator:      http://localhost:38378/api        (localhost maps to the host machine)
//   Android emulator:   http://10.0.2.2:38378/api
//   Physical device:    http://<your-LAN-ip>:38378/api    (or your https tunnel)
//   Production:         https://<your-domain>/api

const DEFAULT_BASE = "http://localhost:38378/api";

export const API_BASE = (process.env.EXPO_PUBLIC_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, "");

/** WebSocket base for the live voice relay (ws:// or wss:// mirroring API_BASE). */
export const WS_BASE = API_BASE.replace(/^http/, "ws");

/** Custom URL scheme (matches app.json) used for the OAuth deep-link redirect. */
export const APP_SCHEME = "evervault";

/** The deep link Google login returns to with ?token=… (must be an allowed redirect on the backend). */
export const AUTH_REDIRECT = `${APP_SCHEME}://auth`;
