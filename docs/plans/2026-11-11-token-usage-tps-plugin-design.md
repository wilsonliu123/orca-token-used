# Token usage and TPS sidebar plugin design

This document defines the architecture, user interface, data pipeline, pricing synchronization, and verification strategy for the Orca token usage, cost, and tokens-per-second (TPS) sidebar plugin.

## Overview and manifest profile

The plugin displays real-time and historical token consumption, true generation TPS, and estimated USD cost across the four primary coding agents in Orca: **Claude Code** (`Anthropic`), **Codex** (`OpenAI`), **Gemini CLI** (`Google`), and **Antigravity** (`Google`).

To keep compatibility with Orca's community catalog rules, the manifest omits the deprecated `publisher` field and uses a non-reserved `id` (`token-pulse`, avoiding the reserved `orca-` prefix):

- **Manifest format:** `manifestVersion: 2`, `engines.orca: ">=1.4.248"`, `pluginApi: 1`
- **Execution profile:** `trusted-worker` (`main: "src/worker.ts"`)
- **UI surface:** Right-sidebar HTML panel (`ui: "html"`, `entry: "src/panel/index.html"`) styled with `--orca-*` theme CSS variables, paired with one `contributes.statusBarItems` entry so Orca keeps the worker active while enabled
- **Capabilities:** `workspace:read`, `agent:read`, `storage:own`, `settings:own`

## Sidebar layout, icon navigation, and localization

The sidebar panel adapts automatically to light and dark Orca themes and follows Orca's configured UI language.

### Pure SVG icon navigation bar

The top navigation bar uses five compact vector icons (without text labels or bracket characters) and displays localized tooltips on hover plus a clean active-view header underneath:

1. **Live (`activity` / lightning pulse icon):** Displays live aggregate TPS, peak TPS, active tokens (Input / Cache / Output stacked bar), and **live USD cost**. Lists currently running Orca agent sessions, showing:
   - Agent badge and status indicator (`working`, `waiting`, `blocked`)
   - **Provider and model identifier** (for example, `Anthropic · claude-opus-5-5`, `OpenAI · gpt-6.1-sol`, `Google · gemini-3-pro`)
   - Workspace name, live TPS with an inline SVG sparkline, session token breakdown, and live session USD cost
2. **Sessions (`message-square` icon):** Scoped to the **currently focused Orca worktree**, listing all conversation sessions sorted from **newest to oldest** (`updatedAt` descending). Each card shows the **conversation session title**, agent badge, provider/model label, relative timestamp, total tokens with a three-segment Input / Cache / Output bar, average TPS, and session USD cost.
3. **Day (`sun` / clock icon):** Includes an **All machine / Current worktree** scope toggle, KPI summary card (total tokens, **total USD cost**, average and peak TPS), a **24-hour stacked SVG bar chart** color-coded by agent, and a four-agent breakdown list.
4. **Week (`calendar-range` icon):** Same structure as **Day**, aggregated over a **7-day stacked SVG bar chart**.
5. **Month (`calendar-days` icon):** Same structure as **Day**, aggregated over a **30-day stacked SVG bar chart**.

### Status bar item and localization

The bottom status bar item updates via `statusBar.update` to display live throughput and daily spend at a glance (for example, `⚡ 96.4 tok/s · 1.84M ($4.28)` when an agent is working). All panel strings, tooltips, relative timestamps, and status bar labels read `window.orca.locale` and support `zh-TW`, `zh-CN`, `en`, `ja`, and `ko` (defaulting to `en`).

## Data sources, TPS calculation, and live online pricing

The background worker aggregates local transcripts incrementally without blocking the UI or re-reading large historical files on every refresh.

### Agent transcript adapters and session titles

- **Claude Code:** Tails `~/.claude/projects/**/*.jsonl` for `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`), `message.model`, `cwd`, and turn timestamps.
- **Codex:** Tails `~/.codex/sessions/**/*.jsonl` for `session_meta` (`cwd`), `turn_context` (`model`), and `token_count` events (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`).
- **Antigravity:** Tails `~/Library/Application Support/orca/antigravity-chat/**/transcript.jsonl` (and `~/.gemini/antigravity-cli` logs) for `PLANNER_RESPONSE` token counts, model metadata, and step timestamps.
- **Gemini CLI:** Reads `~/.gemini/tmp/**/chats/session-*.json` (and JSONL logs) for per-message token usage, model name, and workspace directory mapping.
- **Session title alignment:** Queries Orca's `agent-session-journal.db` in read-only mode (`mode=ro`) to match `agent_session_records.conversationName` and `workspaceId`, falling back to transcript custom titles or the truncated first user prompt.

### True generation TPS formula

For each completed model turn, the worker computes generation speed over actual model inference time rather than idle user think time:

- `turnTps = (outputTokens + reasoningTokens) / inferenceDurationSeconds`
- Sub-200ms metadata-only events are excluded from TPS averages to prevent artificial spikes.
- Aggregations expose **Live TPS** (most recent active turn), **Weighted Average TPS**, and **Peak TPS**.

### Periodic online model pricing sync

Instead of manual pricing overrides, the worker runs an automated online pricing synchronization engine:

- Fetches live structured model rates (`input`, `output`, `cache_read`, `cache_write` per 1M tokens) on worker startup and every `pricingSyncHours` (default `6` hours, `5s` request timeout) from `https://models.dev/api.json` and `https://openrouter.ai/api/v1/models`.
- Resolves provider family aliases for CLI-specific model identifiers (such as `gpt-6.1-sol`, `gpt-6.1-terra`, `claude-opus-5-5`, `claude-fable-5-1`, and `gemini-3-*`) to their corresponding official provider rates, while honoring native `costUSD` fields when recorded directly in a transcript.
- Persists the synced pricing catalog and `updatedAt` timestamp in `storage:own`, falling back seamlessly to cached or built-in baseline rates when offline.

## Settings, error handling, and verification

### Plugin settings

`contributes.settings` exposes two lightweight numeric controls:

1. `pricingSyncHours` (integer, default `6`, minimum `1`, maximum `24`): Interval in hours for online model rate updates.
2. `livePollSeconds` (integer, default `2`, minimum `1`, maximum `10`): Refresh interval in seconds for active session tailing.

### Fault tolerance and testing

- **Safe concurrent reads:** The JSONL tailer advances byte offsets only up to the last complete newline (`\n`) so half-written lines during active streaming never fail parsing or drop tokens. Missing agent folders resolve quietly to empty state.
- **Historical bucket cache:** Completed past-day file summaries are cached in `storage:own` keyed by file path, size, and `mtimeMs` so 7-day and 30-day charts load instantaneously.
- **Verification suite:** Unit tests under `orca plugin test` (`orca/testing` `mountWorker`) cover all four agent parsers, partial-line tailing, TPS math, session sorting, and live pricing resolution, followed by `orca plugin validate .`, `orca plugin dev load`, and `orca plugin shot` visual verification.
