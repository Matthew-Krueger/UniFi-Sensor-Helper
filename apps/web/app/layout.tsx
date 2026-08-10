import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { Nav } from "@/components/nav";
import { PasswordResetGate } from "@/components/password-reset-gate";
import "./globals.css";

export const metadata: Metadata = {
  title: "UnifiSensorLatch",
  description: "Hysteresis latch layer between UniFi Protect sensors and webhooks",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <PasswordResetGate />
          <Nav />
          <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
        </ThemeProvider>
      </body>
    </html>
  );
}
