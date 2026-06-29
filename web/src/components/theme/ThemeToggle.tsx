"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "./ThemeProvider";

const BTN =
  "rounded-md p-2 text-black/60 transition hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10";

/** Single button that toggles between light and dark. */
export default function ThemeToggle({ size = 18 }: { size?: number }) {
  const { theme, mounted, toggle } = useTheme();

  // Until mounted we can't know the resolved theme, so render a same-sized
  // placeholder to reserve layout and avoid a hydration mismatch.
  if (!mounted) {
    return (
      <button type="button" className={BTN} aria-hidden="true" tabIndex={-1} disabled>
        <span style={{ display: "block", width: size, height: size }} />
      </button>
    );
  }

  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      className={BTN}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? <Sun size={size} /> : <Moon size={size} />}
    </button>
  );
}
