import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionText } from "./types";

/** Files bigger than this are not parsed whole (V8 strings top out near 512 MB anyway); streamed ones have no cap. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

export interface FileInfo {
  mtimeMs: number;
  size: number;
}

const fileCache = new Map<string, { key: string; value: unknown }>();
/** Reads in progress, so two adapters asking for one file share a single read. */
const inflight = new Map<string, Promise<unknown>>();

export async function statFile(path: string): Promise<FileInfo | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : null;
  } catch {
    return null;
  }
}

/**
 * Reads a file once per (mtime, size): later calls with an unchanged file return the cached result.
 * `ns` keeps the results of different readers of one file apart (stats vs. text). Never throws; a
 * missing, oversized, unreadable or unparsable file is null.
 */
async function cachedRead<T>(path: string, read: () => Promise<T>, known: FileInfo | null | undefined, ns: string, maxBytes: number): Promise<T | null> {
  const info = known ?? (await statFile(path));
  if (!info || info.size > maxBytes) return null;
  const key = info.mtimeMs + ":" + info.size;
  const slot = ns ? ns + "\0" + path : path;
  const hit = fileCache.get(slot);
  if (hit && hit.key === key) return hit.value as T;
  const flightKey = slot + "\0" + key;
  const pending = inflight.get(flightKey);
  if (pending) return (await pending) as T | null;
  const run = (async () => {
    try {
      const value = await read();
      fileCache.set(slot, { key, value });
      return value;
    } catch {
      return null;
    } finally {
      inflight.delete(flightKey);
    }
  })();
  inflight.set(flightKey, run);
  return run;
}

/** Parse a whole file, cached per (mtime, size). */
export function cachedParse<T>(path: string, parse: (text: string) => T, known?: FileInfo | null, ns = ""): Promise<T | null> {
  return cachedRead(path, async () => parse(await readFile(path, "utf8")), known, ns, MAX_FILE_BYTES);
}

export interface LineParser<T> {
  /** Called for every non-empty line. */
  line(line: string): void;
  done(): T;
}

/** Feed a file to a line parser in 1 MB chunks, so huge transcripts never sit in memory whole. */
function streamLines<T>(path: string, parser: LineParser<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let rest = "";
    const stream = createReadStream(path, { highWaterMark: 1 << 20 });
    const feed = (text: string) => {
      let start = 0;
      for (;;) {
        const end = text.indexOf("\n", start);
        if (end < 0) break;
        if (end > start) parser.line(text.slice(start, end));
        start = end + 1;
      }
      rest = text.slice(start);
    };
    stream.on("data", (chunk) => feed(rest + decoder.write(chunk as Buffer)));
    stream.on("error", reject);
    stream.on("end", () => {
      const tail = rest + decoder.end();
      if (tail) parser.line(tail);
      try {
        resolve(parser.done());
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Stream a file (JSONL) through a line parser, cached per (mtime, size). */
export function cachedLines<T>(path: string, make: () => LineParser<T>, known?: FileInfo | null, ns = ""): Promise<T | null> {
  return cachedRead(path, () => streamLines(path, make()), known, ns, Infinity);
}

/** JSON.parse a line into an object, or null for a torn or non-object line. */
export function parseLine(line: string): Record<string, unknown> | null {
  try {
    const row = JSON.parse(line);
    return row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A LineParser that JSON-parses the lines passing `want` and hands them to `onRow`. */
export function jsonlParser<T>(want: (line: string) => boolean, onRow: (row: Record<string, unknown>) => void, done: () => T): LineParser<T> {
  return {
    line(line) {
      if (!want(line)) return;
      const row = parseLine(line);
      if (row) onRow(row);
    },
    done,
  };
}

/** Directory entries, or [] when the directory is missing. */
export async function listDir(path: string): Promise<{ name: string; dir: boolean }[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch {
    return [];
  }
}

/** Run `fn` over items with at most `limit` in flight. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function home(): string {
  return homedir();
}

export function xdgData(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

/** Epoch ms from an ISO string, epoch ms or epoch seconds; null when it is none of those. */
export function toMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A one-line title from a prompt: its first non-empty line, at most 120 characters. */
export function titleOf(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line) return line.length > 120 ? line.slice(0, 119) + "…" : line;
  }
  return null;
}

/** Slash commands without arguments ("/login", "/clear") are housekeeping, not work. */
export function isHousekeeping(text: string): boolean {
  const shown = text.trim();
  return !shown || (shown.startsWith("/") && !/\s/.test(shown));
}

/** Every object line of a JSONL text; torn lines are skipped. */
export function eachJsonLine(text: string, fn: (row: Record<string, unknown>) => void): void {
  // indexOf, not split: history.jsonl can be hundreds of MB.
  for (let at = 0; at < text.length; ) {
    let end = text.indexOf("\n", at);
    if (end < 0) end = text.length;
    const row = end > at ? parseLine(text.slice(at, end)) : null;
    if (row) fn(row);
    at = end + 1;
  }
}

/** Earliest and latest of the timestamps, or `fallback` for both when there are none. */
export function span(times: number[], fallback: number): { start: number; end: number } {
  let start = Infinity;
  let end = -Infinity;
  for (const t of times) {
    if (t < start) start = t;
    if (t > end) end = t;
  }
  return Number.isFinite(start) ? { start, end } : { start: fallback, end: fallback };
}

// Session text (for the report's notes)

/** The non-blank lines, trimmed and joined with " ⏎ ". */
function oneLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ⏎ ");
}

/** The first `limit` characters, with "…" when anything was cut. */
function clipped(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + "…";
}

/** Both ends within `limit`: final replies open with what was done and close with what's next. */
function headTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return text.slice(0, half) + " … " + text.slice(text.length - half);
}

/**
 * `<pasted_content id="b313">…</pasted_content id="b313"> what does this mean?` → the owner's own
 * words first, then what they pasted, without the tags.
 */
function unwrapPastes(text: string): string {
  const own: string[] = [];
  const pasted: string[] = [];
  let rest = text;
  for (;;) {
    const open = /<pasted_content[^>]*>/.exec(rest);
    if (!open) break;
    own.push(rest.slice(0, open.index));
    rest = rest.slice(open.index + open[0].length);
    const close = /<\/pasted_content[^>]*>/.exec(rest);
    if (close) {
      pasted.push(rest.slice(0, close.index));
      rest = rest.slice(close.index + close[0].length);
    } else {
      pasted.push(rest);
      rest = "";
    }
  }
  own.push(rest);
  return own
    .concat(pasted)
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * The owner's words in a user message, or null for what isn't a prompt: tagged echoes (slash
 * commands, hook output, injected context), interrupt markers, caveats, bare slash commands.
 */
function cleanPrompt(raw: string): string | null {
  let text = raw.trim();
  if (text.startsWith("<pasted_content")) text = unwrapPastes(text);
  if (!text || text.startsWith("<") || text.startsWith("[Request interrupted") || text.startsWith("Caveat:")) return null;
  if (isHousekeeping(text)) return null;
  return text;
}

const TEXT_PROMPT_CHARS = 400;
const TEXT_REPLY_CHARS = 1500;
const TEXT_RECAP_CHARS = 1000;

/** Collects a session's prompts and replies while a transcript is read, then clips them. */
export class TextCollector {
  private prompts: { at: number | null; text: string; queued: boolean }[] = [];
  private reply = "";
  private awaiting = false;
  private recapAt: number | null = null;
  private recap: string | null = null;
  private lastAt: number | null = null;

  private touch(at: number | null) {
    if (at !== null && (this.lastAt === null || at > this.lastAt)) this.lastAt = at;
  }

  /** A user message; filtered through cleanPrompt. Returns whether it counted. */
  prompt(raw: string, at: number | null, queued = false): boolean {
    const text = cleanPrompt(raw);
    if (!text) return false;
    this.prompts.push({ at, text, queued });
    this.awaiting = true;
    this.touch(at);
    return true;
  }

  replyText(raw: string, at: number | null) {
    const text = raw.trim();
    if (!text) return;
    this.reply = text;
    this.awaiting = false;
    this.touch(at);
  }

  /** The agent's own recap of the session; kept only when written after the last prompt. */
  setRecap(raw: string, at: number | null) {
    this.recap = raw;
    this.recapAt = at;
  }

  finish(): SessionText {
    // A prompt queued mid-turn and then sent the ordinary way is there twice.
    const typed = new Set(this.prompts.filter((p) => !p.queued).map((p) => p.text));
    const prompts = this.prompts.filter((p) => !p.queued || !typed.has(p.text));
    const lastPrompt = prompts.length ? prompts[prompts.length - 1].at : null;
    let recap: string | null = null;
    if (this.recap && this.recapAt !== null && lastPrompt !== null && this.recapAt >= lastPrompt) {
      const line = oneLine(this.recap.replace(/\s*\((?:disable|turn off) recaps[^)]*\)\s*$/i, ""));
      recap = line ? clipped(line, TEXT_RECAP_CHARS) : null;
    }
    const picked = prompts.length > 16 ? [prompts[0]].concat(prompts.slice(-15)) : prompts;
    return {
      prompts: picked.map((p) => clipped(oneLine(p.text), TEXT_PROMPT_CHARS)),
      promptCount: prompts.length,
      recap,
      lastReply: headTail(oneLine(this.reply), TEXT_REPLY_CHARS),
      awaitingReply: this.awaiting && prompts.length > 0,
      lastAt: this.lastAt,
    };
  }
}
