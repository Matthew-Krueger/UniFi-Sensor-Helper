import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { Nav } from "@/components/nav";
import { SessionGuard } from "@/components/session-guard";
import { CurrentUserProvider } from "@/lib/useCurrentUser";
import { getSessionUser } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "UniFi Sensor Helper",
  description: "Hysteresis latch layer between UniFi Protect sensors and webhooks",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const initialUser = await getSessionUser();
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <div className="app-backdrop" aria-hidden="true" />
          <CurrentUserProvider initialUser={initialUser}>
            <SessionGuard />
            <Nav />
            {/* md:pl-72 reserves space for the drawer, which defaults open
                as a persistent sidebar at that breakpoint — see nav-drawer.tsx.
                mx-auto/max-w-5xl live on the inner div so content is still
                centered *within* the remaining space, not the full viewport. */}
            <main className="md:pl-72">
              <div className="mx-auto max-w-5xl px-6 py-8">{children}</div>
            </main>
          </CurrentUserProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
