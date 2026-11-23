/**
 * opencode (anomalyco/opencode, ex sst/opencode). WRITTEN FROM SOURCE (core/session/sql.ts at
 * v1.19.6 and dev, schema/src/session-message.ts, storage/json-migration.ts): there is no opencode
 * data on this machine (only ~/.config/opencode/plugins).
 *
 * Store: $XDG_DATA_HOME/opencode (default ~/.local/share/opencode, macOS too).
 *  - v1.2+ : SQLite opencode*.db ($OPENCODE_DB overrides). v1 tables session/message/part; v2.x
 *    adds session_v2/session_message/session_part in the same file, often for the same ids, so
 *    v2 rows win. Read with node:sqlite, loaded lazily: without it (older runtimes) the DB is
 *    skipped, never crashing the plugin.
 *  - up to v1.1: JSON files storage/session/<project>/<id>.json and storage/message/<session>/
 *    <id>.json. Read only when there is no database (the migration leaves them behind).
 * Subagent sessions (parent_id set) are skipped. Times are epoch ms.
 */
import { isAbsolute, join } from "node:path";
import type { CollectOptions, SessionRecord, SessionText, SourceAdapter } from "./types";
import { cachedParse, listDir, mapLimit, obj, statFile, str, TextCollector, titleOf, toMs, xdgData } from "./util";

function dataDir(): string {
  return join(xdgData(), "opencode");
}

interface Row {
  [key: string]: unknown;
}

interface Db {
  prepare(sql: string): { all(...params: unknown[]): Row[] };
  close(): void;
}

type DbCtor = new (path: string, opts?: { readOnly?: boolean }) => Db;

let sqliteCtor: DbCtor | null | undefined;

async function sqlite(): Promise<DbCtor | null> {
  if (sqliteCtor !== undefined) return sqliteCtor;
  try {
    const name = "node:sqlite";
    const mod = (await import(/* @vite-ignore */ name)) as { DatabaseSync?: DbCtor };
    sqliteCtor = mod.DatabaseSync ?? null;
  } catch {
    sqliteCtor = null;
  }
  return sqliteCtor;
}

interface Draft {
  id: string;
  cwd: string;
  title: string | null;
  model: string | null;
  created: number;
  updated: number;
  prompts: number[];
  tools: number[];
  /** The database or session JSON file it was read from. */
  file?: string;
}

function tableNames(db: Db): Set<string> {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name)));
}

function modelOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const m = obj(JSON.parse(value));
    return str(m.id) ?? str(m.modelID);
  } catch {
    return value || null;
  }
}

function num(value: unknown): number | null {
  const n = typeof value === "bigint" ? Number(value) : value;
  return toMs(n);
}

/** Every top-level session in one database (v2 tables preferred over v1 for the same id). */
function readDb(Database: DbCtor, path: string): Draft[] {
  const db = new Database(path, { readOnly: true });
  try {
    const tables = tableNames(db);
    const drafts = new Map<string, Draft>();
    const load = (sessions: Row[]) => {
      for (const s of sessions) {
        const id = String(s.id);
        if (drafts.has(id) || s.parent_id) continue;
        const created = num(s.time_created) ?? 0;
        drafts.set(id, {
          id,
          cwd: str(s.directory) ?? "",
          title: str(s.title),
          model: modelOf(s.model),
          created,
          updated: num(s.time_updated) ?? created,
          prompts: [],
          tools: [],
        });
      }
    };
    const add = (rows: Row[], field: "prompts" | "tools", fresh: Set<string>) => {
      for (const r of rows) {
        const draft = drafts.get(String(r.session_id));
        const at = num(r.at);
        if (draft && at !== null && fresh.has(draft.id)) draft[field].push(at);
      }
    };
    if (tables.has("session_v2")) {
      load(db.prepare("SELECT id, parent_id, directory, title, model, time_created, time_updated FROM session_v2").all());
      const v2 = new Set(drafts.keys());
      if (tables.has("session_message")) {
        add(db.prepare("SELECT session_id, time_created AS at FROM session_message WHERE type = 'user'").all(), "prompts", v2);
      }
      if (tables.has("session_part")) {
        add(db.prepare("SELECT session_id, time_created AS at FROM session_part WHERE type = 'tool'").all(), "tools", v2);
      }
    }
    if (tables.has("session")) {
      const before = new Set(drafts.keys());
      load(db.prepare("SELECT id, parent_id, directory, title, model, time_created, time_updated FROM session").all());
      const v1 = new Set(Array.from(drafts.keys()).filter((id) => !before.has(id)));
      if (v1.size && tables.has("message")) {
        add(
          db.prepare("SELECT session_id, time_created AS at FROM message WHERE json_extract(data, '$.role') = 'user'").all(),
          "prompts",
          v1,
        );
      }
      if (v1.size && tables.has("part")) {
        add(
          db
            .prepare(
              "SELECT session_id, COALESCE(json_extract(data, '$.state.time.start'), time_created) AS at FROM part WHERE json_extract(data, '$.type') = 'tool'",
            )
            .all(),
          "tools",
          v1,
        );
      }
    }
    return Array.from(drafts.values());
  } finally {
    db.close();
  }
}

const dbCache = new Map<string, { key: string; drafts: Draft[] }>();

async function dbDrafts(path: string): Promise<Draft[]> {
  const info = await statFile(path);
  if (!info) return [];
  const wal = await statFile(path + "-wal");
  const key = [info.mtimeMs, info.size, wal?.mtimeMs ?? 0, wal?.size ?? 0].join(":");
  const hit = dbCache.get(path);
  if (hit && hit.key === key) return hit.drafts;
  const Database = await sqlite();
  if (!Database) return [];
  try {
    const drafts = readDb(Database, path);
    for (const d of drafts) d.file = path;
    dbCache.set(path, { key, drafts });
    return drafts;
  } catch {
    return [];
  }
}

/** Pre-v1.2 JSON storage: sessions and user messages only (tool parts are one file each; skipped). */
async function jsonDrafts(since: number): Promise<Draft[]> {
  const storage = join(dataDir(), "storage");
  const projects = (await listDir(join(storage, "session"))).filter((e) => e.dir);
  const files = (
    await Promise.all(
      projects.map(async (p) =>
        (await listDir(join(storage, "session", p.name))).filter((f) => f.name.endsWith(".json")).map((f) => join(storage, "session", p.name, f.name)),
      ),
    )
  ).flat();
  const drafts = await mapLimit(files, 8, async (path): Promise<Draft | null> => {
    const s = await cachedParse(path, (t) => obj(JSON.parse(t)));
    if (!s || s.parentID) return null;
    const id = str(s.id);
    const time = obj(s.time);
    const created = toMs(time.created) ?? 0;
    const updated = toMs(time.updated) ?? created;
    if (!id || updated < since) return null;
    const draft: Draft = { id, cwd: str(s.directory) ?? "", title: str(s.title), model: null, created, updated, prompts: [], tools: [], file: path };
    const dir = join(storage, "message", id);
    for (const f of await listDir(dir)) {
      if (!f.name.endsWith(".json")) continue;
      const m = await cachedParse(join(dir, f.name), (t) => obj(JSON.parse(t)));
      if (!m) continue;
      const at = toMs(obj(m.time).created);
      if (m.role === "user" && at !== null) draft.prompts.push(at);
      if (m.role === "assistant") draft.model = str(m.modelID) ?? draft.model;
    }
    return draft;
  });
  return drafts.filter((d): d is Draft => d !== null);
}

/** "New session - 2026-..." style placeholder titles say nothing. */
function realTitle(title: string | null): string | null {
  if (!title || /^(New session|Child session)\b/i.test(title)) return null;
  return titleOf(title);
}

export const opencodeAdapter: SourceAdapter = {
  id: "opencode",
  label: "OpenCode",
  async collect(opts: CollectOptions): Promise<SessionRecord[]> {
    const since = opts.sinceMs ?? -Infinity;
    const dir = dataDir();
    const dbs = new Set<string>();
    const override = process.env.OPENCODE_DB;
    if (override) dbs.add(isAbsolute(override) ? override : join(dir, override));
    for (const e of await listDir(dir)) if (!e.dir && /^opencode.*\.db$/.test(e.name)) dbs.add(join(dir, e.name));
    let drafts: Draft[] = [];
    if (dbs.size) {
      // The newest DB first, so its copy of a session wins.
      const list = await Promise.all(Array.from(dbs).map(async (p) => ({ p, m: (await statFile(p))?.mtimeMs ?? 0 })));
      list.sort((a, b) => b.m - a.m);
      for (const { p } of list) drafts = drafts.concat(await dbDrafts(p));
    } else {
      drafts = await jsonDrafts(since);
    }
    const seen = new Set<string>();
    const out: SessionRecord[] = [];
    for (const d of drafts) {
      if (seen.has(d.id) || !d.prompts.length) continue;
      seen.add(d.id);
      const prompts = d.prompts.slice().sort((a, b) => a - b);
      const startedAt = Math.min(d.created || Infinity, prompts[0]);
      let endedAt = Math.max(d.updated, prompts[prompts.length - 1]);
      for (const t of d.tools) if (t > endedAt) endedAt = t;
      if (endedAt < since) continue;
      out.push({
        source: "opencode",
        provider: "opencode",
        id: d.id,
        cwd: d.cwd,
        title: realTitle(d.title),
        startedAt,
        endedAt,
        prompts,
        tools: d.tools.slice().sort((a, b) => a - b),
        model: d.model,
        paseoAgentId: null,
        nativeId: d.id,
        files: d.file ? [d.file] : undefined,
      });
    }
    return out;
  },
};

// Text, for the report's notes. WRITTEN FROM SOURCE, not verified on real data (none here):
// v1 message/part rows ({role} / {type:"text", text, synthetic?} JSON), the pre-v1.2 JSON storage,
// and the v2 tables read defensively (columns looked up by name; skipped when they do not fit).

interface TextRow {
  role: string;
  at: number | null;
  text: string;
}

function partText(data: unknown): string {
  let p: Record<string, unknown>;
  try {
    p = typeof data === "string" ? obj(JSON.parse(data)) : obj(data);
  } catch {
    return "";
  }
  return p.type === "text" && p.synthetic !== true && typeof p.text === "string" ? p.text : "";
}

/** Parts grouped into messages, in order. */
function collect(rows: { mid: string; role: string; at: number | null; text: string }[]): TextRow[] {
  const out: TextRow[] = [];
  const index = new Map<string, TextRow>();
  for (const r of rows) {
    let m = index.get(r.mid);
    if (!m) {
      m = { role: r.role, at: r.at, text: "" };
      index.set(r.mid, m);
      out.push(m);
    }
    if (r.text) m.text = m.text ? m.text + "\n" + r.text : r.text;
  }
  return out;
}

function dbText(Database: DbCtor, path: string, sessionId: string): TextRow[] {
  const db = new Database(path, { readOnly: true });
  try {
    const tables = tableNames(db);
    if (tables.has("session_message") && tables.has("session_part")) {
      try {
        const messages = db.prepare("SELECT * FROM session_message WHERE session_id = ? ORDER BY time_created").all(sessionId);
        const parts = db.prepare("SELECT * FROM session_part WHERE session_id = ? ORDER BY time_created").all(sessionId);
        const roles = new Map<string, { role: string; at: number | null }>();
        for (const m of messages) roles.set(String(m.id), { role: String(m.type ?? m.role ?? ""), at: num(m.time_created) });
        const rows = parts
          .filter((p) => p.message_id !== undefined && roles.has(String(p.message_id)))
          .map((p) => {
            const m = roles.get(String(p.message_id))!;
            const text = typeof p.text === "string" && p.type === "text" ? p.text : partText(p.data);
            return { mid: String(p.message_id), role: m.role, at: m.at, text };
          });
        const out = collect(rows);
        if (out.some((r) => r.text)) return out;
      } catch {
        // columns differ from what was expected: fall through to v1
      }
    }
    if (tables.has("message") && tables.has("part")) {
      const rows = db
        .prepare(
          "SELECT m.id AS mid, json_extract(m.data, '$.role') AS role, m.time_created AS at, p.data AS pdata FROM message m JOIN part p ON p.message_id = m.id WHERE m.session_id = ? ORDER BY m.time_created, p.time_created",
        )
        .all(sessionId)
        .map((r) => ({ mid: String(r.mid), role: String(r.role ?? ""), at: num(r.at), text: partText(r.pdata) }));
      return collect(rows);
    }
    return [];
  } finally {
    db.close();
  }
}

/** Pre-v1.2 JSON storage: storage/message/<session>/<id>.json and storage/part/<message>/<id>.json. */
async function jsonText(sessionFile: string, sessionId: string): Promise<TextRow[]> {
  const storage = join(sessionFile, "..", "..", "..");
  const dir = join(storage, "message", sessionId);
  const messages: { id: string; role: string; at: number | null }[] = [];
  for (const f of await listDir(dir)) {
    if (!f.name.endsWith(".json")) continue;
    const m = await cachedParse(join(dir, f.name), (t) => obj(JSON.parse(t)));
    const id = m ? str(m.id) : null;
    if (m && id) messages.push({ id, role: String(m.role ?? ""), at: toMs(obj(m.time).created) });
  }
  messages.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const out: TextRow[] = [];
  for (const m of messages) {
    const partDir = join(storage, "part", m.id);
    const texts: string[] = [];
    for (const f of (await listDir(partDir)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!f.name.endsWith(".json")) continue;
      const t = await cachedParse(join(partDir, f.name), (x) => partText(x), undefined, "text");
      if (t) texts.push(t);
    }
    out.push({ role: m.role, at: m.at, text: texts.join("\n") });
  }
  return out;
}

const textCache = new Map<string, { key: string; text: SessionText | null }>();

/** Text of one opencode session from the database (or JSON storage) it was read from. */
export async function loadOpencodeText(file: string, sessionId: string): Promise<SessionText | null> {
  const info = await statFile(file);
  if (!info) return null;
  const wal = file.endsWith(".db") ? await statFile(file + "-wal") : null;
  const key = [sessionId, info.mtimeMs, info.size, wal?.mtimeMs ?? 0, wal?.size ?? 0].join(":");
  const hit = textCache.get(file + "\0" + sessionId);
  if (hit && hit.key === key) return hit.text;
  let rows: TextRow[] = [];
  try {
    if (file.endsWith(".db")) {
      const Database = await sqlite();
      if (!Database) return null;
      rows = dbText(Database, file, sessionId);
    } else {
      rows = await jsonText(file, sessionId);
    }
  } catch {
    return null;
  }
  const text = new TextCollector();
  for (const r of rows) {
    if (r.role === "user") text.prompt(r.text, r.at);
    else if (r.role === "assistant") text.replyText(r.text, r.at);
  }
  const out = rows.length ? text.finish() : null;
  textCache.set(file + "\0" + sessionId, { key, text: out });
  return out;
}
