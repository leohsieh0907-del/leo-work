// 亮/暗主題：存 localStorage，套在 <html data-theme>（index.html 開機前已先套一次防閃白）
export type Theme = "dark" | "light";

const KEY = "leo-theme";

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* localStorage 不可用時略過，僅當次有效 */
  }
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
