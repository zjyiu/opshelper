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

  return (
    <button
      type="button"
      className="theme-toggle-menu-item"
      role="menuitemcheckbox"
      aria-label="切换主题（白灰主题）"
      aria-checked={gray}
      onClick={toggleTheme}
    >
      <IconTheme />
      <span>切换主题</span>
    </button>
  );
}
