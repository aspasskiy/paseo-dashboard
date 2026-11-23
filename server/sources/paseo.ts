/**
 * Paseo agents. VERIFIED against real files ($PASEO_HOME/agents/<project>/<agentId>.json).
 *
 * Each agent record names its provider, cwd and the provider's session id
 * (persistence.sessionId). For Claude agents the transcript is read here; for every other
 * provider this adapter returns a placeholder (the agent's creation as one prompt) and
 * collectSessions() swaps in the matching record from that provider's adapter.
 *
 * Internal agents and this plugin's own helpers (label dashboard=focus|report) are excluded, but
 * their session ids are still reported in `hidden` so provider adapters drop them too.
 */
import { join } from "node:path";
import { paseoHome } from "../paths";
import { readClaudeTranscript } from "./claude";
import type { CollectOptions, SessionRecord, SourceAdapter } from "./types";
import { cachedParse, listDir, mapLimit, obj, str, toMs } from "./util";

interface PaseoAgent {
  id: string;
  provider: string;
  cwd: string;
  title: string | null;
  createdAt: number;
  lastAt: number;
  model: string | null;
  sessionId: string | null;
  hidden: boolean;
}

function labelsOf(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (const item of value) {
      if (typeof item !== "string") continue;
      const eq = item.indexOf("=");
      if (eq > 0) out[item.slice(0, eq)] = item.slice(eq + 1);
      else out[item] = "";
    }
    return out;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(value))) if (typeof v === "string") out[k] = v;
  return out;
}

function parseAgent(text: string): PaseoAgent | null {
  const raw = obj(JSON.parse(text));
  const id = str(raw.id);
  const createdAt = toMs(raw.createdAt);
  if (!id || createdAt === null) return null;
  const runtime = obj(raw.runtimeInfo);
  const persistence = obj(raw.persistence);
  const config = obj(raw.config);
  const labels = labelsOf(raw.labels);
  const lastAt = Math.max(createdAt, toMs(raw.lastActivityAt) ?? 0, toMs(raw.updatedAt) ?? 0, toMs(raw.lastUserMessageAt) ?? 0);
  return {
    id,
    provider: str(raw.provider) ?? str(persistence.provider) ?? "agent",
    cwd: str(raw.cwd) ?? "",
    title: str(raw.title),
    createdAt,
    lastAt,
    model: str(runtime.model) ?? str(config.model),
    sessionId: str(persistence.sessionId) ?? str(runtime.sessionId) ?? str(persistence.nativeHandle),
    // This plugin's own helpers: the old focus summarizer and the report's note/synthesis runs.
    hidden: raw.internal === true || labels.dashboard === "focus" || labels.dashboard === "report",
  };
}

/** Every agent record on disk, including hidden ones. Cached per file. */
export async function readPaseoAgents(): Promise<PaseoAgent[]> {
  const root = join(paseoHome(), "agents");
  const dirs = (await listDir(root)).filter((e) => e.dir);
  const groups = await Promise.all(
    dirs.map(async (d) => {
      const files = (await listDir(join(root, d.name))).filter((e) => !e.dir && e.name.endsWith(".json"));
      return Promise.all(files.map((f) => cachedParse(join(root, d.name, f.name), parseAgent)));
    }),
  );
  return groups.flat().filter((a): a is PaseoAgent => a !== null);
}

/** Placeholder records, to be replaced by the provider's own record when one is found. */
export const placeholders = new WeakSet<SessionRecord>();

export const paseoAdapter: SourceAdapter = {
  id: "paseo",
  label: "Paseo",
  async collect(opts: CollectOptions): Promise<SessionRecord[]> {
    const since = opts.sinceMs ?? -Infinity;
    const agents = (await readPaseoAgents()).filter((a) => !a.hidden && a.lastAt >= since);
    return await mapLimit(agents, 8, async (agent): Promise<SessionRecord> => {
      const stats =
        agent.provider === "claude" && agent.sessionId && agent.cwd ? await readClaudeTranscript(agent.cwd, agent.sessionId) : null;
      const base = {
        source: "paseo" as const,
        provider: agent.provider,
        id: agent.id,
        cwd: agent.cwd,
        title: agent.title ?? stats?.title ?? null,
        paseoAgentId: agent.id,
        nativeId: agent.sessionId,
      };
      if (stats && (stats.prompts.length || stats.tools.length)) {
        return {
          ...base,
          startedAt: Math.min(agent.createdAt, stats.first ?? Infinity),
          endedAt: Math.max(agent.lastAt, stats.last ?? -Infinity),
          prompts: stats.prompts.slice(),
          tools: stats.tools.slice(),
          model: stats.model ?? agent.model,
        };
      }
      const record: SessionRecord = {
        ...base,
        startedAt: agent.createdAt,
        endedAt: agent.lastAt,
        prompts: [agent.createdAt],
        tools: [],
        model: agent.model,
      };
      placeholders.add(record);
      return record;
    });
  },
};
