# Changelog

All notable changes to Token Pulse are documented in this file.

## [0.2.5] - 2026-11-28

### Fixed

- **Antigravity local-only Quotas UI**: Added `officialQuotaAvailable` tracking on `QuotaProviderSnapshot` (preserving cached state across reloads) so Antigravity renders a `Local only` status badge, account-safety hint banner, full 5h/7d local usage tiles, and account list without redundant empty pool summaries when official Antigravity quota pools are unavailable, localized across all 6 locales (`zh-TW`, `zh-CN`, `en`, `ja`, `ko`, `cs`) (#12).

## [0.2.4] - 2026-11-26

### Fixed

- **Stuck `working` session silence timeout**: Added a conservative 5-minute silence timeout guard in `resolveSessionRunState` so interrupted sessions (such as Codex sessions stopped mid-turn without writing `turn_aborted`/`task_complete` while Orca Host still reports `working`) downgrade to `done` after 5 minutes of transcript and state inactivity, without affecting active background tasks, `waiting` prompts, active child subagent elevation, or sessions without transcript timestamps yet (#10).

## [0.2.3] - 2026-11-24

### Added

- **Per-agent tracking switches**: Added per-agent toggles (`enableClaude`, `enableCodex`, `enableAntigravity`, `enableGemini`, all on by default) in Orca plugin settings to stop reading transcripts and settings, clear cached sessions and quota data, hide disabled agents across Live, Sessions, Stats, Quotas, and open detail views, and skip `orca account list --json` when all quota providers are off (#6, @hanyscz).

## [0.2.2] - 2026-11-24

### Added

- **Background command strip & I/O detail task list**: Added a compact single-line background command strip (`>_` command label, `+N` badge, hover list, and 1s live elapsed timer) on Live cards and a full background task list in the Live I/O detail view across all 6 locales (#7).

### Fixed

- **Antigravity background task working state**: Kept Antigravity sessions in `working` while asynchronous background tasks (`GENERIC RUNNING`) are active instead of prematurely marking them `done` after `PLANNER_RESPONSE` or 45s of inactivity (#7).

## [0.2.1] - 2026-11-23

### Added

- **Parent & subagent squad trains in Live Race**: Grouped each active parent session and its active child subagents into a single family formation on the Live Race track — children inherit their parent's species and palette with distinct accessories, trail behind the parent as up to 3 mini ducklings (with a `+N` overflow badge), race by combined squad TPS, and keep matching mini avatars on subagent cards. Active orphan subagents remain visible as standalone mini racers.
- **Full 6-locale i18n coverage (including Czech `cs`)**: Localized all Live Race strings (`LIVE RACE`, thinking/waiting counters, subagent tooltip labels) and status-bar quota tooltip labels across `zh-TW`, `zh-CN`, `en`, `ja`, `ko`, and `cs`, with automated key-parity tests across all 6 locales.

### Fixed

- **Quotas multi-account row overflow**: Stacked the account email/active badge above a wrapped pool summary inside `.tp-quota-account-row` so long multi-pool quota lines (and longer localized labels such as Czech `Neuplatňuje se`) never clip or overflow past the card border.

## [0.2.0] - 2026-11-23

### Added

- **Shared Live Race track**: Added a compact single-track runtime session race bar in the Live view with a parametric SVG mascot generator (8 species × 8 palettes × 6 accessories = 384 unique combinations) using collision-free assignment per active `sessionKey`, leader crown for active token output (`> 0 tok/s`), thinking/waiting indicators, hover tooltips, matching card avatars, and click-to-focus navigation.
- **Model & Project breakdowns in Stats**: Added `byModel` and `byProject` aggregation in `PeriodSummary` and an inline `Agent | Model | Project` switcher in the Stats breakdown card.
- **Cache hit rate indicators**: Added inline `Cache XX%` hit-rate indicators (highlighted in amber below 50%) on Live agent cards, Live I/O detail view (updated live at 1s), Sessions cards, and Stats period summaries.
- **Status bar quota waterlines & spend/quota thresholds**: Added `dailyBudgetUsd` and `quotaAlertPercent` settings to highlight the status bar in `warning`/`danger` tone and display quota waterlines in the status bar tooltip without requiring additional capabilities.

### Changed

- **4-tab navigation**: Consolidated the 6 navigation tabs into 4 primary tabs (**Live**, **Sessions**, **Stats**, **Quotas**), moving the `Today | Week | Month` switcher alongside `All | Worktree` inside **Stats**.
- **Sticky top navigation & Live KPI header**: Pinned the tab bar and Live KPI summary at the top while scrolling the agent list underneath.
- **UI decluttering**: Removed redundant page subheaders, merged the duplicate `ACTIVE TOKENS` summary card into a compact tricolor bar, moved the pricing sync action into the clickable footer, removed duplicate hero rate cards from the Live I/O detail view while adding a `← Live` back button, and flattened the Sessions list.

### Fixed

- **Unified status groups for orphan subagents**: Merged orphaned subagents into the same `WORKING` / `WAITING` / `BLOCKED` / `DONE` collapse groups as root agents to eliminate duplicate status group headers.

## [0.1.9] - 2026-11-23

### Added

- Add Czech (`cs`, `cs-CZ`, `cs_CZ`) UI localization for the dashboard panel
  (#5, @hanyscz).

## [0.1.8] - 2026-11-20

### Fixed

- Restore Windows quota readings for Codex, Antigravity, and Claude by using
  Orca's bundled CLI and supplying the default Orca data directory when the
  worker has neither `APPDATA` nor `ORCA_USER_DATA_PATH`.

## [0.1.7] - 2026-11-20

- Use Orca's public workspace, agent, terminal, and history APIs for session
  metadata. Live rates, subagents, and costs continue to use local agent records.
- Require Orca 1.4.259 or later for `history:read`.
- Keep Codex subagents listed separately when their records include a parent
  session header.

## [0.1.6] - 2026-11-19

### Fixed

- Live TPS now includes producing agents and subagents across workspaces. Each
  contributing session appears once, including nested workers and sessions
  beyond the 12-card recent list.
- Cards and I/O details use an 8-second window of reported token usage.
  Finished sessions show 0 tok/s and retain their average generation rate.
- Live clears stale working states when terminals close and recognizes completed
  Antigravity error events.
- Session matching reads Orca's current session database with a fallback for
  older versions. New Antigravity conversations appear under their own titles.

## [0.1.5] - 2026-11-17

### Fixed
- **Current model & reasoning badge sync on `/model` switch**: Preferred `st.latestModel` over historical token-weighted `summary.topModel` when journal `model` is absent (CLI sessions), and extracted Antigravity model reasoning effort suffixes (`-minimal`/`-low`/`-medium`/`-high`/`-xhigh`/`-max`) while keeping the latest reasoning level active.

## [0.1.4] - 2026-11-17

### Added
- **Readable subagent names across Antigravity, Codex, and Claude Code**:
  - **Antigravity**: Queries `agent_name` from `conversation_summaries.db` (e.g., `backend`, `frontend`, `verifier`, `monitor`) with raw UUID filtering.
  - **Codex**: Extracts `agent_role`, `agent_path` basename, and `agent_nickname` from `session_meta` / `thread_spawn` metadata (e.g., `premortem_merge · Linnaeus`).
  - **Claude Code**: Correlates parent `Task`/`Agent` `tool_use` descriptions and `subagent_type` via `toolUseResult.agentId`, with bounded (64 KiB) sibling `agent-<id>.meta.json` `agentType` fallback and mtime/delete cache tracking.

## [0.1.3] - 2026-11-17

### Added
- **Quotas tab with 240° circular arc gauges**: Added a 6th navigation tab (`Quotas`) displaying 5-hour and weekly (7-day) rate-limit gauges across Codex, Antigravity (split by Gemini Models and Claude/GPT model pools, with multi-account support), and Claude.
- **Dynamic window & local fallback rendering**: Accounts without a 5-hour window (such as Codex weekly-only plans) render the weekly gauge alongside an explicit `5h Window · N/A` and reset-credits tile; providers without subscription quota data fall back to local rolling 5h/7d token and USD usage.
- **Non-blocking `QuotaEngine`**: Queries `orca account list --json` asynchronously with a 15s timeout, in-flight deduplication, 5-minute TTL cache, and abort-on-deactivate lifecycle handling.
- **Refreshed directory screenshots**: Updated `assets/token-pulse-cover.png` and `assets/token-pulse-live.png` to reflect the updated UI.

### Fixed
- **Active transcript state precedence**: Prevented stale journal `settled` states from overriding newer active `working` transcript writes in `resolveSessionRunState`.
- **Quota edge cases**: Normalized 10-digit epoch seconds for reset timestamps, fixed future reset-credit expiry countdown formatting, guarded `#btn-refresh` when `window.orca` is unavailable, and checked worker shutdown state before persisting quota cache.
- **Publish script**: Added `CHANGELOG.md` to release staging, verified `orca plugin release-entry . --json` `contentHash` output, and updated the printed `orca.dev` directory URL.

## [0.1.2] - 2026-11-17

### Added
- **Nested subagents & status elevation**: Nested subagent cards under parent sessions and elevated parent status to `waiting` while child subagents are active.
- **Terminal tab & handoff title sync**: Bound runtime terminal handles via `tabId`, synchronized terminal tab/handoff titles across CLI sessions, and added click-to-focus terminal navigation.
- **Live dashboard telemetry**: Added provider logos, reasoning effort badges, collapsible status groups, and today's cumulative cost.
- **Documentation**: Documented local read-only data paths and updated `README.md` features.

## [0.1.1] - 2026-11-12

### Added
- Added compact sidebar screenshots (`assets/user-*.png`) and view table in `README.md`.

## [0.1.0] - 2026-11-12

### Added
- Initial release of Token Pulse for Orca: real-time output/input TPS, 60-second waveforms, session/today/week/month summaries, multi-agent transcript parsing (Claude Code, Codex, Gemini CLI, Antigravity), live online pricing from OpenRouter and models.dev, and light/dark Orca theme support.
