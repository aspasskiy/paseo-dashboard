import { claudeAdapter, findClaudeTranscript, loadClaudeText } from "./claude";
import { codexAdapter, loadCodexText } from "./codex";
import { copilotAdapter, loadCopilotText } from "./copilot";
import { geminiAdapter, loadGeminiText, resolveGeminiCwds } from "./gemini";
import { loadOpencodeText, opencodeAdapter } from "./opencode";
import { paseoAdapter, placeholders, readPaseoAgents } from "./paseo";
import { loadPiText, ompAdapter, piAdapter } from "./pi";
import type { CollectOptions, SessionRecord, SessionText, SourceAdapter } from "./types";

export type { SessionRecord, SessionText } from "./types";

/** Every provider adapter, in display order. */
export const ADAPTERS: SourceAdapter[] = [
  paseoAdapter,
  claudeAdapter,
  codexAdapter,
  geminiAdapter,
  opencodeAdapter,
  copilotAdapter,
  piAdapter,
  ompAdapter,
];

/** An adapter that throws (a store it can't read) contributes nothing. */
async function safe(adapter: SourceAdapter, opts: CollectOptions): Promise<SessionRecord[]> {
  try {
    return await adapter.collect(opts);
  } catch {
    return [];
  }
}

/**
 * All sessions from every installed provider, deduplicated: a Paseo agent's own provider
 * session is reported once, as source "paseo" (with provider = the agent's provider), and the
 * sessions of hidden agents (internal, or this plugin's summarizers) are not reported at all.
 */
export async function collectSessions(opts: CollectOptions = {}): Promise<SessionRecord[]> {
  const [agents, ...lists] = await Promise.all([readPaseoAgents().catch(() => []), ...ADAPTERS.map((a) => safe(a, opts))]);

  // Provider session id -> agent id, or null for hidden agents whose sessions are dropped.
  const owned = new Map<string, string | null>();
  for (const agent of agents) if (agent.sessionId) owned.set(agent.sessionId, agent.hidden ? null : agent.id);

  const paseoById = new Map<string, SessionRecord>();
  const out: SessionRecord[] = [];
  for (const list of lists) {
    for (const record of list) {
      if (record.source === "paseo") {
        paseoById.set(record.id, record);
        out.push(record);
      }
    }
  }
  for (const list of lists) {
    for (const record of list) {
      if (record.source === "paseo") continue;
      const native = record.nativeId ?? record.id;
      if (!owned.has(native)) {
        out.push(record);
        continue;
      }
      // Owned by a Paseo agent: fill that agent's placeholder from the provider's own record.
      const agentId = owned.get(native);
      const target = agentId ? paseoById.get(agentId) : undefined;
      if (target && placeholders.has(target)) {
        placeholders.delete(target);
        target.prompts = record.prompts;
        target.tools = record.tools;
        target.startedAt = Math.min(target.startedAt, record.startedAt);
        target.endedAt = Math.max(target.endedAt, record.endedAt);
        target.model = record.model ?? target.model;
        target.title = target.title ?? record.title;
        target.files = record.files;
        if (!target.cwd) target.cwd = record.cwd;
      }
    }
  }

  const cwds = new Set<string>();
  for (const r of out) if (r.cwd) cwds.add(r.cwd);
  for (const a of agents) if (a.cwd) cwds.add(a.cwd);
  resolveGeminiCwds(out, cwds);
  return out;
}

/**
 * What a session says (prompts, recap, last reply), read from its provider's transcript; null when
 * the transcript is gone or the provider keeps no text. A Paseo agent's text comes from its
 * provider's own transcript. Never throws. Server-side only.
 */
export async function loadSessionText(record: SessionRecord): Promise<SessionText | null> {
  try {
    const kind = record.source === "paseo" ? record.provider : record.source;
    const file = record.files?.[0];
    switch (kind) {
      case "claude": {
        const id = record.nativeId ?? (record.source === "claude" ? record.id : null);
        if (!id || id.startsWith("legacy:")) return null;
        const path = file ?? (await findClaudeTranscript(record.cwd, id));
        return path ? await loadClaudeText(path) : null;
      }
      case "codex":
        return file ? await loadCodexText(file) : null;
      case "gemini":
        return record.files?.length ? await loadGeminiText(record.files, record.nativeId ?? record.id) : null;
      case "pi":
      case "omp":
        return file ? await loadPiText(file) : null;
      case "copilot":
        return file ? await loadCopilotText(file) : null;
      case "opencode":
        return file ? await loadOpencodeText(file, record.nativeId ?? record.id) : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
