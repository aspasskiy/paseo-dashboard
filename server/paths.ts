import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function paseoHome(): string {
  return process.env.PASEO_HOME || join(homedir(), ".paseo");
}

/** This plugin's own files, under the daemon home, never inside the plugin directory. */
export function dataDir(): string {
  return join(paseoHome(), "plugin-data", "dashboard");
}

/** The plugin's own helper sessions (the report's agents) are not the user's work. */
export function isOwnHelper(cwd: string): boolean {
  const own = dataDir();
  return !!cwd && (cwd === own || cwd.startsWith(own + "/"));
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Where Claude Code keeps a session transcript for a working directory. */
export function claudeTranscriptPath(cwd: string, sessionId: string): string {
  return join(claudeHome(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), sessionId + ".jsonl");
}

/** "~/dev/acme" for a path under home; "(no folder)" for an unknown one. */
export function shortPath(path: string): string {
  const home = homedir();
  return path && path.startsWith(home) ? "~" + path.slice(home.length) : path || "(no folder)";
}

const GENERIC = new Set(["web", "app", "apps", "api", "server", "client", "src", "frontend", "backend", "ios", "android", "site", "www", "admin", "mobile", "packages"]);

/** A short project name: the last folder, with its parent when the last one is generic ("acme/web"). */
export function baseName(path: string): string {
  if (!path) return "";
  if (path === homedir()) return "~ (home)";
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return path;
  const last = parts[parts.length - 1];
  if (parts.length > 1 && GENERIC.has(last.toLowerCase())) return parts[parts.length - 2] + "/" + last;
  return last;
}

export async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

let writes = 0;

/** Atomic write (temp file + rename), creating the folder. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + "." + ++writes + ".tmp";
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}
