/**
 * Dashboard visit metrics.
 *
 * Pure arithmetic behind the "Today's Patient Visits" card, kept out of the
 * component so the numbers can be tested without a DOM. Everything here is
 * derived from the summary the API actually returns — no placeholder scores.
 *
 * The card answers three questions and nothing more:
 *   - headline → how many patient visits today (booked or registered)
 *   - New patients tile → progress toward the ten-a-day front-desk goal
 *   - Returning tile → how much of today's visits are repeat business
 *
 * Chair utilization deliberately has no metric here: the dashboard is a
 * front-desk view, and chair time is reported on the Reports page where the
 * kiosk check-in data lives.
 */

/** New patients the practice aims to see per day. A progress bar needs a
 *  scale, and "share of the patient base" gave it none — a practice with
 *  history pinned every day at ~100%. Ten a day is the front-desk goal; it is
 *  a constant because nothing in Settings configures it yet. */
export const NEW_PATIENT_DAILY_TARGET = 10;

export interface VisitSummaryLike {
  total_visits?: number | null;
  visits_delta_pct?: number | null;
  new_patients_today?: number | null;
  new_patients_delta_pct?: number | null;
  returning_patients_today?: number | null;
  returning_patients_delta_pct?: number | null;
}

export interface VisitMetrics {
  /** Today's patient visits (the card's headline number). */
  visits: number;
  /** New patients seen or registered today (no completed visit before today). */
  newToday: number;
  /** Returning patients seen or registered today (a completed visit before today). */
  returningToday: number;
  /** The daily new-patient goal the tile's bar is measured against. */
  newGoal: number;
  /** Progress toward that goal, clamped to 100. */
  newGoalPercent: number;
  /** New patients still needed to reach today's goal (0 once it is met). */
  newGoalRemaining: number;
  /** Returning patients as a share of today's visits, clamped to 100. */
  returningShare: number;
  /** Visits vs the same day last month; `null` when there is nothing to compare. */
  visitsDelta: number | null;
  /** New patients today vs the same day last month. */
  newDelta: number | null;
  /** Returning patients today vs the same day last month. */
  returningDelta: number | null;
}

export interface VisitCopy {
  /** The sentence under the headline number. */
  headline: string;
  /** Unit shown beside the returning tile's number. */
  returningUnit: string;
  /** Caption under the returning tile's bar. */
  returningCaption: string;
}

/** Non-negative whole count; anything missing or malformed counts as zero. */
function count(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

function percentOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, (part / whole) * 100);
}

function delta(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function visitMetrics(summary: VisitSummaryLike | null | undefined): VisitMetrics {
  const visits = count(summary?.total_visits);
  const newToday = count(summary?.new_patients_today);
  const returningToday = count(summary?.returning_patients_today);
  const newGoal = NEW_PATIENT_DAILY_TARGET;
  return {
    visits,
    newToday,
    returningToday,
    newGoal,
    newGoalPercent: percentOf(newToday, newGoal),
    newGoalRemaining: Math.max(0, newGoal - newToday),
    // A visit is either a new or a returning patient's; when the counts do not
    // add up (a first visit completed today is neither) the share stays honest
    // by dividing by the visits actually recorded.
    returningShare: percentOf(returningToday, visits),
    visitsDelta: delta(summary?.visits_delta_pct),
    newDelta: delta(summary?.new_patients_delta_pct),
    returningDelta: delta(summary?.returning_patients_delta_pct),
  };
}

/**
 * The card's prose. A visit is now a booking *or* a registration at the front
 * desk, so the copy says "visits" and "registered" rather than talking about
 * chairs and booked slots — a patient added today counts before they are
 * booked, and the sentence should not claim otherwise.
 */
export function visitCopy(m: VisitMetrics): VisitCopy {
  const headline =
    m.visits === 0
      ? "No patient visits yet today — register a patient or book one and it shows here."
      : `${m.newToday} new ${m.newToday === 1 ? "patient" : "patients"} and ${m.returningToday} returning, from today's bookings and registrations.`;
  return {
    headline,
    returningUnit: "today",
    returningCaption:
      m.visits === 0
        ? "No returning patients yet today"
        : `${Math.round(m.returningShare)}% of today's ${m.visits === 1 ? "visit" : "visits"}`,
  };
}
