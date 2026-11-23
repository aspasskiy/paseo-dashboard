import { Icon } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { Timeframe, TimeframeStats } from "../shared/rpc";
import { DOT, MONTHS, WEEKDAY_LETTERS, WEEKDAYS, delta, formatMinutes, formatNumber, parseDayKey, pct, plural } from "./format";
import { NUM, usePalette } from "./kit";
import { mix, type Palette } from "./theme";

// The period switch and the widget tiles. Every tile is its own block on the grid (catalog.tsx
// lists them as "w:<id>"): a label, one number and a tiny chart, scaled to the width it gets.

/** The global period switch: drives the widgets, the focus block and the report. */
export const TIMEFRAMES: { id: Timeframe; label: string; noun: string }[] = [
  { id: "week", label: "This week", noun: "this week" },
  { id: "last-week", label: "Last week", noun: "last week" },
  { id: "30d", label: "30 days", noun: "the last 30 days" },
];

// --- Tile sizes. A tile is 2 to 6 grid columns (~150 to ~560 px). Three steps, so a wide tile reads
// as a deliberate larger tile (bigger number, taller chart with an axis), not a stretched small one.

interface TileSize {
  step: "s" | "m" | "l";
  /** Chart height. */
  h: number;
  /** Labels under the charts. */
  axis: boolean;
}

function tileSize(width: number): TileSize {
  if (width >= 400) return { step: "l", h: 48, axis: true };
  if (width >= 240) return { step: "m", h: 32, axis: false };
  return { step: "s", h: 20, axis: false };
}

const VALUE_TEXT = { s: { fontSize: 18, lineHeight: 24 }, m: { fontSize: 22, lineHeight: 28 }, l: { fontSize: 28, lineHeight: 34 } } as const;

// --- Catalog

interface WidgetDef {
  id: string;
  title: string;
  icon: string;
  description: string;
  render(s: TimeframeStats, todayKey: string, z: TileSize): WidgetBody;
}

interface WidgetBody {
  value: string;
  unit?: string;
  change?: { text: string; up: boolean } | null;
  chart: ReactNode;
}

export const WIDGETS: WidgetDef[] = [
  {
    id: "prompts",
    title: "Prompts",
    icon: "MessageSquare",
    description: "Prompts you typed in the period, per day",
    render: (s, today, z) => ({
      value: formatNumber(s.prompts),
      change: delta(s.prompts, s.previous.prompts),
      chart: <DayBars values={s.dailyPrompts} days={s.days} todayKey={today} z={z} />,
    }),
  },
  {
    id: "time",
    title: "Active time",
    icon: "Clock",
    description: "Time spent working with agents, per day",
    render: (s, today, z) => ({
      value: formatMinutes(s.activeMinutes),
      change: delta(s.activeMinutes, s.previous.activeMinutes),
      chart: <DayBars values={s.dailyMinutes} days={s.days} todayKey={today} z={z} />,
    }),
  },
  {
    id: "sessions",
    title: "Sessions",
    icon: "MessagesSquare",
    description: "Agent sessions and prompts per session",
    render: (s) => ({
      value: formatNumber(s.sessions),
      change: delta(s.sessions, s.previous.sessions),
      chart: <Caption text={s.sessions ? (s.prompts / s.sessions).toFixed(1).replace(/\.0$/, "") + " prompts each" : "None yet"} />,
    }),
  },
  {
    id: "days",
    title: "Active days",
    icon: "CalendarDays",
    description: "Days with at least one prompt",
    render: (s, today, z) => ({
      value: String(s.activeDays),
      unit: "of " + s.days.filter((d) => d <= today).length,
      change: s.timeframe === "week" ? null : delta(s.activeDays, s.previous.activeDays),
      chart: <DayDots values={s.dailyPrompts} days={s.days} todayKey={today} z={z} />,
    }),
  },
  {
    id: "peak",
    title: "Peak hour",
    icon: "Sun",
    description: "The hour of day you prompt the most",
    render: (s, _today, z) => {
      const peak = s.hours.reduce((best, v, h) => (v > s.hours[best] ? h : best), 0);
      const any = s.hours[peak] > 0;
      return { value: any ? hourLabel(peak) : "-", chart: <HourBars hours={s.hours} peak={any ? peak : -1} z={z} /> };
    },
  },
  {
    id: "sources",
    title: "Sources",
    icon: "Layers",
    description: "Where your prompts came from: terminal, Paseo and others",
    render: (s, _today, z) => {
      const top = s.sources[0];
      const share = top && s.prompts ? Math.round((top.prompts / s.prompts) * 100) : 0;
      return {
        value: top ? share + "%" : "-",
        unit: top ? top.label : undefined,
        chart: <SplitBar parts={s.sources.map((x) => ({ key: x.id, label: x.label, value: x.prompts }))} skipFirst z={z} />,
      };
    },
  },
  {
    id: "projects",
    title: "Projects",
    icon: "FolderGit2",
    description: "How many projects you touched and their split",
    render: (s, _today, z) => ({
      value: String(s.projectsCount),
      chart: <SplitBar parts={s.projects.map((x) => ({ key: x.path || "none", label: x.name, value: x.prompts }))} z={z} />,
    }),
  },
  {
    id: "busiest",
    title: "Busiest day",
    icon: "Flame",
    description: "The day of the period with the most prompts",
    render: (s, today, z) => {
      let best = -1;
      s.dailyPrompts.forEach((v, i) => {
        if (v > 0 && (best < 0 || v > s.dailyPrompts[best])) best = i;
      });
      const d = best >= 0 ? parseDayKey(s.days[best]) : null;
      return {
        value: d ? (s.timeframe === "30d" ? MONTHS[d.getMonth()] + " " + d.getDate() : WEEKDAYS[d.getDay()]) : "-",
        unit: best >= 0 ? plural(s.dailyPrompts[best], "prompt") : undefined,
        chart: <DayBars values={s.dailyPrompts} days={s.days} todayKey={today} mark={best} z={z} />,
      };
    },
  },
  {
    id: "agents",
    title: "Paseo agents",
    icon: "Bot",
    description: "Paseo agents started and their share of sessions",
    render: (s) => ({
      value: formatNumber(s.agents),
      unit: "started",
      chart: (
        <Caption
          text={s.sessions ? Math.round(((s.sources.find((x) => x.id === "paseo")?.sessions ?? 0) / s.sessions) * 100) + "% of sessions ran in Paseo" : "None yet"}
        />
      ),
    }),
  },
  {
    id: "tools",
    title: "Tool calls",
    icon: "Wrench",
    description: "Tool calls your agents made, per prompt",
    render: (s) => ({
      value: formatNumber(s.tools),
      chart: <Caption text={s.prompts ? (s.tools / s.prompts).toFixed(1).replace(/\.0$/, "") + " per prompt" : "None yet"} />,
    }),
  },
];

export const DEFAULT_WIDGETS = ["prompts", "time", "sessions", "days", "peak", "sources"];

function hourLabel(h: number): string {
  return (h < 10 ? "0" : "") + h + ":00";
}

// --- One tile: a grid block of its own. flex: 1 so the grid can stretch tiles of a row to one
// height; the chart sits at the bottom so stretched tiles keep their charts on one line.

export function WidgetTile({ def, stats, todayKey, width }: { def: WidgetDef; stats: TimeframeStats; todayKey: string; width: number }) {
  const p = usePalette();
  const z = tileSize(width);
  const body = def.render(stats, todayKey, z);
  const big = z.step === "l";
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: p.card,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: p.border,
        paddingHorizontal: big ? 16 : z.step === "m" ? 14 : 12,
        paddingTop: big ? 14 : 10,
        paddingBottom: big ? 16 : 12,
        gap: big ? 6 : 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name={def.icon} size={big ? 14 : 12} color={p.muted} />
        <Text style={{ color: p.muted, fontSize: 12, flex: 1 }} numberOfLines={1}>
          {def.title}
        </Text>
        {body.change ? (
          <Text style={[{ color: body.change.up ? p.success : p.muted, fontSize: 12 }, NUM]} numberOfLines={1}>
            {body.change.text}
            {big ? <Text style={{ color: p.muted }}>{" vs before"}</Text> : null}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: big ? 8 : 5, minWidth: 0 }}>
        <Text style={[{ color: p.fg, fontWeight: "600", flexShrink: 1 }, VALUE_TEXT[z.step], NUM]} numberOfLines={1}>
          {body.value}
        </Text>
        {body.unit ? (
          <Text style={[{ color: p.muted, fontSize: big ? 14 : 12, flexShrink: 1 }, NUM]} numberOfLines={1}>
            {body.unit}
          </Text>
        ) : null}
      </View>
      <View style={{ flex: 1 }} />
      <View style={{ minHeight: z.h + 2, justifyContent: "flex-end", marginTop: big ? 4 : 0 }}>{body.chart}</View>
    </View>
  );
}

// --- Tiny charts. Bars in the activity hue; the future is an empty baseline, not a zero.

/** Labels under a row of flex cells, lined up with the bars above (same gap). */
function Axis({ labels, gap, highlight }: { labels: (string | null)[]; gap: number; highlight?: number }) {
  const p = usePalette();
  const many = labels.length > 10;
  return (
    <View style={{ flexDirection: "row", gap, height: 14, marginTop: 4 }}>
      {labels.map((label, i) => (
        <View key={i} style={{ flex: 1, alignItems: many ? "flex-start" : "center" }}>
          {label ? (
            <Text
              style={[
                { color: i === highlight ? p.fg : p.muted, fontSize: 10, lineHeight: 14, fontWeight: i === highlight ? "500" : "400" },
                // Wider than its cell: hangs to the right, so it must not be clipped (numberOfLines would).
                many ? { position: "absolute", left: 0, width: 44 } : null,
                NUM,
              ]}
              numberOfLines={many ? undefined : 1}
            >
              {label}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** Weekday letters for a week; the date of each Monday for 30 days. */
function dayLabels(days: string[]): (string | null)[] {
  const many = days.length > 10;
  return days.map((key) => {
    const d = parseDayKey(key);
    if (!many) return WEEKDAY_LETTERS[d.getDay()];
    return d.getDay() === 1 ? String(d.getDate()) : null;
  });
}

function DayBars({ values, days, todayKey, mark, z }: { values: number[]; days: string[]; todayKey: string; mark?: number; z: TileSize }) {
  const p = usePalette();
  const max = Math.max(1, ...values);
  const many = values.length > 10;
  const gap = many ? (z.step === "l" ? 2 : 1) : z.step === "l" ? 10 : z.step === "m" ? 8 : 6;
  return (
    <View>
      <View style={{ height: z.h, flexDirection: "row", alignItems: "flex-end", gap }}>
        {values.map((v, i) => {
          const future = days[i] > todayKey;
          const color = future ? p.heatLevels[0] : mark !== undefined && mark >= 0 && i !== mark ? p.heatLevels[2] : v > 0 ? p.heat : p.heatLevels[0];
          return (
            <View
              key={i}
              style={{ flex: 1, height: future || !v ? 2 : Math.max(3, Math.round((v / max) * z.h)), borderRadius: z.step === "l" ? 2 : 1, backgroundColor: color }}
            />
          );
        })}
      </View>
      {z.axis ? <Axis labels={dayLabels(days)} gap={gap} highlight={days.indexOf(todayKey)} /> : null}
    </View>
  );
}

function DayDots({ values, days, todayKey, z }: { values: number[]; days: string[]; todayKey: string; z: TileSize }) {
  const p = usePalette();
  const many = values.length > 10;
  const dot = many ? (z.step === "l" ? 14 : 8) : z.step === "l" ? 20 : z.step === "m" ? 14 : 10;
  return (
    <View>
      <View style={{ flexDirection: "row", gap: many ? 2 : z.step === "s" ? 4 : 6, alignItems: "center", minHeight: z.axis ? undefined : z.h }}>
        {values.map((v, i) => {
          const future = days[i] > todayKey;
          const d = parseDayKey(days[i]);
          return (
            <View key={i} style={{ flex: 1, alignItems: "center", gap: 2 }}>
              <View
                style={{
                  alignSelf: "stretch",
                  height: dot,
                  borderRadius: z.step === "l" ? 3 : 2,
                  backgroundColor: future ? "transparent" : v > 0 ? p.heat : p.heatLevels[0],
                  borderWidth: future ? 1 : 0,
                  borderColor: p.border,
                }}
              />
              {many || z.axis ? null : (
                <Text style={{ color: days[i] === todayKey ? p.fg : p.muted, fontSize: 9, lineHeight: 10 }}>{WEEKDAY_LETTERS[d.getDay()]}</Text>
              )}
            </View>
          );
        })}
      </View>
      {z.axis ? <Axis labels={dayLabels(days)} gap={many ? 2 : 6} highlight={days.indexOf(todayKey)} /> : null}
    </View>
  );
}

function HourBars({ hours, peak, z }: { hours: number[]; peak: number; z: TileSize }) {
  const p = usePalette();
  const max = Math.max(1, ...hours);
  const gap = z.step === "l" ? 2 : 1;
  return (
    <View>
      <View style={{ height: z.h, flexDirection: "row", alignItems: "flex-end", gap }}>
        {hours.map((v, h) => (
          <View
            key={h}
            style={{
              flex: 1,
              height: v ? Math.max(2, Math.round((v / max) * z.h)) : 1,
              borderRadius: 1,
              backgroundColor: h === peak ? p.heat : v ? p.neutral : p.heatLevels[0],
            }}
          />
        ))}
      </View>
      {z.axis ? <Axis labels={hours.map((_, h) => (h % 6 === 0 ? hourLabel(h) : null))} gap={gap} /> : null}
    </View>
  );
}

const RANK_FADE = [0, 0.3, 0.5, 0.66, 0.78];

/** Shades of the activity hue by rank, fading toward the card; the long tail is neutral. */
export function rankColor(p: Palette, rank: number): string {
  if (rank === 0) return p.heat;
  return rank < RANK_FADE.length ? mix(p.heat, p.card, RANK_FADE[rank]) : p.neutral;
}

/** skipFirst: the tile's number already names the top part, so the legend starts at the second. */
function SplitBar({ parts, skipFirst, z }: { parts: { key: string; label: string; value: number }[]; skipFirst?: boolean; z: TileSize }) {
  const p = usePalette();
  const total = parts.reduce((a, x) => a + x.value, 0);
  const shown = parts.filter((x) => x.value > 0);
  const legendCount = z.step === "l" ? 4 : z.step === "m" ? 3 : 2;
  const from = skipFirst ? 1 : 0;
  const legend = shown
    .slice(from, from + legendCount)
    .map((x) => x.label + " " + Math.round((x.value / Math.max(1, total)) * 100) + "%")
    .join(DOT);
  const barH = z.step === "l" ? 10 : z.step === "m" ? 8 : 6;
  return (
    <View style={{ gap: z.step === "l" ? 6 : 4 }}>
      <View style={{ height: barH, flexDirection: "row", gap: 2, borderRadius: barH / 2, overflow: "hidden", backgroundColor: total ? "transparent" : p.heatLevels[0] }}>
        {shown.map((x, i) => (
          <View key={x.key} style={{ width: pct(x.value / total), flexShrink: 1, minWidth: 2, backgroundColor: rankColor(p, i) }} />
        ))}
      </View>
      <Text style={[{ color: p.muted, fontSize: z.step === "s" ? 11 : 12, lineHeight: z.step === "s" ? 12 : 16 }, NUM]} numberOfLines={1}>
        {legend || " "}
      </Text>
    </View>
  );
}

function Caption({ text }: { text: string }) {
  const p = usePalette();
  return (
    <Text style={[{ color: p.muted, fontSize: 12, lineHeight: 16 }, NUM]} numberOfLines={1}>
      {text}
    </Text>
  );
}
