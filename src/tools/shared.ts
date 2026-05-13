import type { Priority, Reminder } from "../types.js";

export const PRIORITY_VALUES = ["none", "high", "medium", "low"] as const;

export type DueFilter = "overdue" | "today" | "this_week" | "no_date" | "any";

/** Parse a `due` input into a JS Date + all-day flag, or null. Throws on malformed input.
 *
 *  - `YYYY-MM-DD`  → all-day (unless allDayOverride is false)
 *  - ISO 8601 with time component → timed
 */
export function parseDueInput(due: string, allDayOverride?: boolean): { date: Date; allDay: boolean } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    const [y, m, d] = due.split("-").map(Number) as [number, number, number];
    const date = new Date(y, m - 1, d, 0, 0, 0, 0);
    if (Number.isNaN(date.getTime())) throw new Error(`Malformed date: ${due}`);
    return { date, allDay: allDayOverride ?? true };
  }
  const ms = Date.parse(due);
  if (!Number.isFinite(ms)) throw new Error(`Malformed date: ${due}`);
  return { date: new Date(ms), allDay: allDayOverride ?? false };
}

/** Parse a `due` value (ISO 8601 or YYYY-MM-DD) into ms since epoch, or null. */
export function dueMillis(due: string | null): number | null {
  if (!due) return null;
  // YYYY-MM-DD (all-day) — interpret as local midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    const [y, m, d] = due.split("-").map(Number) as [number, number, number];
    return new Date(y, m - 1, d).getTime();
  }
  const t = Date.parse(due);
  return Number.isFinite(t) ? t : null;
}

export function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfTodayMs(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function endOfThisWeekMs(): number {
  // Monday-start ISO week, exclusive end on next Monday 00:00.
  const now = new Date();
  const dow = now.getDay() || 7; // Sun=0 → 7
  const startOfWeek = new Date(now);
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - (dow - 1));
  const end = new Date(startOfWeek);
  end.setDate(end.getDate() + 7);
  return end.getTime();
}

export function matchesDueFilter(r: Reminder, f: DueFilter): boolean {
  if (f === "any") return true;
  const t = dueMillis(r.due);
  switch (f) {
    case "no_date":
      return t === null;
    case "overdue":
      return t !== null && t < startOfTodayMs() && !r.completed;
    case "today":
      return t !== null && t >= startOfTodayMs() && t <= endOfTodayMs();
    case "this_week":
      return t !== null && t >= startOfTodayMs() && t < endOfThisWeekMs();
  }
}

/** Default sort: overdue → ascending due → undated last. Ties broken by title. */
export function sortReminders(rs: Reminder[]): Reminder[] {
  const now = startOfTodayMs();
  return [...rs].sort((a, b) => {
    const ta = dueMillis(a.due);
    const tb = dueMillis(b.due);
    const aOver = ta !== null && ta < now && !a.completed;
    const bOver = tb !== null && tb < now && !b.completed;
    if (aOver && !bOver) return -1;
    if (!aOver && bOver) return 1;
    if (ta === null && tb === null) return a.title.localeCompare(b.title);
    if (ta === null) return 1;
    if (tb === null) return -1;
    if (ta !== tb) return ta - tb;
    return a.title.localeCompare(b.title);
  });
}

export function matchesPriority(r: Reminder, p?: Priority): boolean {
  if (!p) return true;
  return r.priority === p;
}

export function matchesTags(r: Reminder, want?: string[]): boolean {
  if (!want || want.length === 0) return true;
  const set = new Set(r.tags.map((t) => t.toLowerCase()));
  return want.some((t) => set.has(t.toLowerCase().replace(/^#/, "")));
}

export function matchesStatus(r: Reminder, status: "open" | "completed" | "all"): boolean {
  if (status === "all") return true;
  if (status === "open") return !r.completed;
  return r.completed;
}
