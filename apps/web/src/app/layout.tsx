import type { Metadata } from "next";
import { cookies } from "next/headers";
import { DM_Sans, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import { Toaster } from "sonner";

import { ThemeProvider } from "@/components/theme-toggle";
import { DialogHost } from "@/components/ui/dialog-host";
import { UploadFloater } from "@/components/upload-floater";

import "./themes.css";
import "./globals.css";
import "./chat.css";

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
});

const body = DM_Sans({
  subsets: ["latin"],
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "小信运维助手",
  description: "小信运维助手 opencode 智能助理网关。",
  icons: {
    icon: "/gateway/brand/xiaoxin-ops-logo.webp?v=3",
    apple: "/gateway/brand/xiaoxin-ops-logo.webp?v=3",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const theme = (await cookies()).get("opshelper-theme")?.value === "gray" ? "gray" : "green";

  return (
    <html lang="zh-CN" data-theme={theme}>
      <body className={`${display.variable} ${body.variable}`}>
        <ThemeProvider initialTheme={theme}>{children}</ThemeProvider>
        <DialogHost />
        <UploadFloater />
        <Toaster
          position="bottom-right"
          richColors
          closeButton
          toastOptions={{ style: { fontFamily: "var(--font-body)" } }}
        />
      </body>
    </html>
  );
}
