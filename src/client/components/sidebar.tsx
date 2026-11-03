import { AppNav, embedded } from "@clawnify/app/client";
import {
  Calendar,
  Users,
  Settings,
  FileBarChart2,
  FlaskConical,
  Pill,
  Boxes,
  Search,
  LayoutDashboard,
  UserPlus,
  Monitor,
  Moon,
  Sun,
  Receipt,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { openQuickRegister } from "@/lib/quick-register";
import { useTheme, type ThemePreference } from "@/hooks/use-theme";
import { ToothGlyph } from "@/components/dental-art";
import type { Route } from "@/hooks/use-router";
import { lastFinanceTabPath } from "@/lib/finance-tab";
import { SyncIndicator } from "@/components/account/sync-indicator";

interface NavItem {
  label: string;
  /** Short label under the rail icon — the rail is 88px wide. */
  rail?: string;
  icon: typeof Calendar;
  path?: string;
  /** Resolved at navigation time when one entry stands for several routes. */
  resolvePath?: () => string;
  match?: (r: Route) => boolean;
  disabled?: boolean;
}

/** Where an entry actually goes — its fixed path, or its remembered view. */
function targetOf(item: NavItem): string | undefined {
  return item.resolvePath ? item.resolvePath() : item.path;
}

const sections: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Practice",
    items: [
      { label: "Dashboard", rail: "Home", icon: LayoutDashboard, path: "/dashboard", match: (r) => r.name === "dashboard" },
      { label: "Agenda",     rail: "Agenda", icon: Calendar,      path: "/agenda",   match: (r) => r.name === "agenda" },
      { label: "Patients",   rail: "Patients", icon: Users,         path: "/patients", match: (r) => r.name === "patients" || r.name === "patient" },
      { label: "Lab cases",  rail: "Lab", icon: FlaskConical,  path: "/lab",      match: (r) => r.name === "lab" },
      { label: "Medicines",  rail: "Meds", icon: Pill,          path: "/medicines", match: (r) => r.name === "medicines" },
      { label: "Inventory",  rail: "Stock", icon: Boxes,         path: "/inventory", match: (r) => r.name === "inventory" },
    ],
  },
  {
    heading: "Finance",
    // One entry: Billing Record, Revenue Breakdown and Appointment Overview are
    // tabs inside the page, so they belong in its tab strip, not the rail.
    items: [
      {
        label: "Finance",
        rail: "Finance",
        icon: Receipt,
        path: "/finance/billing-record",
        // Reopen the tab the doctor was last on, not always Billing Record.
        resolvePath: lastFinanceTabPath,
        match: (r) => r.name === "finance-billing" || r.name === "finance-revenue" || r.name === "finance-appointments",
      },
    ],
  },
  {
    heading: "Admin",
    items: [
      { label: "Reports",  rail: "Reports", icon: FileBarChart2, path: "/reports",  match: (r) => r.name === "reports" },
      { label: "Settings", rail: "Settings", icon: Settings,      path: "/settings", match: (r) => r.name === "settings" },
      { label: "What's new", rail: "Updates", icon: Sparkles,   path: "/whats-new", match: (r) => r.name === "whats-new" },
    ],
  },
];

export function Sidebar({
  route,
  navigate,
  onOpenSearch,
}: {
  route: Route;
  navigate: (to: string) => void;
  onOpenSearch?: () => void;
}) {
  const { pref: theme, cycleTheme } = useTheme();
  if (embedded) {
    const icons: Record<string, string> = { "/dashboard": "layout-dashboard", "/agenda": "calendar-days", "/patients": "users", "/lab": "package", "/medicines": "clipboard-list", "/inventory": "archive", "/finance/billing-record": "receipt", "/reports": "bar-chart-3", "/settings": "settings", "/whats-new": "sparkles" };
    const activeItem = sections.flatMap(section => section.items).find(item => item.match?.(route));
    const active = activeItem && targetOf(activeItem);
    return <AppNav title="Dental Canvas" icon="calendar-days" active={active}
      groups={sections.map(section => ({ label: section.heading, items: section.items.filter(item => item.path && !item.disabled).map(item => ({
        id: targetOf(item)!, label: item.label, href: targetOf(item)!, icon: icons[item.path!],
      })) }))}
      onNavigate={item => navigate(item.href ?? "/dashboard")} />;
  }

  return (
    <aside
      aria-label="Practice navigation"
      className="hidden w-[88px] shrink-0 flex-col border-r border-sidebar-border/70 bg-sidebar/80 text-sidebar-foreground backdrop-blur md:flex"
    >
      <div className="flex h-[72px] shrink-0 items-center justify-center border-b border-sidebar-border/60">
        <button
          type="button"
          onClick={() => navigate("/dashboard")}
          title="Dental Canvas — dashboard"
          aria-label="Dental Canvas — go to dashboard"
          className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-teal-600 text-primary-foreground shadow-lg shadow-primary/25 transition-transform hover:scale-105"
        >
          <ToothGlyph className="h-6 w-6" />
        </button>
      </div>

      {/* min-h-0 + force-scrollbar: the nav must always scroll inside the rail
          on short windows, with a visible scrollbar (Windows 11 hides overlay
          scrollbars until hover). */}
      <nav className="force-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {sections.map((section, si) => (
          <div
            key={section.heading}
            className={cn(si > 0 && "mt-2 border-t border-sidebar-border/60 pt-2")}
          >
            <ul className="space-y-1">
              {section.items.map((item) => {
                const active = item.match ? item.match(route) : false;
                const isDisabled = !!item.disabled;
                return (
                  <li key={item.label}>
                    <button
                      type="button"
                      disabled={isDisabled}
                      onClick={() => {
                        const target = targetOf(item);
                        if (target) navigate(target);
                      }}
                      aria-current={active ? "page" : undefined}
                      title={item.label}
                      className={cn(
                        "flex w-full flex-col items-center gap-1 rounded-2xl px-1 py-2 text-[9px] font-semibold leading-tight transition-all",
                        active
                          ? "bg-primary text-primary-foreground shadow-lg shadow-primary/25"
                          : !isDisabled && "text-muted-foreground hover:bg-primary/[0.07] hover:text-primary",
                        isDisabled && "cursor-not-allowed text-muted-foreground/50",
                      )}
                    >
                      <item.icon className="h-[18px] w-[18px] shrink-0" />
                      <span className="max-w-full truncate">{item.rail ?? item.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="flex shrink-0 flex-col items-center gap-1 border-t border-sidebar-border/60 p-2">
        <SyncIndicator onOpenSettings={() => navigate("/settings")} />
        <button
          type="button"
          onClick={() => onOpenSearch?.()}
          title="Search (Ctrl K)"
          aria-label="Search"
          className="flex h-10 w-10 items-center justify-center rounded-2xl text-muted-foreground transition-colors hover:bg-primary/[0.07] hover:text-primary"
        >
          <Search className="h-[18px] w-[18px]" />
        </button>
        <button
          type="button"
          onClick={openQuickRegister}
          title="Register patient (N)"
          aria-label="Register patient"
          className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary transition-colors hover:bg-primary/20"
        >
          <UserPlus className="h-[18px] w-[18px]" />
        </button>
        <button
          type="button"
          onClick={cycleTheme}
          title={themeLabel(theme)}
          aria-label={`Theme: ${themeLabel(theme)} — click to change`}
          className="flex h-10 w-10 items-center justify-center rounded-2xl text-muted-foreground transition-colors hover:bg-primary/[0.07] hover:text-primary"
        >
          {theme === "system" ? <Monitor className="h-[18px] w-[18px]" /> : theme === "light" ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </button>
      </div>
    </aside>
  );
}

function themeLabel(p: ThemePreference): string {
  return p === "system" ? "System" : p === "light" ? "Light" : "Dark";
}
