/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 表面色綁 CSS 變數 → 隨 data-theme 切換亮/暗（見 index.css）
        brand: {
          DEFAULT: "#6366f1",
          dark: "var(--bg)",
          panel: "var(--panel)",
          accent: "#34d399",
          warn: "#f59e0b",
          danger: "#ef4444",
        },
        // 語意化色票（亮/暗各一組值定義在 index.css）
        inset: "var(--inset)",
        line: "var(--line)",
        hover: { DEFAULT: "var(--hover)", weak: "var(--hover-weak)" },
        fg: {
          DEFAULT: "var(--fg)",
          muted: "var(--fg-muted)",
          subtle: "var(--fg-subtle)",
          faint: "var(--fg-faint)",
        },
      },
      fontFamily: { mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"] },
    },
  },
  plugins: [],
};
