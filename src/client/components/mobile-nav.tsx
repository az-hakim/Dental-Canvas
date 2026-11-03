import { useEffect, useRef, useState } from "react";
import {
  Calendar,
  FileBarChart2,
  FlaskConical,
  Pill,
  LayoutDashboard,
  Monitor,
  Moon,
  Search,
  Settings,
  Sun,
  UserPlus,
  Users,
  Boxes,
  Ellipsis,
  Receipt,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { openQuickRegister } from "@/lib/quick-register";
import { useTheme } from "@/hooks/use-theme";
import { ToothGlyph } from "@/components/dental-art";
import { lastFinanceTabPath } from "@/lib/finance-tab";
import { SyncIndicator } from "@/components/account/sync-indicator";
import type { Route } from "@/hooks/use-router";

/**
 * Mobile navigation chrome — the sidebar is `hidden md:flex`, so below the
 * `md` breakpoint these two pieces take over:
 *
 *  - MobileTopBar: slim brand bar with the global actions (search, register,
 *    theme) that would otherwise only live in the desktop sidebar.
 *  - BottomNav: an iOS-style floating pill with the four primary
 *    destinations; secondary pages (Reports, Settings) sit behind a "•••"
 *    menu, the way iOS handles more than five tabs.
 *
 * Both are hidden at `md` and on print routes (handled by the caller).
 */

interface NavItem {
  label: string;
  icon: typeof Calendar;
  path: string;
  /** Resolved at tap time when one entry stands for several routes. */
  resolvePath?: () => string;
  match: (r: Route) => boolean;
}

/** Where an entry actually goes — its fixed path, or its remembered view. */
function targetOf(item: NavItem): string {
  return item.resolvePath ? item.resolvePath() : item.path;
}

const PRIMARY_ITEMS: NavItem[] = [
  { label: "Home", icon: LayoutDashboard, path: "/dashboard", match: (r) => r.name === "dashboard" },
  { label: "Agenda", icon: Calendar, path: "/agenda", match: (r) => r.name === "agenda" },
  { label: "Patients", icon: Users, path: "/patients", match: (r) => r.name === "patients" || r.name === "patient" },
  { label: "Lab", icon: FlaskConical, path: "/lab", match: (r) => r.name === "lab" },
];

const MORE_ITEMS: NavItem[] = [
  // Finance is one destination; its three views are tabs on the page itself.
  {
    label: "Finance",
    icon: Receipt,
    path: "/finance/billing-record",
    // Reopen the tab that was last open, matching the desktop rail.
    resolvePath: lastFinanceTabPath,
    match: (r) => r.name === "finance-billing" || r.name === "finance-revenue" || r.name === "finance-appointments",
  },
  { label: "Medicines", icon: Pill, path: "/medicines", match: (r) => r.name === "medicines" },
  { label: "Inventory", icon: Boxes, path: "/inventory", match: (r) => r.name === "inventory" },
  { label: "Reports", icon: FileBarChart2, path: "/reports", match: (r) => r.name === "reports" },
  { label: "Settings", icon: Settings, path: "/settings", match: (r) => r.name === "settings" },
];

export function MobileTopBar({ onOpenSearch, navigate }: { onOpenSearch?: () => void; navigate: (to: string) => void }) {
  const { pref: theme, cycleTheme } = useTheme();

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-sidebar px-3 text-sidebar-foreground md:hidden">
      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-teal-600 text-primary-foreground shadow-sm shadow-primary/25">
        <ToothGlyph className="h-4 w-4" />
      </div>
      <span className="flex-1 truncate text-sm font-semibold tracking-tight">Dental Canvas</span>
      <SyncIndicator compact onOpenSettings={() => navigate("/settings")} />
      <button
        type="button"
        onClick={cycleTheme}
        aria-label={`Theme: ${theme} — tap to change`}
        className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-sidebar-accent"
      >
        {theme === "system" ? <Monitor className="h-4 w-4" /> : theme === "light" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={() => onOpenSearch?.()}
        aria-label="Search"
        className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-sidebar-accent"
      >
        <Search className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={openQuickRegister}
        aria-label="Register patient"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <UserPlus className="h-4 w-4" />
      </button>
    </header>
  );
}

export function BottomNav({ route, navigate }: { route: Route; navigate: (to: string) => void }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = MORE_ITEMS.some((i) => i.match(route));
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the More menu on navigation.
  useEffect(() => {
    setMoreOpen(false);
  }, [route]);

  // Close on outside tap.
  useEffect(() => {
    if (!moreOpen) return;
    function onDocClick(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMoreOpen(false);
    }
    document.addEventListener("pointerdown", onDocClick);
    return () => document.removeEventListener("pointerdown", onDocClick);
  }, [moreOpen]);

  function renderItem(item: NavItem) {
    const active = item.match(route);
    const Icon = item.icon;
    return (
      <button
        key={item.path}
        type="button"
        onClick={() => navigate(targetOf(item))}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-full px-2 py-1.5 transition-colors",
          active
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground active:bg-muted",
        )}
      >
        <Icon className="h-5 w-5" />
        <span className="text-[10px] font-medium leading-none">{item.label}</span>
      </button>
    );
  }

  return (
    <nav
      // z-30 lifts the bar (and the More sheet above it) over page content: the
      // pill's backdrop-blur creates a stacking context, so the sheet's own z-50
      // is local and pages with `relative z-10` panels would paint over it.
      className="relative z-30 shrink-0 px-3 pt-1 md:hidden"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      aria-label="Primary"
    >
      <div
        ref={menuRef}
        className="relative mx-auto w-full max-w-md rounded-full border bg-popover/95 shadow-lg backdrop-blur-md"
      >
        {moreOpen && (
          <>
            {/* Tap-away catcher */}
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              onClick={() => setMoreOpen(false)}
              className="fixed inset-0 z-40 cursor-default"
            />
            <div
              role="menu"
              className="absolute bottom-full right-0 z-50 mb-3 w-44 overflow-hidden rounded-2xl border bg-popover p-1 shadow-xl"
            >
              {MORE_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.path}
                    type="button"
                    role="menuitem"
                    onClick={() => navigate(targetOf(item))}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                      item.match(route) ? "bg-primary/10 text-primary" : "text-foreground active:bg-muted",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="flex items-stretch gap-0.5 p-1.5">
          {PRIMARY_ITEMS.map(renderItem)}
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            aria-expanded={moreOpen}
            aria-haspopup="menu"
            aria-label="More pages"
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-full px-2 py-1.5 transition-colors",
              moreActive && !moreOpen
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground active:bg-muted",
            )}
          >
            <Ellipsis className="h-5 w-5" />
            <span className="text-[10px] font-medium leading-none">More</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
