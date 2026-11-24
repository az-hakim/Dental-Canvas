import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { formatDate, toIsoDate } from "@/lib/utils";

interface Props {
  date: string;
  onChange: (date: string) => void;
  onCreate: () => void;
  /** Extra actions rendered beside "Add appointment" (e.g. Register & book). */
  children?: ReactNode;
}

export function DayToolbar({ date, onChange, onCreate, children }: Props) {
  const today = toIsoDate(new Date());
  const isToday = date === today;

  const shift = (days: number) => {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + days);
    onChange(toIsoDate(d));
  };

  return (
    <div className="shrink-0 px-4 pb-3 pt-5 md:px-6">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary/80">
            {isToday ? "Today" : "Chairside schedule"}
          </p>
          <h1 className="mt-1 text-[26px] font-bold leading-tight tracking-tight md:text-[30px]">
            {formatDate(date, { month: "long", year: "numeric" })}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {formatDate(date, { weekday: "long", day: "numeric" })}
            {isToday ? " — the chairs are live" : ""}
          </p>
        </div>

        {/* Full-width on phones so the two action buttons can share one row
            instead of stacking into a third line of chrome. */}
        <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {/* Prev | Today | Next pill */}
          {/* 36px tap targets on phones, back to the compact pill from sm up. */}
          <div className="inline-flex items-center gap-0.5 rounded-full border border-border/60 bg-card/85 p-1 shadow-sm backdrop-blur">
            <button
              type="button"
              onClick={() => shift(-1)}
              aria-label="Previous day"
              className="rounded-full p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:p-1.5"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onChange(today)}
              className={
                "rounded-full px-3.5 py-2 text-sm font-semibold transition-colors sm:py-1 " +
                (isToday
                  ? "bg-primary text-primary-foreground shadow-sm shadow-primary/25 hover:bg-primary/90"
                  : "hover:bg-accent")
              }
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => shift(1)}
              aria-label="Next day"
              className="rounded-full p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:p-1.5"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Date picker */}
          <input
            type="date"
            value={date}
            onChange={(e) => onChange(e.target.value)}
            aria-label="Pick a day"
            className="h-10 min-w-0 flex-1 rounded-full border border-border/60 bg-card/85 px-4 text-sm font-medium shadow-sm outline-none backdrop-blur focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-background sm:flex-none"
          />

          <div className="mx-1 hidden h-6 w-px bg-border/70 sm:block" />

          {children}

          <Button onClick={onCreate} className="h-10 flex-1 justify-center rounded-full px-4 shadow-lg shadow-primary/20 sm:flex-none">
            <Plus className="h-4 w-4" /> Add appointment
          </Button>
        </div>
      </div>
    </div>
  );
}
