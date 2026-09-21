export type ThemeMode = "system" | "light" | "dark";

const THEME_KEY = "webspeak:theme";

/**
 * 首次访问（localStorage 里没有选择）时的默认主题。
 *
 * 用 "light" 而不是 "system"：跟系统走会让系统设为深色的访客一进来就是深色首页，
 * 而这里的浅色是设计基准色（品牌色、渐变、插画都按浅色调过）。用户仍可用头部
 * 的主题按钮切到深色，选择会被记住。
 */
const DEFAULT_THEME: ThemeMode = "light";

export function getStoredTheme(): ThemeMode {
  const value = typeof localStorage === "undefined" ? "" : localStorage.getItem(THEME_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : DEFAULT_THEME;
}

export function applyTheme(theme: ThemeMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: ThemeMode): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

export function isDarkTheme(theme: ThemeMode): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

export function nextTheme(theme: ThemeMode): ThemeMode {
  return isDarkTheme(theme) ? "light" : "dark";
}

applyTheme(getStoredTheme());
