/**
 * Claude Code. VERIFIED against real files (~/.claude/history.jsonl, ~/.claude/projects/*.jsonl).
 *
 * Terminal prompts come from history.jsonl (one line per typed prompt: display, timestamp,
 * project, sessionId). The transcripts under projects/ are huge (tens of GB on heavy users),
 * so they are only opened for short windows (sinceMs within ENRICH_WINDOW_MS), to add tool
 * calls, model and the real end time, and for Paseo agents (see paseo.ts).
 */
import { join } from "node:path";
import { claudeHome, claudeTranscriptPath } from "../paths";
import type { CollectOptions, SessionRecord, SessionText, SourceAdapter } from "./types";
import {
  cachedLines,
  cachedParse,
  eachJsonLine,
  isHousekeeping,
  jsonlParser,
  listDir,
  mapLimit,
  parseLine,
  span,
  statFile,
  TextCollector,
  titleOf,
  toMs,
  type LineParser,
} from "./util";

const ENRICH_WINDOW_MS = 8 * 86_400_000;

interface HistorySession {
  sessionId: string;
  project: string;
  prompts: number[];
  first: number;
  last: number;
  title: string | null;
}

function parseHistory(text: string): HistorySession[] {
  const sessions = new Map<string, HistorySession>();
  eachJsonLine(
    text,
    (row) => {
      const at = typeof row.timestamp === "number" ? row.timestamp : NaN;
      if (!Number.isFinite(at)) return;
      const project = typeof row.project === "string" ? row.project : "";
      const shown = typeof row.display === "string" ? row.display : "";
      // Old Claude Code versions wrote no sessionId: group those by project and day.
      const sessionId =
        typeof row.sessionId === "string" && row.sessionId
          ? row.sessionId
          : "legacy:" + project + ":" + new Date(at).toISOString().slice(0, 10);
      let session = sessions.get(sessionId);
      if (!session) {
        session = { sessionId, project, prompts: [], first: at, last: at, title: null };
        sessions.set(sessionId, session);
      }
      session.first = Math.min(session.first, at);
      session.last = Math.max(session.last, at);
      if (!session.project && project) session.project = project;
      if (isHousekeeping(shown)) return;
      session.prompts.push(at);
      if (!session.title) session.title = titleOf(shown);
    },
  );
  return Array.from(sessions.values()).filter((s) => s.prompts.length > 0);
}

interface TranscriptStats {
  prompts: number[];
  tools: number[];
  model: string | null;
  first: number | null;
  last: number | null;
  title: string | null;
}

/** User prompts, tool calls and model from one Claude Code transcript (main thread only). */
function transcriptParser(): LineParser<TranscriptStats> {
  const prompts: number[] = [];
  const tools: number[] = [];
  let model: string | null = null;
  let title: string | null = null;
  let first: number | null = null;
  let last: number | null = null;
  return jsonlParser(
    (line) => line.indexOf('"type":"user"') >= 0 || line.indexOf('"type":"assistant"') >= 0,
    (row) => {
      if (row.isSidechain || row.isMeta || typeof row.timestamp !== "string") return;
      const at = Date.parse(row.timestamp);
      if (!Number.isFinite(at)) return;
      const message = (row.message ?? {}) as { content?: unknown; model?: unknown };
      const content = message.content;
      if (row.type === "user") {
        let text: string | null = null;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          const parts = content as { type?: string; text?: string }[];
          if (parts.some((p) => p && p.type === "tool_result")) return;
          const textPart = parts.find((p) => p && p.type === "text");
          if (!textPart) return;
          text = typeof textPart.text === "string" ? textPart.text : "";
        } else {
          return;
        }
        // Local command echoes and caveats are written as user lines too.
        if (text.startsWith("<command-name>") || text.startsWith("<local-command") || text.startsWith("Caveat:")) return;
        prompts.push(at);
        if (!title) title = titleOf(text);
      } else if (row.type === "assistant") {
        if (typeof message.model === "string" && message.model !== "<synthetic>") model = message.model;
        if (Array.isArray(content)) {
          for (const part of content as { type?: string }[]) if (part && part.type === "tool_use") tools.push(at);
        }
      }
      if (first === null || at < first) first = at;
      if (last === null || at > last) last = at;
    },
    () => ({ prompts, tools, model, first, last, title }),
  );
}

export function readClaudeTranscript(cwd: string, sessionId: string): Promise<TranscriptStats | null> {
  return cachedLines(claudeTranscriptPath(cwd, sessionId), transcriptParser);
}

export const claudeAdapter: SourceAdapter = {
  id: "claude",
  label: "Claude Code",
  async collect(opts: CollectOptions): Promise<SessionRecord[]> {
    const history = await cachedParse(join(claudeHome(), "history.jsonl"), parseHistory);
    if (!history) return [];
    const since = opts.sinceMs ?? -Infinity;
    // A session keeps working after its last typed prompt; allow a day of slack.
    const picked = history.filter((s) => s.last >= since - 86_400_000);
    const enrich = opts.sinceMs !== undefined && Date.now() - opts.sinceMs <= ENRICH_WINDOW_MS;
    const records = await mapLimit(picked, 4, async (s): Promise<SessionRecord | null> => {
      const stats = enrich && s.project && !s.sessionId.startsWith("legacy:") ? await readClaudeTranscript(s.project, s.sessionId) : null;
      const times = span(s.prompts, s.first);
      const startedAt = Math.min(times.start, stats?.first ?? Infinity);
      const endedAt = Math.max(times.end, s.last, stats?.last ?? -Infinity);
      if (endedAt < since) return null;
      return {
        source: "claude",
        provider: "claude",
        id: s.sessionId,
        cwd: s.project,
        title: s.title ?? stats?.title ?? null,
        startedAt,
        endedAt,
        prompts: s.prompts.slice().sort((a, b) => a - b),
        tools: stats ? stats.tools.slice() : [],
        model: stats?.model ?? null,
        paseoAgentId: null,
        nativeId: s.sessionId.startsWith("legacy:") ? null : s.sessionId,
      };
    });
    return records.filter((r): r is SessionRecord => r !== null);
  },
};

// Text, for the report's notes

/** Lines bigger than this are tool output or pasted blobs, never a prompt worth reading. */
const MAX_TEXT_LINE = 256 * 1024;

function claudeContentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const part of content as { type?: unknown; text?: unknown }[]) {
    if (part && part.type === "text" && typeof part.text === "string") texts.push(part.text);
  }
  return texts.length ? texts.join("\n") : null;
}

/**
 * The owner's prompts (typed, and queued mid-turn), Claude Code's away recap (system/away_summary)
 * and the assistant's last text reply, main thread only. Only lines that can hold them are parsed:
 * a transcript is mostly tool traffic and bookkeeping.
 */
function claudeTextParser(): LineParser<SessionText> {
  const text = new TextCollector();
  // A resumed or forked session copies earlier records into the file again (new uuids, same time
  // and text): count each (kind, time, text) once.
  const seen = new Set<string>();
  const once = (kind: string, at: number | null, body: string) => {
    const key = kind + "|" + at + "|" + body.slice(0, 200);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  return {
    line(line) {
      if (line.length > MAX_TEXT_LINE) return;
      const user = line.indexOf('"type":"user"') >= 0;
      const assistant = !user && line.indexOf('"type":"assistant"') >= 0;
      const recap = !user && !assistant && line.indexOf('"away_summary"') >= 0;
      const queued = !user && !assistant && !recap && line.indexOf('"queued_command"') >= 0;
      if (!user && !assistant && !recap && !queued) return;
      // Tool results ride on user lines and assistant lines without a text part hold only tool calls.
      if (user && line.indexOf('"tool_use_id"') >= 0) return;
      if (assistant && line.indexOf('"type":"text"') < 0) return;
      const row = parseLine(line);
      if (!row || row.isSidechain === true) return;
      const at = toMs(row.timestamp);
      if (row.type === "system") {
        if (row.subtype === "away_summary" && typeof row.content === "string") text.setRecap(row.content, at);
        return;
      }
      if (row.type === "attachment") {
        const a = (row.attachment ?? {}) as Record<string, unknown>;
        const origin = (a.origin ?? {}) as Record<string, unknown>;
        if (a.type !== "queued_command" || a.commandMode !== "prompt" || origin.kind !== "human") return;
        const prompt = claudeContentText(a.prompt);
        if (prompt && once("q", at, prompt)) text.prompt(prompt, at, true);
        return;
      }
      if (row.isMeta === true || row.isCompactSummary === true) return;
      const message = (row.message ?? {}) as { content?: unknown };
      const content = claudeContentText(message.content);
      if (content === null || !once(String(row.type), at, content)) return;
      if (row.type === "user") text.prompt(content, at);
      else if (row.type === "assistant") text.replyText(content, at);
    },
    done: () => text.finish(),
  };
}

/** The transcript of a Claude Code session: by its launch folder, else found by id in any project folder. */
export async function findClaudeTranscript(cwd: string, sessionId: string): Promise<string | null> {
  if (cwd) {
    const direct = claudeTranscriptPath(cwd, sessionId);
    if (await statFile(direct)) return direct;
  }
  const root = join(claudeHome(), "projects");
  for (const dir of await listDir(root)) {
    if (!dir.dir) continue;
    const path = join(root, dir.name, sessionId + ".jsonl");
    if (await statFile(path)) return path;
  }
  return null;
}

/** Text of one Claude Code transcript file. Cached per (mtime, size). */
export function loadClaudeText(path: string): Promise<SessionText | null> {
  return cachedLines(path, claudeTextParser, undefined, "text");
}
