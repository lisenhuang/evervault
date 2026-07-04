// The end-user session token (a stateless Data-Protection bearer token minted by the backend after
// Google login) is kept in the OS secure keystore — never in plain AsyncStorage.

import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "ev_session_token";

export async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function setToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  } catch {
    /* keystore unavailable — the session just won't persist */
  }
}

export async function clearToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}
