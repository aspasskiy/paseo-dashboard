/**
 * Runs one prompt on a Paseo helper agent and returns its parsed JSON answer. Generic: the notes
 * and the synthesis stage both go through it.
 *
 * A helper is a background agent in an empty folder (so it loads no project's instructions),
 * labelled dashboard=report so the history adapters never count it as the user's work. Each helper
 * is deleted when its run ends; the project Paseo registers for the helper folder is removed once
 * no helper of the pool is running (siblings run concurrently in the same folder).
 */
import { execFile } from "node:child_process";
import { access, constants, mkdir, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { runnerConfig, type ResolvedRunner } from "./settings";
import { helperDir } from "./store";
import { claudeHome } from "../paths";

type PaseoApi = PluginHandlerContext["paseo"];

interface RunRequest {
  stage: "notes" | "synthesis";
  runner: ResolvedRunner;
  title: string;
  systemPrompt: string;
  prompt: string;
  /** JSON Schema of the answer; passed to the provider and repeated in the prompt by the caller. */
  schema: Record<string, unknown>;
  timeoutMs: number;
}

/** One helper run → the first JSON object of its answer (unvalidated). Throws a readable error. */
export type Runner = (req: RunRequest) => Promise<unknown>;

/** A Runner whose helpers can be cleaned up and whose further runs can be refused. */
export interface RunnerPool {
  run: Runner;
  /** Refuse new runs and stop and remove the helpers in flight (plugin unload). */
  dispose(): Promise<void>;
  /** Remove the helper folder's project once nothing runs (end of a job). */
  finish(): Promise<void>;
}

/** The first JSON object in a reply: a fenced block, else the first balanced {...}. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const candidates = fenced ? [fenced[1]] : [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text.charAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        candidates.push(text.slice(start, i + 1));
        break;
      }
    }
    if (candidates.length > (fenced ? 1 : 0)) break;
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next one
    }
  }
  throw new Error("The reply held no JSON object.");
}

/** `PASEO_CLI` (the desktop app sets it for the daemon), then `paseo` on PATH, then the macOS app bundle. */
async function findCli(): Promise<string | null> {
  const isExec = async (path: string) => {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const candidates = [process.env.PASEO_CLI ?? ""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir) candidates.push(join(dir, process.platform === "win32" ? "paseo.cmd" : "paseo"));
  candidates.push("/Applications/Paseo.app/Contents/Resources/bin/paseo");
  for (const c of candidates) if (c && (await isExec(c))) return c;
  return null;
}

function runCli(cli: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout: timeoutMs, env: process.env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(0, 300)));
      else resolve(stdout);
    });
  });
}

/** Deletes one helper agent (the SDK can only archive, so through the CLI; archiving is the fallback). */
async function removeAgent(paseo: PaseoApi, agentId: string, log: (msg: string) => void): Promise<void> {
  const cli = await findCli();
  if (cli) {
    try {
      await runCli(cli, ["delete", agentId, "--json"], 30_000);
      return;
    } catch (e) {
      log("paseo delete " + agentId + " failed: " + String(e));
    }
  } else {
    log("paseo CLI not found; archiving helper " + agentId + " instead of deleting it");
  }
  await paseo.agents
    .ref(agentId)
    .archive()
    .catch((e: unknown) => log("could not archive helper " + agentId + ": " + String(e)));
}

/** Removes the project Paseo registered for the helper folder (never a user project), else archives its workspaces. */
async function removeHelperProject(paseo: PaseoApi, workspaceIds: Set<string>, log: (msg: string) => void): Promise<void> {
  // The helper's own Claude Code transcripts hold copies of the user's session text: drop them too.
  // Only the folder Claude Code derives from the plugin's helper cwd, never anything else.
  const transcripts = join(claudeHome(), "projects", helperDir().replace(/[^a-zA-Z0-9]/g, "-"));
  await rm(transcripts, { recursive: true, force: true }).catch((e: unknown) => log("could not remove helper transcripts: " + String(e)));
  const cli = await findCli();
  if (cli) {
    try {
      const projects = JSON.parse(await runCli(cli, ["project", "ls", "--json"], 30_000)) as { projectId?: string; path?: string }[];
      const own = projects.filter((p) => p.projectId && p.path === helperDir());
      for (const p of own) await runCli(cli, ["project", "delete", p.projectId!, "--json"], 30_000);
      return;
    } catch (e) {
      log("could not remove the helper project: " + String(e));
    }
  }
  for (const id of workspaceIds) {
    await paseo.workspaces.archive(id).catch((e: unknown) => log("could not archive helper workspace " + id + ": " + String(e)));
  }
}

const SECONDS = (ms: number) => Math.round(ms / 1000);

/** The real runner: helper agents on the user's Paseo providers. */
export function paseoRunnerPool(paseo: PaseoApi, log: (msg: string) => void): RunnerPool {
  const active = new Map<string, string | null>(); // agent id -> workspace id
  const workspaces = new Set<string>();
  let disposed = false;
  let used = false;

  const run: Runner = async (req) => {
    if (disposed) throw new Error("The report was cancelled.");
    used = true;
    await mkdir(helperDir(), { recursive: true });
    const handle = await paseo.agents.create({
      cwd: helperDir(),
      config: {
        provider: runnerConfig(req.runner),
        systemPrompt: req.systemPrompt,
        ...(req.runner.safeModeId ? { modeId: req.runner.safeModeId } : {}),
      },
      title: req.title,
      labels: { dashboard: "report" },
      background: true,
      prompt: req.prompt,
      outputSchema: req.schema,
    });
    active.set(handle.id, handle.workspaceId ?? null);
    if (handle.workspaceId) workspaces.add(handle.workspaceId);
    if (disposed) {
      // Disposed while the create was in flight: do not let it run on.
      active.delete(handle.id);
      await removeAgent(paseo, handle.id, log);
      throw new Error("The report was cancelled.");
    }
    try {
      const result = await handle.waitForFinish(req.timeoutMs);
      const ws = result.final?.workspaceId ?? handle.workspaceId;
      if (ws) workspaces.add(ws);
      log(req.stage + " helper " + handle.id + " finished: status=" + result.status);
      if (result.status === "timeout") throw new Error("The " + req.stage + " step took longer than " + SECONDS(req.timeoutMs) + " s and was stopped.");
      if (result.status === "permission") throw new Error("The " + req.stage + " helper asked for a permission instead of answering. Try another provider or model.");
      if (result.status === "error") throw new Error("The " + req.stage + " helper failed: " + String(result.error || "unknown error").slice(0, 300));
      let text = result.lastMessage?.trim() ?? "";
      if (!text) {
        const page = await handle.timeline.refetch({ direction: "tail", limit: 50 });
        for (let i = page.entries.length - 1; i >= 0 && !text; i--) {
          const item = page.entries[i].item;
          if (item.type === "assistant_message" && item.text.trim()) text = item.text.trim();
        }
      }
      if (!text) throw new Error("The " + req.stage + " helper finished without an answer.");
      try {
        return extractJson(text);
      } catch (e) {
        throw new Error("The " + req.stage + " helper's answer was not JSON (" + (e instanceof Error ? e.message : String(e)) + ").");
      }
    } finally {
      if (active.delete(handle.id)) await removeAgent(paseo, handle.id, log);
    }
  };

  const finish = async () => {
    if (!used || active.size) return;
    used = false;
    await removeHelperProject(paseo, workspaces, log).catch(() => {});
    workspaces.clear();
  };

  const dispose = async () => {
    disposed = true;
    const ids = Array.from(active.keys());
    active.clear();
    await Promise.all(ids.map((id) => removeAgent(paseo, id, log).catch(() => {})));
    if (used) await removeHelperProject(paseo, workspaces, log).catch(() => {});
  };

  return { run, dispose, finish };
}
