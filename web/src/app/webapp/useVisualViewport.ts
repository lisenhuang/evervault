"use client";

import { useEffect } from "react";

/**
 * Binds the chat shell to the on-screen keyboard.
 *
 * Sets the `--app-height` CSS variable on <html> to the current visual-viewport height
 * (the area not covered by the keyboard) so a `.app-shell` element shrinks to fit and the
 * composer at the bottom of its flex column stays just above the keyboard. While the chat
 * is mounted it also locks page scroll, which stops iOS Safari from scrolling the layout
 * viewport out from under the fixed-height shell when the keyboard opens.
 *
 * Degrades safely: with no `visualViewport` support the shell falls back to the CSS
 * `100dvh` default, which is already correct on Chrome (interactive-widget=resizes-content).
 */
export function useVisualViewport() {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;

    const apply = () => {
      const h = vv ? vv.height : window.innerHeight;
      root.style.setProperty("--app-height", `${Math.round(h)}px`);
    };
    apply();

    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);

    // Lock page scroll only while the chat is mounted, so iOS can't push the shell offscreen.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
      document.body.style.overflow = prevOverflow;
      root.style.removeProperty("--app-height");
    };
  }, []);
}
