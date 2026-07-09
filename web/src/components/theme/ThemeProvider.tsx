"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/** The active, resolved theme actually applied to the page. */
export type Theme = "light" | "dark";
/** The user's stored preference. "system" tracks the OS setting live. */
export type ThemePreference = Theme | "system";

/** localStorage key — kept in sync with the no-flash script in app/layout.tsx. */
export const THEME_STORAGE_KEY = "theme";

type ThemeContextValue = {
  /** The active, resolved theme ("light" | "dark"). */
  theme: Theme;
  /** The user's preference ("light" | "dark" | "system"). "system" follows the OS. */
  preference: ThemePreference;
  /** False on the server / first paint, true once hydrated — gate UI on this to
   *  avoid a hydration mismatch when the resolved theme isn't known yet. */
  mounted: boolean;
  setTheme: (preference: ThemePreference) => void;
  /** Cycle light → dark → system → light. */
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

// --- external store: localStorage (explicit choice) + OS preference (default) ---

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The stored preference; defaults to "system" when nothing valid is stored. */
function resolvePreference(): ThemePreference {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

function resolveTheme(): Theme {
  const preference = resolvePreference();
  return preference === "system" ? systemTheme() : preference;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  // Follow the OS live only while the preference is "system" (the default).
  const onSystem = () => {
    if (resolvePreference() === "system") emit();
  };
  // Cross-tab: another tab changed the stored preference.
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_STORAGE_KEY) emit();
  };
  mql.addEventListener("change", onSystem);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    mql.removeEventListener("change", onSystem);
    window.removeEventListener("storage", onStorage);
  };
}

function applyClass(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Persist the preference, apply the resolved theme to <html>, and notify subscribers. */
function setStoredTheme(preference: ThemePreference) {
  localStorage.setItem(THEME_STORAGE_KEY, preference);
  applyClass(preference === "system" ? systemTheme() : preference);
  emit();
}

/** Cycle order for the toggle button. */
const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  light: "dark",
  dark: "system",
  system: "light",
};

// `mounted` flips false → true after hydration without any setState-in-effect.
const noopSubscribe = () => () => {};

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore<Theme>(subscribe, resolveTheme, () => "light");
  const preference = useSyncExternalStore<ThemePreference>(
    subscribe,
    resolvePreference,
    () => "system",
  );
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);

  // Keep the <html> class in sync with the resolved theme (e.g. live OS changes).
  useEffect(() => {
    if (mounted) applyClass(theme);
  }, [theme, mounted]);

  const setTheme = useCallback((next: ThemePreference) => setStoredTheme(next), []);
  const toggle = useCallback(() => setStoredTheme(NEXT_PREFERENCE[preference]), [preference]);

  return (
    <ThemeContext.Provider value={{ theme, preference, mounted, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}
