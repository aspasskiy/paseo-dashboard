import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { timeframeRpc } from "../shared/rpc";
import { baseName, isOwnHelper } from "./paths";
import { periodRange } from "./report/store";
import { ADAPTERS, collectSessions } from "./sources";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * Active time heuristic. Prompts are merged into one timeline per scope (the whole period, or one
 * project), so parallel agents are never counted twice. A gap under 30 minutes between two
 * consecutive prompts counts in full: you were at the keyboard, or waiting on an agent you had
 * just prompted. A longer gap ends a burst, and every burst gets 5 more minutes for its last
 * prompt (reading the answer), so an isolated prompt counts as 5 minutes.
 */
const BURST_GAP_MS = 30 * MINUTE_MS;
const TAIL_MS = 5 * MINUTE_MS;

function activeMs(sorted: number[], onSpan?: (at: number, ms: number) => void): number {
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const gap = i + 1 < sorted.length ? sorted[i + 1] - sorted[i] : Infinity;
    const ms = gap < BURST_GAP_MS ? gap : TAIL_MS;
    total += ms;
    onSpan?.(sorted[i], ms);
  }
  return total;
}

const minutes = (ms: number) => Math.round(ms / MINUTE_MS);

interface Window {
  startMs: number;
  endMs: number;
}

const inWindow = (at: number, w: Window) => at >= w.startMs && at < w.endMs;

/**
 * Plain numbers for one period (this week, last week, the last 30 days) and the one before it,
 * from every provider's history. No AI, no prompt text. Same boundaries as the report.
 */
export async function buildTimeframe(input: RpcInput<typeof timeframeRpc>): Promise<RpcOutput<typeof timeframeRpc>> {
  const { timeframe, tzOffsetMinutes } = input;
  const offsetMs = tzOffsetMinutes * MINUTE_MS;
  const dayKey = (ms: number) => new Date(ms - offsetMs).toISOString().slice(0, 10);
  const localHour = (ms: number) => new Date(ms - offsetMs).getUTCHours();

  const range = periodRange(timeframe, tzOffsetMinutes);
  const current: Window = { startMs: range.startMs, endMs: range.endMs };
  // The period before, of equal length. "This week" is still running, so it is compared with the
  // same stretch of last week (Monday to this time a week ago), not with the days right before
  // Monday: otherwise Monday morning would always compare against a whole weekend.
  const span = current.endMs - current.startMs;
  const previous: Window =
    timeframe === "week"
      ? { startMs: current.startMs - 7 * DAY_MS, endMs: current.endMs - 7 * DAY_MS }
      : { startMs: current.startMs - span, endMs: current.startMs };

  // Day columns: whole local days of the period; this week always shows Monday to Sunday.
  const dayCount = timeframe === "30d" ? 30 : 7;
  const days: string[] = [];
  for (let i = 0; i < dayCount; i++) days.push(dayKey(current.startMs + i * DAY_MS + DAY_MS / 2));
  const dayIndex = new Map(days.map((key, i) => [key, i]));

  const sessions = (await collectSessions({ sinceMs: Math.min(previous.startMs, current.startMs) })).filter((s) => !isOwnHelper(s.cwd));

  const dailyPrompts = new Array<number>(dayCount).fill(0);
  const dailyMs = new Array<number>(dayCount).fill(0);
  const hours = new Array<number>(24).fill(0);
  const timeline: number[] = [];
  const prevTimeline: number[] = [];
  let sessionCount = 0;
  let prevSessions = 0;
  let agents = 0;
  let tools = 0;
  const sources = new Map<string, { sessions: number; prompts: number }>();
  interface ProjectAcc {
    prompts: number[];
    sessions: number;
    daily: number[];
  }
  const projects = new Map<string, ProjectAcc>();

  for (const session of sessions) {
    const inRange = session.prompts.filter((at) => inWindow(at, current));
    const before = session.prompts.filter((at) => inWindow(at, previous));
    if (before.length) {
      prevSessions += 1;
      for (const at of before) prevTimeline.push(at);
    }
    if (session.source === "paseo" && inWindow(session.startedAt, current)) agents += 1;
    for (const at of session.tools) if (inWindow(at, current)) tools += 1;
    if (!inRange.length) continue;

    sessionCount += 1;
    const src = sources.get(session.source) ?? { sessions: 0, prompts: 0 };
    src.sessions += 1;
    src.prompts += inRange.length;
    sources.set(session.source, src);

    let project = projects.get(session.cwd);
    if (!project) {
      project = { prompts: [], sessions: 0, daily: new Array<number>(dayCount).fill(0) };
      projects.set(session.cwd, project);
    }
    project.sessions += 1;
    for (const at of inRange) {
      timeline.push(at);
      project.prompts.push(at);
      hours[localHour(at)] += 1;
      const i = dayIndex.get(dayKey(at));
      if (i !== undefined) {
        dailyPrompts[i] += 1;
        project.daily[i] += 1;
      }
    }
  }

  const byTime = (a: number, b: number) => a - b;
  timeline.sort(byTime);
  prevTimeline.sort(byTime);
  const totalMs = activeMs(timeline, (at, ms) => {
    const i = dayIndex.get(dayKey(at));
    if (i !== undefined) dailyMs[i] += ms;
  });
  const prevMs = activeMs(prevTimeline);
  const activeDayCount = (list: number[]) => new Set(list.map(dayKey)).size;

  const projectRows = Array.from(projects.entries())
    .map(([path, row]) => {
      row.prompts.sort(byTime);
      return {
        path,
        name: path ? baseName(path) : "No folder",
        prompts: row.prompts.length,
        sessions: row.sessions,
        share: timeline.length ? row.prompts.length / timeline.length : 0,
        daily: row.daily,
        activeMinutes: minutes(activeMs(row.prompts)),
        lastAt: row.prompts.length ? new Date(row.prompts[row.prompts.length - 1]).toISOString() : null,
      };
    })
    .sort((a, b) => b.prompts - a.prompts || b.activeMinutes - a.activeMinutes || a.name.localeCompare(b.name));

  return {
    timeframe,
    days,
    dailyPrompts,
    dailyMinutes: dailyMs.map(minutes),
    prompts: timeline.length,
    sessions: sessionCount,
    activeDays: activeDayCount(timeline),
    // Sessions without a working folder are shown (as "No folder") but are not a project.
    projectsCount: projectRows.filter((p) => p.path).length,
    agents,
    tools,
    activeMinutes: minutes(totalMs),
    hours,
    previous: {
      prompts: prevTimeline.length,
      sessions: prevSessions,
      activeDays: activeDayCount(prevTimeline),
      activeMinutes: minutes(prevMs),
    },
    sources: ADAPTERS.filter((a) => sources.has(a.id))
      .map((a) => ({ id: a.id, label: a.label, sessions: sources.get(a.id)!.sessions, prompts: sources.get(a.id)!.prompts }))
      .sort((a, b) => b.prompts - a.prompts),
    projects: projectRows,
  };
}
