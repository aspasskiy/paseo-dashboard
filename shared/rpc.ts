import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** One local calendar day, "YYYY-MM-DD". */
export const dayActivitySchema = z.object({
  date: z.string(),
  /** User prompts that day, across every source. */
  prompts: z.number(),
  /** The same prompts by source id ("paseo", "claude", "codex", ...); sources with none are left out. */
  bySource: z.record(z.string(), z.number()),
  /** Paseo agents started that day. */
  agents: z.number(),
  /** Tool calls that day (sources that record them; terminal Claude Code only in short windows). */
  tools: z.number(),
});

export const sourceStatSchema = z.object({
  /** Source id: "paseo", "claude", "codex", "gemini", "opencode", "copilot", "pi", "omp". */
  id: z.string(),
  label: z.string(),
  sessions: z.number(),
  prompts: z.number(),
});

/** All-time activity for the heatmap. */
export const overviewSchema = z.object({
  /** 53 full weeks ending with this week's Sunday, oldest first. */
  days: z.array(dayActivitySchema),
  totals: z.object({
    /** Where regular use begins (a few stray old sessions don't count). */
    firstDay: z.string().nullable(),
    busiestDay: z.object({ date: z.string(), count: z.number() }).nullable(),
  }),
  /** Detected sources with data, in display order. */
  sources: z.array(sourceStatSchema),
});

export type Overview = z.infer<typeof overviewSchema>;
export type DayActivity = z.infer<typeof dayActivitySchema>;

export const overviewRpc = defineRpc({
  name: "dashboard.overview",
  input: z.object({ tzOffsetMinutes: z.number() }),
  output: overviewSchema,
});

/** One grid item: a block id from the client catalog and its width in columns (1..12). */
export const layoutItemSchema = z.object({ id: z.string(), w: z.number() });
export type LayoutItem = z.infer<typeof layoutItemSchema>;

/**
 * Saved dashboard layout. v3 (current) = `{ version: 3, items }`: every block is a top-level item
 * of a 12-column grid. v2 files carry `blocks` with full/half sizes and an optional `widgets` list;
 * they still parse and the client migrates them on load (client/grid/model.ts).
 */
export const layoutSchema = z.object({
  version: z.number().optional(),
  items: z.array(layoutItemSchema).optional(),
  /** Legacy v2 blocks. */
  blocks: z.array(z.object({ id: z.string(), size: z.string() })).optional(),
  /** Legacy v2: tiles shown in the old widgets block, in order; missing = the default set. */
  widgets: z.array(z.string()).optional(),
});
export type DashboardLayout = z.infer<typeof layoutSchema>;

export const layoutGetRpc = defineRpc({
  name: "layout.get",
  input: z.object({}),
  output: z.object({ layout: layoutSchema.nullable() }),
});

export const layoutSetRpc = defineRpc({
  name: "layout.set",
  input: z.object({ layout: layoutSchema }),
  output: z.object({ ok: z.boolean() }),
});

// Timeframe: plain numbers for one period, no AI. Drives the widgets and the Focus block.
// Periods match the report's, so one switch drives both.

export const timeframeSchema = z.enum(["week", "last-week", "30d"]);
export type Timeframe = z.infer<typeof timeframeSchema>;

export const focusProjectSchema = z.object({
  /** Absolute cwd (key for project icons); "" when unknown. */
  path: z.string(),
  name: z.string(),
  prompts: z.number(),
  sessions: z.number(),
  /** Share of the period's prompts, 0..1. */
  share: z.number(),
  /** Prompts per day, one entry per day of the period (same order as `days`). */
  daily: z.array(z.number()),
  /** Estimated active minutes (gaps under 30 min between prompts count). */
  activeMinutes: z.number(),
  lastAt: z.string().nullable(),
});

export const timeframeStatsSchema = z.object({
  timeframe: timeframeSchema,
  /** Local day keys "YYYY-MM-DD" in the period, oldest first, future days of this week included. */
  days: z.array(z.string()),
  /** Prompts per day, aligned to `days`. */
  dailyPrompts: z.array(z.number()),
  /** Estimated active minutes per day, aligned to `days` (same heuristic as `activeMinutes`). */
  dailyMinutes: z.array(z.number()),
  prompts: z.number(),
  sessions: z.number(),
  activeDays: z.number(),
  projectsCount: z.number(),
  agents: z.number(),
  tools: z.number(),
  activeMinutes: z.number(),
  /** Prompts by local hour 0..23 inside the period. */
  hours: z.array(z.number()),
  /** Same stats for the previous period of equal length, for deltas. */
  previous: z.object({ prompts: z.number(), sessions: z.number(), activeDays: z.number(), activeMinutes: z.number() }),
  /** Prompts by source inside the period, sources with data only. */
  sources: z.array(sourceStatSchema),
  /** Sorted by prompts desc; all projects with any prompt in the period. */
  projects: z.array(focusProjectSchema),
});
export type TimeframeStats = z.infer<typeof timeframeStatsSchema>;
export type FocusProject = z.infer<typeof focusProjectSchema>;

export const timeframeRpc = defineRpc({
  name: "dashboard.timeframe",
  input: z.object({ timeframe: timeframeSchema, tzOffsetMinutes: z.number() }),
  output: timeframeStatsSchema,
});
