"use client";

import { Moon, Sun, SunMoon } from "lucide-react";
import { useT } from "@/i18n/LanguageProvider";
import { useTheme, type ThemePreference } from "./ThemeProvider";

const BTN =
  "rounded-md p-2 text-black/60 transition hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10";

// "system" uses the sun/moon hybrid rather than a device icon: it reads as
// "auto — switches between light and dark" instead of "this computer".
const ICON = { light: Sun, dark: Moon, system: SunMoon } as const;

/** Cycles light → dark → system → light; the icon reflects the current preference. */
export default function ThemeToggle({ size = 18 }: { size?: number }) {
  const { preference, mounted, toggle } = useTheme();
  const t = useT();

  // Until mounted we can't know the resolved preference, so render a same-sized
  // placeholder to reserve layout and avoid a hydration mismatch.
  if (!mounted) {
    return (
      <button type="button" className={BTN} aria-hidden="true" tabIndex={-1} disabled>
        <span style={{ display: "block", width: size, height: size }} />
      </button>
    );
  }

  const labels: Record<ThemePreference, string> = {
    light: t.sidebar.themeLight,
    dark: t.sidebar.themeDark,
    system: t.sidebar.themeSystem,
  };
  const Icon = ICON[preference];
  const label = `${t.sidebar.theme}: ${labels[preference]}`;

  return (
    <button type="button" onClick={toggle} className={BTN} title={label} aria-label={label}>
      <Icon size={size} />
    </button>
  );
}
