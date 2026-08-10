"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { TemperatureUnitToggle } from "@/components/temperature-unit-toggle";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SignOutButton } from "@/components/sign-out-button";

interface NavLink {
  href: string;
  label: string;
}

interface NavDrawerProps {
  links: NavLink[];
  username: string | null;
  role: string | null;
}

const DESKTOP_QUERY = "(min-width: 768px)"; // matches Tailwind's md: breakpoint

// useLayoutEffect (not useEffect) so isDesktop is resolved synchronously
// before the browser paints, not after — with a plain useEffect, the
// drawer briefly mounted as "closed" (nothing on screen), then flipped
// open a tick later, which meant the slide-in entrance animation played
// on every load even though desktop is supposed to be permanently
// pinned, no animation, ever. Falls back to useEffect on the server
// (useLayoutEffect warns if it runs there) — harmless, since this file is
// "use client" and only actually executes client-side anyway.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

// Drawer-based nav (matches Unifi's own app navigation pattern, per
// project preference over a horizontal tab bar) — the hamburger trigger
// and slide-in drawer are the nav on mobile; on desktop the drawer is
// pinned permanently open as a real sidebar — no close button, no
// hamburger to toggle it, can't be dismissed, no entrance/exit animation
// (see the `animated` prop below). (An earlier version left it
// closeable-but-defaulted-open on desktop; pinned is simpler and was the
// preferred choice.)
export function NavDrawer({ links, username, role }: NavDrawerProps) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [isDesktop, setIsDesktop] = React.useState(false);
  const pathname = usePathname();

  useIsomorphicLayoutEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    setIsDesktop(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Always open on desktop regardless of mobileOpen — nothing can close
  // it there (see onInteractOutside/onEscapeKeyDown below and
  // hideCloseOnDesktop on SheetContent).
  const open = isDesktop || mobileOpen;

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background">
      <div className="flex items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          {/* modal={false} on desktop is the actual fix for "can't click
              anything outside the sidebar" — Radix's Dialog is modal by
              default, which disables pointer-events on the rest of the
              page while open regardless of whether the overlay is
              visually hidden (md:hidden only hides the *overlay*, it
              doesn't touch Radix's modal pointer-event lockout). Since
              the drawer is permanently open on desktop, that lockout was
              permanent too. Mobile keeps modal={true} — a temporary
              overlay drawer should still block the background while
              it's open. */}
          <Sheet open={open} onOpenChange={(next) => !isDesktop && setMobileOpen(next)} modal={!isDesktop}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="sm" className="px-2 md:hidden">
                <Menu className="h-5 w-5" />
                <span className="sr-only">Open navigation</span>
              </Button>
            </SheetTrigger>
            <SheetContent
              hideCloseOnDesktop
              animated={!isDesktop}
              onInteractOutside={(e) => {
                if (isDesktop) e.preventDefault();
              }}
              onEscapeKeyDown={(e) => {
                if (isDesktop) e.preventDefault();
              }}
            >
              <SheetTitle>UnifiSensorLatch</SheetTitle>
              <nav className="flex flex-col gap-1">
                {links.map((link) => {
                  const active = pathname === link.href;
                  return (
                    <SheetClose asChild key={link.href}>
                      <Link
                        href={link.href}
                        className={
                          "rounded-md px-3 py-2 text-sm font-medium transition-colors " +
                          (active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")
                        }
                      >
                        {link.label}
                      </Link>
                    </SheetClose>
                  );
                })}
              </nav>
              <div className="mt-auto flex flex-col gap-3 border-t border-border pt-4">
                {username && (
                  <span className="text-sm text-muted-foreground">
                    {username} <span className="text-xs">({role})</span>
                  </span>
                )}
                {username && <SignOutButton />}
              </div>
            </SheetContent>
          </Sheet>
          <span className="font-semibold">UnifiSensorLatch</span>
        </div>
        <div className="flex items-center gap-1">
          <TemperatureUnitToggle />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
