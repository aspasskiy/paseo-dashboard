import { join } from "node:path";
import { dataDir } from "../paths";

// The report's files: the notes cache, the last report per period, the settings and the helper
// agents' empty working folder.
export const notesFile = () => join(dataDir(), "report-notes.json");
export const reportsFile = () => join(dataDir(), "report-cache.json");
export const settingsFile = () => join(dataDir(), "report-settings.json");
/** An empty folder for the helper agents, so they load no project's instructions. */
export const helperDir = () => join(dataDir(), "report-helper");

// Periods

const DAY = 86_400_000;
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface PeriodRange {
  startMs: number;
  endMs: number;
  /** "Nov 16 – Nov 22" (local days, end inclusive). */
  label: string;
  /** "this week (since Monday)", for the synthesis prompt. */
  description: string;
}

/** Local-time bounds of a period. `tzOffsetMinutes` is the client's Date#getTimezoneOffset(). */
export function periodRange(period: "week" | "last-week" | "30d", tzOffsetMinutes: number, now = Date.now()): PeriodRange {
  const shift = -tzOffsetMinutes * 60_000;
  const local = new Date(now + shift);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - shift;
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  const monday = midnight - sinceMonday * DAY;
  const day = (ms: number) => {
    const d = new Date(ms + shift);
    return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
  };
  const make = (startMs: number, endMs: number, description: string) => ({
    startMs,
    endMs,
    description,
    label: day(startMs) + " – " + day(Math.max(startMs, endMs - 1)),
  });
  if (period === "week") return make(monday, now, "this week (since Monday)");
  if (period === "last-week") return make(monday - 7 * DAY, monday, "last week (Monday to Sunday)");
  return make(midnight - 29 * DAY, now, "the last 30 days");
}

/** Local calendar day number of an epoch-ms time. */
export function localDay(ms: number, tzOffsetMinutes: number): number {
  return Math.floor((ms - tzOffsetMinutes * 60_000) / DAY);
}
