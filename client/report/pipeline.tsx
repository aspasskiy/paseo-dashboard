import { Icon } from "@getpaseo/plugin/client/ui";
import { ActivityIndicator, Text, View } from "react-native";
import type { ReportJob } from "../../shared/report";
import { DOT, plural } from "../format";
import { NUM, usePalette } from "../kit";
import { Bar, modelWord } from "./parts";

// The two-stage pipeline, drawn the same way before a run (what it will cost) and during one
// (where it is). Scan is local; notes are many cheap calls, cached per session; the report is one strong call.

export interface Pending {
  sessions: number;
  uncached: number;
  projects: number;
  prompts: number;
  estimatedNoteCalls: number;
}

type StepStatus = "todo" | "active" | "done";

interface Step {
  key: string;
  title: string;
  runner: string;
  lines: string[];
  status: StepStatus;
  /** 0..1 for a progress bar, null for none. */
  progress: number | null;
  /** Cached fraction, drawn as a second tone in the bar before the run. */
  cached?: number;
}

export function costLine(pending: Pending, notesRunner: string, synthesisRunner: string): string {
  const cached = Math.max(0, pending.sessions - pending.uncached);
  const notes = modelWord(notesRunner);
  const synth = modelWord(synthesisRunner);
  const parts = ["Reads " + plural(pending.sessions, "session")];
  if (pending.estimatedNoteCalls > 0) {
    parts.push(plural(pending.estimatedNoteCalls, notes + " call") + " for notes" + (cached ? " (" + cached + " cached)" : ""));
  } else if (pending.sessions > 0) {
    parts.push("all notes cached");
  }
  parts.push("1 " + synth + " call");
  return parts.join(DOT);
}

export function buildSteps(pending: Pending, notesRunner: string, synthesisRunner: string, job: ReportJob | null): Step[] {
  const cached = Math.max(0, pending.sessions - pending.uncached);
  const stage = job && job.status === "running" ? job.stage : null;
  const order = ["scanning", "notes", "synthesis"];
  const at = stage ? order.indexOf(stage) : -1;
  const status = (i: number): StepStatus => (at < 0 ? "todo" : i < at ? "done" : i === at ? "active" : "todo");
  const total = job?.total ?? 0;
  const done = job?.done ?? 0;
  const notesProgress =
    status(1) === "active" ? (total > 0 ? Math.min(1, done / total) : 0) : status(1) === "done" ? 1 : null;
  return [
    {
      key: "scan",
      title: "Scan",
      runner: "On this machine",
      lines: [plural(pending.sessions, "session") + " in " + plural(pending.projects, "project"), plural(pending.prompts, "prompt") + DOT + "no AI"],
      status: status(0),
      progress: null,
    },
    {
      key: "notes",
      title: "Notes",
      runner: notesRunner,
      lines:
        status(1) === "active" && total > 0
          ? ["Batch " + Math.min(done + 1, total) + " of " + total, "Each note is kept for the next report"]
          : pending.uncached > 0
            ? [plural(pending.estimatedNoteCalls, "call") + " for " + plural(pending.uncached, "new session"), cached ? cached + " already noted, read from cache" : "One short note per session, kept for next time"]
            : ["No calls" + DOT + "every session is noted", "Notes are kept per session"],
      status: status(1),
      progress: notesProgress,
      cached: at < 0 && pending.sessions > 0 ? cached / pending.sessions : undefined,
    },
    {
      key: "report",
      title: "Report",
      runner: synthesisRunner,
      lines: ["1 call over all notes", "What needs you, what shipped"],
      status: status(2),
      progress: null,
    },
  ];
}

export function Pipeline({ steps, compact, live }: { steps: Step[]; compact: boolean; live: boolean }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: compact ? "column" : "row", alignItems: "stretch" }}>
      {steps.map((step, i) => (
        <View key={step.key} style={compact ? { flexDirection: "row", gap: 12 } : { flex: 1, minWidth: 0, gap: 10 }}>
          {/* rail: the node and the line to the next step */}
          {compact ? (
            <View style={{ alignItems: "center", width: 22 }}>
              <Node status={step.status} index={i} />
              {i < steps.length - 1 ? <View style={{ flex: 1, width: 1, backgroundColor: step.status === "done" ? p.success : p.line, marginVertical: 4 }} /> : null}
            </View>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Node status={step.status} index={i} />
              {i < steps.length - 1 ? (
                <View style={{ flex: 1, height: 1, backgroundColor: step.status === "done" ? p.success : p.line, marginRight: 8 }} />
              ) : null}
            </View>
          )}
          <View style={{ flex: compact ? 1 : undefined, gap: 4, paddingRight: compact ? 0 : 16, paddingBottom: compact && i < steps.length - 1 ? 16 : 0 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
              <Text style={{ color: step.status === "todo" && live ? p.muted : p.fg, fontSize: 14, fontWeight: "500" }}>{step.title}</Text>
              <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={1}>
                {step.runner}
              </Text>
            </View>
            {step.lines.map((line, j) => (
              <Text key={j} style={[{ color: j === 0 && !(step.status === "todo" && live) ? p.fg : p.muted, fontSize: 12, lineHeight: 18 }, NUM]}>
                {line}
              </Text>
            ))}
            {step.progress !== null ? (
              <View style={{ marginTop: 4, maxWidth: 240 }}>
                <Bar value={step.progress} color={p.heat} height={4} />
              </View>
            ) : step.cached !== undefined ? (
              <View style={{ marginTop: 4, maxWidth: 240 }}>
                <CacheBar cached={step.cached} />
              </View>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

/** Cached notes in the activity hue, the sessions still to read as a quiet track. */
function CacheBar({ cached }: { cached: number }) {
  const p = usePalette();
  const c = Math.max(0, Math.min(1, cached));
  return (
    <View style={{ flexDirection: "row", height: 4, gap: 2 }}>
      {c > 0 ? <View style={{ flex: c, height: 4, borderRadius: 2, backgroundColor: p.heatLevels[3] }} /> : null}
      {c < 1 ? <View style={{ flex: 1 - c, height: 4, borderRadius: 2, backgroundColor: p.hover }} /> : null}
    </View>
  );
}

function Node({ status, index }: { status: StepStatus; index: number }) {
  const p = usePalette();
  if (status === "done") {
    return (
      <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: p.success }}>
        <Icon name="Check" size={12} color={p.success} />
      </View>
    );
  }
  if (status === "active") {
    return (
      <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: p.running }}>
        <ActivityIndicator size={12} color={p.running} />
      </View>
    );
  }
  return (
    <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: p.line, backgroundColor: p.card }}>
      <Text style={[{ color: p.muted, fontSize: 11, fontWeight: "500" }, NUM]}>{index + 1}</Text>
    </View>
  );
}
