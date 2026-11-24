import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  reportSettingsSchema,
  type ProviderOption,
  type ReportSettings,
  type reportSettingsGetRpc,
  type reportSettingsSetRpc,
} from "../../shared/report";
import { readJson, writeJson } from "../paths";
import { settingsFile } from "./store";
import { toolFreeProfile } from "./toolfree";

type PaseoApi = PluginHandlerContext["paseo"];

type Tier = "notes" | "synthesis";

/** A provider and model a stage will run on, resolved from the settings and what Paseo has ready. */
export interface ResolvedRunner {
  providerId: string;
  providerLabel: string;
  /** null = the provider's own default model. */
  model: string | null;
  modelLabel: string | null;
  /** Picked automatically (no saved model, or the saved one is gone). */
  auto: boolean;
}

const DEFAULT_SETTINGS: ReportSettings = {
  notes: { provider: null, model: null },
  synthesis: { provider: null, model: null },
};

export async function readSettings(): Promise<ReportSettings> {
  const parsed = reportSettingsSchema.safeParse(await readJson(settingsFile()));
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

/**
 * Enabled providers whose CLI is installed and signed in, in Paseo's own order, and that can run a
 * helper with no tools (see toolfree.ts). Others are left out: the report never runs on them.
 */
export async function readyProviders(paseo: PaseoApi): Promise<ProviderOption[]> {
  const snapshot = await paseo.providers.snapshot();
  return snapshot.entries
    .filter((e) => e.enabled && e.status === "ready" && e.source !== "custom" && toolFreeProfile(e.provider))
    .map((e) => ({
      id: e.provider,
      label: e.label || e.provider,
      models: (e.models ?? [])
        .filter((m) => m.isSelectable !== false)
        .map((m) => ({ id: m.id, label: m.label || m.id, isDefault: Boolean(m.isDefault) })),
    }));
}

/** The small, fast tier: notes are many short, structured summaries. Whole words: "gemini" is not "mini". */
const FAST = /\b(?:haiku|mini|flash|lite|nano|small|fast)\b/i;
/** The strongest tier: the synthesis reads every note and writes the story. */
const STRONG = /\b(?:opus|pro|max)\b|gpt-5(?!.*\bmini\b)/i;
/** Long-context variants cost more and add nothing here. */
const LONG_CONTEXT = /\[1m\]|\b1m\b/i;

type Model = ProviderOption["models"][number];

const matches = (re: RegExp, m: Model) => re.test(m.id) || re.test(m.label);

/**
 * The automatic model of a tier. Notes: the first fast model. Synthesis: the first strong model that
 * is not a fast one, else the provider's default. Lists come newest first, so "first" is the latest
 * release. Long-context variants are passed over when a plain one exists. null = provider default.
 */
function autoModel(provider: ProviderOption, tier: Tier): Model | null {
  const plain = provider.models.filter((m) => !matches(LONG_CONTEXT, m));
  const pool = plain.length ? plain : provider.models;
  if (tier === "notes") return pool.find((m) => matches(FAST, m)) ?? null;
  return pool.find((m) => matches(STRONG, m) && !matches(FAST, m)) ?? pool.find((m) => m.isDefault) ?? null;
}

/** Pure: the runner a stage would use with these settings and these ready providers. */
export function resolveRunner(providers: ProviderOption[], settings: ReportSettings, tier: Tier): ResolvedRunner | null {
  // Only tool-free providers, whatever the list or the saved settings say: a saved choice of a
  // provider that has no profile falls back to the first one that has.
  const usable = providers.filter((p) => toolFreeProfile(p.id));
  const choice = settings[tier];
  const provider = (choice.provider && usable.find((p) => p.id === choice.provider)) || usable[0];
  if (!provider) return null;
  const saved = provider.id === choice.provider && choice.model ? provider.models.find((m) => m.id === choice.model) : undefined;
  const model = saved ?? autoModel(provider, tier);
  return {
    providerId: provider.id,
    providerLabel: provider.label,
    model: model?.id ?? null,
    modelLabel: model?.label ?? null,
    auto: !saved,
  };
}

/** "Claude · Haiku 5.5"; "Claude · default model" when the provider picks. */
export function runnerLabel(r: ResolvedRunner | null): string {
  if (!r) return "No supported provider ready";
  return r.providerLabel + " · " + (r.modelLabel ?? "default model");
}

/** `provider/model` as agents.create wants it. */
export function runnerConfig(r: ResolvedRunner): string {
  return r.model ? r.providerId + "/" + r.model : r.providerId;
}

export async function getReportSettings(
  _input: RpcInput<typeof reportSettingsGetRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof reportSettingsGetRpc>> {
  const settings = await readSettings();
  let providers: ProviderOption[] = [];
  try {
    providers = await readyProviders(context.paseo);
  } catch (e) {
    console.error("[report] could not read providers: " + (e instanceof Error ? e.message : String(e)));
  }
  return {
    settings,
    providers,
    resolved: {
      notes: runnerLabel(resolveRunner(providers, settings, "notes")),
      synthesis: runnerLabel(resolveRunner(providers, settings, "synthesis")),
    },
  };
}

export async function setReportSettings(input: RpcInput<typeof reportSettingsSetRpc>): Promise<RpcOutput<typeof reportSettingsSetRpc>> {
  await writeJson(settingsFile(), input.settings);
  return { ok: true };
}
