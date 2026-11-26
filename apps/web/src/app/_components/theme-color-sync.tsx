"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";

// `--background` in @onecli/ui's globals.css: on a phone the page panel
// fills the screen, so the browser chrome continues its top bar.
const THEME_COLORS = {
  light: "#fdfbf7",
  dark: "#1a1917",
} as const;

export const ThemeColorSync = () => {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const color =
      THEME_COLORS[(resolvedTheme as keyof typeof THEME_COLORS) ?? "light"] ??
      THEME_COLORS.light;

    let meta = document.querySelector(
      'meta[name="theme-color"]',
    ) as HTMLMetaElement | null;

    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }

    meta.content = color;
  }, [resolvedTheme]);

  return null;
};
