import { Text, View } from "react-native";
import type { FocusProject, TimeframeStats } from "../shared/rpc";
import { DOT, WEEKDAY_LETTERS, formatMinutes, formatNumber, heatCuts, heatLevel, parseDayKey, plural } from "./format";
import { ProjectIcon } from "./icon";
import { Card, Empty, NUM, usePalette } from "./kit";
import type { Palette } from "./theme";
import { rankColor } from "./widgets";

// "Where your focus went": every project of the period at once, no expanding. A stacked share bar
// with the project icons on top, then one row per project with its share, active time, sessions
// and a strip of day cells aligned to the period's days, so you can see which project took which day.

const ICON_ROW = 22;

interface Row {
  key: string;
  project: FocusProject | null;
  /** The collapsed long tail: its projects, for the stacked icons. */
  tail?: FocusProject[];
  name: string;
  share: number;
  minutes: number;
  sessions: number;
  prompts: number;
  daily: number[];
  color: string;
}

/** width: outer width of the block as the grid measured it (0 until then). */
export function FocusBlock({ stats, todayKey, compact, width: blockWidth }: { stats: TimeframeStats; todayKey: string; compact: boolean; width: number }) {
  const p = usePalette();
  // Card content box = block width minus padding (16 each side) and the 1px border.
  const width = blockWidth > 0 ? blockWidth - 34 : 0;
  const projects = stats.projects;
  // The wide table needs room for the name next to the day strip: 30 days takes ~330 px of strip.
  const narrow = compact || (width > 0 && width < (stats.days.length > 10 ? 760 : 600));
  const limit = narrow ? 6 : 9;
  const head = projects.length > limit + 1 ? projects.slice(0, limit) : projects;
  const rest = projects.slice(head.length);
  const rows: Row[] = head.map((x, i) => ({
    key: x.path || "none",
    project: x,
    name: x.name,
    share: x.share,
    minutes: x.activeMinutes,
    sessions: x.sessions,
    prompts: x.prompts,
    daily: x.daily,
    color: rankColor(p, i),
  }));
  if (rest.length) {
    rows.push({
      key: "rest",
      project: null,
      tail: rest,
      name: rest.length + " more",
      share: rest.reduce((a, x) => a + x.share, 0),
      minutes: rest.reduce((a, x) => a + x.activeMinutes, 0),
      sessions: rest.reduce((a, x) => a + x.sessions, 0),
      prompts: rest.reduce((a, x) => a + x.prompts, 0),
      daily: stats.days.map((_, d) => rest.reduce((a, x) => a + (x.daily[d] ?? 0), 0)),
      color: p.neutral,
    });
  }
  // Cuts over every project-day with prompts, so the strips compare across projects.
  const cuts = heatCuts(projects.flatMap((x) => x.daily));
  const top = projects[0];
  const subtitle = projects.length
    ? plural(stats.projectsCount, "project") + DOT + formatMinutes(stats.activeMinutes) + " active" + (top ? DOT + top.name + " led with " + Math.round(top.share * 100) + "%" : "")
    : undefined;

  // Strip geometry: a fixed day-cell size so every row lines up with the header.
  const many = stats.days.length > 10;
  const cell = many ? 9 : 18;
  const cellGap = many ? 2 : 4;
  const stripW = stats.days.length * cell + (stats.days.length - 1) * cellGap;

  return (
    <Card title="Where your focus went" icon="Crosshair" subtitle={subtitle} style={{ flex: 1 }}>
      {!projects.length ? (
        <Empty icon="FolderGit2" text="No prompts in this period yet." />
      ) : (
        <View style={{ gap: 12 }}>
          {width ? <ShareBar rows={rows} width={width} /> : null}
          <View>
            {narrow ? null : <StripHeader days={stats.days} todayKey={todayKey} cell={cell} gap={cellGap} width={stripW} />}
            {rows.map((row) =>
              narrow ? (
                <CompactRow key={row.key} row={row} days={stats.days} todayKey={todayKey} cuts={cuts} />
              ) : (
                <WideRow key={row.key} row={row} days={stats.days} todayKey={todayKey} cuts={cuts} cell={cell} gap={cellGap} stripW={stripW} />
              ),
            )}
          </View>
        </View>
      )}
    </Card>
  );
}

/** The period's prompts split by project, icons sitting over the segments wide enough to hold one. */
function ShareBar({ rows, width }: { rows: Row[]; width: number }) {
  const p = usePalette();
  const gap = 2;
  const usable = width - gap * (rows.length - 1);
  let left = 0;
  const placed = rows.map((row) => {
    const w = Math.max(2, row.share * usable);
    const at = left;
    left += w + gap;
    return { row, left: at, width: w };
  });
  return (
    <View>
      <View style={{ height: ICON_ROW + 4 }}>
        {placed.map(({ row, left: x, width: w }) =>
          row.project && w >= ICON_ROW + 2 ? (
            <View key={row.key} style={{ position: "absolute", left: x, width: w, alignItems: "flex-start", flexDirection: "row", gap: 6 }}>
              <ProjectIcon path={row.project.path} name={row.name} size={ICON_ROW - 2} />
              {w >= 110 ? (
                <Text style={[{ color: p.muted, fontSize: 12, lineHeight: ICON_ROW - 2, flexShrink: 1 }, NUM]} numberOfLines={1}>
                  {Math.round(row.share * 100)}%
                </Text>
              ) : null}
            </View>
          ) : null,
        )}
      </View>
      <View style={{ height: 8, flexDirection: "row", gap, borderRadius: 4, overflow: "hidden" }}>
        {placed.map(({ row, width: w }) => (
          <View key={row.key} style={{ width: w, backgroundColor: row.color }} />
        ))}
      </View>
    </View>
  );
}

function dayLetter(key: string): string {
  return WEEKDAY_LETTERS[parseDayKey(key).getDay()];
}

function StripHeader({ days, todayKey, cell, gap, width }: { days: string[]; todayKey: string; cell: number; gap: number; width: number }) {
  const p = usePalette();
  const many = days.length > 10;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, height: 20, paddingHorizontal: 8 }}>
      <View style={{ width: 8 + 20 + 8 }} />
      <Text style={{ color: p.muted, fontSize: 11, flex: 1 }}>Project</Text>
      <View style={{ width, height: 14 }}>
        {days.map((d, i) => {
          const date = parseDayKey(d);
          // 30 days: label each Monday with its date; a week: every day's letter.
          if (many && date.getDay() !== 1) return null;
          return (
            <Text
              key={d}
              style={[
                {
                  position: "absolute",
                  left: i * (cell + gap) + (many ? 0 : cell / 2 - 6),
                  width: many ? 30 : 12,
                  textAlign: many ? "left" : "center",
                  color: d === todayKey ? p.fg : p.muted,
                  fontSize: 11,
                  lineHeight: 14,
                  fontWeight: d === todayKey ? "500" : "400",
                },
                NUM,
              ]}
            >
              {many ? date.getDate() : dayLetter(d)}
            </Text>
          );
        })}
      </View>
      <Text style={[{ color: p.muted, fontSize: 11, width: COL_SHARE, textAlign: "right" }]}>Share</Text>
      <Text style={[{ color: p.muted, fontSize: 11, width: COL_TIME, textAlign: "right" }]}>Time</Text>
      <Text style={[{ color: p.muted, fontSize: 11, width: COL_SESS, textAlign: "right" }]}>Sessions</Text>
    </View>
  );
}

const COL_SHARE = 44;
const COL_TIME = 56;
const COL_SESS = 56;

function Lead({ row, size }: { row: Row; size: number }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: row.color }} />
      {row.project ? <ProjectIcon path={row.project.path} name={row.name} size={size} /> : <TailIcons projects={row.tail ?? []} size={size} p={p} />}
    </View>
  );
}

/** The collapsed tail: up to three tiny icons, overlapped, in the space of one. */
function TailIcons({ projects, size, p }: { projects: FocusProject[]; size: number; p: Palette }) {
  const shown = projects.slice(0, 3);
  const small = Math.round(size * 0.6);
  return (
    <View style={{ width: size, height: size }}>
      {shown.map((x, i) => (
        <View
          key={x.path || i}
          style={{ position: "absolute", left: i * ((size - small) / Math.max(1, shown.length - 1)), top: i % 2 ? size - small : 0, borderRadius: 4, backgroundColor: p.card }}
        >
          <ProjectIcon path={x.path} name={x.name} size={small} />
        </View>
      ))}
    </View>
  );
}

function Strip({ row, days, todayKey, cuts, cell, gap }: { row: Row; days: string[]; todayKey: string; cuts: number[]; cell?: number; gap: number }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", gap, flex: cell ? undefined : 1 }}>
      {days.map((d, i) => {
        const future = d > todayKey;
        const v = row.daily[i] ?? 0;
        return (
          <View
            key={d}
            style={{
              width: cell,
              flex: cell ? undefined : 1,
              height: cell ? Math.min(cell, 14) : 10,
              borderRadius: 2,
              backgroundColor: future ? "transparent" : p.heatLevels[heatLevel(v, cuts)],
              borderWidth: future ? 1 : 0,
              borderColor: p.border,
            }}
          />
        );
      })}
    </View>
  );
}

function WideRow({ row, days, todayKey, cuts, cell, gap, stripW }: { row: Row; days: string[]; todayKey: string; cuts: number[]; cell: number; gap: number; stripW: number }) {
  const p = usePalette();
  const nameColor = row.project ? p.fg : p.muted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, height: 36, paddingHorizontal: 8, borderTopWidth: 1, borderTopColor: p.border }}>
      <Lead row={row} size={20} />
      <Text style={{ color: nameColor, fontSize: 14, flex: 1, minWidth: 0 }} numberOfLines={1}>
        {row.name}
      </Text>
      <View style={{ width: stripW }}>
        <Strip row={row} days={days} todayKey={todayKey} cuts={cuts} cell={cell} gap={gap} />
      </View>
      <Text style={[{ color: p.fg, fontSize: 14, width: COL_SHARE, textAlign: "right" }, NUM]}>{shareText(row.share)}</Text>
      <Text style={[{ color: p.muted, fontSize: 12, width: COL_TIME, textAlign: "right" }, NUM]}>{formatMinutes(row.minutes)}</Text>
      <Text style={[{ color: p.muted, fontSize: 12, width: COL_SESS, textAlign: "right" }, NUM]}>{formatNumber(row.sessions)}</Text>
    </View>
  );
}

function CompactRow({ row, days, todayKey, cuts }: { row: Row; days: string[]; todayKey: string; cuts: number[] }) {
  const p = usePalette();
  return (
    <View style={{ paddingVertical: 8, gap: 6, borderTopWidth: 1, borderTopColor: p.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Lead row={row} size={20} />
        <Text style={{ color: row.project ? p.fg : p.muted, fontSize: 14, flex: 1, minWidth: 0 }} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={[{ color: p.fg, fontSize: 14 }, NUM]}>{shareText(row.share)}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 36 }}>
        <Strip row={row} days={days} todayKey={todayKey} cuts={cuts} gap={days.length > 10 ? 1 : 3} />
        <Text style={[{ color: p.muted, fontSize: 12, width: 112, textAlign: "right" }, NUM]} numberOfLines={1}>
          {formatMinutes(row.minutes) + DOT + row.sessions + " sess"}
        </Text>
      </View>
    </View>
  );
}

function shareText(share: number): string {
  const v = share * 100;
  if (v > 0 && v < 1) return "<1%";
  return Math.round(v) + "%";
}
