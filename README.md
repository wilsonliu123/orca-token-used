# Token Pulse

Token Pulse is an Orca sidebar plugin for tracking token usage, generation speed, model pricing, and live input/output telemetry across Claude Code, Codex, Gemini CLI, and Antigravity.

## Install

From Orca's plugin directory, search for **Token Pulse**. You can also install the repository directly:

```bash
orca plugin install wilsonliu123/orca-token-used
```

The plugin uses Orca's `trusted-worker` profile. Orca will show the requested access and ask you to approve it before the worker runs.

## Features

- Compact 4-tab navigation (**Live**, **Sessions**, **Stats** with Today/Week/Month switcher, and **Quotas**) with a sticky tab bar and sticky Live KPI header while scrolling.
- Shared **Live Race** track grouping each active parent session and its child subagents into a family squad train (same species and palette, distinct accessories, up to 3 mini subagent ducklings + `+N` overflow badge, racing by combined squad TPS) with click-to-focus navigation and full 6-locale labels.
- Live output and input token rates with 60-second waveforms and inline back navigation.
- Session, day, week, and month token summaries with **Agent**, **Model**, and **Project** breakdowns, plus today's cumulative cost in the live dashboard.
- Inline **Cache hit rate** (`Cache XX%`, highlighted below 50%) across Live cards, Live I/O detail, Sessions history, and Stats summaries.
- Claude Code, Codex, Gemini CLI, and Antigravity transcript parsing with provider logos and reasoning effort badges.
- Antigravity background task tracking: Live cards keep sessions `working` while background tasks run and display a compact command strip with live elapsed time, with the full task list in the I/O detail view.
- Nested subagent cards under parent sessions with parent status elevation while child subagents are active, unified status groups, and flattened worktree session history.
- Orca agent and terminal titles from the host API, with click-to-focus navigation for linked terminals.
- Current model labels and provider-aware USD estimates, with one-click pricing sync in the footer.
- 5-hour and weekly (7-day) quota gauges across Codex, Antigravity (Gemini and Claude/GPT model pools), and Claude, paired with local rolling 5h/7d token and USD usage.
- Status-bar summary with quota waterlines in the tooltip and configurable warning/danger tone thresholds for daily spend and quota usage.
- Online pricing refresh from OpenRouter and models.dev, with offline built-in rates.
- Localized panel UI in Traditional Chinese, Simplified Chinese, English, Japanese, Korean, and Czech.
- Light and dark Orca themes.

## Reading Live TPS

**Live TPS** adds up the output rates of individual agents and subagents across
workspaces. Each card shows that session's own output. When a parent is waiting
for a child, expand the group to see which session is producing tokens. Every
session contributing to the total has a card, even when the recent list exceeds
12 entries.

The current rate uses the last 8 seconds of reported usage. A working agent can
show 0 tok/s between usage reports. A finished session shows 0 tok/s and keeps
its average generation rate. In the I/O detail view, the curves show the last
60 seconds of reported input and output.

## Views

These compact sidebar captures show the full navigation set and the status-bar summary:

| View | Screenshot |
| --- | --- |
| Live overview | ![Live overview](assets/user-live-overview.png) |
| Sessions | ![Sessions](assets/user-sessions.png) |
| Today | ![Today](assets/user-today.png) |
| Week | ![Week](assets/user-week.png) |
| Month | ![Month](assets/user-month.png) |
| Status bar | ![Status bar](assets/user-status-bar.png) |

The larger listing screenshots in the manifest are captured directly from Orca at the directory's minimum image size. These compact captures document the narrow sidebar layouts users see in normal use.

## Data access and privacy

The worker reads agent-owned transcripts and model settings in read-only mode.
Depending on which agents are installed, the paths include:

- Claude Code: `~/.claude/projects/**/*.jsonl` and `~/.claude/settings.json`.
- Codex: `~/.codex/sessions/**/*.jsonl` and `~/.codex/config.toml`.
- Gemini CLI: `~/.gemini/tmp/**/chats/session-*.json` and `~/.gemini/settings.json`.
- Antigravity: `~/.gemini/antigravity*/brain/**`, `<Orca data>/antigravity-chat/**`, and `<Orca data>/antigravity-accounts/*/**`.
- Orca-managed Codex homes under `<Orca data>/codex-runtime-home/` and
  `<Orca data>/codex-accounts/`, for their Codex transcripts and model settings.

Token Pulse uses Orca's public workspace, agent, and terminal APIs for status,
workspace selection, and terminal focus. The `history:read` permission lets
`agent.listSessions` supply recent conversation titles and workspace assignments.
Per-turn usage, TPS, costs, and subagent relationships come from the agent's own
files. When Orca cannot supply a session match, the session uses its transcript
metadata. Terminal focus is available when the host supplies a terminal linked
to the session. Token Pulse reads local tab labels from the Orca CLI's public
terminal layout and matches them by terminal handle. Custom Codex and Claude
homes are discovered through `CODEX_HOME` and `CLAUDE_CONFIG_DIR` when those
variables are available to the plugin worker.
To read quota windows and pool usage, Token Pulse also runs
`orca account list --json` with a five-minute cache. On Windows, it uses Orca's
bundled CLI unless `ORCA_BIN` is set. If the worker has neither `APPDATA` nor
`ORCA_USER_DATA_PATH`, the CLI uses the user's default roaming app data folder.

The settings files are parsed only for model and account-home metadata. Token Pulse uses local paths and `orca account list --json` output internally to display quotas and match sessions, and does not modify accounts or transmit credentials, emails, prompts, responses, transcript contents, or local paths.

The only outbound requests are public pricing reads from:

- `https://openrouter.ai/api/v1/models`
- `https://models.dev/api.json`

Transcript contents, prompts, responses, and local paths are not sent to those endpoints. Token Pulse has no analytics, telemetry, advertising, or account sign-in flow.

## Settings

| Setting | Default | Description |
| --- | ---: | --- |
| Live pricing sync interval | 6 hours | How often online model rates are refreshed. |
| Live transcript refresh interval | 2 seconds | How often active transcripts are tailed. |
| Daily spend warning threshold | $0 (off) | Highlights the status bar in danger tone when today's estimated spend reaches this USD amount. |
| Quota warning threshold | 85% | Highlights the status bar in warning/danger tone when any provider 5h or weekly quota reaches this percentage (0 = off). |
| Track Claude Code / Codex / Antigravity / Gemini CLI | on | Per-agent switch. When off, the agent's transcripts and settings are not read, its already loaded sessions are removed from the plugin's history cache (rebuilt from the transcripts when it is switched back on), and it is not shown (Live, Sessions, Stats, Quotas, open detail). Two Orca calls cannot be filtered by agent and stay shared: Orca's session history list (`agent.listSessions`) is still requested while any agent is on, and rows of switched-off agents are discarded before they are stored (the request is skipped when every agent is off). Orca's `account list --json` is a single call that returns every provider together with its rate limits (the per-agent form has none), so it still runs while any quota provider is on; the switched-off provider's part is discarded and never cached, and a cache written earlier is rewritten at startup (deleted when every provider is off). Once every quota provider is off the call is skipped and the Quotas tab says so. |

## Development

```bash
orca plugin dev watch .
orca plugin validate .
orca plugin test .
```

The plugin requires Orca `>=1.4.259`.

## Releases

Pass the next unused version to the release script. Add `--dry-run` to preview
the release without publishing it.

```text
scripts/publish-plugin.sh <version> [--dry-run]
```

The script updates the manifest, validates and tests the plugin, and pushes
`main` and the matching `vX.Y.Z` tag. Orca automatically checks new tags on
public repositories with the `orca-plugin` topic. After publishing, verify the
listed version and commit in the [community catalog](https://github.com/stablyai/orca-community-plugins/blob/main/orca-catalog.json).

## License

MIT
