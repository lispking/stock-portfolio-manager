import { useEffect, useMemo, useState } from "react";
import { theme } from "antd";
import { useSettingsStore } from "../stores/settingsStore";

const { darkAlgorithm, defaultAlgorithm } = theme;

function getSystemTheme(): "light" | "dark" {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

export function useTheme() {
  const themeMode = useSettingsStore((s) => s.themeMode);
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(getSystemTheme);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? "dark" : "light");
    };
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

  const resolvedTheme: "light" | "dark" = useMemo(() => {
    if (themeMode === "system") {
      return systemTheme;
    }
    return themeMode;
  }, [themeMode, systemTheme]);

  // Apply theme to document for CSS selectors
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }, [resolvedTheme]);

  const algorithm = resolvedTheme === "dark" ? darkAlgorithm : defaultAlgorithm;

  return { themeMode, resolvedTheme, algorithm };
}
