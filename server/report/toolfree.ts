/**
 * Report helpers read session transcripts. A transcript is untrusted input: anything a user pasted
 * or an agent printed ends up in a helper's prompt. So a helper must not be able to act on what it
 * reads: it gets no tools at all, enforced by the provider's own CLI, not asked for in a prompt.
 *
 * A provider is offered for reports only when it has a profile below. Each profile is a launch
 * configuration that the provider enforces, verified against that provider's tool inventory. A
 * provider without one (Codex, OpenCode, Copilot, Pi, ACP and plugin providers, custom profiles)
 * is not listed in the report settings, and the runner refuses it.
 */

export interface ToolFreeProfile {
  /** The mode the helper starts in: one where any tool that is still there would ask first. */
  modeId: string;
  /** Provider options that remove every tool (`agents.create` → `config.options`). */
  options: Record<string, unknown>;
  /** Environment for the provider's process that turns off what the options cannot reach. */
  env: Record<string, string>;
}

const PROFILES: Readonly<Record<string, ToolFreeProfile>> = {
  /**
   * Claude Code, the built-in `claude` provider (Paseo does not let a custom provider take this id).
   * - `--tools ""` removes every built-in tool: Bash, Read, Edit, Write, Glob, Grep, WebFetch,
   *   WebSearch, Task, Skill, ToolSearch and the rest.
   * - `disallowedTools: ["mcp__*"]` removes every MCP tool, whatever server it comes from: the
   *   `paseo` server the daemon injects, servers other plugins attach, the user's own servers.
   * - `--strict-mcp-config` leaves out the user's MCP configuration and claude.ai connectors.
   * - `--disable-slash-commands` turns off skills and custom commands.
   * - `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` turns off the server-side advisor tool a user may have
   *   enabled in their Claude settings (`advisorModel`), which the flags above do not remove.
   * With these, Claude Code 2.1.331 reports an empty `tools` list at session start, and a helper told
   * directly to read a file in its folder, call `mcp__paseo__list_hosts` or call the advisor makes
   * no tool call. The same requests without them do: read the file, ask to run the Paseo tool,
   * call the advisor.
   * "default" (Always Ask) is the backstop: the runner fails a helper that asks for a permission.
   */
  claude: {
    modeId: "default",
    options: {
      disallowedTools: ["mcp__*"],
      extraArgs: { tools: "", "strict-mcp-config": null, "disable-slash-commands": null },
    },
    env: { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" },
  },
};

/** The tool-free launch profile of a provider, or null when it has none (not usable for reports). */
export function toolFreeProfile(providerId: string): ToolFreeProfile | null {
  return Object.hasOwn(PROFILES, providerId) ? PROFILES[providerId] : null;
}

/** Display names of the providers reports can run on, for messages. */
export const TOOL_FREE_PROVIDERS = ["Claude"];
