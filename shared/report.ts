import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * FROZEN CONTRACT between the report pipeline (server/report/*), the project icons
 * (server/icons.ts) and the UI (client/report/*). Two-stage AI:
 *   1. notes: a small model (Haiku-class) writes one note per session, in batches, cached per session;
 *   2. synthesis: a strong model (Opus-class) turns the notes into the period report.
 * Both stages run as Paseo helper agents on the user's own provider. Only on explicit request.
 * Changes allowed only as new OPTIONAL fields; never rename or remove.
 */

export const reportPeriodSchema = z.enum(["week", "last-week", "30d"]);
export type ReportPeriod = z.infer<typeof reportPeriodSchema>;

export const sessionStateSchema = z.enum(["done", "in_progress", "blocked", "abandoned", "no_work"]);
export type SessionState = z.infer<typeof sessionStateSchema>;

/** What kind of work a session was (stage 1). */
export const workKindSchema = z.enum(["feature", "fix", "ops", "research", "content", "admin"]);
export type WorkKind = z.infer<typeof workKindSchema>;

/** What the owner has to do about a loose end (stage 2). */
export const askKindSchema = z.enum(["decide", "approve", "fix", "follow_up"]);
export type AskKind = z.infer<typeof askKindSchema>;

/** What kind of outcome shipped (stage 2). */
export const outcomeTypeSchema = z.enum(["release", "feature", "fix", "infra", "content", "research"]);
export type OutcomeType = z.infer<typeof outcomeTypeSchema>;

/** Stage 1 output for one session, plus the facts the server already knows. */
export const sessionNoteSchema = z.object({
  /** "<source>:<id>", unique across sources. */
  key: z.string(),
  source: z.string(),
  provider: z.string(),
  /** Absolute project path ("" unknown) and its short name. */
  projectPath: z.string(),
  projectName: z.string(),
  /** Session title (agent title or first prompt line), max 120 chars. */
  title: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  prompts: z.number(),
  tools: z.number(),
  /** Set for Paseo agents, so the UI can open them. */
  paseoAgentId: z.string().nullable(),
  // --- written by the notes model ---
  /** ≤ 300 chars: goal and what was done, with specifics. */
  summary: z.string(),
  state: sessionStateSchema,
  /** 0 trivial … 4 critical (money, prod, customers, deadlines). */
  importance: z.number(),
  /** ≤ 3 items, ≤ 120 chars each: what is left for the owner, imperative. */
  open: z.array(z.string()),
  /** Optional: notes written before this field existed have none. */
  kind: workKindSchema.optional(),
});
export type SessionNote = z.infer<typeof sessionNoteSchema>;

/** Stage 2 output: one project in the report. */
export const reportProjectSchema = z.object({
  projectPath: z.string(),
  projectName: z.string(),
  /** Share of the period's prompts, 0..1 (computed by the server, not the model). */
  share: z.number(),
  prompts: z.number(),
  sessions: z.number(),
  activeDays: z.number(),
  /** One line: the most important outcome in this project this period. */
  headline: z.string(),
  /** 1–2 sentences of context. */
  summary: z.string(),
  /** Concrete outcomes, most important first, ≤ 6. */
  shipped: z.array(z.string()),
  /** Loose ends for the owner, ≤ 4. */
  open: z.array(z.string()),
  /** Keys of the sessions behind it (sessionNote.key), most important first. */
  sessionKeys: z.array(z.string()),
});
export type ReportProject = z.infer<typeof reportProjectSchema>;

export const reportSchema = z.object({
  period: reportPeriodSchema,
  /** "Nov 16 – Nov 22" */
  rangeLabel: z.string(),
  /** One sentence: where the period went. */
  headline: z.string(),
  /** 2–4 sentences: the story of the period, specific, no filler. */
  narrative: z.string(),
  /** 2–5 short theme labels. */
  themes: z.array(z.string()),
  projects: z.array(reportProjectSchema),
  /** The most important loose ends across projects, ≤ 6. */
  openLoops: z.array(z.object({ text: z.string(), projectName: z.string(), sessionKey: z.string().nullable(), importance: z.number() })),
  /** Typed asks for the owner, most important first, ≤ 8. Optional: older reports only have openLoops. */
  needsYou: z
    .array(z.object({ kind: askKindSchema, text: z.string(), projectName: z.string(), sessionKey: z.string().nullable(), importance: z.number() }))
    .optional(),
  /** Typed outcomes of the period, most important first, ≤ 10. Optional: older reports only have projects[].shipped. */
  shipped: z.array(z.object({ type: outcomeTypeSchema, text: z.string(), projectName: z.string(), sessionKey: z.string().nullable() })).optional(),
  /** Every note used, so the UI can drill into a project's sessions. */
  notes: z.array(sessionNoteSchema),
  generatedAt: z.string(),
  /** "Claude · Haiku 5.5" / "Claude · Opus 5.5" */
  notesRunner: z.string(),
  synthesisRunner: z.string(),
  stats: z.object({
    sessions: z.number(),
    notesFromCache: z.number(),
    notesWritten: z.number(),
    noteCalls: z.number(),
    durationMs: z.number(),
  }),
});
export type Report = z.infer<typeof reportSchema>;

export const reportJobSchema = z.object({
  status: z.enum(["idle", "running", "error"]),
  period: reportPeriodSchema.nullable(),
  stage: z.enum(["scanning", "notes", "synthesis"]).nullable(),
  /** During "notes": batches finished / total. */
  done: z.number(),
  total: z.number(),
  startedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type ReportJob = z.infer<typeof reportJobSchema>;

export const reportInputSchema = z.object({ period: reportPeriodSchema, tzOffsetMinutes: z.number() });

export const reportGetRpc = defineRpc({
  name: "report.get",
  input: reportInputSchema,
  output: z.object({
    job: reportJobSchema,
    report: reportSchema.nullable(),
    /** Activity changed since `report` was generated. */
    stale: z.boolean(),
    /** What a run would cover now; `uncached` = sessions that still need a note. */
    pending: z.object({ sessions: z.number(), uncached: z.number(), projects: z.number(), prompts: z.number(), estimatedNoteCalls: z.number() }),
  }),
});

export const reportGenerateRpc = defineRpc({
  name: "report.generate",
  input: reportInputSchema,
  /** Starts the background job and returns at once; poll report.get. */
  output: z.object({ started: z.boolean(), error: z.string().nullable() }),
});

export const runnerChoiceSchema = z.object({
  /** null = Paseo's first ready provider. */
  provider: z.string().nullable(),
  /** null = automatic: fast tier for notes, strongest tier for synthesis. */
  model: z.string().nullable(),
});
export const reportSettingsSchema = z.object({ notes: runnerChoiceSchema, synthesis: runnerChoiceSchema });
export type ReportSettings = z.infer<typeof reportSettingsSchema>;

export const providerOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  models: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean() })),
});
export type ProviderOption = z.infer<typeof providerOptionSchema>;

export const reportSettingsGetRpc = defineRpc({
  name: "report.settings.get",
  input: z.object({}),
  output: z.object({
    settings: reportSettingsSchema,
    providers: z.array(providerOptionSchema),
    /** What "automatic" resolves to now, for display. */
    resolved: z.object({ notes: z.string(), synthesis: z.string() }),
  }),
});

export const reportSettingsSetRpc = defineRpc({
  name: "report.settings.set",
  input: z.object({ settings: reportSettingsSchema }),
  output: z.object({ ok: z.boolean() }),
});

// Project icons (owned by server/icons.ts)

export const projectIconSchema = z.object({
  /** data: URI of a raster image (png/jpeg/webp/ico converted), ≤ 64 KB; null = none found. */
  uri: z.string().nullable(),
  /** Where it came from, for debugging ("public/favicon.png", "AppIcon.appiconset/…"). */
  from: z.string().nullable(),
});
export type ProjectIcon = z.infer<typeof projectIconSchema>;

export const projectIconsRpc = defineRpc({
  name: "projects.icons",
  input: z.object({ paths: z.array(z.string()).max(50) }),
  output: z.object({ icons: z.record(z.string(), projectIconSchema) }),
});
