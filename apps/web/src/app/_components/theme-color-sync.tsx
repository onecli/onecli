"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";

const THEME_COLORS = {
  light: "#fbfbfb",
  dark: "#1f1e1d",
} as const;

export const ThemeColorSync = () => {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const color =
      THEME_COLORS[(resolvedTheme as keyof typeof THEME_COLORS) ?? "dark"] ??
      THEME_COLORS.dark;

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
