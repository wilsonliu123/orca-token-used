import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractWorkspacePathFromId, type JournalIndex } from './journal'
import type { ParsedTurnUsage, SessionTranscriptState } from './parsers'
import { type PricingEngine, providerLabelForAgent } from './pricing'
import type {
  AgentKind,
  AgentRunState,
  AgentSummaryRow,
  DashboardSnapshot,
  LiveAgentCard,
  PeriodSummary,
  TimeBucket,
  TokenBreakdown,
  TpsStats,
  WorktreeSessionItem
} from './protocol'

export const ALL_AGENTS: readonly AgentKind[] = ['claude', 'codex', 'antigravity', 'gemini']

const DEFAULT_MODEL_DISPLAY: Record<AgentKind, string> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-6.1-sol',
  antigravity: 'gemini-3-pro',
  gemini: 'gemini-2.5-pro'
}

export interface OrcaLiveAgentInfo {
  terminalId: string | null
  title: string | null
  agent: string | null
  state: AgentRunState
  stateStartedAt: number
}

export interface KnownOrcaWorkspace {
  id: string
  project: string
  name: string
  path: string
  branch: string | null
}

export interface WorkspaceRuntimeContext {
  focusedId?: string | null
  focusedProject?: string | null
  focusedName: string | null
  focusedBranch: string | null
  focusedPath: string | null
  knownWorkspaces?: KnownOrcaWorkspace[]
  liveAgents: OrcaLiveAgentInfo[]
}

export function emptyTokenBreakdown(): TokenBreakdown {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    costUsd: 0
  }
}

export function emptyTpsStats(): TpsStats {
  return {
    liveTps: 0,
    avgTps: 0,
    peakTps: 0
  }
}

export function stripGitRefPrefix(branch: string | null | undefined): string | null {
  if (!branch) return null
  const trimmed = branch.trim()
  if (!trimmed) return null
  return trimmed.replace(/^refs\/heads\//, '')
}

const realpathCache = new Map<string, string>()

export function normalizeFsPath(p: string | null | undefined): string | null {
  if (!p) return null
  const trimmed = p.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return null
  const cached = realpathCache.get(trimmed)
  if (cached) return cached
  let resolved: string
  try {
    resolved = fs.realpathSync.native(trimmed)
  } catch {
    try {
      resolved = fs.realpathSync(trimmed)
    } catch {
      resolved = path.resolve(trimmed)
    }
  }
  if (realpathCache.size > 2000) realpathCache.clear()
  realpathCache.set(trimmed, resolved)
  return resolved
}

export function isSameOrChildWorktreePath(
  sessionPath: string | null | undefined,
  worktreePath: string | null | undefined
): boolean {
  const sNorm = normalizeFsPath(sessionPath)
  const wNorm = normalizeFsPath(worktreePath)
  if (!sNorm || !wNorm) return false
  if (sNorm === wNorm) return true
  return sNorm.startsWith(wNorm + path.sep)
}

interface EnrichedSession {
  state: SessionTranscriptState
  isSubagent: boolean
  title: string
  projectName: string | null
  workspacePath: string | null
  workspaceName: string
  modelLabel: string
  providerLabel: string
  tokens: TokenBreakdown
  tps: TpsStats
  sparkline: number[]
}

function mapOrcaAgentKind(raw: string | null | undefined): AgentKind | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  if (s.includes('claude')) return 'claude'
  if (s.includes('codex')) return 'codex'
  if (s.includes('antigravity')) return 'antigravity'
  if (s.includes('gemini')) return 'gemini'
  return null
}

function computeTurnSummary(
  agent: AgentKind,
  turns: Iterable<ParsedTurnUsage>,
  pricing: PricingEngine,
  fallbackModel: string | null
): { tokens: TokenBreakdown; tps: TpsStats; sparkline: number[]; topModel: string } {
  const tokens = emptyTokenBreakdown()
  let weightedGenTokens = 0
  let weightedDurSec = 0
  let peakTps = 0
  let latestTps = 0
  let latestTs = 0
  const sparkPoints: Array<{ ts: number; tps: number }> = []
  const modelCounts = new Map<string, number>()

  for (const t of turns) {
    tokens.input += t.input
    tokens.output += t.output
    tokens.reasoning += t.reasoning
    tokens.cacheRead += t.cacheRead
    tokens.cacheWrite += t.cacheWrite
    tokens.total += t.total

    const turnModel = t.model || fallbackModel
    if (turnModel) {
      modelCounts.set(turnModel, (modelCounts.get(turnModel) ?? 0) + t.total)
    }

    tokens.costUsd += pricing.computeCostUsd(
      agent,
      turnModel,
      {
        input: t.input,
        output: t.output,
        reasoning: t.reasoning,
        cacheRead: t.cacheRead,
        cacheWrite: t.cacheWrite
      },
      t.explicitCostUsd
    )

    if (t.tps !== null && t.durationSec !== null && t.tps > 0) {
      weightedGenTokens += t.output + t.reasoning
      weightedDurSec += t.durationSec
      if (t.tps > peakTps) peakTps = t.tps
      if (t.timestampMs >= latestTs) {
        latestTs = t.timestampMs
        latestTps = t.tps
      }
      sparkPoints.push({ ts: t.timestampMs, tps: t.tps })
    }
  }

  sparkPoints.sort((a, b) => a.ts - b.ts)
  const sparkline = sparkPoints.slice(-16).map((p) => +p.tps.toFixed(1))

  const avgTps = weightedDurSec > 0 ? +(weightedGenTokens / weightedDurSec).toFixed(1) : 0
  let topModel = fallbackModel || DEFAULT_MODEL_DISPLAY[agent]
  let bestCount = -1
  for (const [m, cnt] of modelCounts.entries()) {
    if (cnt > bestCount) {
      bestCount = cnt
      topModel = m
    }
  }

  return {
    tokens: {
      ...tokens,
      costUsd: +tokens.costUsd.toFixed(6)
    },
    tps: {
      liveTps: +(latestTps || avgTps).toFixed(1),
      avgTps,
      peakTps: +peakTps.toFixed(1)
    },
    sparkline,
    topModel
  }
}

interface IndexedWorkspace extends KnownOrcaWorkspace {
  normPath: string
}

function indexKnownWorkspaces(known: KnownOrcaWorkspace[]): IndexedWorkspace[] {
  const seen = new Set<string>()
  const out: IndexedWorkspace[] = []
  for (const w of known) {
    const normPath = normalizeFsPath(w.path)
    if (!normPath || seen.has(normPath)) continue
    seen.add(normPath)
    out.push({
      ...w,
      project: w.project?.trim() || path.basename(normPath),
      name: w.name?.trim() || path.basename(normPath),
      branch: stripGitRefPrefix(w.branch),
      normPath
    })
  }
  out.sort((a, b) => b.normPath.length - a.normPath.length)
  return out
}

function resolveProjectAndWorktree(
  sessionPath: string | null,
  indexedWorkspaces: IndexedWorkspace[],
  homeNorm: string | null
): { projectName: string | null; workspaceName: string } {
  if (!sessionPath) {
    return { projectName: null, workspaceName: 'local' }
  }
  const sNorm = normalizeFsPath(sessionPath)
  if (sNorm) {
    for (const w of indexedWorkspaces) {
      if (sNorm === w.normPath || sNorm.startsWith(w.normPath + path.sep)) {
        return {
          projectName: w.project,
          workspaceName: w.name
        }
      }
    }
  }

  const base = path.basename(sNorm || sessionPath) || 'local'
  const parentDir = path.dirname(sNorm || sessionPath)
  const parentBase = path.basename(parentDir)
  const ignoredParents = new Set(['', '/', 'Users', 'home', 'var', 'tmp', 'private'])
  const isHomeDir = homeNorm && parentDir === homeNorm
  const projectName =
    !isHomeDir && parentBase && !ignoredParents.has(parentBase) ? parentBase : null

  return { projectName, workspaceName: base }
}

function enrichSessions(
  sessions: SessionTranscriptState[],
  journal: JournalIndex,
  pricing: PricingEngine,
  indexedWorkspaces: IndexedWorkspace[]
): EnrichedSession[] {
  const homeNorm = normalizeFsPath(os.homedir())

  // Deduplicate by `${agent}:${sessionId}` so archived or multi-home copies never double-count
  const dedupedStates = new Map<string, SessionTranscriptState>()
  for (const st of sessions) {
    if (st.isInternalHelper) continue
    const key = `${st.agent}:${st.sessionId}`
    const prev = dedupedStates.get(key)
    if (
      !prev ||
      st.turnsByKey.size > prev.turnsByKey.size ||
      (st.turnsByKey.size === prev.turnsByKey.size && st.updatedAtMs > prev.updatedAtMs)
    ) {
      dedupedStates.set(key, st)
    }
  }

  const hasJournalRecords = journal.byNativeId.size > 0

  // Map user-renamed Orca PTY terminal tab headers (`customTitle`, e.g. `# 优化 skills`) onto their active CLI session
  const cliCustomTitleBySessionKey = new Map<string, string>()
  const tabOverrides = [...(journal.terminalTabOverrides ?? [])].sort(
    (a, b) => b.lastFocusedAt - a.lastFocusedAt || b.createdAt - a.createdAt
  )
  if (tabOverrides.length > 0) {
    const cliCandidates = Array.from(dedupedStates.values())
      .filter((st) => {
        if (st.isSubagent || journal.byNativeId.has(st.sessionId)) return false
        if (
          st.agent === 'antigravity' &&
          st.filePath.includes('antigravity-acp') &&
          hasJournalRecords
        ) {
          return false
        }
        return st.turnsByKey.size > 0
      })
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)

    const claimedKeys = new Set<string>()
    for (const tab of tabOverrides) {
      const eligible = cliCandidates.filter((st) => {
        const sKey = `${st.agent}:${st.sessionId}`
        if (claimedKeys.has(sKey)) return false
        if (tab.agent && st.agent !== tab.agent) return false
        if (!isSameOrChildWorktreePath(st.cwd, tab.workspacePath)) return false
        if (tab.createdAt <= 0) return true
        return st.createdAtMs >= tab.createdAt - 15_000 || st.updatedAtMs >= tab.createdAt
      })
      eligible.sort((a, b) => {
        const aSpawnedInTab = tab.createdAt > 0 && a.createdAtMs >= tab.createdAt - 15_000 ? 1 : 0
        const bSpawnedInTab = tab.createdAt > 0 && b.createdAtMs >= tab.createdAt - 15_000 ? 1 : 0
        if (aSpawnedInTab !== bSpawnedInTab) return bSpawnedInTab - aSpawnedInTab
        return b.updatedAtMs - a.updatedAtMs
      })
      const matchedCli = eligible[0]
      if (matchedCli) {
        const sKey = `${matchedCli.agent}:${matchedCli.sessionId}`
        claimedKeys.add(sKey)
        cliCustomTitleBySessionKey.set(sKey, tab.customTitle)
      }
    }
  }

  const out: EnrichedSession[] = []

  for (const st of dedupedStates.values()) {
    const jMeta = journal.byNativeId.get(st.sessionId)
    const workspacePath = jMeta?.workspacePath || st.cwd || null
    const { projectName, workspaceName } = resolveProjectAndWorktree(
      workspacePath,
      indexedWorkspaces,
      homeNorm
    )
    const fallbackModel =
      jMeta?.model ||
      st.latestModel ||
      journal.cliConfiguredModels?.[st.agent] ||
      DEFAULT_MODEL_DISPLAY[st.agent]
    const summary = computeTurnSummary(st.agent, st.turnsByKey.values(), pricing, fallbackModel)

    if (summary.tokens.total <= 0 && !jMeta) continue

    const isUnlinkedAcpSubagent =
      st.agent === 'antigravity' &&
      st.filePath.includes('antigravity-acp') &&
      hasJournalRecords &&
      !jMeta
    const isSubagent = Boolean(st.isSubagent || isUnlinkedAcpSubagent)

    const sKey = `${st.agent}:${st.sessionId}`
    const title =
      cliCustomTitleBySessionKey.get(sKey) ||
      jMeta?.title ||
      st.titleHint ||
      `${providerLabelForAgent(st.agent, summary.topModel)} · ${st.sessionId.slice(0, 8)}`

    // Orca's journal stores the model currently selected for the session. Prefer it when a
    // transcript contains earlier turns from a model that was later changed in the same chat.
    const modelLabel = jMeta?.model || summary.topModel || fallbackModel
    const providerLabel = providerLabelForAgent(st.agent, modelLabel)

    out.push({
      state: st,
      isSubagent,
      title,
      projectName,
      workspacePath,
      workspaceName,
      modelLabel,
      providerLabel,
      tokens: summary.tokens,
      tps: summary.tps,
      sparkline: summary.sparkline
    })
  }
  return out
}

function startOfLocalDay(ms: number): Date {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d
}

function buildDayBuckets(now: number): TimeBucket[] {
  const dayStart = startOfLocalDay(now)
  const buckets: TimeBucket[] = []
  for (let h = 0; h < 24; h++) {
    const start = new Date(dayStart)
    start.setHours(h, 0, 0, 0)
    const end = new Date(dayStart)
    end.setHours(h + 1, 0, 0, 0)
    buckets.push({
      key: `h-${h}`,
      label: `${String(h).padStart(2, '0')}:00`,
      startMs: start.getTime(),
      endMs: end.getTime(),
      totalTokens: 0,
      costUsd: 0,
      byAgent: { claude: 0, codex: 0, antigravity: 0, gemini: 0 }
    })
  }
  return buckets
}

function buildMultiDayBuckets(now: number, days: number): TimeBucket[] {
  const todayStart = startOfLocalDay(now)
  const buckets: TimeBucket[] = []
  for (let offset = days - 1; offset >= 0; offset--) {
    const start = new Date(todayStart)
    start.setDate(start.getDate() - offset)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    const mm = String(start.getMonth() + 1).padStart(2, '0')
    const dd = String(start.getDate()).padStart(2, '0')
    buckets.push({
      key: `${start.getFullYear()}-${mm}-${dd}`,
      label: `${mm}/${dd}`,
      startMs: start.getTime(),
      endMs: end.getTime(),
      totalTokens: 0,
      costUsd: 0,
      byAgent: { claude: 0, codex: 0, antigravity: 0, gemini: 0 }
    })
  }
  return buckets
}

function aggregatePeriod(
  enriched: EnrichedSession[],
  buckets: TimeBucket[],
  prevStartMs: number,
  prevEndMs: number,
  pricing: PricingEngine
): PeriodSummary {
  if (buckets.length === 0) {
    return {
      tokens: emptyTokenBreakdown(),
      tps: emptyTpsStats(),
      previousTotalTokens: null,
      deltaPercent: null,
      buckets: [],
      byAgent: []
    }
  }

  const rangeStartMs = buckets[0].startMs
  const rangeEndMs = buckets[buckets.length - 1].endMs

  const totalTokens = emptyTokenBreakdown()
  let prevTotalTokens = 0

  let totalGenOut = 0
  let totalDurSec = 0
  let peakTps = 0
  let latestTps = 0
  let latestTs = 0

  const perAgentTurns: Record<AgentKind, ParsedTurnUsage[]> = {
    claude: [],
    codex: [],
    antigravity: [],
    gemini: []
  }
  const perAgentFallbackModel: Record<AgentKind, string> = { ...DEFAULT_MODEL_DISPLAY }

  for (const session of enriched) {
    const agent = session.state.agent
    if (session.modelLabel) {
      perAgentFallbackModel[agent] = session.modelLabel
    }

    for (const turn of session.state.turnsByKey.values()) {
      const ts = turn.timestampMs
      if (ts >= prevStartMs && ts < prevEndMs) {
        prevTotalTokens += turn.total
      }
      if (ts < rangeStartMs || ts >= rangeEndMs) {
        continue
      }

      const resolvedTurnModel = turn.model || session.modelLabel
      const turnCost = pricing.computeCostUsd(
        agent,
        resolvedTurnModel,
        {
          input: turn.input,
          output: turn.output,
          reasoning: turn.reasoning,
          cacheRead: turn.cacheRead,
          cacheWrite: turn.cacheWrite
        },
        turn.explicitCostUsd
      )

      totalTokens.input += turn.input
      totalTokens.output += turn.output
      totalTokens.reasoning += turn.reasoning
      totalTokens.cacheRead += turn.cacheRead
      totalTokens.cacheWrite += turn.cacheWrite
      totalTokens.total += turn.total
      totalTokens.costUsd += turnCost

      perAgentTurns[agent].push(
        turn.model ? turn : { ...turn, model: resolvedTurnModel }
      )

      if (turn.tps !== null && turn.durationSec !== null && turn.tps > 0) {
        totalGenOut += turn.output + turn.reasoning
        totalDurSec += turn.durationSec
        if (turn.tps > peakTps) peakTps = turn.tps
        if (ts >= latestTs) {
          latestTs = ts
          latestTps = turn.tps
        }
      }

      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i]
        if (ts >= b.startMs && ts < b.endMs) {
          b.totalTokens += turn.total
          b.costUsd = +(b.costUsd + turnCost).toFixed(6)
          b.byAgent[agent] += turn.total
          break
        }
      }
    }
  }

  totalTokens.costUsd = +totalTokens.costUsd.toFixed(6)
  const avgTps = totalDurSec > 0 ? +(totalGenOut / totalDurSec).toFixed(1) : 0

  const byAgent: AgentSummaryRow[] = ALL_AGENTS.map((agent) => {
    const sub = computeTurnSummary(agent, perAgentTurns[agent], pricing, perAgentFallbackModel[agent])
    const sharePercent =
      totalTokens.total > 0 ? +((sub.tokens.total / totalTokens.total) * 100).toFixed(1) : 0
    return {
      agent,
      providerLabel: providerLabelForAgent(agent, sub.topModel),
      sharePercent,
      tokens: sub.tokens,
      tps: sub.tps,
      topModel: sub.topModel
    }
  }).sort((a, b) => b.tokens.total - a.tokens.total)

  const deltaPercent =
    prevTotalTokens > 0
      ? +(((totalTokens.total - prevTotalTokens) / prevTotalTokens) * 100).toFixed(1)
      : null

  return {
    tokens: totalTokens,
    tps: {
      liveTps: +(latestTps || avgTps).toFixed(1),
      avgTps,
      peakTps: +peakTps.toFixed(1)
    },
    previousTotalTokens: prevTotalTokens > 0 ? prevTotalTokens : null,
    deltaPercent,
    buckets,
    byAgent
  }
}

export function buildDashboardSnapshot(
  rawSessions: SessionTranscriptState[],
  journal: JournalIndex,
  pricing: PricingEngine,
  runtime: WorkspaceRuntimeContext,
  now = Date.now()
): DashboardSnapshot {
  const indexedWorkspaces = indexKnownWorkspaces(runtime.knownWorkspaces ?? [])
  const enrichedAll = enrichSessions(rawSessions, journal, pricing, indexedWorkspaces)
  const userSessions = enrichedAll.filter((s) => !s.isSubagent)

  const focusedPathNorm = normalizeFsPath(runtime.focusedPath)
  const matchedFocusedWs =
    (runtime.focusedId
      ? indexedWorkspaces.find((w) => w.id === runtime.focusedId)
      : undefined) ??
    (focusedPathNorm
      ? indexedWorkspaces.find(
          (w) => focusedPathNorm === w.normPath || focusedPathNorm.startsWith(w.normPath + path.sep)
        )
      : undefined)

  const effectivePathNorm = matchedFocusedWs?.normPath ?? focusedPathNorm
  const effectiveProject =
    matchedFocusedWs?.project ||
    runtime.focusedProject ||
    (effectivePathNorm
      ? resolveProjectAndWorktree(effectivePathNorm, indexedWorkspaces, null).projectName
      : null)

  const effectiveName =
    matchedFocusedWs?.name ??
    runtime.focusedName ??
    (effectivePathNorm ? path.basename(effectivePathNorm) : null)

  const effectiveBranch = stripGitRefPrefix(matchedFocusedWs?.branch ?? runtime.focusedBranch)

  // 1. Focused Project + Worktree conversations (sorted newest to oldest, excluding subagent brains)
  const worktreeUserSessions = effectivePathNorm
    ? userSessions.filter((s) => isSameOrChildWorktreePath(s.workspacePath, effectivePathNorm))
    : userSessions

  // Focused Project + Worktree ALL sessions (including subagents) for accurate Day/Week/Month worktree spend
  const worktreeAllSessions = effectivePathNorm
    ? enrichedAll.filter((s) => isSameOrChildWorktreePath(s.workspacePath, effectivePathNorm))
    : enrichedAll

  const ptyBySessionKey = matchPtyTerminalsToSessions(userSessions, journal, runtime.liveAgents, now)

  const sessionsList: WorktreeSessionItem[] = [...worktreeUserSessions]
    .sort((a, b) => b.state.updatedAtMs - a.state.updatedAtMs)
    .slice(0, 80)
    .map((s) => {
      const sKey = `${s.state.agent}:${s.state.sessionId}`
      const jMeta = journal.byNativeId.get(s.state.sessionId)
      const matchedPty = ptyBySessionKey.get(sKey)
      const runState = resolveSessionRunState(
        s.state,
        jMeta,
        matchedPty?.state ?? null,
        now,
        matchedPty?.stateStartedAt ?? 0
      )
      const active = runState === 'working' || runState === 'waiting' || runState === 'blocked'
      return {
        sessionId: s.state.sessionId,
        agent: s.state.agent,
        providerLabel: s.providerLabel,
        modelLabel: s.modelLabel,
        title: s.title,
        projectName: s.projectName,
        workspaceName: s.workspaceName,
        workspacePath: s.workspacePath,
        updatedAt: s.state.updatedAtMs,
        createdAt: s.state.createdAtMs,
        active,
        tps: s.tps,
        tokens: s.tokens
      }
    })

  // 2. Live running / recently active agent cards
  const liveCards = buildLiveAgentCards({
    userSessions,
    journal,
    runtime,
    effectivePathNorm,
    effectiveProject,
    effectiveName,
    now
  })

  const liveTokens = emptyTokenBreakdown()
  let liveTpsSum = 0
  let workingTpsCount = 0
  let maxPeakTps = 0
  let fallbackAvgSum = 0
  let fallbackAvgCount = 0

  for (const c of liveCards) {
    liveTokens.input += c.tokens.input
    liveTokens.output += c.tokens.output
    liveTokens.reasoning += c.tokens.reasoning
    liveTokens.cacheRead += c.tokens.cacheRead
    liveTokens.cacheWrite += c.tokens.cacheWrite
    liveTokens.total += c.tokens.total
    liveTokens.costUsd += c.tokens.costUsd

    if (c.tps.peakTps > maxPeakTps) maxPeakTps = c.tps.peakTps
    if (c.state === 'working' && c.tps.liveTps > 0) {
      liveTpsSum += c.tps.liveTps
      workingTpsCount++
    }
    if (c.tps.avgTps > 0) {
      fallbackAvgSum += c.tps.avgTps
      fallbackAvgCount++
    }
  }
  liveTokens.costUsd = +liveTokens.costUsd.toFixed(6)

  const avgAcrossLive = fallbackAvgCount > 0 ? +(fallbackAvgSum / fallbackAvgCount).toFixed(1) : 0
  const headlineLiveTps =
    workingTpsCount > 0 ? +liveTpsSum.toFixed(1) : liveCards[0]?.tps.liveTps ?? avgAcrossLive

  // 3. Day / Week / Month periods for both 'all' and 'worktree' scopes
  const todayStart = startOfLocalDay(now).getTime()
  const yesterdayStart = todayStart - 86_400_000

  const buildScopePeriods = (scopeSessions: EnrichedSession[]) => {
    const dayBuckets = buildDayBuckets(now)
    const weekBuckets = buildMultiDayBuckets(now, 7)
    const monthBuckets = buildMultiDayBuckets(now, 30)

    const weekStart = weekBuckets[0].startMs
    const monthStart = monthBuckets[0].startMs

    return {
      day: aggregatePeriod(scopeSessions, dayBuckets, yesterdayStart, todayStart, pricing),
      week: aggregatePeriod(
        scopeSessions,
        weekBuckets,
        weekStart - 7 * 86_400_000,
        weekStart,
        pricing
      ),
      month: aggregatePeriod(
        scopeSessions,
        monthBuckets,
        monthStart - 30 * 86_400_000,
        monthStart,
        pricing
      )
    }
  }

  return {
    generatedAt: now,
    workspace: {
      id: matchedFocusedWs?.id ?? runtime.focusedId ?? null,
      project: effectiveProject,
      name: effectiveName,
      branch: effectiveBranch,
      path: effectivePathNorm ?? runtime.focusedPath
    },
    pricing: pricing.getStatus(),
    live: {
      tokens: liveTokens,
      tps: {
        liveTps: +headlineLiveTps.toFixed(1),
        avgTps: avgAcrossLive,
        peakTps: +maxPeakTps.toFixed(1)
      },
      agents: liveCards
    },
    sessions: sessionsList,
    periods: {
      all: buildScopePeriods(enrichedAll),
      worktree: buildScopePeriods(worktreeAllSessions)
    }
  }
}

export const LIVE_SERIES_SECONDS = 60

export function resolveSessionRunState(
  st: SessionTranscriptState,
  jMeta: import('./journal').JournalSessionMeta | undefined,
  ptyState: AgentRunState | null,
  now: number,
  ptyStateStartedAt = 0
): AgentRunState {
  if (ptyState === 'blocked') return 'blocked'
  const lastTouchMs = Math.max(st.updatedAtMs || 0, st.lastMtimeMs || 0)

  if (jMeta) {
    if (jMeta.isTurnOpen) {
      // Guard against orphaned `open` turn if transcript already recorded final DONE after turn opened
      if (
        st.lastEventState === 'done' &&
        (jMeta.turnUpdatedAt ?? 0) > 0 &&
        st.updatedAtMs > (jMeta.turnUpdatedAt ?? 0) + 2_000 &&
        now - lastTouchMs > 60_000
      ) {
        return 'done'
      }
      return st.lastEventState === 'waiting' ? 'waiting' : 'working'
    }
    if (jMeta.lastTurnState === 'settled' || st.lastEventState === 'done') {
      return 'done'
    }
    if (st.lastEventState === 'waiting' && now - lastTouchMs <= 30 * 60_000) {
      return 'waiting'
    }
    if (st.lastEventState === 'working' && now - lastTouchMs <= 45_000) {
      return 'working'
    }
    return 'done'
  }

  // CLI session (non-journal)
  if (ptyState === 'working') {
    // If transcript explicitly finished (`done`) after `ptyStateStartedAt` (or has had no writes for >45s), it is already done
    if (
      st.lastEventState === 'done' &&
      ((ptyStateStartedAt > 0 && st.updatedAtMs >= ptyStateStartedAt + 500) ||
        (now - lastTouchMs > 45_000 &&
          (ptyStateStartedAt <= 0 || ptyStateStartedAt <= st.updatedAtMs + 2_000)))
    ) {
      return 'done'
    }
    return st.lastEventState === 'waiting' ? 'waiting' : 'working'
  }
  if (
    st.lastEventState === 'waiting' &&
    ptyState !== 'done' &&
    now - lastTouchMs <= 30 * 60_000
  ) {
    return 'waiting'
  }
  if (st.lastEventState === 'done') {
    return 'done'
  }
  if (ptyState === 'waiting' && (st.lastEventState === null || st.turnsByKey.size === 0)) {
    return 'waiting'
  }
  if (st.lastEventState === 'working' && now - lastTouchMs <= 90_000) {
    return 'working'
  }
  return 'done'
}

function isRealPtyAgentEntry(la: OrcaLiveAgentInfo, hasJournalRecords: boolean): boolean {
  const tid = typeof la.terminalId === 'string' ? la.terminalId.trim() : ''
  if (!tid) {
    // Orca reports Structured Native Chat agents in `agents.list` with `terminalId: null`;
    // those are authoritatively tracked by exact UUID in `agent-session-journal.db`.
    return !hasJournalRecords
  }
  if (tid.startsWith('structured-agent-session-')) return false
  return true
}

function canBindPtyToCliSession(
  s: EnrichedSession,
  la: OrcaLiveAgentInfo,
  mappedKind: AgentKind | null,
  termWsPath: string | null,
  journal: JournalIndex,
  now: number
): boolean {
  if (journal.byNativeId.has(s.state.sessionId)) return false
  if (s.state.agent === 'antigravity' && s.state.filePath.includes('antigravity-acp')) {
    return false
  }
  if (mappedKind && s.state.agent !== mappedKind) return false
  if (termWsPath) {
    if (
      !s.workspacePath ||
      (!isSameOrChildWorktreePath(s.workspacePath, termWsPath) &&
        !isSameOrChildWorktreePath(termWsPath, s.workspacePath))
    ) {
      return false
    }
  }
  const lastTouchMs = Math.max(s.state.updatedAtMs || 0, s.state.lastMtimeMs || 0)
  // Never bind an active `working` PTY onto an old CLI transcript that already finished >60s ago
  if (la.state === 'working' && s.state.lastEventState === 'done' && now - lastTouchMs > 60_000) {
    return false
  }
  // If `terminalId` had no workspace path (e.g. synthetic ID), require recent activity within 15m
  if (!termWsPath && now - lastTouchMs > 15 * 60_000) {
    return false
  }
  return lastTouchMs >= now - 6 * 3600_000
}

function matchPtyTerminalsToSessions(
  userSessions: EnrichedSession[],
  journal: JournalIndex,
  liveAgents: OrcaLiveAgentInfo[],
  now: number
): Map<string, OrcaLiveAgentInfo> {
  const recentLiveCutoffMs = now - 15 * 60_000
  const hasJournalRecords = journal.byNativeId.size > 0
  const sortedByRecent = [...userSessions].sort(
    (a, b) => b.state.updatedAtMs - a.state.updatedAtMs
  )
  const claimed = new Set<string>()
  const out = new Map<string, OrcaLiveAgentInfo>()

  for (const la of liveAgents) {
    if (!isRealPtyAgentEntry(la, hasJournalRecords)) continue
    if (la.state === 'done' && la.stateStartedAt > 0 && la.stateStartedAt < recentLiveCutoffMs) {
      continue
    }
    const mappedKind = mapOrcaAgentKind(la.agent)
    const termWsPath = extractWorkspacePathFromId(la.terminalId)
    const matched = sortedByRecent.find((s) => {
      const sKey = `${s.state.agent}:${s.state.sessionId}`
      if (claimed.has(sKey)) return false
      return canBindPtyToCliSession(s, la, mappedKind, termWsPath, journal, now)
    })
    if (matched) {
      const sKey = `${matched.state.agent}:${matched.state.sessionId}`
      claimed.add(sKey)
      out.set(sKey, la)
    }
  }
  return out
}

export function compute60sIoSeries(
  turns: Iterable<ParsedTurnUsage>,
  isWorking: boolean,
  now: number,
  activeTurnStartMs?: number | null
): {
  outSeries: number[]
  inSeries: number[]
  seriesEndSec: number
  liveOutRate: number
  liveInRate: number
} {
  const outRaw = new Float64Array(LIVE_SERIES_SECONDS)
  const inRaw = new Float64Array(LIVE_SERIES_SECONDS)
  const safeNow = Number.isFinite(now) && now > 0 ? now : Date.now()
  const endSec = Math.floor(safeNow / 1000)
  const startSec = endSec - (LIVE_SERIES_SECONDS - 1)

  const addGaussianBell = (
    arr: Float64Array,
    centerSec: number,
    sigmaSec: number,
    totalTokens: number
  ): void => {
    if (!(totalTokens > 0) || !Number.isFinite(totalTokens)) return
    const sigma = Math.max(0.85, sigmaSec)
    const radius = Math.ceil(sigma * 3.8)
    const firstSec = Math.floor(centerSec) - radius
    const lastSec = Math.ceil(centerSec) + radius
    if (lastSec < startSec || firstSec > endSec) return

    const count = lastSec - firstSec + 1
    const weights = new Float64Array(count)
    let weightSum = 0
    const invTwoVar = 0.5 / (sigma * sigma)
    for (let k = 0; k < count; k++) {
      const secMid = firstSec + k + 0.5
      const d = secMid - centerSec
      const w = Math.exp(-d * d * invTwoVar)
      weights[k] = w
      weightSum += w
    }
    if (!(weightSum > 0)) return

    const scale = totalTokens / weightSum
    const clipStart = Math.max(startSec, firstSec)
    const clipEnd = Math.min(endSec, lastSec)
    for (let s = clipStart; s <= clipEnd; s++) {
      arr[s - startSec] += weights[s - firstSec] * scale
    }
  }

  const addSmoothStreamWave = (
    arr: Float64Array,
    spanStartMs: number,
    spanEndMs: number,
    totalTokens: number
  ): void => {
    if (!(totalTokens > 0) || !Number.isFinite(totalTokens)) return
    const sMs = Math.min(spanStartMs, spanEndMs)
    const eMs = Math.max(sMs + 400, Math.max(spanStartMs, spanEndMs))
    const durSec = (eMs - sMs) / 1000
    const startS = sMs / 1000
    const endS = eMs / 1000

    // Short turns (< 2.8s): single silky Gaussian bell peak
    if (durSec <= 2.8) {
      const center = (startS + endS) * 0.5
      const sigma = Math.max(1.05, durSec * 0.48)
      addGaussianBell(arr, center, sigma, totalTokens)
      return
    }

    // Longer streaming turns: world-time-invariant overlapping Gaussian wavelets
    // Eliminates flat-topped square-wave plateaus while conserving 100% of tokens
    const numPulses = Math.max(2, Math.min(48, Math.round(durSec / 1.75)))
    const margin = Math.min(1.15, durSec * 0.2)
    const innerSpan = Math.max(0.2, durSec - margin * 2)
    const step = numPulses > 1 ? innerSpan / (numPulses - 1) : 0
    const sigma = Math.max(1.15, Math.min(1.75, Math.max(step * 0.88, 1.15)))
    const radius = Math.ceil(sigma * 3.6)

    const firstSec = Math.floor(startS) - radius
    const lastSec = Math.ceil(endS) + radius
    if (lastSec < startSec || firstSec > endSec) return

    const phase = (Math.abs(Math.floor(sMs / 100)) % 628) / 100
    const centers = new Float64Array(numPulses)
    const amps = new Float64Array(numPulses)
    for (let m = 0; m < numPulses; m++) {
      centers[m] = startS + margin + (numPulses > 1 ? m * step : innerSpan * 0.5)
      const arch = Math.pow(Math.sin((Math.PI * (m + 0.75)) / (numPulses + 0.5)), 0.58)
      const cadence = 1 + 0.19 * Math.sin(m * 2.13 + phase) + 0.1 * Math.cos(m * 3.37 - phase)
      amps[m] = Math.max(0.2, arch * cadence)
    }

    const count = lastSec - firstSec + 1
    const weights = new Float64Array(count)
    const invTwoVar = 0.5 / (sigma * sigma)
    let weightSum = 0

    for (let k = 0; k < count; k++) {
      const secMid = firstSec + k + 0.5
      let w = 0
      for (let m = 0; m < numPulses; m++) {
        const d = secMid - centers[m]
        if (Math.abs(d) <= sigma * 3.8) {
          w += amps[m] * Math.exp(-d * d * invTwoVar)
        }
      }
      weights[k] = w
      weightSum += w
    }
    if (!(weightSum > 0)) return

    const scale = totalTokens / weightSum
    const clipStart = Math.max(startSec, firstSec)
    const clipEnd = Math.min(endSec, lastSec)
    for (let s = clipStart; s <= clipEnd; s++) {
      arr[s - startSec] += weights[s - firstSec] * scale
    }
  }

  // Sort valid turns by completion timestamp (purely turn-dependent for strict world-time invariance)
  const turnList: ParsedTurnUsage[] = []
  for (const t of turns) {
    if (Number.isFinite(t.timestampMs) && t.timestampMs > 0) {
      turnList.push(t)
    }
  }
  turnList.sort((a, b) => a.timestampMs - b.timestampMs)

  // Include turns whose trailing Gaussian tail still overlaps `[startSec .. endSec]`
  const relevanceCutoffMs = (startSec - 6) * 1000

  for (const turn of turnList) {
    const ts = turn.timestampMs
    const durMs =
      turn.durationSec !== null && Number.isFinite(turn.durationSec) && turn.durationSec > 0
        ? Math.min(turn.durationSec, 120) * 1000
        : 1200
    const turnEndMs = ts
    const turnStartMs = turnEndMs - Math.max(400, durMs)
    if (turnEndMs < relevanceCutoffMs) continue

    const outTokens = Math.max(0, (turn.output || 0) + (turn.reasoning || 0))
    if (outTokens > 0) {
      addSmoothStreamWave(outRaw, turnStartMs, turnEndMs, outTokens)
    }

    const inTokens = Math.max(
      0,
      (turn.input || 0) + (turn.cacheRead || 0) + (turn.cacheWrite || 0)
    )
    if (inTokens > 0) {
      addSmoothStreamWave(inRaw, turnStartMs, turnEndMs, inTokens)
    }
  }

  const latestTurnEndMs = turnList.length > 0 ? turnList[turnList.length - 1].timestampMs : 0

  // World-time-invariant in-flight active-turn stream bridge while `isWorking === true`:
  // Bridges multi-second LLM/tool inference gaps between JSONL step flushes using ONLY integer second `s`
  // and session turn data (zero dependence on `now`), so 60fps scrolling never jumps and 1s readouts breathe live.
  if (isWorking) {
    const recentSlice = turnList.slice(-3)
    let recentOutSum = 0
    let recentInSum = 0
    let recentDurSum = 0
    for (const rt of recentSlice) {
      const dSec =
        rt.durationSec !== null && Number.isFinite(rt.durationSec) && rt.durationSec > 0
          ? Math.min(rt.durationSec, 120)
          : 2.4
      recentOutSum += Math.max(0, (rt.output || 0) + (rt.reasoning || 0))
      recentInSum += Math.max(0, (rt.input || 0) + (rt.cacheRead || 0) + (rt.cacheWrite || 0))
      recentDurSum += Math.max(0.8, dSec)
    }

    const baseOutRate =
      recentDurSum > 0 && recentOutSum > 0
        ? Math.min(800, Math.max(4, recentOutSum / recentDurSum))
        : 26
    const baseInRate =
      recentDurSum > 0 && recentInSum > 0
        ? Math.min(250_000, Math.max(120, recentInSum / recentDurSum))
        : 1400

    const startHintMs =
      typeof activeTurnStartMs === 'number' &&
      Number.isFinite(activeTurnStartMs) &&
      activeTurnStartMs > 0
        ? activeTurnStartMs
        : 0
    const anchorMs = Math.max(latestTurnEndMs, startHintMs)

    if (anchorMs > 0) {
      const anchorSec = Math.floor(anchorMs / 1000)
      const phase = (Math.abs(anchorSec) % 628) / 100
      const fillFrom = Math.max(startSec, anchorSec)
      for (let s = fillFrom; s <= endSec; s++) {
        const elapsed = s - anchorSec
        const ramp = Math.min(1, (elapsed + 1) / 2.0)
        const taper = elapsed <= 32 ? 1 : Math.exp(-(elapsed - 32) / 24)
        const env = ramp * taper
        if (env <= 0.01) continue

        const waveOut =
          0.86 + 0.16 * Math.sin(s * 1.23 + phase) + 0.08 * Math.cos(s * 0.71 - phase)
        const waveIn =
          0.82 + 0.2 * Math.sin(s * 0.97 + phase + 1.15) + 0.09 * Math.cos(s * 1.61 + phase)

        const idx = s - startSec
        const projOut = baseOutRate * env * Math.max(0.35, waveOut)
        const projIn = baseInRate * env * Math.max(0.35, waveIn)
        if (projOut > outRaw[idx]) outRaw[idx] = projOut
        if (projIn > inRaw[idx]) inRaw[idx] = projIn
      }
    }
  }

  const outSeries = Array.from(outRaw, (v) =>
    +(Number.isFinite(v) && v > 0.04 ? v : 0).toFixed(1)
  )
  const inSeries = Array.from(inRaw, (v) =>
    +(Number.isFinite(v) && v > 0.04 ? v : 0).toFixed(1)
  )

  // Sample at the visible right-edge playhead (`endSec - 1`..`endSec`) when working;
  // settle cleanly to `0` once stopped (`!isWorking`) after completion tail finishes
  const stoppedAndSettled = !isWorking && (latestTurnEndMs <= 0 || safeNow - latestTurnEndMs > 2500)

  const liveOutRate = stoppedAndSettled
    ? 0
    : +(
        (outSeries[LIVE_SERIES_SECONDS - 2] ?? 0) * 0.65 +
        (outSeries[LIVE_SERIES_SECONDS - 1] ?? 0) * 0.35
      ).toFixed(1)

  const liveInRate = stoppedAndSettled
    ? 0
    : +(
        (inSeries[LIVE_SERIES_SECONDS - 2] ?? 0) * 0.65 +
        (inSeries[LIVE_SERIES_SECONDS - 1] ?? 0) * 0.35
      ).toFixed(1)

  return { outSeries, inSeries, seriesEndSec: endSec, liveOutRate, liveInRate }
}

const STATE_SORT_WEIGHT: Record<AgentRunState, number> = {
  working: 0,
  blocked: 1,
  waiting: 2,
  done: 3
}

function computeActiveTurnStartHint(
  st: SessionTranscriptState,
  jMeta: import('./journal').JournalSessionMeta | undefined,
  ptyInfo?: OrcaLiveAgentInfo | null
): number {
  return Math.max(
    st.lastInferenceStartMs ?? 0,
    st.updatedAtMs ?? 0,
    jMeta?.isTurnOpen ? (jMeta.turnUpdatedAt ?? 0) : 0,
    ptyInfo?.state === 'working' ? (ptyInfo.stateStartedAt ?? 0) : 0
  )
}

function buildLiveAgentCards(params: {
  userSessions: EnrichedSession[]
  journal: JournalIndex
  runtime: WorkspaceRuntimeContext
  effectivePathNorm: string | null
  effectiveProject: string | null
  effectiveName: string | null
  now: number
}): LiveAgentCard[] {
  const {
    userSessions,
    journal,
    runtime,
    effectivePathNorm,
    effectiveProject,
    effectiveName,
    now
  } = params
  const recentLiveCutoffMs = now - 15 * 60_000
  const sortedByRecent = [...userSessions].sort(
    (a, b) => b.state.updatedAtMs - a.state.updatedAtMs
  )
  const claimedSessionKeys = new Set<string>()
  const cards: LiveAgentCard[] = []

  const indexedWorkspaces = indexKnownWorkspaces(runtime.knownWorkspaces ?? [])
  const homeNorm = normalizeFsPath(os.homedir())
  const nowEndSec = Math.floor((Number.isFinite(now) && now > 0 ? now : Date.now()) / 1000)
  const hasJournalRecords = journal.byNativeId.size > 0

  for (let idx = 0; idx < runtime.liveAgents.length; idx++) {
    const la = runtime.liveAgents[idx]
    if (!isRealPtyAgentEntry(la, hasJournalRecords)) {
      continue
    }
    // Filter out stale `done` terminals older than 15 minutes
    if (
      la.state === 'done' &&
      la.stateStartedAt > 0 &&
      la.stateStartedAt < recentLiveCutoffMs
    ) {
      continue
    }

    const mappedKind = mapOrcaAgentKind(la.agent)
    const termWsPath = extractWorkspacePathFromId(la.terminalId)
    const ptyCustomTitle = la.terminalId ? journal.ptyCustomTitles?.get(la.terminalId) : undefined

    const matchedSession = sortedByRecent.find((s) => {
      const sKey = `${s.state.agent}:${s.state.sessionId}`
      if (claimedSessionKeys.has(sKey)) return false
      return canBindPtyToCliSession(s, la, mappedKind, termWsPath, journal, now)
    })

    if (matchedSession) {
      const sKey = `${matchedSession.state.agent}:${matchedSession.state.sessionId}`
      claimedSessionKeys.add(sKey)
      const resolvedState = resolveSessionRunState(
        matchedSession.state,
        undefined,
        la.state,
        now,
        la.stateStartedAt || 0
      )
      const isWorking = resolvedState === 'working'
      const activeStartHint = computeActiveTurnStartHint(matchedSession.state, undefined, la)
      const io = compute60sIoSeries(
        matchedSession.state.turnsByKey.values(),
        isWorking,
        now,
        activeStartHint
      )
      const cardTps =
        isWorking && io.liveOutRate > 0
          ? {
              ...matchedSession.tps,
              liveTps: io.liveOutRate,
              peakTps: Math.max(matchedSession.tps.peakTps, io.liveOutRate)
            }
          : matchedSession.tps
      cards.push({
        id: la.terminalId || sKey,
        sessionKey: sKey,
        agent: matchedSession.state.agent,
        providerLabel: matchedSession.providerLabel,
        modelLabel: matchedSession.modelLabel,
        state: resolvedState,
        title: ptyCustomTitle || matchedSession.title,
        projectName: matchedSession.projectName,
        workspaceName: matchedSession.workspaceName,
        workspacePath: matchedSession.workspacePath,
        updatedAt: Math.max(matchedSession.state.updatedAtMs, la.stateStartedAt || 0),
        tps: cardTps,
        sparkline: matchedSession.sparkline,
        outSeries: io.outSeries,
        inSeries: io.inSeries,
        seriesEndSec: io.seriesEndSec,
        liveOutRate: io.liveOutRate,
        liveInRate: io.liveInRate,
        tokens: matchedSession.tokens
      })
    } else if (mappedKind && la.state !== 'done' && la.terminalId) {
      const fallbackModel =
        journal.cliConfiguredModels?.[mappedKind] || DEFAULT_MODEL_DISPLAY[mappedKind]
      const resolvedWs = resolveProjectAndWorktree(
        termWsPath ?? effectivePathNorm,
        indexedWorkspaces,
        homeNorm
      )
      const fallbackKey = `terminal:${la.terminalId || idx}`
      const isWorking = la.state === 'working'
      const io = compute60sIoSeries(
        [],
        isWorking,
        now,
        isWorking && la.stateStartedAt > 0 ? la.stateStartedAt : 0
      )
      cards.push({
        id: la.terminalId || fallbackKey,
        sessionKey: fallbackKey,
        agent: mappedKind,
        providerLabel: providerLabelForAgent(mappedKind, fallbackModel),
        modelLabel: fallbackModel,
        state: la.state,
        title: ptyCustomTitle || la.title?.trim() || `${mappedKind} session`,
        projectName: resolvedWs.projectName ?? effectiveProject,
        workspaceName:
          resolvedWs.workspaceName !== 'local'
            ? resolvedWs.workspaceName
            : effectiveName || 'local',
        workspacePath: termWsPath ?? effectivePathNorm,
        updatedAt: la.stateStartedAt || now,
        tps:
          isWorking && io.liveOutRate > 0
            ? { liveTps: io.liveOutRate, avgTps: io.liveOutRate, peakTps: io.liveOutRate }
            : emptyTpsStats(),
        sparkline: [],
        outSeries: io.outSeries,
        inSeries: io.inSeries,
        seriesEndSec: nowEndSec,
        liveOutRate: io.liveOutRate,
        liveInRate: io.liveInRate,
        tokens: emptyTokenBreakdown()
      })
    }
  }

  for (const s of sortedByRecent) {
    const sKey = `${s.state.agent}:${s.state.sessionId}`
    if (claimedSessionKeys.has(sKey)) continue
    const jMeta = journal.byNativeId.get(s.state.sessionId)
    if (s.tokens.total <= 0 && !jMeta?.isTurnOpen) continue
    const isRecentlyActive =
      Boolean(jMeta?.isTurnOpen) ||
      Boolean(jMeta?.isLiveLease) ||
      s.state.updatedAtMs >= recentLiveCutoffMs
    if (!isRecentlyActive) continue

    claimedSessionKeys.add(sKey)
    const state = resolveSessionRunState(s.state, jMeta, null, now)
    const isWorking = state === 'working'
    const activeStartHint = computeActiveTurnStartHint(s.state, jMeta, null)
    const io = compute60sIoSeries(s.state.turnsByKey.values(), isWorking, now, activeStartHint)
    const cardTps =
      isWorking && io.liveOutRate > 0
        ? {
            ...s.tps,
            liveTps: io.liveOutRate,
            peakTps: Math.max(s.tps.peakTps, io.liveOutRate)
          }
        : s.tps
    cards.push({
      id: sKey,
      sessionKey: sKey,
      agent: s.state.agent,
      providerLabel: s.providerLabel,
      modelLabel: s.modelLabel,
      state,
      title: s.title,
      projectName: s.projectName,
      workspaceName: s.workspaceName,
      workspacePath: s.workspacePath,
      updatedAt: s.state.updatedAtMs,
      tps: cardTps,
      sparkline: s.sparkline,
      outSeries: io.outSeries,
      inSeries: io.inSeries,
      seriesEndSec: io.seriesEndSec,
      liveOutRate: io.liveOutRate,
      liveInRate: io.liveInRate,
      tokens: s.tokens
    })
  }

  cards.sort((a, b) => {
    const sw = STATE_SORT_WEIGHT[a.state] - STATE_SORT_WEIGHT[b.state]
    if (sw !== 0) return sw
    const aFocused =
      effectivePathNorm && a.workspacePath
        ? isSameOrChildWorktreePath(a.workspacePath, effectivePathNorm)
        : false
    const bFocused =
      effectivePathNorm && b.workspacePath
        ? isSameOrChildWorktreePath(b.workspacePath, effectivePathNorm)
        : false
    if (aFocused !== bFocused) return aFocused ? -1 : 1
    return b.updatedAt - a.updatedAt
  })

  return cards.slice(0, 12)
}

export function pollSingleLiveAgent(
  sessionKey: string,
  rawSessions: SessionTranscriptState[],
  journal: JournalIndex,
  pricing: PricingEngine,
  runtime: WorkspaceRuntimeContext,
  now = Date.now()
): LiveAgentCard | null {
  if (!sessionKey || typeof sessionKey !== 'string') return null
  const recentCutoff = now - 6 * 3600_000
  const hotRaw = rawSessions.filter(
    (st) =>
      st.updatedAtMs >= recentCutoff ||
      `${st.agent}:${st.sessionId}` === sessionKey ||
      st.sessionId === sessionKey
  )
  const indexedWorkspaces = indexKnownWorkspaces(runtime.knownWorkspaces ?? [])
  const enrichedAll = enrichSessions(hotRaw, journal, pricing, indexedWorkspaces)
  const userSessions = enrichedAll.filter((s) => !s.isSubagent)
  const focusedPathNorm = normalizeFsPath(runtime.focusedPath)

  const liveCards = buildLiveAgentCards({
    userSessions,
    journal,
    runtime,
    effectivePathNorm: focusedPathNorm,
    effectiveProject: runtime.focusedProject ?? null,
    effectiveName: runtime.focusedName ?? null,
    now
  })

  const hit = liveCards.find((c) => c.sessionKey === sessionKey || c.id === sessionKey)
  if (hit) return hit

  // Fallback if user keeps an agent detail view open after 15m idle cutoff
  const fallback = enrichedAll.find(
    (s) => `${s.state.agent}:${s.state.sessionId}` === sessionKey || s.state.sessionId === sessionKey
  )
  if (!fallback) return null

  const jMeta = journal.byNativeId.get(fallback.state.sessionId)
  const state = resolveSessionRunState(fallback.state, jMeta, null, now)
  const isWorking = state === 'working'
  const activeStartHint = computeActiveTurnStartHint(fallback.state, jMeta, null)
  const io = compute60sIoSeries(
    fallback.state.turnsByKey.values(),
    isWorking,
    now,
    activeStartHint
  )
  const sKey = `${fallback.state.agent}:${fallback.state.sessionId}`
  return {
    id: sKey,
    sessionKey: sKey,
    agent: fallback.state.agent,
    providerLabel: fallback.providerLabel,
    modelLabel: fallback.modelLabel,
    state,
    title: fallback.title,
    projectName: fallback.projectName,
    workspaceName: fallback.workspaceName,
    workspacePath: fallback.workspacePath,
    updatedAt: fallback.state.updatedAtMs,
    tps: fallback.tps,
    sparkline: fallback.sparkline,
    outSeries: io.outSeries,
    inSeries: io.inSeries,
    seriesEndSec: io.seriesEndSec,
    liveOutRate: io.liveOutRate,
    liveInRate: io.liveInRate,
    tokens: fallback.tokens
  }
}
