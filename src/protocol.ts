import type {} from 'orca'

export type AgentKind = 'claude' | 'codex' | 'antigravity' | 'gemini'

export type ViewTab = 'live' | 'sessions' | 'day' | 'week' | 'month'

export type ScopeMode = 'all' | 'worktree'

export type AgentRunState = 'working' | 'waiting' | 'blocked' | 'done'

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

export interface LiveAgentCard {
  id: string
  /** Stable session identity (`<agent>:<sessionId>` or terminal ID) for 1s live drill-down */
  sessionKey: string
  agent: AgentKind
  providerLabel: string
  modelLabel: string
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
  tokens: TokenBreakdown
}

export interface WorktreeSessionItem {
  sessionId: string
  agent: AgentKind
  providerLabel: string
  modelLabel: string
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

export interface PeriodSummary {
  tokens: TokenBreakdown
  tps: TpsStats
  previousTotalTokens: number | null
  deltaPercent: number | null
  buckets: TimeBucket[]
  byAgent: AgentSummaryRow[]
}

export interface PricingStatus {
  source: 'online' | 'cache' | 'builtin'
  syncedAt: number | null
  modelCount: number
  lastError: string | null
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
  live: {
    tokens: TokenBreakdown
    tps: TpsStats
    agents: LiveAgentCard[]
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
    'pricing.refresh': {
      input: Record<string, never>
      output: PricingStatus
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
