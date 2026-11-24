/**
 * The report job: report.get / report.generate. One plan() decides what a run covers (which
 * sessions, which notes are cached, how the rest is batched), so the estimate report.get shows is
 * exactly what generate runs. One job at a time; it runs in the background and the client polls
 * report.get (the host's RPC limit is 30 s).
 */
import { createHash } from "node:crypto";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  reportSchema,
  type Report,
  type ReportJob,
  type ReportPeriod,
  type SessionNote,
  type reportGenerateRpc,
  type reportGetRpc,
} from "../../shared/report";
import { baseName, isOwnHelper, readJson, writeJson } from "../paths";
import { collectSessions, loadSessionText } from "../sources";
import { mapLimit } from "../sources/util";
import { cachedNote, clip, loadNotesCache, packBatches, runNotes, type NoteFields, type NoteItem, type NotesCache } from "./notes";
import { paseoRunnerPool, type Runner, type RunnerPool } from "./runner";
import { readSettings, readyProviders, resolveRunner, runnerLabel, type ResolvedRunner } from "./settings";
import { TOOL_FREE_PROVIDERS } from "./toolfree";
import { localDay, periodRange, reportsFile, type PeriodRange } from "./store";
import { buildSynthesisPrompt, normalizeSynthesis, SYNTH_SCHEMA, SYNTH_SYSTEM_PROMPT, SYNTH_TIMEOUT_MS, type ProjectFacts } from "./synthesis";

const log = (msg: string) => console.log("[report] " + msg);

// Plan

interface Plan {
  period: ReportPeriod;
  range: PeriodRange;
  /** Sessions with typed prompts in the period and a readable transcript, newest first. */
  items: NoteItem[];
  /** Prompts inside the period, by session key. */
  promptsInRange: Map<string, number>;
  cache: NotesCache;
  cached: Map<string, NoteFields>;
  /** Sessions that still need a note, newest first. */
  need: NoteItem[];
  batches: NoteItem[][];
  facts: ProjectFacts[];
  /** Changes when the period's activity does (what `stale` compares). */
  fingerprint: string;
}

async function buildPlan(period: ReportPeriod, tzOffsetMinutes: number): Promise<Plan> {
  const range = periodRange(period, tzOffsetMinutes);
  const sessions = await collectSessions({ sinceMs: range.startMs });
  const inRange = sessions.filter((s) => {
    if (isOwnHelper(s.cwd)) return false;
    return s.prompts.some((t) => t >= range.startMs && t < range.endMs);
  });
  const texts = await mapLimit(inRange, 6, (s) => loadSessionText(s));
  const items: NoteItem[] = [];
  const promptsInRange = new Map<string, number>();
  inRange.forEach((record, i) => {
    const text = texts[i];
    // Trivial sessions (no typed prompt in the transcript, or no transcript at all) get no note.
    if (!text || !text.promptCount) return;
    const key = record.source + ":" + record.id;
    items.push({ key, record, text });
    promptsInRange.set(key, record.prompts.filter((t) => t >= range.startMs && t < range.endMs).length);
  });
  const end = (i: NoteItem) => i.text.lastAt ?? i.record.endedAt;
  items.sort((a, b) => end(b) - end(a) || a.key.localeCompare(b.key));

  const cache = await loadNotesCache();
  const cached = new Map<string, NoteFields>();
  const need: NoteItem[] = [];
  for (const item of items) {
    const note = cachedNote(cache, item);
    if (note) cached.set(item.key, note);
    else need.push(item);
  }

  // Facts per project (by folder): share of the period's prompts, sessions, active local days.
  const byPath = new Map<string, { prompts: number; sessions: number; days: Set<number> }>();
  let total = 0;
  for (const item of items) {
    const path = item.record.cwd;
    const entry = byPath.get(path) ?? { prompts: 0, sessions: 0, days: new Set<number>() };
    const n = promptsInRange.get(item.key) ?? 0;
    entry.prompts += n;
    entry.sessions += 1;
    for (const t of item.record.prompts) if (t >= range.startMs && t < range.endMs) entry.days.add(localDay(t, tzOffsetMinutes));
    byPath.set(path, entry);
    total += n;
  }
  const facts: ProjectFacts[] = Array.from(byPath, ([path, e]) => ({
    projectPath: path,
    projectName: path ? baseName(path) : "(no folder)",
    share: total ? e.prompts / total : 0,
    prompts: e.prompts,
    sessions: e.sessions,
    activeDays: e.days.size,
  })).sort((a, b) => b.prompts - a.prompts || a.projectPath.localeCompare(b.projectPath));

  const fingerprint = createHash("sha1")
    .update(range.startMs + "|" + items.map((i) => i.key + ":" + i.text.promptCount + ":" + (i.text.lastAt ?? 0)).sort().join(","))
    .digest("hex")
    .slice(0, 16);

  return { period, range, items, promptsInRange, cache, cached, need, batches: packBatches(need), facts, fingerprint };
}

/** Plans are cheap to keep and costly to rebuild on every poll, so they live a minute. */
const planCache = new Map<string, { at: number; plan: Promise<Plan> }>();

function currentPlan(period: ReportPeriod, tzOffsetMinutes: number): Promise<Plan> {
  const key = period + ":" + tzOffsetMinutes;
  const hit = planCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.plan;
  const plan = buildPlan(period, tzOffsetMinutes);
  planCache.set(key, { at: Date.now(), plan });
  plan.catch(() => planCache.delete(key));
  return plan;
}

// Notes → SessionNote

const iso = (ms: number) => new Date(ms).toISOString();

function toSessionNote(item: NoteItem, note: NoteFields): SessionNote {
  const r = item.record;
  return {
    key: item.key,
    source: r.source,
    provider: r.provider,
    projectPath: r.cwd,
    projectName: r.cwd ? baseName(r.cwd) : "(no folder)",
    title: clip(r.title ?? item.text.prompts[0] ?? "", 120),
    startedAt: iso(r.startedAt),
    endedAt: iso(Math.max(r.endedAt, item.text.lastAt ?? 0)),
    prompts: r.prompts.length,
    tools: r.tools.length,
    paseoAgentId: r.paseoAgentId,
    summary: note.summary,
    state: note.state,
    importance: note.importance,
    open: note.open,
    ...(note.kind ? { kind: note.kind } : {}),
  };
}

// Report cache

interface StoredReport {
  report: Report;
  fingerprint: string;
  rangeStartMs: number;
}

async function readReports(): Promise<Partial<Record<ReportPeriod, StoredReport>>> {
  const raw = (await readJson(reportsFile())) as Record<string, unknown> | null;
  const out: Partial<Record<ReportPeriod, StoredReport>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const value of Object.values(raw)) {
    const v = value as Partial<StoredReport> | null;
    const parsed = reportSchema.safeParse(v?.report);
    if (parsed.success && typeof v?.fingerprint === "string") {
      out[parsed.data.period] = { report: parsed.data, fingerprint: v.fingerprint, rangeStartMs: Number(v.rangeStartMs) || 0 };
    }
  }
  return out;
}

// The job

const IDLE: ReportJob = { status: "idle", period: null, stage: null, done: 0, total: 0, startedAt: null, error: null };
let job: ReportJob = IDLE;
let pool: RunnerPool | null = null;
let disposed = false;

interface JobDeps {
  run: Runner;
  runners: { notes: ResolvedRunner; synthesis: ResolvedRunner };
  cancelled: () => boolean;
}

/** Runs a whole report on a fresh plan: notes for the uncached sessions, then the synthesis. */
async function runReport(plan: Plan, deps: JobDeps, onStage: (stage: ReportJob["stage"], done: number, total: number) => void): Promise<Report> {
  const started = Date.now();
  const notes = new Map(plan.cached);
  let noteCalls = 0;
  let notesWritten = 0;
  if (plan.batches.length) {
    onStage("notes", 0, plan.batches.length);
    const outcome = await runNotes(plan.batches, deps.run, deps.runners.notes, plan.cache, {
      onProgress: (done, total) => onStage("notes", done, total),
      cancelled: deps.cancelled,
      log,
    });
    noteCalls = outcome.calls;
    notesWritten = outcome.notes.size;
    for (const [k, v] of outcome.notes) notes.set(k, v);
    if (deps.cancelled()) throw new Error("The report was cancelled.");
    if (!outcome.notes.size && outcome.failures) throw new Error("Every notes call failed: " + outcome.firstError);
    if (outcome.failures) log(outcome.failures + " of " + plan.batches.length + " notes calls failed; going on with the rest");
  }
  const sessionNotes = plan.items.filter((i) => notes.has(i.key)).map((i) => toSessionNote(i, notes.get(i.key)!));
  if (!sessionNotes.length) throw new Error("No session got a note, so there is nothing to report.");
  const noted = new Set(sessionNotes.map((n) => n.key));
  // Facts over the noted sessions only, so shares match what the report shows.
  const facts = plan.facts.length && noted.size === plan.items.length ? plan.facts : recomputeFacts(plan, noted);

  onStage("synthesis", 0, 1);
  if (deps.cancelled()) throw new Error("The report was cancelled.");
  const input = { periodDescription: plan.range.description, rangeLabel: plan.range.label, projects: facts, notes: sessionNotes };
  const built = buildSynthesisPrompt(input);
  if (built.omitted) log("synthesis input trimmed: " + built.omitted + " minor notes left out");
  const answer = await deps.run({
    stage: "synthesis",
    runner: deps.runners.synthesis,
    title: "Dashboard report",
    systemPrompt: SYNTH_SYSTEM_PROMPT,
    prompt: built.prompt,
    schema: SYNTH_SCHEMA as unknown as Record<string, unknown>,
    timeoutMs: SYNTH_TIMEOUT_MS,
  });
  const words = normalizeSynthesis(answer, input, built);
  onStage("synthesis", 1, 1);
  return reportSchema.parse({
    period: plan.period,
    rangeLabel: plan.range.label,
    ...words,
    notes: sessionNotes,
    generatedAt: new Date().toISOString(),
    notesRunner: runnerLabel(deps.runners.notes),
    synthesisRunner: runnerLabel(deps.runners.synthesis),
    stats: {
      sessions: sessionNotes.length,
      notesFromCache: sessionNotes.filter((n) => plan.cached.has(n.key)).length,
      notesWritten,
      noteCalls,
      durationMs: Date.now() - started,
    },
  });
}

function recomputeFacts(plan: Plan, noted: Set<string>): ProjectFacts[] {
  const keep = new Set(plan.items.filter((i) => noted.has(i.key)).map((i) => i.record.cwd));
  const prompts = new Map<string, number>();
  const sessions = new Map<string, number>();
  for (const i of plan.items) {
    if (!noted.has(i.key)) continue;
    prompts.set(i.record.cwd, (prompts.get(i.record.cwd) ?? 0) + (plan.promptsInRange.get(i.key) ?? 0));
    sessions.set(i.record.cwd, (sessions.get(i.record.cwd) ?? 0) + 1);
  }
  const total = Array.from(prompts.values()).reduce((a, b) => a + b, 0);
  return plan.facts
    .filter((f) => keep.has(f.projectPath))
    .map((f) => ({ ...f, prompts: prompts.get(f.projectPath) ?? 0, sessions: sessions.get(f.projectPath) ?? 0, share: total ? (prompts.get(f.projectPath) ?? 0) / total : 0 }))
    .sort((a, b) => b.prompts - a.prompts || a.projectPath.localeCompare(b.projectPath));
}

export async function getReport(input: RpcInput<typeof reportGetRpc>): Promise<RpcOutput<typeof reportGetRpc>> {
  const [reports, plan] = await Promise.all([readReports(), currentPlan(input.period, input.tzOffsetMinutes).catch((e) => {
    log("could not plan: " + (e instanceof Error ? e.message : String(e)));
    return null;
  })]);
  const stored = reports[input.period] ?? null;
  const prompts = plan ? Array.from(plan.promptsInRange.values()).reduce((a, b) => a + b, 0) : 0;
  return {
    job: job.period === input.period || job.status === "running" ? job : IDLE,
    report: stored?.report ?? null,
    stale: Boolean(stored && plan && (stored.fingerprint !== plan.fingerprint || stored.rangeStartMs !== plan.range.startMs)),
    pending: {
      sessions: plan?.items.length ?? 0,
      uncached: plan?.need.length ?? 0,
      projects: plan?.facts.length ?? 0,
      prompts,
      estimatedNoteCalls: plan?.batches.length ?? 0,
    },
  };
}

async function liveRunners(context: PluginHandlerContext): Promise<{ notes: ResolvedRunner; synthesis: ResolvedRunner }> {
  const [providers, settings] = await Promise.all([readyProviders(context.paseo), readSettings()]);
  const notes = resolveRunner(providers, settings, "notes");
  const synthesis = resolveRunner(providers, settings, "synthesis");
  if (!notes || !synthesis)
    throw new Error(
      "Reports run on a provider that can start a helper with no tools: " + TOOL_FREE_PROVIDERS.join(", ") + ". None is ready in Paseo. Install or sign in to one in Paseo's settings.",
    );
  return { notes, synthesis };
}

export async function generateReport(
  input: RpcInput<typeof reportGenerateRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof reportGenerateRpc>> {
  if (job.status === "running") return { started: false, error: "A report is already being generated." };
  if (disposed) return { started: false, error: "The plugin is shutting down." };
  // Claimed before the first await, so two quick clicks can never start two paid runs.
  const previous = job;
  const period = input.period;
  job = { status: "running", period, stage: "scanning", done: 0, total: 0, startedAt: new Date().toISOString(), error: null };
  let plan: Plan;
  let runners: JobDeps["runners"];
  try {
    planCache.clear();
    plan = await buildPlan(period, input.tzOffsetMinutes);
    if (!plan.items.length) {
      job = previous;
      return { started: false, error: "No activity in this period to report on." };
    }
    runners = await liveRunners(context);
  } catch (e) {
    job = previous;
    return { started: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (disposed) {
    job = previous;
    return { started: false, error: "The plugin is shutting down." };
  }
  const own = paseoRunnerPool(context.paseo, log);
  pool = own;
  log("report " + period + ": " + plan.items.length + " sessions, " + plan.need.length + " need notes in " + plan.batches.length + " calls");
  // Not awaited: a run takes far longer than the host's RPC limit. The client polls report.get.
  void (async () => {
    try {
      const report = await runReport(plan, { run: own.run, runners, cancelled: () => disposed }, (stage, done, total) => {
        job = { ...job, stage, done, total };
      });
      const stored = await readReports();
      stored[period] = { report, fingerprint: plan.fingerprint, rangeStartMs: plan.range.startMs };
      await writeJson(reportsFile(), stored);
      job = { ...IDLE, period };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log("report failed: " + message);
      job = { ...IDLE, status: "error", period, error: message };
    } finally {
      planCache.clear();
      await own.finish().catch(() => {});
      if (pool === own) pool = null;
    }
  })();
  return { started: true, error: null };
}

/** Plugin start (also after a reload that kept this module loaded). */
export function initReport(): void {
  disposed = false;
}

/** Plugin cleanup: refuse new helper runs and remove the ones in flight. */
export async function disposeReport(): Promise<void> {
  disposed = true;
  const p = pool;
  pool = null;
  if (p) await p.dispose().catch(() => {});
}
