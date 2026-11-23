/**
 * GitHub Copilot CLI. WRITTEN FROM SOURCE (closed source CLI; schema from microsoft/copilot-sdk
 * generated session-events.ts, and the bundled JS of @github/copilot 1.0.57 / 0.0.350).
 * ~/.copilot exists on this machine but session-state/ holds only lock files.
 *
 * Store: $COPILOT_HOME (default ~/.copilot); old builds used $XDG_STATE_HOME/.copilot.
 *   session-state/<id>/events.jsonl (+ workspace.yaml with cwd and name/summary), and the
 *   legacy flat session-state/<id>.jsonl with the same events.
 * Event: {type, data, id, timestamp, parentId, agentId?, checkpoint?}. session.start carries
 * data.context.cwd and selectedModel; user.message is a prompt unless it has data.source,
 * isAutopilotContinuation/agentAuthored, or an agentId (subagent); tool.execution_start is a
 * tool call. The pre-0.0.342 history-session-state/*.json files have no per-message times and
 * are not read.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CollectOptions, SessionRecord, SessionText, SourceAdapter } from "./types";
import { cachedLines, home, isHousekeeping, jsonlParser, listDir, mapLimit, obj, span, statFile, str, TextCollector, titleOf, toMs, type LineParser } from "./util";

interface ParsedCopilot {
  id: string | null;
  cwd: string;
  start: number | null;
  last: number | null;
  prompts: number[];
  tools: number[];
  model: string | null;
  title: string | null;
  firstPrompt: string | null;
}

function copilotParser(): LineParser<ParsedCopilot> {
  const out: ParsedCopilot = { id: null, cwd: "", start: null, last: null, prompts: [], tools: [], model: null, title: null, firstPrompt: null };
  return jsonlParser(
    // Assistant text and tool output are the bulk; only their envelope type matters here.
    (line) => line.indexOf('"assistant.message_delta"') < 0 && line.indexOf('"tool.execution_partial_result"') < 0,
    (row) => {
      if (row.checkpoint === true || row.ephemeral === true) return;
      const at = toMs(row.timestamp);
      if (at !== null) {
        if (out.start === null || at < out.start) out.start = at;
        if (out.last === null || at > out.last) out.last = at;
      }
      const data = obj(row.data);
      const sub = typeof row.agentId === "string" && row.agentId !== "";
      switch (row.type) {
        case "session.start":
        case "session.resume": {
          out.id = out.id ?? str(data.sessionId);
          const context = obj(data.context);
          if (!out.cwd) out.cwd = str(context.cwd) ?? str(context.gitRoot) ?? "";
          out.model = str(data.selectedModel) ?? out.model;
          const t = toMs(data.startTime);
          if (t !== null) out.start = Math.min(out.start ?? Infinity, t);
          break;
        }
        case "session.context_changed":
          out.cwd = str(obj(data.context).cwd) ?? str(data.cwd) ?? out.cwd;
          break;
        case "session.model_change":
          out.model = str(data.newModel) ?? out.model;
          break;
        case "session.title_changed":
          out.title = str(data.title) ?? out.title;
          break;
        case "assistant.message":
          if (!sub) out.model = str(data.model) ?? out.model;
          break;
        case "user.message": {
          if (sub || at === null || data.source || data.isAutopilotContinuation === true || data.agentAuthored === true) break;
          const text = typeof data.content === "string" ? data.content : "";
          if (isHousekeeping(text)) break;
          out.prompts.push(at);
          if (!out.firstPrompt) out.firstPrompt = titleOf(text);
          break;
        }
        case "tool.execution_start":
          if (!sub && at !== null) out.tools.push(at);
          break;
      }
    },
    () => out,
  );
}

/** name / summary / cwd from workspace.yaml (flat `key: value` lines; no YAML parser needed). */
async function workspaceInfo(dir: string): Promise<{ cwd: string | null; title: string | null }> {
  let text: string;
  try {
    text = await readFile(join(dir, "workspace.yaml"), "utf8");
  } catch {
    return { cwd: null, title: null };
  }
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (m) values[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return { cwd: values.cwd || null, title: values.name || values.summary || null };
}

function roots(): string[] {
  const out = [join(process.env.COPILOT_HOME || join(home(), ".copilot"), "session-state")];
  if (process.env.XDG_STATE_HOME) out.push(join(process.env.XDG_STATE_HOME, ".copilot", "session-state"));
  return out;
}

export const copilotAdapter: SourceAdapter = {
  id: "copilot",
  label: "Copilot CLI",
  async collect(opts: CollectOptions): Promise<SessionRecord[]> {
    const since = opts.sinceMs ?? -Infinity;
    const files: { path: string; dir: string | null }[] = [];
    for (const root of roots()) {
      for (const e of await listDir(root)) {
        if (e.name.startsWith(".")) continue;
        if (e.dir) files.push({ path: join(root, e.name, "events.jsonl"), dir: join(root, e.name) });
        else if (e.name.endsWith(".jsonl")) files.push({ path: join(root, e.name), dir: null });
      }
    }
    const records = await mapLimit(files, 8, async ({ path, dir }): Promise<SessionRecord | null> => {
      const info = await statFile(path);
      if (!info || info.mtimeMs < since) return null;
      const parsed = await cachedLines(path, copilotParser, info);
      if (!parsed || !parsed.prompts.length) return null;
      const ws = dir ? await workspaceInfo(dir) : { cwd: null, title: null };
      const times = span(parsed.prompts.concat(parsed.tools), parsed.start ?? info.mtimeMs);
      const endedAt = Math.max(times.end, parsed.last ?? -Infinity);
      if (endedAt < since) return null;
      const id = parsed.id ?? (dir ? dir.split(/[\\/]/).pop()! : path);
      return {
        source: "copilot",
        provider: "copilot",
        id,
        cwd: parsed.cwd || ws.cwd || "",
        title: parsed.title ?? (ws.title ? titleOf(ws.title) : null) ?? parsed.firstPrompt,
        startedAt: Math.min(times.start, parsed.start ?? Infinity),
        endedAt,
        prompts: parsed.prompts.slice(),
        tools: parsed.tools.slice(),
        model: parsed.model,
        paseoAgentId: null,
        nativeId: id,
        files: [path],
      };
    });
    // A session can exist both as a legacy flat file and as a folder: keep the bigger one.
    const byId = new Map<string, SessionRecord>();
    for (const r of records) {
      if (!r) continue;
      const prev = byId.get(r.id);
      if (!prev || r.prompts.length > prev.prompts.length) byId.set(r.id, r);
    }
    return Array.from(byId.values());
  },
};

// Text, for the report's notes (same events as above; Copilot writes no recap).

function copilotTextParser(): LineParser<SessionText> {
  const text = new TextCollector();
  return jsonlParser(
    (line) => (line.indexOf('"user.message"') >= 0 || line.indexOf('"assistant.message"') >= 0) && line.length < 256 * 1024,
    (row) => {
      if (row.checkpoint === true || row.ephemeral === true) return;
      if (typeof row.agentId === "string" && row.agentId !== "") return;
      const data = obj(row.data);
      const at = toMs(row.timestamp);
      if (row.type === "user.message") {
        if (data.source || data.isAutopilotContinuation === true || data.agentAuthored === true) return;
        text.prompt(typeof data.content === "string" ? data.content : "", at);
      } else if (row.type === "assistant.message") {
        if (typeof data.content === "string") text.replyText(data.content, at);
      }
    },
    () => text.finish(),
  );
}

/** Text of one Copilot CLI events file. Cached per (mtime, size). */
export function loadCopilotText(path: string): Promise<SessionText | null> {
  return cachedLines(path, copilotTextParser, undefined, "text");
}
