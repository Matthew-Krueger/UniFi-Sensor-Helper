"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
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

// Drawer-based nav (matches Unifi's own app navigation pattern, per
// project preference over a horizontal tab bar) — the hamburger trigger
// and slide-in drawer are the nav on every screen size, not just a mobile
// fallback, so there's one nav pattern to maintain instead of two.
export function NavDrawer({ links, username, role }: NavDrawerProps) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background">
      <div className="flex items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="sm" className="px-2">
                <Menu className="h-5 w-5" />
                <span className="sr-only">Open navigation</span>
              </Button>
            </SheetTrigger>
            <SheetContent>
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
        <ThemeToggle />
      </div>
    </header>
  );
}
