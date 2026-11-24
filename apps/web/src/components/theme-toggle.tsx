"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import { IconTheme } from "./chat/icons";

export type Theme = "green" | "gray";

const ThemeContext = createContext<{
  theme: Theme;
  toggleTheme: () => void;
} | null>(null);

export function ThemeProvider({ initialTheme, children }: {
  initialTheme: Theme;
  children: ReactNode;
}) {
  const [theme, setTheme] = useState(initialTheme);

  function toggleTheme() {
    const nextTheme = theme === "gray" ? "green" : "gray";
    document.documentElement.dataset.theme = nextTheme;
    document.cookie = `opshelper-theme=${nextTheme}; Path=/gateway; Max-Age=31536000; SameSite=Lax`;
    setTheme(nextTheme);
  }

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle() {
  const { theme, toggleTheme } = useContext(ThemeContext)!;
  const gray = theme === "gray";
  const currentLabel = gray ? "白灰" : "清新绿";
  const nextLabel = gray ? "清新绿" : "白灰";

  return (
    <button
      type="button"
      className="theme-toggle-menu-item"
      role="menuitemcheckbox"
      aria-label={`切换主题（当前：${currentLabel}，点击切换到${nextLabel}）`}
      aria-checked={gray}
      onClick={toggleTheme}
    >
      <IconTheme />
      <span>主题配色</span>
      <span className="theme-toggle-badge" aria-hidden="true">
        <span className={`theme-toggle-swatch theme-toggle-swatch-${theme}`} />
        {currentLabel}
      </span>
    </button>
  );
}
