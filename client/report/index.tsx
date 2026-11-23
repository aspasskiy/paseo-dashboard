import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import {
  reportGenerateRpc,
  reportGetRpc,
  reportSettingsGetRpc,
  reportSettingsSetRpc,
  type Report,
  type ReportJob,
  type ReportPeriod,
  type ReportSettings,
  type SessionNote,
  type SessionState,
} from "../../shared/report";
import { DOT, ago, plural } from "../format";
import { NUM, usePalette } from "../kit";
import { mix } from "../theme";
import { IconButton, LinkButton, PrimaryButton, STATE_META, clamp4, clock, modelWord, periodOf, stateDot } from "./parts";
import { Pipeline, buildSteps, costLine, type Pending } from "./pipeline";
import { NeedsYou, Shipped, asksOf, outcomesOf, type ListContext, type OpenAgent } from "./overview";
import { SettingsPanel } from "./settings";

// "Needs you & Shipped": two AI stages on the user's own provider, only when asked.
// Stage 1 writes a cached note per session (fast model), stage 2 turns the notes into typed asks
// and outcomes (strong model). The server runs both in the background; this card polls while they run.
// The period is controlled by the screen's one timeframe switch.
//
// On the grid the report is two blocks, "Needs you" and "Shipped" (part "needs" / "shipped"). Both
// read the same query (same queryKey, so one fetch) and both carry the shared states: the intro with
// Generate, the running pipeline, errors, staleness and the models panel, so either works alone.

export type ReportPart = "needs" | "shipped";

const EMPTY_PENDING: Pending = { sessions: 0, uncached: 0, projects: 0, prompts: 0, estimatedNoteCalls: 0 };
const AUTO_SETTINGS: ReportSettings = { notes: { provider: null, model: null }, synthesis: { provider: null, model: null } };
const GENERATE_KEY = ["dashboard", "report-generate"];

const PART_INTRO: Record<ReportPart, string> = {
  needs: "Reads every session and lists what is waiting on you: decisions, approvals, fixes.",
  shipped: "Reads every session and lists what shipped, per project.",
};

const PART_STATES: Record<ReportPart, SessionState[]> = {
  needs: ["in_progress", "blocked"],
  shipped: ["done"],
};

export function ReportBlock({
  part,
  compact,
  navigation,
  params,
  period = "week",
  width,
}: {
  part: ReportPart;
  compact: boolean;
  navigation: PluginScreenProps["navigation"];
  params?: Record<string, string>;
  period?: ReportPeriod;
  /** Outer width of the block as the grid measured it. */
  width: number;
}) {
  const p = usePalette();
  const queryClient = useQueryClient();
  const getReport = useRpc(reportGetRpc);
  const generate = useRpc(reportGenerateRpc);
  const getSettings = useRpc(reportSettingsGetRpc);
  const saveSettings = useRpc(reportSettingsSetRpc);
  const [settingsOpen, setSettingsOpen] = useState(params?.settings === "1" && part !== "shipped");
  const [startError, setStartError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const tzOffsetMinutes = new Date().getTimezoneOffset();

  const query = useQuery({
    queryKey: ["dashboard", "report", period],
    queryFn: () => getReport({ period, tzOffsetMinutes }),
    refetchInterval: (q) => (q.state.data?.job.status === "running" ? 1500 : 60_000),
    staleTime: 10_000,
  });
  const settings = useQuery({ queryKey: ["dashboard", "report-settings"], queryFn: () => getSettings({}), staleTime: 5 * 60_000 });

  // Shared key: the two report blocks each have a Generate button; a run started from one
  // disables both at once (before the job shows up as running), so it can never start twice.
  const starting = useIsMutating({ mutationKey: GENERATE_KEY }) > 0;
  const start = useMutation({
    mutationKey: GENERATE_KEY,
    mutationFn: () => generate({ period, tzOffsetMinutes }),
    onSuccess: (res) => {
      setStartError(res.started ? null : (res.error ?? "The report could not start."));
      void queryClient.invalidateQueries({ queryKey: ["dashboard", "report"] });
    },
    onError: (e) => setStartError(String(e)),
  });
  const save = useMutation({
    mutationFn: (next: ReportSettings) => saveSettings({ settings: next }),
    onMutate: (next) => {
      const prev = queryClient.getQueryData<typeof settings.data>(["dashboard", "report-settings"]);
      if (prev) queryClient.setQueryData(["dashboard", "report-settings"], { ...prev, settings: next });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["dashboard", "report-settings"] }),
  });

  const data = query.data;
  const job = data?.job ?? null;
  const running = job?.status === "running";
  const runningHere = running && job?.period === period;
  const runningElsewhere = running && job?.period !== period;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  useEffect(() => setStartError(null), [period]);

  const providers = settings.data?.providers ?? [];
  const noProvider = settings.data !== undefined && providers.length === 0;
  const resolved = settings.data?.resolved ?? { notes: "", synthesis: "" };
  const report = data?.report ?? null;
  const pending = data?.pending ?? EMPTY_PENDING;
  const notesRunner = resolved.notes || report?.notesRunner || "Fast model";
  const synthesisRunner = resolved.synthesis || report?.synthesisRunner || "Strong model";
  const error = startError ?? (job?.status === "error" && (job.period === period || job.period === null) ? job.error : null);
  const canRun = !noProvider && !running && !starting;
  const onRun = () => {
    setSettingsOpen(false);
    setStartError(null);
    start.mutate();
  };
  const openAgent: OpenAgent = navigation ? (agentId) => navigation.openAgent({ agentId }) : null;
  const narrow = compact || (width > 0 && width < 560);
  const cost = runCost(pending, notesRunner, synthesisRunner);
  const reason = noProvider
    ? "No agent provider is ready in Paseo. Set one up in Paseo's settings first."
    : runningElsewhere
      ? "Writing " + periodOf(job?.period).noun + " first. One at a time."
      : null;

  let body: ReactNode;
  if (!data) {
    body = query.error ? <Notice tone="danger" icon="CircleAlert" text={String(query.error)} /> : <Centered><ActivityIndicator color={p.muted} /></Centered>;
  } else if (runningHere) {
    body = (
      <View style={{ gap: 16 }}>
        <Running job={job!} pending={pending} notesRunner={notesRunner} synthesisRunner={synthesisRunner} now={now} compact={narrow} />
        {report ? <ReportBody part={part} report={report} compact={narrow} openAgent={openAgent} expand={params?.expand ?? null} /> : null}
      </View>
    );
  } else if (report) {
    body = <ReportBody part={part} report={report} compact={narrow} openAgent={openAgent} expand={params?.expand ?? null} />;
  } else if (!pending.sessions) {
    body = (
      <Centered>
        <Text style={{ color: p.muted, fontSize: 14, textAlign: "center" }}>No sessions {periodOf(period).noun} yet, so nothing to read.</Text>
      </Centered>
    );
  } else {
    body = (
      <Intro
        text={PART_INTRO[part]}
        pending={pending}
        notesRunner={notesRunner}
        synthesisRunner={synthesisRunner}
        compact={narrow}
        onRun={onRun}
        disabled={!canRun}
        reason={reason}
      />
    );
  }

  const stale = Boolean(data?.stale && report && !runningHere);
  const head = headOf(part, report, p);

  return (
    <View
      style={{ flex: 1, backgroundColor: p.card, borderRadius: 8, borderWidth: 1, borderColor: p.border, padding: 16, gap: 12 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name={head.icon} size={14} color={head.iconColor} />
            <Text style={{ color: p.fg, fontSize: 14, fontWeight: "500", flexShrink: 1 }} numberOfLines={1}>
              {head.title}
            </Text>
            {head.count !== null ? <Text style={[{ color: p.muted, fontSize: 12 }, NUM]}>{head.count}</Text> : null}
            {head.note ? (
              <Text style={[{ color: head.noteColor, fontSize: 12, flexShrink: 1 }, NUM]} numberOfLines={1}>
                {DOT.trim() + " " + head.note}
              </Text>
            ) : null}
          </View>
          <Summary report={report} pending={data ? pending : null} period={period} narrow={narrow} states={PART_STATES[part]} />
        </View>
        <IconButton icon="SlidersHorizontal" label="Models" active={settingsOpen} onPress={() => setSettingsOpen(!settingsOpen)} />
      </View>

      {/* Inline, not floating: a popover would hang over the blocks below. */}
      {settingsOpen ? (
        <SettingsPanel
          providers={providers}
          loading={settings.isLoading}
          settings={settings.data?.settings ?? AUTO_SETTINGS}
          resolved={resolved}
          onChange={(next) => save.mutate(next)}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {error ? (
        <Notice
          tone="danger"
          icon="CircleAlert"
          text={error}
          action={canRun && report ? <LinkButton label="Try again" icon="RefreshCw" onPress={onRun} color={p.fg} /> : undefined}
        />
      ) : null}
      {runningElsewhere && report ? <Notice tone="muted" icon="Loader" text={"Writing " + periodOf(job?.period).noun + "…"} /> : null}
      {stale ? (
        <Notice
          tone="warning"
          text={staleText(report!, pending)}
          action={canRun ? <LinkButton label={narrow ? "Update" : "Update" + DOT + cost} icon="RefreshCw" onPress={onRun} color={p.fg} /> : undefined}
        />
      ) : null}

      {body}

      {/* Blocks in a row share one height: the footer keeps to the bottom. */}
      {report && !runningHere ? <View style={{ flex: 1, marginTop: -12 }} /> : null}
      {report && !runningHere ? <Footer report={report} onRegenerate={canRun && !stale ? onRun : undefined} cost={cost} compact={narrow} /> : null}

    </View>
  );
}

/** "6 Haiku calls + 1 Opus call" for what a run would cost right now. */
function runCost(pending: Pending, notesRunner: string, synthesisRunner: string): string {
  const synth = "1 " + modelWord(synthesisRunner) + " call";
  if (pending.estimatedNoteCalls <= 0) return synth;
  return plural(pending.estimatedNoteCalls, modelWord(notesRunner) + " call") + " + " + synth;
}

function staleText(report: Report, pending: Pending): string {
  const extra = pending.sessions - report.stats.sessions;
  return extra > 0 ? plural(extra, "new session") + " since this was written" : "New activity since this was written";
}

/** Title, count and the note beside it for each part's header. */
function headOf(part: ReportPart, report: Report | null, p: ReturnType<typeof usePalette>) {
  if (part === "needs") {
    const asks = report ? asksOf(report) : [];
    const urgent = asks.filter((a) => clamp4(a.importance) >= 4).length;
    return { title: "Needs you", icon: "Hand", iconColor: urgent ? p.warning : p.muted, count: report ? asks.length : null, note: urgent ? urgent + " urgent" : "", noteColor: p.warning };
  }
  const outcomes = report ? outcomesOf(report) : [];
  const projects = new Set(outcomes.map((o) => o.projectName)).size;
  return {
    title: "Shipped",
    icon: "CircleCheck",
    iconColor: report ? p.success : p.muted,
    count: report ? outcomes.length : null,
    note: outcomes.length ? "in " + plural(projects, "project") : "",
    noteColor: p.muted,
  };
}

/** "Nov 16 – Nov 22 · 91 sessions  ● 14 done ● 6 in progress ● 2 blocked" */
function Summary({
  report,
  pending,
  period,
  narrow,
  states,
}: {
  report: Report | null;
  pending: Pending | null;
  period: ReportPeriod;
  narrow: boolean;
  states: SessionState[];
}) {
  const p = usePalette();
  const lead = report
    ? (narrow ? "" : report.rangeLabel + DOT) + plural(report.stats.sessions, "session")
    : pending
      ? periodOf(period).label + DOT + plural(pending.sessions, "session") + DOT + plural(pending.projects, "project")
      : periodOf(period).label;
  const counts = report ? states.map((state) => ({ state, n: report.notes.filter((x: SessionNote) => x.state === state).length })).filter((x) => x.n) : [];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 10, rowGap: 2 }}>
      <Text style={[{ color: p.muted, fontSize: 12, lineHeight: 16 }, NUM]} numberOfLines={1}>
        {lead}
      </Text>
      {counts.map(({ state, n }) => (
        <View key={state} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: stateDot(p, state) }} />
          <Text style={[{ color: p.muted, fontSize: 12, lineHeight: 16 }, NUM]} numberOfLines={1}>
            {n + " " + STATE_META[state].label.toLowerCase()}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Intro({
  text,
  pending,
  notesRunner,
  synthesisRunner,
  compact,
  onRun,
  disabled,
  reason,
}: {
  text: string;
  pending: Pending;
  notesRunner: string;
  synthesisRunner: string;
  compact: boolean;
  onRun: () => void;
  disabled: boolean;
  reason: string | null;
}) {
  const p = usePalette();
  return (
    <View
      style={{
        flexDirection: compact ? "column" : "row",
        alignItems: compact ? "stretch" : "center",
        gap: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: p.line,
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <View style={{ flex: compact ? undefined : 1, minWidth: 0, gap: 4 }}>
        <Text style={{ color: p.fg, fontSize: 13, lineHeight: 18 }}>
          {text}
        </Text>
        <Text style={[{ color: reason ? p.warning : p.muted, fontSize: 12, lineHeight: 16 }, NUM]}>
          {reason ?? costLine(pending, notesRunner, synthesisRunner) + DOT + "your provider, only on press"}
        </Text>
      </View>
      <PrimaryButton label="Generate" icon="Sparkles" onPress={onRun} disabled={disabled} />
    </View>
  );
}

function Running({
  job,
  pending,
  notesRunner,
  synthesisRunner,
  now,
  compact,
}: {
  job: ReportJob;
  pending: Pending;
  notesRunner: string;
  synthesisRunner: string;
  now: number;
  compact: boolean;
}) {
  const p = usePalette();
  const elapsed = job.startedAt ? now - Date.parse(job.startedAt) : 0;
  const what =
    job.stage === "scanning" ? "Scanning sessions" : job.stage === "notes" ? "Writing session notes" : job.stage === "synthesis" ? "Sorting what needs you and what shipped" : "Starting";
  return (
    <View style={{ borderRadius: 8, borderWidth: 1, borderColor: p.border, backgroundColor: p.bg, padding: 16, gap: 16 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.running }} />
        <Text style={{ color: p.fg, fontSize: 13, fontWeight: "500", flex: 1 }} numberOfLines={1}>
          {what}
        </Text>
        <Text style={[{ color: p.muted, fontSize: 12 }, NUM]}>{clock(elapsed)}</Text>
      </View>
      <Pipeline steps={buildSteps(pending, notesRunner, synthesisRunner, job)} compact={compact} live />
      <Text style={{ color: p.muted, fontSize: 12, lineHeight: 16 }}>Usually one to three minutes. It keeps going if you leave.</Text>
    </View>
  );
}

function ReportBody({
  part,
  report,
  compact,
  openAgent,
  expand,
}: {
  part: ReportPart;
  report: Report;
  compact: boolean;
  openAgent: OpenAgent;
  expand: string | null;
}) {
  const byKey = useMemo(() => {
    const map: Record<string, SessionNote> = {};
    for (const n of report.notes) map[n.key] = n;
    return map;
  }, [report]);
  const ctx: ListContext = useMemo(
    () => ({
      pathOf: (name: string) => {
        const proj = report.projects.find((x) => x.projectName === name);
        if (proj) return proj.projectPath;
        return report.notes.find((n) => n.projectName === name)?.projectPath ?? "";
      },
      noteOf: (key: string | null) => (key ? (byKey[key] ?? null) : null),
      openAgent,
      longDates: report.period === "30d",
      compact,
      expand,
    }),
    [report, byKey, openAgent, compact, expand],
  );
  // One list per block: rows run to the card's padding, without a frame of their own.
  return (
    <View style={{ marginHorizontal: -12 }}>
      {part === "needs" ? <NeedsYou report={report} ctx={ctx} /> : <Shipped report={report} ctx={ctx} />}
    </View>
  );
}
/** One quiet line: when it was written and by which model, and Regenerate. */
function Footer({ report, onRegenerate, cost, compact }: { report: Report; onRegenerate?: () => void; cost: string; compact: boolean }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <Text style={[{ color: p.muted, fontSize: 12, lineHeight: 16, flex: 1, minWidth: 120 }, NUM]} numberOfLines={1}>
        {"Written " + ago(report.generatedAt) + DOT + "by " + modelWord(report.synthesisRunner)}
      </Text>
      {onRegenerate ? <LinkButton label={compact ? "Regenerate" : "Regenerate" + DOT + cost} icon="RefreshCw" onPress={onRegenerate} /> : null}
    </View>
  );
}

function Notice({ tone, icon, text, action }: { tone: "danger" | "warning" | "muted"; icon?: string; text: string; action?: ReactNode }) {
  const p = usePalette();
  const color = tone === "danger" ? p.danger : tone === "warning" ? p.warning : p.muted;
  const bg = tone === "muted" ? p.bg : mix(p.card, color, p.dark ? 0.12 : 0.08);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 8, backgroundColor: bg, paddingHorizontal: 12, paddingVertical: 8, minHeight: 40 }}>
      {icon ? <Icon name={icon} size={14} color={color} /> : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />}
      <Text style={{ color: tone === "muted" ? p.muted : p.fg, fontSize: 12, lineHeight: 18, flex: 1 }}>{text}</Text>
      {action}
    </View>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <View style={{ alignItems: "center", paddingVertical: 24, paddingHorizontal: 16, gap: 10 }}>{children}</View>;
}
