import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProgressRing } from "@/components/ui/progress-ring";
import { ToothGlyph } from "@/components/dental-art";
import { primeNotifications } from "@/lib/desktop-notify";
import {
  CHAIRSIDE_TIMER_EVENT,
  CHAIRSIDE_TIMER_STORAGE_KEY,
} from "@/lib/chairside-timer-alert";

/**
 * Chairside timer.
 *
 * A countdown for procedures that have a clock attached to them — etch/rinse,
 * impression set, whitening cycles — with presets sized for common dental
 * steps. It counts against a wall-clock deadline rather than decrementing on
 * every tick, so a backgrounded tab or a slow render cannot make it drift.
 */

const PRESETS = [
  { label: "Etch", minutes: 1, hint: "bonding prep" },
  { label: "Rinse", minutes: 2, hint: "post-op rinse" },
  { label: "Whitening", minutes: 10, hint: "per cycle" },
  { label: "Set", minutes: 15, hint: "impression / cement" },
] as const;

/** Session snapshot so stepping away from the dashboard does not lose a run. */
const STORAGE_KEY = CHAIRSIDE_TIMER_STORAGE_KEY;

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

interface SavedTimer {
  minutes: number;
  remaining: number;
  deadline: number | null;
}

function loadTimer(): SavedTimer | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<SavedTimer>;
    if (typeof saved.minutes !== "number" || !Number.isFinite(saved.minutes)) return null;
    if (typeof saved.remaining !== "number" || !Number.isFinite(saved.remaining)) return null;
    return {
      minutes: Math.max(1, Math.round(saved.minutes)),
      remaining: Math.max(0, Math.round(saved.remaining)),
      deadline: typeof saved.deadline === "number" && Number.isFinite(saved.deadline) ? saved.deadline : null,
    };
  } catch {
    return null;
  }
}

export function ChairsideTimer({ className }: { className?: string }) {
  // Restored once, on mount: a countdown that is still running continues from
  // its wall-clock deadline, so time spent on another page is not lost.
  const [restored] = useState(loadTimer);
  const [minutes, setMinutes] = useState<number>(restored?.minutes ?? PRESETS[2].minutes);
  const savedDeadline = restored?.deadline ?? null;
  const restoredRemaining = savedDeadline !== null
    ? Math.max(0, Math.round((savedDeadline - Date.now()) / 1000))
    : (restored?.remaining ?? (restored?.minutes ?? PRESETS[2].minutes) * 60);
  const [remaining, setRemaining] = useState(restoredRemaining);
  const [running, setRunning] = useState(() => savedDeadline !== null && savedDeadline > Date.now());
  const [finished, setFinished] = useState(() => savedDeadline !== null && savedDeadline <= Date.now());
  /** Wall-clock deadline; null whenever the timer is not running. */
  const deadline = useRef<number | null>(running ? savedDeadline : null);

  // Mirror the session so a route change (or a reload) can pick it back up.
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ minutes, remaining, deadline: running ? deadline.current : null }),
      );
    } catch {
      /* storage unavailable — the timer still works for this session */
    }
  }, [minutes, remaining, running]);

  // Tell the app-level watcher (lib/chairside-timer-alert) about start/pause/
  // reset/finish. This effect runs after the snapshot above is written, and
  // deliberately does not depend on `remaining` — a 500ms tick must not
  // re-arm the finish alert.
  useEffect(() => {
    window.dispatchEvent(new Event(CHAIRSIDE_TIMER_EVENT));
  }, [running, minutes, finished]);

  const total = minutes * 60;
  const elapsedPercent = total > 0 ? ((total - remaining) / total) * 100 : 0;

  const stop = useCallback(() => {
    deadline.current = null;
    setRunning(false);
  }, []);

  // One interval per running session. The remaining time is recomputed from
  // the deadline on every tick, so a missed tick (throttled background tab)
  // catches up instead of pausing the countdown.
  useEffect(() => {
    if (!running) return;
    const tick = () => {
      if (deadline.current === null) return;
      const left = Math.max(0, Math.round((deadline.current - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) {
        deadline.current = null;
        setRunning(false);
        setFinished(true);
        // The finish toast + desktop notification come from the app-level
        // watcher (lib/chairside-timer-alert), which also fires when this card
        // is not on screen.
      }
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [running]);

  function choose(nextMinutes: number) {
    stop();
    setMinutes(nextMinutes);
    setRemaining(nextMinutes * 60);
    setFinished(false);
  }

  function toggle() {
    if (running) {
      // Freeze at the exact remaining time, not the last whole second shown.
      if (deadline.current !== null) {
        setRemaining(Math.max(0, Math.round((deadline.current - Date.now()) / 1000)));
      }
      stop();
      return;
    }
    const left = remaining > 0 ? remaining : total;
    if (left <= 0) return;
    setRemaining(left);
    setFinished(false);
    deadline.current = Date.now() + left * 1000;
    setRunning(true);
    // Ask for OS notification permission now, so the finish alert is not the
    // moment the clinic first sees a permission prompt.
    void primeNotifications();
  }

  function reset() {
    stop();
    setRemaining(total);
    setFinished(false);
  }

  // What the footer tells the chair: the wall-clock finish while it is
  // counting, the chosen cycle when ready, and a plain "time's up" at zero.
  const endsAt = new Date(Date.now() + remaining * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const footer = finished
    ? { label: "Status", value: "Time's up" }
    : running
      ? { label: "Ends at", value: endsAt }
      : { label: "Cycle", value: `${minutes} min` };

  return (
    <section
      aria-labelledby="chairside-timer-heading"
      className={cn("dc-card relative overflow-hidden p-5", className)}
    >
      {/* Faint molar in the corner — the same watermark language as the tip
          card, and it keeps the card from reading as empty at row height. */}
      <ToothGlyph className="pointer-events-none absolute -bottom-9 -right-7 h-32 w-32 text-primary/[0.04]" />

      <div className="relative flex items-center justify-between gap-2">
        <h2 id="chairside-timer-heading" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-300">
            <Timer className="h-4 w-4" />
          </span>
          Chairside timer
        </h2>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
            running
              ? "bg-teal-500/15 text-teal-700 dark:text-teal-300"
              : finished
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                : "bg-muted text-muted-foreground",
          )}
        >
          {running ? "Running" : finished ? "Done" : "Ready"}
        </span>
      </div>

      <div className="relative mt-3 flex items-center gap-4">
        <div
          className={cn(
            "shrink-0 rounded-full",
            running && "dc-timer-live",
            finished && "text-amber-500",
          )}
        >
          <ProgressRing
            value={elapsedPercent}
            size={104}
            thickness={8}
            tone={finished ? "amber" : "teal"}
            label={`Chairside timer: ${formatClock(remaining)} remaining of ${minutes} minutes`}
          >
            <span className="flex flex-col items-center">
              <span className="text-2xl font-bold tabular-nums leading-none tracking-tight">
                {formatClock(remaining)}
              </span>
              <span className="mt-1 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                {finished ? "Time's up" : running ? "Remaining" : "of " + minutes + " min"}
              </span>
            </span>
          </ProgressRing>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => choose(p.minutes)}
                title={`${p.minutes} minute${p.minutes === 1 ? "" : "s"} — ${p.hint}`}
                aria-pressed={minutes === p.minutes}
                className={cn(
                  "min-h-9 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors sm:min-h-0",
                  minutes === p.minutes
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {p.label}
                <span className="ml-1 font-normal opacity-70">{p.minutes}m</span>
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-1.5">
            <button
              type="button"
              onClick={toggle}
              className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-semibold text-primary-foreground transition-transform hover:scale-[1.02] active:scale-95"
            >
              {running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {running ? "Pause" : remaining === 0 || finished ? "Restart" : "Start"}
            </button>
            <button
              type="button"
              onClick={reset}
              title="Reset timer"
              aria-label="Reset timer"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>      <div className="relative mt-3 flex items-center justify-between gap-2 rounded-xl bg-muted/50 px-3 py-2 text-[11px]">
        <span className="font-semibold uppercase tracking-wider text-muted-foreground">{footer.label}</span>
        <span className="font-semibold tabular-nums text-foreground/85">{footer.value}</span>
      </div>

      <p className="relative mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Counts down on the wall clock, keeps running on other pages, and sends a desktop alert when
        the cycle ends.
      </p>
    </section>
  );
}
