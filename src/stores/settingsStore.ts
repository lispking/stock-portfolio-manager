import { create } from "zustand";

export type ColorScheme = "red-up" | "green-up";
export type ThemeMode = "light" | "dark" | "system";

interface SettingsState {
  colorScheme: ColorScheme;
  setColorScheme: (scheme: ColorScheme) => void;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
}

const COLOR_SCHEME_KEY = "pnl_color_scheme";
const THEME_MODE_KEY = "app_theme_mode";
const VALID_SCHEMES: ColorScheme[] = ["red-up", "green-up"];
const VALID_THEME_MODES: ThemeMode[] = ["light", "dark", "system"];

function loadColorScheme(): ColorScheme {
  const stored = localStorage.getItem(COLOR_SCHEME_KEY);
  return VALID_SCHEMES.includes(stored as ColorScheme) ? (stored as ColorScheme) : "red-up";
}

function loadThemeMode(): ThemeMode {
  const stored = localStorage.getItem(THEME_MODE_KEY);
  return VALID_THEME_MODES.includes(stored as ThemeMode) ? (stored as ThemeMode) : "system";
}

export const useSettingsStore = create<SettingsState>((set) => ({
  colorScheme: loadColorScheme(),
  setColorScheme: (scheme) => {
    localStorage.setItem(COLOR_SCHEME_KEY, scheme);
    set({ colorScheme: scheme });
  },
  themeMode: loadThemeMode(),
  setThemeMode: (mode) => {
    localStorage.setItem(THEME_MODE_KEY, mode);
    set({ themeMode: mode });
  },
}));
