/**
 * pi coding agent (earendil-works/pi, ex badlogic/pi-mono) and Oh My Pi (can1357/oh-my-pi, omp).
 * WRITTEN FROM SOURCE (session-manager.ts, config.ts; omp session-paths.ts, dirs.ts):
 * ~/.pi/agent and ~/.omp/agent exist on this machine but hold no sessions.
 *
 * pi:  $PI_CODING_AGENT_SESSION_DIR (flat), else ($PI_CODING_AGENT_DIR or ~/.pi/agent)/sessions/
 *      --<cwd with / as ->--/<timestamp>_<id>.jsonl
 * omp: ~/.omp/agent/sessions/<-home-relative-cwd>/<timestamp>_<id>.jsonl, or
 *      $XDG_DATA_HOME/omp/sessions when that exists. Subagent sessions sit one level deeper and
 *      are not read. ($PI_CODING_AGENT_DIR also moves omp, but then it is the pi store: not re-read.)
 * Entries: {type:"session", id, timestamp, cwd} header (omp may put a {type:"title"} slot line
 * first), then {type:"message", timestamp, message:{role:"user"|"assistant"|"toolResult", ...}};
 * assistant content holds {type:"toolCall"} parts. omp marks injected user messages synthetic.
 */
import { join } from "node:path";
import type { CollectOptions, SessionRecord, SessionText, SourceAdapter, SourceId } from "./types";
import { cachedLines, home, xdgData, isHousekeeping, jsonlParser, listDir, mapLimit, obj, span, statFile, str, TextCollector, titleOf, toMs, type LineParser } from "./util";

interface ParsedPi {
  id: string | null;
  cwd: string;
  start: number | null;
  last: number | null;
  prompts: number[];
  tools: number[];
  model: string | null;
  title: string | null;
  name: string | null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = obj(part);
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("\n");
}

function piParser(): LineParser<ParsedPi> {
  const out: ParsedPi = { id: null, cwd: "", start: null, last: null, prompts: [], tools: [], model: null, title: null, name: null };
  return jsonlParser(
    () => true,
    (row) => {
      const at = toMs(row.timestamp);
      if (at !== null) {
        if (out.start === null || at < out.start) out.start = at;
        if (out.last === null || at > out.last) out.last = at;
      }
      if (row.type === "session") {
        out.id = out.id ?? str(row.id);
        out.cwd = out.cwd || (str(row.cwd) ?? "");
        return;
      }
      if (row.type === "session_info") {
        out.name = str(row.name) ?? out.name;
        return;
      }
      if (row.type === "title" || row.type === "title_change") {
        out.name = str(row.title) ?? out.name;
        return;
      }
      if (row.type === "model_change") {
        // pi: {provider, modelId}; omp: {model: "provider/modelId"}.
        const model = str(row.modelId) ?? str(row.model);
        if (model) out.model = model.slice(model.indexOf("/") + 1);
        return;
      }
      if (row.type !== "message") return;
      const message = obj(row.message);
      const when = at ?? toMs(message.timestamp);
      if (when === null) return;
      if (message.role === "user") {
        if (message.synthetic === true || message.attribution === "agent") return;
        const text = textOf(message.content);
        if (isHousekeeping(text)) return;
        out.prompts.push(when);
        if (!out.title) out.title = titleOf(text);
      } else if (message.role === "assistant") {
        out.model = str(message.model) ?? out.model;
        if (Array.isArray(message.content)) {
          for (const part of message.content) if (obj(part).type === "toolCall") out.tools.push(when);
        }
      }
    },
    () => out,
  );
}

/** Session files: <root>/<cwd folder>/*.jsonl, plus *.jsonl directly in <root> (flat override). */
async function sessionFiles(root: string): Promise<string[]> {
  const entries = await listDir(root);
  const nested = await Promise.all(
    entries
      .filter((d) => d.dir)
      .map(async (d) => (await listDir(join(root, d.name))).filter((f) => !f.dir && f.name.endsWith(".jsonl")).map((f) => join(root, d.name, f.name))),
  );
  return entries
    .filter((f) => !f.dir && f.name.endsWith(".jsonl"))
    .map((f) => join(root, f.name))
    .concat(nested.flat());
}

function makeAdapter(id: SourceId, label: string, roots: () => string[]): SourceAdapter {
  return {
    id,
    label,
    async collect(opts: CollectOptions): Promise<SessionRecord[]> {
      const since = opts.sinceMs ?? -Infinity;
      const files = Array.from(new Set((await Promise.all(roots().map(sessionFiles))).flat()));
      const records = await mapLimit(files, 8, async (path): Promise<SessionRecord | null> => {
        const info = await statFile(path);
        if (!info || info.mtimeMs < since) return null;
        const parsed = await cachedLines(path, piParser, info);
        if (!parsed || !parsed.prompts.length) return null;
        const times = span(parsed.prompts.concat(parsed.tools), parsed.start ?? info.mtimeMs);
        const endedAt = Math.max(times.end, parsed.last ?? -Infinity);
        if (endedAt < since) return null;
        return {
          source: id,
          provider: id,
          id: parsed.id ?? path,
          cwd: parsed.cwd,
          title: parsed.name ?? parsed.title,
          startedAt: Math.min(times.start, parsed.start ?? Infinity),
          endedAt,
          prompts: parsed.prompts.slice(),
          tools: parsed.tools.slice(),
          model: parsed.model,
          paseoAgentId: null,
          nativeId: parsed.id,
          files: [path],
        };
      });
      const byId = new Map<string, SessionRecord>();
      for (const r of records) if (r && !byId.has(r.id)) byId.set(r.id, r);
      return Array.from(byId.values());
    },
  };
}

export const piAdapter = makeAdapter("pi", "Pi", () => {
  const roots = [join(process.env.PI_CODING_AGENT_DIR || join(home(), ".pi", "agent"), "sessions")];
  if (process.env.PI_CODING_AGENT_SESSION_DIR) roots.push(process.env.PI_CODING_AGENT_SESSION_DIR);
  return roots;
});

export const ompAdapter = makeAdapter("omp", "Oh My Pi", () => [
  join(home(), "." + (process.env.PI_CONFIG_DIR || "omp").replace(/^\./, ""), "agent", "sessions"),
  join(xdgData(), "omp", "sessions"),
]);

// Text, for the report's notes (same entries as above; pi writes no recap).

function piTextParser(): LineParser<SessionText> {
  const text = new TextCollector();
  return jsonlParser(
    (line) => line.indexOf('"type":"message"') >= 0 && line.length < 256 * 1024,
    (row) => {
      if (row.type !== "message") return;
      const message = obj(row.message);
      const at = toMs(row.timestamp) ?? toMs(message.timestamp);
      if (message.role === "user") {
        if (message.synthetic === true || message.attribution === "agent") return;
        text.prompt(textOf(message.content), at);
      } else if (message.role === "assistant") {
        text.replyText(textOf(message.content), at);
      }
    },
    () => text.finish(),
  );
}

/** Text of one pi / omp session file. Cached per (mtime, size). */
export function loadPiText(path: string): Promise<SessionText | null> {
  return cachedLines(path, piTextParser, undefined, "text");
}
