import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { DayActivity, overviewRpc } from "../shared/rpc";
import { ADAPTERS, collectSessions } from "./sources";

const DAY_MS = 86_400_000;
const HEATMAP_DAYS = 53 * 7;

type DayRow = Omit<DayActivity, "date">;

/** Activity over every session of every detected agent CLI. Never sends prompt text. */
export async function buildOverview(input: RpcInput<typeof overviewRpc>): Promise<RpcOutput<typeof overviewRpc>> {
  const offsetMs = input.tzOffsetMinutes * 60_000;
  const dayKey = (ms: number) => new Date(ms - offsetMs).toISOString().slice(0, 10);

  const days = new Map<string, DayRow>();
  const day = (key: string): DayRow => {
    let row = days.get(key);
    if (!row) {
      row = { prompts: 0, bySource: {}, agents: 0, tools: 0 };
      days.set(key, row);
    }
    return row;
  };
  const sources = new Map<string, { sessions: number; prompts: number }>();

  for (const session of await collectSessions()) {
    const src = sources.get(session.source) ?? { sessions: 0, prompts: 0 };
    src.sessions += 1;
    src.prompts += session.prompts.length;
    sources.set(session.source, src);
    if (session.source === "paseo") day(dayKey(session.startedAt)).agents += 1;
    for (const at of session.prompts) {
      const row = day(dayKey(at));
      row.prompts += 1;
      row.bySource[session.source] = (row.bySource[session.source] ?? 0) + 1;
    }
    for (const at of session.tools) day(dayKey(at)).tools += 1;
  }

  // Heatmap window: 53 full weeks ending with this week's Sunday.
  const now = Date.now();
  const todayStartUtc = Date.parse(dayKey(now) + "T00:00:00Z") + offsetMs;
  const todayWeekday = (new Date(now - offsetMs).getUTCDay() + 6) % 7; // Monday = 0
  const endMs = todayStartUtc + (6 - todayWeekday) * DAY_MS;
  const startMs = endMs - (HEATMAP_DAYS - 1) * DAY_MS;
  const dayRows: DayActivity[] = [];
  for (let i = 0; i < HEATMAP_DAYS; i++) {
    const key = dayKey(startMs + i * DAY_MS + DAY_MS / 2);
    const row = days.get(key);
    dayRows.push({ date: key, prompts: row?.prompts ?? 0, bySource: { ...row?.bySource }, agents: row?.agents ?? 0, tools: row?.tools ?? 0 });
  }

  let busiestDay: { date: string; count: number } | null = null;
  for (const [key, row] of days) if (!busiestDay || row.prompts > busiestDay.count) busiestDay = { date: key, count: row.prompts };
  const active = Array.from(days.entries())
    .filter(([, row]) => row.prompts + row.agents > 0)
    .map(([key]) => key)
    .sort();

  return {
    days: dayRows,
    totals: { firstDay: regularStart(active), busiestDay },
    sources: ADAPTERS.filter((a) => sources.has(a.id)).map((a) => ({ id: a.id, label: a.label, ...sources.get(a.id)! })),
  };
}

/**
 * Where regular use begins: the first active day followed by at least 5 active days within 30 days.
 * A few stray old sessions (a CLI tried once a year ago) shouldn't stretch the heatmap over empty months.
 */
function regularStart(active: string[]): string | null {
  for (let i = 0; i < active.length; i++) {
    const limit = Date.parse(active[i]) + 30 * DAY_MS;
    let n = 0;
    for (let j = i; j < active.length && Date.parse(active[j]) < limit; j++) n++;
    if (n >= 5) return active[i];
  }
  return active[0] ?? null;
}
