/**
 * OpenAI Codex (CLI, IDE extension and Codex Desktop). PARTLY VERIFIED: the file layout,
 * envelope, session_meta and the import-skip path against real files (~/.codex/sessions/
 * YYYY/MM/DD/rollout-*.jsonl, Codex Desktop 0.153, all of them imported Claude sessions);
 * native turns (event_msg user_message, response_item *_call, turn_context model) and the older
 * pre-envelope format are written from the Codex source and checked on a fixture only.
 *
 * Store: $CODEX_HOME (default ~/.codex): sessions/ and archived_sessions/. The same data is in
 * state_5.sqlite, but node:sqlite is not available in every runtime, and the JSONL has it all.
 *
 * Codex Desktop can import Claude Code sessions: those turns have turn_id "external-import-*"
 * and carry the import time as their timestamp. They are skipped, because the original
 * Claude session is already counted by the claude adapter.
 */
import { join } from "node:path";
import type { CollectOptions, SessionRecord, SessionText, SourceAdapter } from "./types";
import { cachedLines, home, jsonlParser, type LineParser, listDir, mapLimit, obj, span, statFile, str, TextCollector, titleOf, toMs, type FileInfo } from "./util";

function codexHome(): string {
  return process.env.CODEX_HOME || join(home(), ".codex");
}

const INJECTED = ["<environment_context>", "<user_instructions>", "<INSTRUCTIONS>", "# AGENTS.md", "<user_shell_command>", "<turn_aborted>"];

function injected(text: string): boolean {
  const t = text.trimStart();
  return INJECTED.some((p) => t.startsWith(p));
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = obj(part);
      return typeof p.text === "string" ? p.text : "";
    })
    .join("\n");
}

interface ParsedRollout {
  id: string | null;
  cwd: string;
  model: string | null;
  start: number | null;
  last: number | null;
  prompts: number[];
  tools: number[];
  title: string | null;
  subagent: boolean;
}

function rolloutParser(): LineParser<ParsedRollout> {
  const out: ParsedRollout = { id: null, cwd: "", model: null, start: null, last: null, prompts: [], tools: [], title: null, subagent: false };
  const eventPrompts: { at: number; text: string }[] = [];
  const itemPrompts: { at: number; text: string }[] = [];
  let importing = false;
  let sawMeta = false;
  return jsonlParser(
    // Assistant messages and reasoning are most of the bytes and say nothing we count.
    (line) => !(line.indexOf('"role":"assistant"') >= 0 || line.indexOf('"type":"reasoning"') >= 0 || line.indexOf('"type":"token_count"') >= 0),
    (row) => {
      const wrapped = typeof row.type === "string" && "payload" in row;
      const kind = wrapped ? (row.type as string) : "legacy";
      const p = wrapped ? obj(row.payload) : row;
      const at = toMs(row.timestamp) ?? out.start;
      if (at !== null && (out.last === null || at > out.last)) out.last = at;

      if (kind === "session_meta" || (!wrapped && !sawMeta && typeof row.id === "string" && "instructions" in row)) {
        // A resumed or forked rollout repeats session_meta; the first one names this file.
        if (sawMeta) return;
        sawMeta = true;
        out.id = str(p.id) ?? str(p.session_id);
        out.cwd = str(p.cwd) ?? "";
        out.start = toMs(p.timestamp) ?? at;
        const source = p.source;
        if (source && typeof source === "object" && "subagent" in (source as object)) out.subagent = true;
        return;
      }
      if (kind === "turn_context") {
        out.model = str(p.model) ?? out.model;
        if (!out.cwd) out.cwd = str(p.cwd) ?? "";
        return;
      }
      if (kind === "event_msg") {
        if (p.type === "task_started" || p.type === "turn_started") {
          importing = typeof p.turn_id === "string" && p.turn_id.startsWith("external-import");
        } else if (p.type === "user_message" && !importing && at !== null) {
          const message = typeof p.message === "string" ? p.message : "";
          if (!injected(message)) eventPrompts.push({ at, text: message });
        }
        return;
      }
      // response_item (wrapped) or a bare item (legacy format).
      if (kind !== "response_item" && kind !== "legacy") return;
      if (importing || at === null) return;
      const type = typeof p.type === "string" ? p.type : "";
      if (type === "message" && p.role === "user") {
        const message = textOf(p.content);
        if (message && !injected(message)) itemPrompts.push({ at, text: message });
      } else if (type.endsWith("_call") && !type.endsWith("_output")) {
        out.tools.push(at);
      }
    },
    () => {
      // Newer rollouts log each typed prompt as an event; older ones only as a user message item.
      const prompts = eventPrompts.length ? eventPrompts : itemPrompts;
      for (const prompt of prompts) {
        out.prompts.push(prompt.at);
        if (!out.title) out.title = titleOf(prompt.text);
      }
      return out;
    },
  );
}

async function rolloutFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string, depth: number) => {
    const entries = await listDir(dir);
    await Promise.all(
      entries.map(async (e) => {
        const path = join(dir, e.name);
        if (e.dir && depth < 4) await walk(path, depth + 1);
        else if (!e.dir && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) files.push(path);
      }),
    );
  };
  await walk(root, 0);
  return files;
}

export const codexAdapter: SourceAdapter = {
  id: "codex",
  label: "Codex",
  async collect(opts: CollectOptions): Promise<SessionRecord[]> {
    const root = codexHome();
    const files = (await Promise.all([rolloutFiles(join(root, "sessions")), rolloutFiles(join(root, "archived_sessions"))])).flat();
    const since = opts.sinceMs ?? -Infinity;
    const records = await mapLimit(files, 16, async (path): Promise<SessionRecord | null> => {
      const info: FileInfo | null = await statFile(path);
      if (!info || info.mtimeMs < since) return null;
      const parsed = await cachedLines(path, rolloutParser, info);
      if (!parsed || parsed.subagent || (!parsed.prompts.length && !parsed.tools.length)) return null;
      const fallback = parsed.start ?? info.mtimeMs;
      const times = span(parsed.prompts.concat(parsed.tools), fallback);
      const id = parsed.id ?? path;
      return {
        source: "codex",
        provider: "codex",
        id,
        cwd: parsed.cwd,
        title: parsed.title,
        startedAt: Math.min(times.start, parsed.start ?? Infinity),
        endedAt: Math.max(times.end, parsed.last ?? -Infinity),
        prompts: parsed.prompts.slice(),
        tools: parsed.tools.slice(),
        model: parsed.model,
        paseoAgentId: null,
        nativeId: parsed.id,
        files: [path],
      };
    });
    // A thread can be both in sessions/ and archived_sessions/: keep the longer copy.
    const byId = new Map<string, SessionRecord>();
    for (const r of records) {
      if (!r || r.endedAt < since) continue;
      const prev = byId.get(r.id);
      if (!prev || r.prompts.length + r.tools.length > prev.prompts.length + prev.tools.length) byId.set(r.id, r);
    }
    return Array.from(byId.values());
  },
};

// Text, for the report's notes. WRITTEN FROM SOURCE for native turns (event_msg user_message /
// agent_message / task_complete, response_item messages); imported turns are skipped like above.

function codexTextParser(): LineParser<SessionText> {
  const events = new TextCollector();
  const items = new TextCollector();
  let sawEventPrompt = false;
  let importing = false;
  return jsonlParser(
    (line) => line.indexOf('"type":"reasoning"') < 0 && line.indexOf('"type":"token_count"') < 0 && line.length < 256 * 1024,
    (row) => {
      const wrapped = typeof row.type === "string" && "payload" in row;
      const kind = wrapped ? (row.type as string) : "legacy";
      const p = wrapped ? obj(row.payload) : row;
      const at = toMs(row.timestamp);
      if (kind === "event_msg") {
        if (p.type === "task_started" || p.type === "turn_started") {
          importing = typeof p.turn_id === "string" && p.turn_id.startsWith("external-import");
        } else if (importing) {
          return;
        } else if (p.type === "user_message") {
          const message = typeof p.message === "string" ? p.message : "";
          if (!injected(message) && events.prompt(message, at)) sawEventPrompt = true;
        } else if (p.type === "agent_message") {
          if (typeof p.message === "string") events.replyText(p.message, at);
        } else if (p.type === "task_complete") {
          if (typeof p.last_agent_message === "string") events.replyText(p.last_agent_message, at);
        }
        return;
      }
      if ((kind !== "response_item" && kind !== "legacy") || importing) return;
      if (p.type !== "message") return;
      const message = textOf(p.content);
      if (p.role === "user") {
        if (message && !injected(message)) items.prompt(message, at);
      } else if (p.role === "assistant") {
        // Replies count for both shapes: some builds log agent_message events, some only items.
        items.replyText(message, at);
        events.replyText(message, at);
      }
    },
    // Newer rollouts log each typed prompt as an event; older ones only as message items.
    () => (sawEventPrompt ? events.finish() : items.finish()),
  );
}

/** Text of one Codex rollout file. Cached per (mtime, size). */
export function loadCodexText(path: string): Promise<SessionText | null> {
  return cachedLines(path, codexTextParser, undefined, "text");
}
