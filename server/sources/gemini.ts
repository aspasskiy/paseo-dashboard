/**
 * Gemini CLI. The legacy format is VERIFIED against real files (~/.gemini/tmp/<sha256>/chats/
 * session-*.json and logs.json); the Apr 2026+ session-*.jsonl format, projects.json and
 * .project_root are WRITTEN FROM SOURCE (chatRecordingService.ts, projectRegistry.ts).
 * Only files on disk are read; Gemini itself is never called.
 *
 * Store: $GEMINI_CLI_HOME/.gemini (default ~/.gemini). Older versions name the project folder
 * sha256(cwd); newer ones use a readable slug, with the path in tmp/<slug>/.project_root and in
 * ~/.gemini/projects.json. Hash-named folders are resolved by hashing cwds the other sources know.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CollectOptions, SessionRecord, SessionText, SourceAdapter } from "./types";
import { cachedParse, eachJsonLine, home, isHousekeeping, listDir, mapLimit, obj, span, statFile, str, TextCollector, titleOf, toMs } from "./util";

function geminiDir(): string {
  return join(process.env.GEMINI_CLI_HOME || home(), ".gemini");
}

interface ParsedChat {
  id: string | null;
  projectHash: string | null;
  start: number | null;
  last: number | null;
  prompts: number[];
  tools: number[];
  model: string | null;
  title: string | null;
  cwd: string | null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : (str(obj(p).text) ?? ""))).join("\n");
  return str(obj(content).text) ?? "";
}

function addMessage(out: ParsedChat, m: Record<string, unknown>) {
  const at = toMs(m.timestamp);
  if (at !== null) {
    if (out.start === null || at < out.start) out.start = at;
    if (out.last === null || at > out.last) out.last = at;
  }
  if (m.type === "user") {
    const text = contentText(m.content);
    if (at !== null && !isHousekeeping(text)) {
      out.prompts.push(at);
      if (!out.title) out.title = titleOf(text);
    }
  } else if (m.type === "gemini" || m.type === "model") {
    if (typeof m.model === "string") out.model = m.model;
    if (Array.isArray(m.toolCalls)) {
      for (const call of m.toolCalls) {
        const t = toMs(obj(call).timestamp) ?? at;
        if (t !== null) out.tools.push(t);
      }
    }
  }
}

function emptyChat(): ParsedChat {
  return { id: null, projectHash: null, start: null, last: null, prompts: [], tools: [], model: null, title: null, cwd: null };
}

/** session-*.json: one object with a messages array. */
function parseChatJson(text: string): ParsedChat {
  const raw = obj(JSON.parse(text));
  const out = emptyChat();
  out.id = str(raw.sessionId);
  out.projectHash = str(raw.projectHash);
  out.cwd = str(raw.directory) ?? str(raw.cwd);
  if (Array.isArray(raw.messages)) for (const m of raw.messages) addMessage(out, obj(m));
  if (typeof raw.summary === "string" && raw.summary) out.title = titleOf(raw.summary);
  out.start = Math.min(out.start ?? Infinity, toMs(raw.startTime) ?? Infinity);
  if (!Number.isFinite(out.start)) out.start = null;
  out.last = Math.max(out.last ?? -Infinity, toMs(raw.lastUpdated) ?? -Infinity);
  if (!Number.isFinite(out.last)) out.last = null;
  return out;
}

/**
 * session-*.jsonl (Apr 2026+): a metadata line {sessionId, projectHash, startTime, kind}, then
 * MessageRecords (a later line with the same id replaces the earlier one) and control lines
 * {$set}, {$rewindTo: id} (drops that message and all after it) and {$patch}.
 */
function parseChatJsonl(text: string): ParsedChat {
  const out = emptyChat();
  const replay = replayJsonl(text, (row) => {
    out.id = out.id ?? str(row.sessionId);
    out.projectHash = out.projectHash ?? str(row.projectHash);
    out.cwd = out.cwd ?? (Array.isArray(row.directories) ? str(row.directories[0]) : null) ?? str(row.directory);
    const t = toMs(row.startTime);
    if (t !== null) out.start = Math.min(out.start ?? Infinity, t);
    const u = toMs(row.lastUpdated);
    if (u !== null) out.last = Math.max(out.last ?? -Infinity, u);
  });
  if (replay.lastUpdated !== null) out.last = Math.max(out.last ?? -Infinity, replay.lastUpdated);
  for (const m of replay.messages) addMessage(out, m);
  if (replay.summary) out.title = titleOf(replay.summary);
  return out;
}

/** Replays a session-*.jsonl: the surviving messages in order, the summary, the metadata lines. */
function replayJsonl(text: string, onMeta: (row: Record<string, unknown>) => void): { messages: Record<string, unknown>[]; summary: string | null; lastUpdated: number | null } {
  const messages = new Map<string, Record<string, unknown>>();
  let order: string[] = [];
  let summary: string | null = null;
  let lastUpdated: number | null = null;
  let anon = 0;
  eachJsonLine(
    text,
    (row) => {
      if ("$set" in row) {
        const set = obj(row.$set);
        summary = str(set.summary) ?? summary;
        const t = toMs(set.lastUpdated);
        if (t !== null) lastUpdated = Math.max(lastUpdated ?? -Infinity, t);
        if (Array.isArray(set.messages)) {
          messages.clear();
          order = [];
          for (const m of set.messages) {
            const id = str(obj(m).id) ?? "anon" + anon++;
            messages.set(id, obj(m));
            order.push(id);
          }
        }
        return;
      }
      if ("$rewindTo" in row) {
        const at = order.indexOf(String(row.$rewindTo));
        if (at >= 0) {
          for (const id of order.slice(at)) messages.delete(id);
          order = order.slice(0, at);
        }
        return;
      }
      if ("$patch" in row) {
        const patch = obj(row.$patch);
        const id = str(patch.id);
        if (id && messages.has(id)) messages.set(id, { ...messages.get(id), ...patch });
        if (Array.isArray(patch.removeIds)) for (const rid of patch.removeIds) messages.delete(String(rid));
        return;
      }
      if (typeof row.type === "string" && "timestamp" in row) {
        const id = str(row.id) ?? "anon" + anon++;
        if (!messages.has(id)) order.push(id);
        messages.set(id, row);
        return;
      }
      if (typeof row.sessionId === "string") onMeta(row);
    },
  );
  const list: Record<string, unknown>[] = [];
  for (const id of order) {
    const m = messages.get(id);
    if (m) list.push(m);
  }
  return { messages: list, summary, lastUpdated };
}

/** logs.json: every typed prompt (also of sessions with no saved chat). */
function parseLogs(text: string): { sessionId: string; at: number; text: string }[] {
  const raw = JSON.parse(text);
  if (!Array.isArray(raw)) return [];
  const out: { sessionId: string; at: number; text: string }[] = [];
  for (const item of raw) {
    const row = obj(item);
    const at = toMs(row.timestamp);
    const sessionId = str(row.sessionId);
    const message = typeof row.message === "string" ? row.message : "";
    if (row.type === "user" && at !== null && sessionId && !isHousekeeping(message)) out.push({ sessionId, at, text: message });
  }
  return out;
}

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

/** projects.json: { projects: { "/abs/path": "slug" } } in newer builds. */
async function projectRegistry(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const reg = await cachedParse(join(geminiDir(), "projects.json"), (t) => obj(JSON.parse(t)));
  for (const [path, slug] of Object.entries(obj(reg?.projects))) if (typeof slug === "string") map.set(slug, path);
  return map;
}

/** Project folder name of each gemini record whose cwd is still unknown. */
const unresolved = new WeakMap<SessionRecord, string>();

/** Fill gemini cwds by hashing paths known from other sources (and their parents). */
export function resolveGeminiCwds(records: SessionRecord[], knownCwds: Iterable<string>): void {
  const pending = records.filter((r) => r.source === "gemini" && !r.cwd && unresolved.has(r));
  if (!pending.length) return;
  const byHash = new Map<string, string>();
  const add = (path: string) => {
    if (path && !byHash.has(path)) byHash.set(createHash("sha256").update(path).digest("hex"), path);
  };
  add(home());
  for (const cwd of knownCwds) {
    let p = cwd;
    for (let i = 0; i < 4 && p && p !== "/"; i++) {
      add(p);
      p = dirname(p);
    }
  }
  for (const r of pending) {
    const hit = byHash.get(unresolved.get(r)!);
    if (hit) r.cwd = hit;
  }
}

export const geminiAdapter: SourceAdapter = {
  id: "gemini",
  label: "Gemini CLI",
  async collect(opts: CollectOptions): Promise<SessionRecord[]> {
    const tmp = join(geminiDir(), "tmp");
    const since = opts.sinceMs ?? -Infinity;
    const registry = await projectRegistry();
    const projects = (await listDir(tmp)).filter((e) => e.dir && e.name !== "bin");
    const groups = await mapLimit(projects, 8, async (project): Promise<SessionRecord[]> => {
      const dir = join(tmp, project.name);
      const root = registry.get(project.name) ?? (await readText(join(dir, ".project_root")));
      const files = (await listDir(join(dir, "chats"))).filter((e) => !e.dir && e.name.startsWith("session-"));
      const records = new Map<string, SessionRecord>();
      for (const file of files) {
        const path = join(dir, "chats", file.name);
        const info = await statFile(path);
        if (!info || info.mtimeMs < since) continue;
        const parse = file.name.endsWith(".jsonl") ? parseChatJsonl : file.name.endsWith(".json") ? parseChatJson : null;
        if (!parse) continue;
        const chat = await cachedParse(path, parse, info);
        if (!chat || !chat.prompts.length) continue;
        const id = chat.id ?? file.name;
        const times = span(chat.prompts.concat(chat.tools), chat.start ?? info.mtimeMs);
        const record: SessionRecord = {
          source: "gemini",
          provider: "gemini",
          id,
          cwd: chat.cwd ?? root ?? "",
          title: chat.title,
          startedAt: Math.min(times.start, chat.start ?? Infinity),
          endedAt: Math.max(times.end, chat.last ?? -Infinity),
          prompts: chat.prompts.slice(),
          tools: chat.tools.slice(),
          model: chat.model,
          paseoAgentId: null,
          nativeId: chat.id,
          files: [path],
        };
        if (!record.cwd) unresolved.set(record, chat.projectHash ?? project.name);
        const prev = records.get(id);
        // A session can be split over several files; merge them.
        if (prev) {
          prev.prompts = Array.from(new Set(prev.prompts.concat(record.prompts))).sort((a, b) => a - b);
          prev.tools = prev.tools.concat(record.tools);
          prev.startedAt = Math.min(prev.startedAt, record.startedAt);
          prev.endedAt = Math.max(prev.endedAt, record.endedAt);
          prev.files = (prev.files ?? []).concat(path);
        } else {
          records.set(id, record);
        }
      }
      // Sessions that only left prompts in logs.json (chat recording off or not saved).
      const logs = await cachedParse(join(dir, "logs.json"), parseLogs);
      const extra = new Map<string, { at: number; text: string }[]>();
      for (const row of logs ?? []) {
        if (records.has(row.sessionId)) continue;
        const list = extra.get(row.sessionId) ?? [];
        list.push(row);
        extra.set(row.sessionId, list);
      }
      for (const [sessionId, rows] of extra) {
        const prompts = rows.map((r) => r.at).sort((a, b) => a - b);
        const times = span(prompts, 0);
        if (times.end < since) continue;
        const record: SessionRecord = {
          source: "gemini",
          provider: "gemini",
          id: sessionId,
          cwd: root ?? "",
          title: titleOf(rows[0].text),
          startedAt: times.start,
          endedAt: times.end,
          prompts,
          tools: [],
          model: null,
          paseoAgentId: null,
          nativeId: sessionId,
          files: [join(dir, "logs.json")],
        };
        if (!record.cwd) unresolved.set(record, project.name);
        records.set(sessionId, record);
      }
      return Array.from(records.values()).filter((r) => r.endedAt >= since);
    });
    return groups.flat();
  },
};

// Text, for the report's notes. Gemini writes no recap; its `summary` is a title.

/** Messages of one chat file (either format), in order. */
function chatMessages(path: string, text: string): Record<string, unknown>[] {
  if (path.endsWith(".jsonl")) return replayJsonl(text, () => {}).messages;
  const raw = obj(JSON.parse(text));
  return Array.isArray(raw.messages) ? raw.messages.map(obj) : [];
}

function geminiReplyText(m: Record<string, unknown>): string {
  return contentText(m.content);
}

/**
 * Text of a Gemini session from its chat file(s), or from logs.json (prompts only) for sessions
 * whose chat was not saved. `files` come from the record; `sessionId` picks the logs.json rows.
 */
export async function loadGeminiText(files: string[], sessionId: string | null): Promise<SessionText | null> {
  const parts = await Promise.all(
    files.map(async (path) => {
      if (path.endsWith("logs.json")) {
        const rows = await cachedParse(path, parseLogs, undefined, "text");
        return (rows ?? []).filter((r) => r.sessionId === sessionId).map((r) => ({ type: "user", timestamp: r.at, content: r.text }) as Record<string, unknown>);
      }
      return (await cachedParse(path, (t) => chatMessages(path, t), undefined, "text")) ?? [];
    }),
  );
  const messages = parts.flat();
  if (!messages.length) return null;
  messages.sort((a, b) => (toMs(a.timestamp) ?? 0) - (toMs(b.timestamp) ?? 0));
  const text = new TextCollector();
  for (const m of messages) {
    const at = toMs(m.timestamp);
    if (m.type === "user") text.prompt(contentText(m.content), at);
    else if (m.type === "gemini" || m.type === "model") text.replyText(geminiReplyText(m), at);
  }
  return text.finish();
}
