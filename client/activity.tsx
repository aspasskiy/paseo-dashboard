import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { DayActivity, Overview } from "../shared/rpc";
import { NUM, usePalette } from "./kit";
import { DOT, MONTHS, formatNumber, heatCuts, heatLevel, longDate, parseDayKey, plural } from "./format";

const GAP = 3;
const LABEL_W = 30;
const MIN_CELL = 9;
const MAX_CELL = 16;

/** "Paseo 30, Codex 12" for a day with prompts from more than one source; neutral text, no colours. */
function sourceSplit(day: DayActivity, overview: Overview): string {
  const parts = overview.sources
    .filter((s) => (day.bySource[s.id] ?? 0) > 0)
    .map((s) => s.label + " " + formatNumber(day.bySource[s.id]));
  return parts.length > 1 ? " (" + parts.join(", ") + ")" : "";
}

function shortDay(key: string): string {
  const d = parseDayKey(key);
  return MONTHS[d.getMonth()] + " " + d.getDate();
}

/**
 * A grid block: a year of prompts as a heatmap, with the busiest day (or the hovered day) under it;
 * period numbers live in the widget tiles. The weeks of the selected period are marked under the
 * grid, tying the heatmap to the widgets. Sized from the block width the grid measured: narrower
 * blocks show fewer, most recent weeks.
 */
export function ActivityHeatmap({
  overview,
  todayKey,
  period,
  width,
}: {
  overview: Overview;
  todayKey: string;
  /** First and last local day key of the selected timeframe. */
  period?: { from: string; to: string };
  /** Outer width of the block (card included); 0 until measured. */
  width: number;
}) {
  const p = usePalette();
  const [selected, setSelected] = useState<string | null>(null);
  const days = overview.days;
  const allWeeks = Math.ceil(days.length / 7);
  // Start at the first week with data (at least half a year), and on narrow screens keep
  // only the most recent weeks that fit at a readable size.
  // totals.firstDay is where regular use starts (the server skips a few stray old sessions).
  const start = overview.totals.firstDay;
  const firstData = start ? days.findIndex((d) => d.date >= start) : days.findIndex((d) => d.prompts > 0 || d.agents > 0);
  const dataWeeks = firstData < 0 ? 26 : allWeeks - Math.floor(firstData / 7);
  // Card content box = block width minus padding (16 each side) and the 1px border.
  const gridWidth = width > 0 ? width - 34 : 0;
  const fit = gridWidth ? Math.floor((gridWidth - LABEL_W + GAP) / (MIN_CELL + GAP)) : allWeeks;
  const weeks = Math.max(4, Math.min(allWeeks, Math.max(26, dataWeeks), fit));
  const firstWeek = allWeeks - weeks;
  const past = useMemo(() => days.filter((d) => d.date <= todayKey), [days, todayKey]);
  const cuts = useMemo(() => heatCuts(past.map((d) => d.prompts)), [past]);
  const cell = gridWidth ? Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor((gridWidth - LABEL_W - GAP * (weeks - 1)) / weeks))) : 12;

  const monthLabels: { col: number; label: string }[] = [];
  for (let col = 0; col < weeks; col++) {
    const w = firstWeek + col;
    const first = days[w * 7];
    if (!first) continue;
    const date = parseDayKey(first.date);
    const prev = col > 0 ? parseDayKey(days[(w - 1) * 7].date) : null;
    if (!prev || prev.getMonth() !== date.getMonth()) {
      const last = monthLabels[monthLabels.length - 1];
      if (!last || col - last.col >= 3) monthLabels.push({ col, label: MONTHS[date.getMonth()] });
    }
  }

  // Columns (weeks) that hold a day of the selected period.
  const marked: number[] = [];
  if (period) {
    for (let col = 0; col < weeks; col++) {
      const week = days.slice((firstWeek + col) * 7, (firstWeek + col) * 7 + 7);
      if (week.some((d) => d.date >= period.from && d.date <= period.to)) marked.push(col);
    }
  }

  const shown = selected ? (days.find((d) => d.date === selected) ?? null) : null;
  const t = overview.totals;

  return (
    <View style={{ flex: 1, backgroundColor: p.card, borderRadius: 8, borderWidth: 1, borderColor: p.border, padding: 16, gap: 12 }}>
      <View>
        <View style={{ height: 18, marginLeft: LABEL_W }}>
          {monthLabels.map((m) => (
            <Text key={m.col} style={{ position: "absolute", left: m.col * (cell + GAP), color: p.muted, fontSize: 12 }}>
              {m.label}
            </Text>
          ))}
        </View>
        <View style={{ flexDirection: "row" }}>
          <View style={{ width: LABEL_W, gap: GAP }}>
            {["Mon", "", "Wed", "", "Fri", "", ""].map((label, i) => (
              <Text key={i} style={{ height: cell, lineHeight: cell, color: p.muted, fontSize: 11 }}>
                {label}
              </Text>
            ))}
          </View>
          <View style={{ flexDirection: "row", gap: GAP }}>
            {Array.from({ length: weeks }, (_, col) => firstWeek + col).map((w) => (
              <View key={w} style={{ gap: GAP }}>
                {days.slice(w * 7, w * 7 + 7).map((day) => {
                  const future = day.date > todayKey;
                  const level = heatLevel(day.prompts, cuts);
                  const ring = day.date === selected ? p.fg : day.date === todayKey ? p.muted : null;
                  return (
                    <Pressable
                      key={day.date}
                      disabled={future}
                      accessibilityLabel={longDate(day.date) + DOT + plural(day.prompts, "prompt")}
                      onPress={() => setSelected(day.date === selected ? null : day.date)}
                      onHoverIn={() => setSelected(day.date)}
                      onHoverOut={() => setSelected(null)}
                      style={{
                        width: cell,
                        height: cell,
                        borderRadius: 3,
                        backgroundColor: future ? "transparent" : p.heatLevels[level],
                        borderWidth: ring ? 1 : 0,
                        borderColor: ring ?? "transparent",
                      }}
                    />
                  );
                })}
              </View>
            ))}
          </View>
        </View>
        <View style={{ height: 6, marginLeft: LABEL_W, marginTop: 4 }}>
          {marked.length ? (
            <View
              style={{
                position: "absolute",
                top: 2,
                left: marked[0] * (cell + GAP),
                width: (marked[marked.length - 1] - marked[0] + 1) * (cell + GAP) - GAP,
                height: 2,
                borderRadius: 1,
                backgroundColor: p.heat,
              }}
            />
          ) : null}
        </View>
        <View style={{ marginTop: 6, minHeight: 16, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={[{ color: p.muted, fontSize: 12, flex: 1 }, NUM]} numberOfLines={1}>
            {shown ? <Text style={{ color: p.fg, fontWeight: "500" }}>{longDate(shown.date)}</Text> : null}
            {shown ? DOT + plural(shown.prompts, "prompt") + sourceSplit(shown, overview) : ""}
            {shown && shown.agents ? DOT + plural(shown.agents, "agent") : ""}
            {shown && shown.tools ? DOT + plural(shown.tools, "tool call") : ""}
            {!shown && t.busiestDay && t.busiestDay.count > 0
              ? "Busiest day: " + shortDay(t.busiestDay.date) + ", " + parseDayKey(t.busiestDay.date).getFullYear() + DOT + plural(t.busiestDay.count, "prompt")
              : ""}
          </Text>
        </View>
      </View>
    </View>
  );
}
