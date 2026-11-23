import { Icon } from "@getpaseo/plugin/client/ui";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { AskKind, OutcomeType, Report, SessionNote } from "../../shared/report";
import { DOT, MONTHS, WEEKDAYS, plural } from "../format";
import { NUM, pressStyle, usePalette } from "../kit";
import { ProjectIcon } from "../icon";
import { mix } from "../theme";
import { Importance, LinkButton, STATE_META, clamp4, stateDot } from "./parts";

// "Needs you" and "Shipped": the two typed lists the report writes. Each row is one line with
// the project's real icon; a tap opens the full text and the session note behind it.

export type OpenAgent = ((agentId: string) => void) | null;

const ASK_META: Record<AskKind, { label: string; icon: string }> = {
  decide: { label: "Decide", icon: "Scale" },
  approve: { label: "Approve", icon: "ThumbsUp" },
  fix: { label: "Fix", icon: "Wrench" },
  follow_up: { label: "Follow up", icon: "ArrowRight" },
};

const OUTCOME_META: Record<OutcomeType, { label: string; icon: string }> = {
  release: { label: "Release", icon: "Rocket" },
  feature: { label: "Feature", icon: "Sparkles" },
  fix: { label: "Fix", icon: "Bug" },
  infra: { label: "Infra", icon: "Server" },
  content: { label: "Content", icon: "FileText" },
  research: { label: "Research", icon: "FlaskConical" },
};

type Ask = { kind: AskKind | null; text: string; projectName: string; sessionKey: string | null; importance: number };
type Outcome = { type: OutcomeType | null; text: string; projectName: string; sessionKey: string | null };

/** Typed asks, most important first; older reports fall back to their untyped open loops. */
export function asksOf(report: Report): Ask[] {
  const list: Ask[] = report.needsYou ?? report.openLoops.map((l) => ({ ...l, kind: null }));
  return list.slice().sort((a, b) => clamp4(b.importance) - clamp4(a.importance));
}

/** Typed outcomes; older reports fall back to the first two shipped items of each project. */
export function outcomesOf(report: Report): Outcome[] {
  if (report.shipped) return report.shipped;
  const out: Outcome[] = [];
  for (const proj of report.projects.slice().sort((a, b) => b.share - a.share)) {
    for (const text of proj.shipped.slice(0, 2)) out.push({ type: null, text, projectName: proj.projectName, sessionKey: null });
  }
  return out;
}

export interface ListContext {
  pathOf: (projectName: string) => string;
  noteOf: (sessionKey: string | null) => SessionNote | null;
  openAgent: OpenAgent;
  longDates: boolean;
  compact: boolean;
  /** Deep link / preview: "ask:0" or "shipped:2" opens that row. */
  expand: string | null;
}

function initialRow(expand: string | null, list: string): number | null {
  const m = expand ? /^(ask|shipped):(\d+)$/.exec(expand) : null;
  return m && m[1] === list ? Number(m[2]) : null;
}


function when(isoString: string, long: boolean): string {
  const d = new Date(Date.parse(isoString));
  if (!Number.isFinite(d.getTime())) return "";
  const hm = d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
  return (long ? MONTHS[d.getMonth()] + " " + d.getDate() : WEEKDAYS[d.getDay()].slice(0, 3)) + " " + hm;
}

// --- List frame: the block's own card carries the title, so the list is just rows and "Show more".

function List({
  count,
  empty,
  more,
  children,
}: {
  count: number;
  empty: string;
  more: { hidden: number; all: boolean; onToggle: () => void };
  children: ReactNode;
}) {
  const p = usePalette();
  return (
    <View style={{ borderRadius: 6, overflow: "hidden", minWidth: 0 }}>
      {count ? children : <Text style={{ color: p.muted, fontSize: 13, paddingHorizontal: 12, paddingVertical: 14 }}>{empty}</Text>}
      {more.hidden > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={more.onToggle}
          style={pressStyle(({ hovered, pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            height: 32,
            borderTopWidth: 1,
            borderTopColor: p.border,
            backgroundColor: pressed ? p.pressed : hovered ? p.hover : "transparent",
          }))}
        >
          <Text style={[{ color: p.muted, fontSize: 12 }, NUM]}>{more.all ? "Show less" : "Show " + more.hidden + " more"}</Text>
          <Icon name={more.all ? "ChevronUp" : "ChevronDown"} size={12} color={p.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

function Divider({ inset = 0 }: { inset?: number }) {
  const p = usePalette();
  return <View style={{ height: 1, backgroundColor: p.border, marginLeft: inset }} />;
}

/** Small outlined tag: icon + label, coloured only when it carries state. */
function Tag({ icon, label, color }: { icon: string; label: string; color?: string }) {
  const p = usePalette();
  const c = color ?? p.muted;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        height: 18,
        paddingHorizontal: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: color ? mix(p.card, color, 0.45) : p.border,
        backgroundColor: color ? mix(p.card, color, p.dark ? 0.12 : 0.07) : p.hover,
        flexShrink: 0,
      }}
    >
      <Icon name={icon} size={10} color={c} />
      <Text style={{ color: c, fontSize: 11, lineHeight: 14, fontWeight: "500" }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** What a tap reveals: the session note the item came from, and a way into the agent. */
function Detail({ note, ctx, extra, inset }: { note: SessionNote | null; ctx: ListContext; extra?: ReactNode; inset: number }) {
  const p = usePalette();
  const agent = note?.paseoAgentId ?? null;
  const facts = note ? [when(note.startedAt, ctx.longDates), plural(note.prompts, "prompt")].filter(Boolean).join(DOT) : "";
  return (
    <View style={{ paddingLeft: inset, paddingRight: 12, paddingBottom: 12, gap: 8 }}>
      {note ? (
        <View style={{ borderRadius: 6, backgroundColor: p.bg, borderWidth: 1, borderColor: p.border, paddingHorizontal: 10, paddingVertical: 8, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: stateDot(p, note.state) }} />
            <Text style={{ color: p.fg, fontSize: 12, fontWeight: "500", flex: 1, minWidth: 0 }} numberOfLines={1}>
              {note.title}
            </Text>
          </View>
          {note.summary ? <Text style={{ color: p.muted, fontSize: 12, lineHeight: 18 }}>{note.summary}</Text> : null}
          <Text style={[{ color: p.muted, fontSize: 11, lineHeight: 16 }, NUM]} numberOfLines={1}>
            {STATE_META[note.state].label + (facts ? DOT + facts : "")}
          </Text>
        </View>
      ) : null}
      {extra || (agent && ctx.openAgent) ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 20 }}>
          {extra}
          <View style={{ flex: 1 }} />
          {agent && ctx.openAgent ? <LinkButton label="Open session" iconRight="ArrowUpRight" onPress={() => ctx.openAgent!(agent)} color={p.fg} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function Row({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      style={pressStyle(({ hovered, pressed }) => ({
        flexDirection: "row",
        alignItems: open ? "flex-start" : "center",
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: pressed ? p.pressed : hovered && !open ? p.hover : "transparent",
      }))}
    >
      {children}
    </Pressable>
  );
}

// --- Needs you

const SHOWN_ASKS = 5;

export function NeedsYou({ report, ctx }: { report: Report; ctx: ListContext }) {
  const p = usePalette();
  const asks = asksOf(report);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<number | null>(initialRow(ctx.expand, "ask"));
  const shown = all ? asks : asks.slice(0, SHOWN_ASKS);
  return (
    <List
      count={asks.length}
      empty="Nothing is waiting on you."
      more={{ hidden: asks.length - SHOWN_ASKS, all, onToggle: () => setAll(!all) }}
    >
      {shown.map((a, i) => {
        const meta = a.kind ? ASK_META[a.kind] : null;
        const hot = clamp4(a.importance) >= 4;
        const isOpen = open === i;
        return (
          <View key={i} style={{ backgroundColor: isOpen ? p.hover : "transparent" }}>
            {i > 0 ? <Divider /> : null}
            <Row open={isOpen} onToggle={() => setOpen(isOpen ? null : i)}>
              <ProjectIcon path={ctx.pathOf(a.projectName)} name={a.projectName} size={28} style={isOpen ? { marginTop: 1 } : undefined} />
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Text style={{ color: p.fg, fontSize: 13, lineHeight: 18 }} numberOfLines={isOpen ? undefined : ctx.compact ? 2 : 1}>
                  {a.text}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
                  {meta ? <Tag icon={meta.icon} label={meta.label} color={hot ? p.warning : undefined} /> : null}
                  <Text style={{ color: p.muted, fontSize: 12, lineHeight: 16, flexShrink: 1 }} numberOfLines={1}>
                    {a.projectName}
                  </Text>
                </View>
              </View>
              <View style={{ alignSelf: "center" }}>
                <Importance value={a.importance} />
              </View>
            </Row>
            {isOpen ? <Detail note={ctx.noteOf(a.sessionKey)} ctx={ctx} inset={50} /> : null}
          </View>
        );
      })}
    </List>
  );
}

// --- Shipped, clustered by project in report order

const SHOWN_OUTCOMES = 6;

export function Shipped({ report, ctx }: { report: Report; ctx: ListContext }) {
  const p = usePalette();
  const outcomes = outcomesOf(report);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<number | null>(initialRow(ctx.expand, "shipped"));
  const shown = (all ? outcomes : outcomes.slice(0, SHOWN_OUTCOMES)).map((o, index) => ({ ...o, index }));
  const groups: { projectName: string; items: typeof shown }[] = [];
  for (const o of shown) {
    const g = groups.find((x) => x.projectName === o.projectName);
    if (g) g.items.push(o);
    else groups.push({ projectName: o.projectName, items: [o] });
  }
  return (
    <List
      count={outcomes.length}
      empty="Nothing finished yet in this period."
      more={{ hidden: outcomes.length - SHOWN_OUTCOMES, all, onToggle: () => setAll(!all) }}
    >
      {groups.map((g, gi) => (
        <View key={g.projectName}>
          {gi > 0 ? <Divider /> : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 2 }}>
            <ProjectIcon path={ctx.pathOf(g.projectName)} name={g.projectName} size={20} />
            <Text style={{ color: p.fg, fontSize: 12, fontWeight: "500", flexShrink: 1 }} numberOfLines={1}>
              {g.projectName}
            </Text>
          </View>
          <View style={{ paddingBottom: 4 }}>
            {g.items.map((o) => {
              const meta = o.type ? OUTCOME_META[o.type] : null;
              const isOpen = open === o.index;
              return (
                <View key={o.index} style={{ backgroundColor: isOpen ? p.hover : "transparent" }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: isOpen }}
                    onPress={() => setOpen(isOpen ? null : o.index)}
                    style={pressStyle(({ hovered, pressed }) => ({
                      flexDirection: "row",
                      alignItems: isOpen ? "flex-start" : "center",
                      gap: 8,
                      paddingLeft: 16,
                      paddingRight: 12,
                      paddingVertical: 6,
                      backgroundColor: pressed ? p.pressed : hovered && !isOpen ? p.hover : "transparent",
                    }))}
                  >
                    <View style={{ width: 12, height: 18, alignItems: "center", justifyContent: "center" }}>
                      <Icon name={meta?.icon ?? "Check"} size={12} color={meta ? p.muted : p.success} />
                    </View>
                    <Text style={{ color: p.fg, fontSize: 13, lineHeight: 18, flex: 1, minWidth: 0 }} numberOfLines={isOpen ? undefined : ctx.compact ? 2 : 1}>
                      {o.text}
                    </Text>
                    {meta && !ctx.compact ? (
                      <Text style={{ color: p.muted, fontSize: 11, lineHeight: 18 }} numberOfLines={1}>
                        {meta.label}
                      </Text>
                    ) : null}
                  </Pressable>
                  {isOpen ? (
                    <Detail
                      note={ctx.noteOf(o.sessionKey)}
                      ctx={ctx}
                      inset={36}
                      extra={meta && ctx.compact ? <Tag icon={meta.icon} label={meta.label} /> : undefined}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </List>
  );
}
