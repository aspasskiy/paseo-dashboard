<img src="assets/icon.png" width="96" height="96" alt="Paseo Dashboard icon">

# Paseo Dashboard

A home screen plugin for [Paseo](https://paseo.sh): how you work with coding agents, across every agent CLI on the machine.

Open it from **Dashboard** at the top of the sidebar or with "Open Dashboard" in the command center.

## What's on it

- **Activity**: a year of prompts as a heatmap, with your total and your streak.
- **Stat tiles** for this week, last week or the last 30 days: prompts, active time, sessions, active days, peak hour, sources, projects, busiest day, Paseo agents and tool calls.
- **Where your focus went**: every project of the period, its share and its days.
- **Needs you** and **Shipped**: what is waiting on you and what you finished, written by agents when you ask for a report.

Blocks sit on a 12-column grid you can rearrange, resize, add and remove.

## Install

Requires Paseo 0.16.2 or newer. In Paseo, add a plugin from its Git URL:

```
https://github.com/aspasskiy/paseo-dashboard
```

## Data and privacy

Everything is read on the daemon host. Activity comes from the session stores of Paseo, Claude Code, Codex, Gemini CLI, opencode, Copilot CLI and pi, where present: timestamps, project paths and counts, never prompt text. That part sends nothing anywhere.

The **report** is the exception. When you generate one, Paseo helper agents read your session transcripts for the period and summarise them, with the provider and model you choose in the report settings. The text goes to that provider like any other agent prompt and uses your agent quota.

Plugin state (layout, report and its cache) lives in `~/.paseo/plugin-data/dashboard/`.

## Development

```sh
npm install
npm run typecheck
```

Layout:

- `index.client.tsx`, `client/`: the screen and widgets (React Native).
- `index.server.ts`, `server/`: RPC handlers on the daemon; `server/sources/` reads each CLI's session store, `server/report/` builds the report.
- `shared/`: RPC contracts (zod) used by both sides.

## License

[MIT](LICENSE)
