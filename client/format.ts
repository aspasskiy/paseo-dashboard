export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

export const DOT = " · ";

export function formatNumber(n: number): string {
  const s = String(Math.round(n));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s.charAt(i);
  }
  return out;
}

export function plural(n: number, one: string, many?: string): string {
  return formatNumber(n) + " " + (n === 1 ? one : (many ?? one + "s"));
}

/** "YYYY-MM-DD" of a local date. */
export function localDayKey(date: Date): string {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return date.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (d < 10 ? "0" : "") + d;
}

export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function longDate(key: string): string {
  const day = parseDayKey(key);
  return WEEKDAYS[day.getDay()] + ", " + MONTHS[day.getMonth()] + " " + day.getDate() + ", " + day.getFullYear();
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + "m ago";
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + "h ago";
  if (ms < 30 * 86_400_000) return Math.floor(ms / 86_400_000) + "d ago";
  const d = new Date(Date.parse(iso));
  return MONTHS[d.getMonth()] + " " + d.getDate();
}

/** "45m", "3h 20m", "58h": active time at a glance. */
export function formatMinutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h >= 10) return h + "h";
  return m % 60 ? h + "h " + (m % 60) + "m" : h + "h";
}

/** Change against the previous period: "+12%", "−8%", or null when there is nothing to compare. */
export function delta(now: number, before: number): { text: string; up: boolean } | null {
  if (!before) return null;
  const d = Math.round(((now - before) / before) * 100);
  if (d === 0) return { text: "±0%", up: false };
  return { text: (d > 0 ? "+" : "−") + Math.abs(d) + "%", up: d > 0 };
}

export function pct(fraction: number): `${number}%` {
  return ((Math.max(0, Math.min(1, fraction)) * 100).toFixed(1) + "%") as `${number}%`;
}

/** Thresholds splitting the non-zero values into four heat levels by quartile. */
export function heatCuts(values: number[]): number[] {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!sorted.length) return [1, 2, 3];
  const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
  return [q(0.25), q(0.5), q(0.8)];
}

/** Heat level 0..4 of a value against heatCuts(). */
export function heatLevel(value: number, cuts: number[]): number {
  if (value <= 0) return 0;
  if (value <= cuts[0]) return 1;
  if (value <= cuts[1]) return 2;
  if (value <= cuts[2]) return 3;
  return 4;
}
