// Colour themes. "system" follows the phone/computer; the others are fixed palettes defined in styles.css.

export const THEMES = [
  { id: "system", label: "Automatic", hint: "Light or dark, like your phone", swatch: ["#f2f5f4", "#ffffff", "#006f7c"] },
  { id: "light", label: "Light", hint: "Cool white and teal", swatch: ["#f2f5f4", "#ffffff", "#006f7c"] },
  { id: "dark", label: "Dark", hint: "Deep teal at night", swatch: ["#0f1819", "#152224", "#3fb0b8"] },
  { id: "sand", label: "Sand", hint: "Warm paper and terracotta", swatch: ["#f4efe6", "#fffdf9", "#9a4a14"] },
  { id: "forest", label: "Forest", hint: "Soft greens", swatch: ["#eff5ef", "#fcfffc", "#2d7a3f"] },
  { id: "rose", label: "Rose", hint: "Light with a raspberry accent", swatch: ["#f8f1f2", "#fffdfd", "#b0285a"] },
  { id: "midnight", label: "Midnight", hint: "Blue-black with a sky accent", swatch: ["#0b1020", "#131a2e", "#6ea8ff"] },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const KEY = "wallet-theme";
const ids = new Set<string>(THEMES.map((t) => t.id));

export function savedTheme(): ThemeId {
  try {
    const v = localStorage.getItem(KEY);
    if (v && ids.has(v)) return v as ThemeId;
  } catch {
    // storage unavailable (private mode)
  }
  return "system";
}

const dark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

/** Put the theme on <html> and colour the browser bar to match. */
export function applyTheme(theme: ThemeId, remember = true): void {
  const root = document.documentElement;
  root.dataset.theme = theme === "system" ? (dark() ? "dark" : "light") : theme;
  const paper = getComputedStyle(root).getPropertyValue("--paper").trim();
  if (paper) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", paper);
  if (!remember) return;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // storage unavailable
  }
}

/** Call once at startup: apply the saved theme and follow the system setting while on "Automatic". */
export function initTheme(): void {
  applyTheme(savedTheme(), false);
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (savedTheme() === "system") applyTheme("system", false);
  });
}
