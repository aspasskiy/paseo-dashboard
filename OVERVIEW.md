Dashboard adds a home screen to Paseo: how you work with coding agents, across every agent CLI on the daemon host. Open it from **Dashboard** at the top of the sidebar or with "Open Dashboard" in the command center.

- **Activity**: a year of prompts as a heatmap, with your total and your streak.
- **Stat tiles** for this week, last week or the last 30 days: prompts, active time, sessions, active days, peak hour, sources, projects, busiest day, Paseo agents and tool calls.
- **Where your focus went**: every project of the period, its share and its days.
- **Needs you** and **Shipped**: what is waiting on you and what you finished, written by agents when you ask for a report.

Blocks sit on a grid you can rearrange, resize, add and remove.

Activity reads the session stores of Paseo, Claude Code, Codex, Gemini CLI, opencode, Copilot CLI and pi, where present: timestamps, project paths and counts, never prompt text. That part sends nothing anywhere.

The report is the exception. When you generate one, Paseo helper agents read your session transcripts for the period and summarise them, with the provider and model you choose in the report settings. The text goes to that provider like any other agent prompt and uses your agent quota.

Report helpers start with no tools: no shell, no file access, no web, no MCP servers, no skills. They only read the text they are given and answer, so instructions inside a transcript cannot make them act. The restriction is enforced by the provider's CLI, so reports run only on a provider that supports it, for now Claude (Claude Code); other providers are not offered in the report settings.
