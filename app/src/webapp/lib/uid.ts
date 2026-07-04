// Stable id generator. Hermes has no crypto.randomUUID, so use expo-crypto (with a cheap fallback).
import * as Crypto from "expo-crypto";

export function uid(): string {
  try {
    return Crypto.randomUUID();
  } catch {
    return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}
