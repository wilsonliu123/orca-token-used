# Plan: Orca Token Usage, TPS & Live Cost Sidebar Plugin (`token-pulse`)

**Generated**: 2026-11-11

## Overview

Build, test, live-verify, and adversarially review the `token-pulse` Orca sidebar plugin (`manifestVersion: 2`, `trusted-worker` + `ui: "html"` panel + `statusBarItems`) tracking **Claude Code**, **Codex**, **Gemini CLI**, and **Antigravity** token consumption, true generation TPS, and live online model USD pricing across **Live**, **Sessions** (current worktree newest-to-oldest), **Day**, **Week**, and **Month** dimensions with full `orca.locale` multi-language support.

## Prerequisites

- Orca CLI `>=1.4.248` (`1.4.256` installed)
- Node.js `>=20.6` (`v26.13.0` installed, with built-in `node:sqlite`, `node:fs`, `node:test`)

## Dependency Graph

```
T1 (Manifest, License & Typings)
 ├── T2 (Protocol & Shared Domain Types)
 │    ├── T3 (Live Online Model Pricing Engine)
 │    ├── T4 (4-Agent Incremental Tailers & Journal Session Mapper)
 │    ├── T5 (Localization Dictionary & Formatting Utilities)
 │    └── T6 (HTML/SVG/CSS Theme-Adaptive Sidebar Panel)
 │         │
 │    ┌────┴──────────────────────┐
 │    ▼                           ▼
 │   T7 (Aggregator & Worker)    T6 (Panel UI)
 │    │                           │
 └────┴───────────┬───────────────┘
                  ▼
      T8 (Unit & Integration Tests via `orca plugin test`)
                  │
                  ▼
      T9 (Live Orca Load, Real Data Verification & `orca plugin shot`)
                  │
                  ▼
     T10 (Independent Adversarial Review for P0/P1 & Fixes)
```

## Tasks

### T1: Manifest, License & Orca TypeScript Typings
- **depends_on**: []
- **location**: `orca-plugin.json`, `LICENSE`, `tsconfig.json`, `assets/icon.png`
- **description**: Create `orca-plugin.json` (format v2, `id: "token-pulse"`, omitting deprecated `publisher` and avoiding `orca-` prefix, `engines.orca: ">=1.4.248"`, `execution: "trusted-worker"`, `main: "src/worker.ts"`, `panels`, `statusBarItems`, `commands`, `events`, `settings`, `capabilities`), MIT `LICENSE`, 128×128 square PNG icon, `tsconfig.json`, and generate `.orca/types` via `orca plugin types .`.
- **validation**: `orca plugin types .` succeeds; `orca-plugin.json` adheres to v2 schema.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T2: Protocol & Shared Domain Types
- **depends_on**: [T1]
- **location**: `src/protocol.ts`
- **description**: Define shared data contracts (`AgentKind`, `ViewTab`, `ScopeMode`, `TokenBreakdown`, `LiveAgentCard`, `WorktreeSessionItem`, `TimeBucket`, `AgentSummaryRow`, `DashboardSnapshot`, `PricingStatus`) and `declare module 'orca'` `PluginRequests` (`dashboard.get`, `pricing.refresh`, `dashboard.refresh`) and `PluginPanelEvents` (`dashboard.updated`).
- **validation**: Type-checks cleanly against `.orca/types`.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T3: Live Online Model Pricing Engine
- **depends_on**: [T2]
- **location**: `src/pricing.ts`
- **description**: Implement online pricing synchronization fetching official model rates (`input`, `output`, `cache_read`, `cache_write` per 1M tokens) from `https://models.dev/api.json` and `https://openrouter.ai/api/v1/models` with 5s `AbortController` timeout, scheduled sync (`pricingSyncHours`), provider/family alias mapping (`claude-opus-5-5`, `claude-fable-5`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `gemini-4-carbon`, `gemini-3-*`, `gemini-2.5-*`), `storage:own` persistence, and offline baseline fallback.
- **validation**: Unit tests verify live JSON parsing, alias resolution, cache-hit discount math, and timeout fallback.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T4: 4-Agent Incremental Tailers & Orca Session Journal Mapper
- **depends_on**: [T2]
- **location**: `src/parsers.ts`, `src/journal.ts`, `src/scanner.ts`
- **description**:
  - Implement safe newline-bounded byte-offset JSONL reader (never advancing past an incomplete trailing line; handling file truncation/inode replacement).
  - Implement parsers for **Claude Code** (deduplicating streaming `assistant` chunks by `message.id`, extracting `api-request` model & `user` timestamps, ignoring `<synthetic>` zero turns), **Codex** (reading `~/.codex/sessions` + Orca `codex-runtime-home` / `accountHome`, deduplicating consecutive `token_count` events with identical `total_token_usage`, tracking `turn_context.model` and `task_started` inference start time), **Antigravity** (reading Orca `antigravity-chat` + `~/.gemini/antigravity*` brains, filtering out internal `"Name this chat..."` title-gen sessions, computing step-to-step inference duration), and **Gemini CLI** (`~/.gemini/tmp/**/chats/session-*.json` & JSONL).
  - Implement read-only (`node:sqlite` `readOnly: true` with graceful fallback) mapper against Orca's `agent-session-journal.db` to resolve `conversationName`, `workspaceId` worktree path, and `options.model`.
- **validation**: Parsers accurately extract tokens, provider/model, session title, worktree path, and true inference TPS without double-counting or crashing on partial JSONL lines.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T5: Localization Dictionary & Formatting Utilities
- **depends_on**: [T2]
- **location**: `src/panel/i18n.ts`
- **description**: Create `orca.locale`-aware localization dictionaries for `zh-TW`, `zh-CN`, `en`, `ja`, and `ko` plus compact token (`1.84M`, `418.2K`), USD cost (`$4.28`, `$0.012`), TPS (`96.4 tok/s`), and localized relative-time formatters.
- **validation**: Locale resolver handles exact and prefix BCP-47 tags (`zh-Hant`, `zh-TW`, `zh-CN`, `en-US`, `ja-JP`, `ko-KR`).
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T6: HTML/SVG/CSS Theme-Adaptive Sidebar Panel
- **depends_on**: [T2, T5]
- **location**: `src/panel/index.html`, `src/panel/styles.css`, `src/panel/app.ts`
- **description**: Build the isolated frame UI using `--orca-*` CSS variables:
  - Top 5-tab pure SVG icon navigation bar (no text/brackets in tabs, localized `title` tooltips + active view heading)
  - Scope toggle (`All Machine` / `Worktree`) on Day/Week/Month
  - **Live** view: aggregate live TPS + peak TPS, active tokens + tricolor bar + live USD cost, running agent cards showing **Provider · Model**, status dot, workspace, live TPS + SVG sparkline, token breakdown, and live session cost
  - **Sessions** view: current worktree conversations sorted newest-to-oldest (`updatedAt` desc) with session title, agent badge, provider/model, relative time, tokens + tricolor bar, avg TPS, and session USD cost
  - **Day / Week / Month** views: KPI card with USD cost & period delta, pure SVG 4-color stacked bar chart (24h / 7d / 30d) with hover tooltips, and 4-agent breakdown table with cost & TPS
- **validation**: Zero external network assets, XSS-safe DOM/SVG rendering, responsive down to narrow 280px sidebars, supports light & dark themes.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T7: Aggregator & Trusted Worker Entrypoint
- **depends_on**: [T3, T4]
- **location**: `src/aggregator.ts`, `src/worker.ts`
- **description**: Combine active Orca agent state (`agents.list`, `agent.status.changed`, `workspace.readContext`, `workspace.changed`, `workspace.list`) with scanned transcripts, historical file summary caching (`storage:own`), TPS sparkline ring buffers, `orca.panels.handle` / `orca.panels.post` live push, and `statusBar.update` (`⚡ X tok/s · YM ($Z)`).
- **validation**: `orca plugin validate .` exits 0; TypeScript `tsc --noEmit` exits 0.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T8: Automated Unit & Worker Tests
- **depends_on**: [T6, T7]
- **location**: `src/plugin.test.ts`
- **description**: Write comprehensive test suite run via `orca plugin test .` covering all 4 agent parsers, streaming deduplication, partial JSONL tailing, TPS inference duration filtering, pricing sync & alias cost math, session newest-to-oldest sorting, locale resolution, and `mountWorker` host/request lifecycle (`refusals` empty).
- **validation**: `orca plugin test .` passes 100% with 0 refusals.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T9: Live Orca Deployment & Visual Shot Verification
- **depends_on**: [T8]
- **location**: `.orca/shots/`
- **description**: Load development plugin into running Orca via `orca plugin dev load . --approve <fp>`, verify live worker logs (`orca plugin logs local.token-pulse`), test `orca plugin dev request`, and capture real panel & status bar screenshots via `orca plugin shot` across views to verify real machine transcripts render accurately.
- **validation**: `orca plugin shot` exits 0 with `errors: []`, rendering real token, TPS, model, session title, and USD cost data.
- **status**: Not Completed
- **log**:
- **files edited/created**:

### T10: Adversarial Code & Runtime Review (Zero P0/P1 Gate)
- **depends_on**: [T9]
- **location**: `docs/plans/2026-11-11-adversarial-review.md`
- **description**: Dispatch an independent adversarial reviewer (Codex / subagent) to attack security (XSS, SQLite locking, path traversal), accuracy (double-counted tokens, wrong timezone buckets, stale model rates, TPS spikes), performance (large JSONL memory/CPU), and Orca contract compliance. Fix every P0/P1/P2 finding, re-run all tests and live shots, and verify zero P0/P1 remain.
- **validation**: Adversarial review confirms 0 P0 and 0 P1 issues; `orca plugin validate .` and `orca plugin test .` pass cleanly.
- **status**: Not Completed
- **log**:
- **files edited/created**:
