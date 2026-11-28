import type {} from 'orca'

export type AgentKind = 'claude' | 'codex' | 'antigravity' | 'gemini'

export type DashboardTab = 'live' | 'sessions' | 'day' | 'week' | 'month' | 'quotas'

export type ViewTab = DashboardTab

export type ScopeMode = 'all' | 'worktree'

export type StatsBreakdownMode = 'agent' | 'model' | 'project'

export type AgentRunState = 'working' | 'waiting' | 'blocked' | 'done'

export interface BackgroundTaskInfo {
  id: string
  label: string
  startedAt: number
}

export interface TokenBreakdown {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  costUsd: number
}

export interface TpsStats {
  liveTps: number
  avgTps: number
  peakTps: number
}

export interface OrcaLiveAgentInfo {
  terminalId: string | null
  sessionId?: string | null
  workspaceId?: string
  tabId?: string | null
  title: string | null
  agent: string | null
  state: AgentRunState
  stateStartedAt: number
  workspacePath?: string | null
}

export interface LiveAgentCard {
  id: string
  /** Stable session identity (`<agent>:<sessionId>` or terminal ID) for 1s live drill-down */
  sessionKey: string
  /** Parent session identity when this card represents a nested subagent. */
  parentSessionKey?: string | null
  /** Orca terminal to focus when this card represents a terminal-backed agent. */
  terminalId: string | null
  agent: AgentKind
  providerLabel: string
  modelLabel: string
  /** Observed reasoning levels in chronological order; empty means the source did not record one. */
  reasoningLevels?: string[]
  state: AgentRunState
  title: string
  projectName: string | null
  workspaceName: string
  workspacePath: string | null
  updatedAt: number
  tps: TpsStats
  sparkline: number[]
  /** 60 one-second buckets (`[t-59s .. t]`) of output+reasoning token velocity (`tok/s`) */
  outSeries: number[]
  /** 60 one-second buckets (`[t-59s .. t]`) of input+cache token velocity (`tok/s`) */
  inSeries: number[]
  /** Integer Unix second corresponding to the last element (`index 59`) of `outSeries`/`inSeries` */
  seriesEndSec?: number
  /** Current 1s output token velocity (`tok/s`) */
  liveOutRate: number
  /** Current 1s input token velocity (`tok/s`) */
  liveInRate: number
  /** Active background tasks (e.g. async shell commands) currently running for this session. */
  backgroundTasks?: BackgroundTaskInfo[]
  tokens: TokenBreakdown
}

export interface WorktreeSessionItem {
  sessionId: string
  agent: AgentKind
  providerLabel: string
  modelLabel: string
  reasoningLevels?: string[]
  title: string
  projectName: string | null
  workspaceName: string
  workspacePath: string | null
  updatedAt: number
  createdAt: number
  active: boolean
  tps: TpsStats
  tokens: TokenBreakdown
}

export interface TimeBucket {
  key: string
  label: string
  startMs: number
  endMs: number
  totalTokens: number
  costUsd: number
  byAgent: Record<AgentKind, number>
}

export interface AgentSummaryRow {
  agent: AgentKind
  providerLabel: string
  sharePercent: number
  tokens: TokenBreakdown
  tps: TpsStats
  topModel: string
}

export interface ModelSummaryRow {
  modelLabel: string
  providerLabel: string
  agent: AgentKind
  sharePercent: number
  tokens: TokenBreakdown
  tps: TpsStats
}

export interface ProjectSummaryRow {
  projectKey: string
  label: string
  sharePercent: number
  tokens: TokenBreakdown
  sessionCount: number
}

export interface PeriodSummary {
  tokens: TokenBreakdown
  tps: TpsStats
  previousTotalTokens: number | null
  deltaPercent: number | null
  buckets: TimeBucket[]
  byAgent: AgentSummaryRow[]
  byModel?: ModelSummaryRow[]
  byProject?: ProjectSummaryRow[]
}

export interface PricingStatus {
  source: 'online' | 'cache' | 'builtin'
  syncedAt: number | null
  modelCount: number
  lastError: string | null
}

export type QuotaProviderKind = 'codex' | 'antigravity' | 'claude'

export type QuotaProviderStatus = 'ok' | 'unavailable' | 'error' | 'loading'

export interface QuotaWindow {
  /** Percentage of quota used (0-100) */
  usedPercent: number
  /** Window duration in minutes (e.g. 300 for 5h, 10080 for 7d) */
  windowMinutes: number
  /** Epoch ms when this window resets, or null if unknown */
  resetsAt: number | null
  /** Human-readable reset description (e.g. "Wed 3:53 PM"), or null */
  resetDescription: string | null
}

export interface QuotaPool {
  /** Stable slug id (e.g. "gemini-models", "claude-and-gpt-models") */
  id: string
  /** Pool display name (e.g. "Gemini Models", "Claude and GPT models") */
  label: string
  /** 5-hour window, or null if not available */
  session: QuotaWindow | null
  /** 7-day weekly window, or null if not available */
  weekly: QuotaWindow | null
}

export interface QuotaResetCredits {
  availableCount: number
  totalEarnedCount: number
  nextExpiresAt: number | null
}

export interface QuotaAccountSummary {
  id: string | null
  email: string | null
  label: string | null
  authKind: string | null
  active: boolean
  status: QuotaProviderStatus
  session: QuotaWindow | null
  weekly: QuotaWindow | null
  pools: QuotaPool[]
  error: string | null
}

export interface LocalQuotaUsageWindow {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  turnCount: number
  sessionCount: number
  rateLimitHits: number | null
}

export interface LocalActivityBucket {
  startMs: number
  totalTokens: number
  costUsd: number
  turnCount: number
}

export interface LocalDailyBucket {
  dayKey: string
  totalTokens: number
  costUsd: number
  turnCount: number
  isToday: boolean
}

export interface LocalModelMixEntry {
  model: string
  totalTokens: number
  pct: number
  isOther?: boolean
}

export interface QuotaProviderSnapshot {
  provider: QuotaProviderKind
  label: string
  status: QuotaProviderStatus
  error: string | null
  accountEmail: string | null
  authKind: string | null
  session: QuotaWindow | null
  weekly: QuotaWindow | null
  pools: QuotaPool[]
  resetCredits: QuotaResetCredits | null
  accounts: QuotaAccountSummary[]
  updatedAt: number | null
  /** Whether Orca supplied official quota windows or model pools for this provider. */
  officialQuotaAvailable?: boolean
  local: {
    window5h: LocalQuotaUsageWindow
    window7d: LocalQuotaUsageWindow
    activity5h?: LocalActivityBucket[]
    daily7d?: LocalDailyBucket[]
    modelMix7d?: LocalModelMixEntry[]
    cacheHitRate7d?: number | null
  }
}

export interface QuotasSnapshot {
  /** `disabled`: every quota provider is switched off in the plugin settings. */
  source: 'live' | 'cache' | 'loading' | 'error' | 'disabled'
  syncedAt: number | null
  refreshing: boolean
  lastError: string | null
  providers: QuotaProviderSnapshot[]
}

export interface WorkspaceFocusInfo {
  id: string | null
  project: string | null
  name: string | null
  branch: string | null
  path: string | null
}

export interface DashboardSnapshot {
  generatedAt: number
  workspace: WorkspaceFocusInfo
  pricing: PricingStatus
  quotas?: QuotasSnapshot
  /** Agents switched off in the plugin settings; the panel drops any open detail of them. */
  disabledAgents?: AgentKind[]
  live: {
    tokens: TokenBreakdown
    tps: TpsStats
    agents: LiveAgentCard[]
    subagents: LiveAgentCard[]
  }
  sessions: WorktreeSessionItem[]
  periods: {
    all: {
      day: PeriodSummary
      week: PeriodSummary
      month: PeriodSummary
    }
    worktree: {
      day: PeriodSummary
      week: PeriodSummary
      month: PeriodSummary
    }
  }
}

export interface LiveAgentPollResult {
  generatedAt: number
  agent: LiveAgentCard | null
}

declare module 'orca' {
  interface PluginRequests {
    'dashboard.get': {
      input: { forceScan?: boolean; locale?: string }
      output: DashboardSnapshot
    }
    'agent.livePoll': {
      input: { sessionKey: string }
      output: LiveAgentPollResult
    }
    'session.focus': {
      input: { terminalId: string }
      output: { focused: boolean }
    }
    'pricing.refresh': {
      input: Record<string, never>
      output: PricingStatus
    }
    'quotas.refresh': {
      input: Record<string, never>
      output: QuotasSnapshot
    }
    'view.set': {
      input: { tab?: ViewTab; scope?: ScopeMode; locale?: string; liveAgentKey?: string | null }
      output: {
        tab: ViewTab
        scope: ScopeMode
        locale: string | null
        liveAgentKey: string | null
      }
    }
  }

  interface PluginPanelEvents {
    'dashboard.updated': DashboardSnapshot
    'view.changed': {
      tab?: ViewTab
      scope?: ScopeMode
      locale?: string | null
      liveAgentKey?: string | null
    }
  }
}
