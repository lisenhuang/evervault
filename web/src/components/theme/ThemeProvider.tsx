"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark";

/** localStorage key — kept in sync with the no-flash script in app/layout.tsx. */
export const THEME_STORAGE_KEY = "theme";

type ThemeContextValue = {
  /** The active, resolved theme ("light" | "dark"). */
  theme: Theme;
  /** False on the server / first paint, true once hydrated — gate UI on this to
   *  avoid a hydration mismatch when the resolved theme isn't known yet. */
  mounted: boolean;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

// --- external store: localStorage (explicit choice) + OS preference (default) ---

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function resolveTheme(): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  // Follow the OS live only while the user hasn't made an explicit choice.
  const onSystem = () => {
    if (!localStorage.getItem(THEME_STORAGE_KEY)) emit();
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

/** Persist an explicit choice, apply it to <html>, and notify subscribers. */
function setStoredTheme(theme: Theme) {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  applyClass(theme);
  emit();
}

// `mounted` flips false → true after hydration without any setState-in-effect.
const noopSubscribe = () => () => {};

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribe, resolveTheme, () => "light");
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);

  // Keep the <html> class in sync with the resolved theme (e.g. live OS changes).
  useEffect(() => {
    if (mounted) applyClass(theme);
  }, [theme, mounted]);

  const setTheme = useCallback((next: Theme) => setStoredTheme(next), []);
  const toggle = useCallback(() => setStoredTheme(theme === "dark" ? "light" : "dark"), [theme]);

  return (
    <ThemeContext.Provider value={{ theme, mounted, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
  return ctx;
}
