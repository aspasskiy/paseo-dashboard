/**
 * Shared contract between the history adapters (server/sources/*) and their consumers
 * (server/overview.ts, server/timeframe.ts, server/report/*). Change it only together with every consumer.
 */

/** Where a session came from. "paseo" = launched by a Paseo agent, whatever the provider. */
export type SourceId = "claude" | "codex" | "gemini" | "pi" | "omp" | "opencode" | "copilot" | "paseo";

export interface SessionRecord {
  source: SourceId;
  /** Provider behind it (for "paseo": the agent's provider, e.g. "claude", "codex"). */
  provider: string;
  /** Stable id, unique within the source. */
  id: string;
  /** Absolute working directory ("" when unknown). */
  cwd: string;
  /** Short task title: Paseo agent title, else first user prompt's first line, max 120 chars. Server-side only. */
  title: string | null;
  startedAt: number;
  endedAt: number;
  /** Epoch-ms timestamps of real user prompts (no tool results, no slash housekeeping). */
  prompts: number[];
  /** Epoch-ms timestamps of tool calls. */
  tools: number[];
  model: string | null;
  /** Set when this session belongs to a Paseo agent. */
  paseoAgentId: string | null;
  /**
   * The provider's own session id (Claude session UUID, Codex thread id, ...). For "paseo"
   * records: the agent's provider session. Used to dedupe Paseo agents against provider stores.
   */
  nativeId?: string | null;
  /**
   * Transcript files the record was read from (server-side only), so its text can be loaded
   * later (loadSessionText). Unset when the adapter keeps no per-session file (Claude: the
   * transcript path is derived from cwd + nativeId).
   */
  files?: string[];
}

/**
 * What a session says, for the report's notes. Clipped at parse time, so it never holds pastes or
 * tool output: the first typed prompt and the last 15, the agent's own recap, its last reply.
 * Server-side only; never sent to the client.
 */
export interface SessionText {
  /** Typed prompts: the first, then the last 15; each one line, at most 400 chars. */
  prompts: string[];
  /** Typed prompts in total (prompts queued mid-turn and then sent again counted once). */
  promptCount: number;
  /** The agent's own summary written after the owner's last prompt (Claude Code's away recap). */
  recap: string | null;
  /** The assistant's last text reply, one line, head + tail within 1500 chars. */
  lastReply: string;
  /** The owner's last prompt got no text reply (interrupted, crashed or still running). */
  awaitingReply: boolean;
  /** Last prompt or text reply (epoch ms): where the session stands, for the notes cache. */
  lastAt: number | null;
}

export interface CollectOptions {
  /** Only sessions active at or after this time (epoch ms). Omit for all history. */
  sinceMs?: number;
}

/** One adapter per provider. A missing store returns []; collectSessions() catches anything thrown. */
export interface SourceAdapter {
  id: SourceId;
  label: string;
  collect(opts: CollectOptions): Promise<SessionRecord[]>;
}
