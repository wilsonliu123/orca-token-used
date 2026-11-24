import path from 'node:path'
import type { HostResult } from 'orca/host'
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import {
  ALL_AGENTS,
  buildDashboardSnapshot,
  type KnownOrcaWorkspace,
  liveAgentKind,
  mapOrcaAgentKind,
  type OrcaLiveAgentInfo,
  pollSingleLiveAgent,
  stripGitRefPrefix,
  type WorkspaceRuntimeContext
} from './aggregator'
import { cleanConversationTitle, inferAgentFromTerminalTitle, isGenericTerminalTabLabel, type JournalIndex } from './journal'
import { parseOrcaTabTitles, runOrcaJson } from './orca-cli'
import { formatTokens, formatUsd, getMessages } from './panel/i18n'
import type { SessionTranscriptState } from './parsers'
import { PRICING_STORAGE_KEY, PricingEngine } from './pricing'
import type { AgentKind, DashboardSnapshot, QuotasSnapshot, ScopeMode, ViewTab } from './protocol'
import { QUOTAS_STORAGE_KEY, QuotaEngine } from './quotas'
import { HISTORICAL_CACHE_STORAGE_KEY, TranscriptScanner } from './scanner'

const LOCALE_STORAGE_KEY = 'lastLocale.v1'
const VALID_TABS: readonly ViewTab[] = ['live', 'sessions', 'day', 'week', 'month', 'quotas']

let activeCleanup: (() => Promise<void>) | null = null

type ReadContextResult = HostResult<'workspace.readContext'>
type HistoryRow = HostResult<'agent.listSessions'>['sessions'][number]
type WorkspaceRow = KnownOrcaWorkspace & { hostId: string | null; mayRunAgents: boolean }

function isLocalWorkspace(workspace: WorkspaceRow): boolean {
  return !workspace.hostId || workspace.hostId === 'local'
}

function liveAgentKey(agent: OrcaLiveAgentInfo): string {
  if (agent.terminalId) return `terminal:${agent.terminalId}`
  return `session:${agent.workspaceId ?? ''}:${mapOrcaAgentKind(agent.agent) ?? ''}:${agent.sessionId ?? ''}`
}

function setHistoryRow(rows: Map<string, HistoryRow>, row: HistoryRow, disabled: ReadonlySet<AgentKind>): void {
  const provider = mapOrcaAgentKind(row.agent)
  if (!provider || disabled.has(provider) || !row.sessionId || row.hostId !== 'local') return
  const key = `${provider}:${row.sessionId}`
  if (!rows.has(key) || (rows.get(key)?.updatedAt ?? 0) <= row.updatedAt) rows.set(key, row)
}

const AGENT_ENABLE_SETTING: ReadonlyArray<readonly [AgentKind, string]> = [
  ['claude', 'enableClaude'],
  ['codex', 'enableCodex'],
  ['antigravity', 'enableAntigravity'],
  ['gemini', 'enableGemini']
]

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const disposables: Disposable[] = []
  const pricing = new PricingEngine()
  const quotas = new QuotaEngine()
  const scanner = new TranscriptScanner()

  let pricingSyncHours = 6
  let livePollSeconds = 2
  let dailyBudgetUsd = 0
  let quotaAlertPercent = 85
  let disabledAgents = new Set<AgentKind>()
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pricingTimer: ReturnType<typeof setInterval> | null = null
  let quotaTimer: ReturnType<typeof setInterval> | null = null
  let statusDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let refreshInFlight: Promise<DashboardSnapshot> | null = null
  let latestSnapshot: DashboardSnapshot | null = null
  let lastScannedSessions: SessionTranscriptState[] = []
  let lastHistPersistMs = 0
  let currentLocale = 'zh-TW'
  let activePanelTab: ViewTab = 'live'
  let activePanelScope: ScopeMode = 'all'
  let activeLiveAgentKey: string | null = null

  let lastReadContext: ReadContextResult = null
  let contextRevision = 0
  let contextFromEvent = false
  let historyRows = new Map<string, HistoryRow>()
  let historyRequest: AbortController | null = null
  let lastHistoryRequestMs = 0
  let historyDone: Promise<void> = Promise.resolve()

  const runtime: WorkspaceRuntimeContext = {
    focusedId: null,
    focusedProject: null,
    focusedName: null,
    focusedBranch: null,
    focusedPath: null,
    knownWorkspaces: [],
    liveAgents: []
  }

  const tabTitlesByWorkspace = new Map<string, { expiresAt: number; titles: Promise<Map<string, string>> }>()
  const tabTitlesAbort = new AbortController()
  function readTabTitles(workspace: WorkspaceRow): Promise<Map<string, string>> {
    const cached = tabTitlesByWorkspace.get(workspace.id)
    const now = Date.now()
    if (cached && cached.expiresAt > now) return cached.titles
    // Host terminal titles describe the pane. Orca's public layout also exposes the tab label.
    const titles = runOrcaJson([
      'terminal', 'list', '--environment', 'local', '--worktree', `path:${workspace.path}`,
      '--include-visual-layouts', '--limit', '50', '--json'
    ], tabTitlesAbort.signal, 1000).then(parseOrcaTabTitles).catch(() => new Map<string, string>())
    tabTitlesByWorkspace.set(workspace.id, { expiresAt: now + 15_000, titles })
    return titles
  }

  let workspaceListCache: WorkspaceRow[] = []
  let lastWorkspaceListMs = 0

  function isLiveAgentDisabled(agent: OrcaLiveAgentInfo): boolean {
    const kind = liveAgentKind(agent)
    return kind !== null && disabledAgents.has(kind)
  }

  async function loadSettings(): Promise<void> {
    try {
      const all = await orca.settings.get()
      const syncH = Number(all.pricingSyncHours)
      if (Number.isFinite(syncH) && syncH >= 1 && syncH <= 24) {
        pricingSyncHours = Math.round(syncH)
      }
      const pollS = Number(all.livePollSeconds)
      if (Number.isFinite(pollS) && pollS >= 1 && pollS <= 10) {
        livePollSeconds = Math.round(pollS)
      }
      const budget = Number(all.dailyBudgetUsd)
      if (Number.isFinite(budget) && budget >= 0 && budget <= 10000) {
        dailyBudgetUsd = budget
      }
      const quotaPct = Number(all.quotaAlertPercent)
      if (Number.isFinite(quotaPct) && quotaPct >= 0 && quotaPct <= 100) {
        quotaAlertPercent = Math.round(quotaPct)
      }
      const disabled = new Set<AgentKind>()
      for (const [agent, key] of AGENT_ENABLE_SETTING) {
        if (all[key] === false) disabled.add(agent)
      }
      disabledAgents = disabled
      runtime.disabledAgents = disabled
      scanner.setDisabledAgents(disabled)
      quotas.setDisabledProviders(
        [...disabled].filter((a): a is 'claude' | 'codex' | 'antigravity' => a === 'claude' || a === 'codex' || a === 'antigravity')
      )
    } catch {
      // Use defaults if settings:own unavailable
    }
  }

  function resolveFocusedWorkspace(): void {
    const ctx = lastReadContext
    const branch = stripGitRefPrefix(ctx?.branch)
    const candidates = ctx && !ctx.workspaceId
      ? workspaceListCache.filter((w) => w.name === ctx.displayName && stripGitRefPrefix(w.branch) === branch)
      : []
    const workspace = ctx?.workspaceId
      ? workspaceListCache.find((w) => w.id === ctx.workspaceId && isLocalWorkspace(w))
      : candidates.length === 1 && isLocalWorkspace(candidates[0]) ? candidates[0] : undefined
    runtime.focusedId = workspace?.id ?? ctx?.workspaceId ?? null
    runtime.focusedProject = workspace?.project ?? null
    runtime.focusedName = workspace?.name ?? ctx?.displayName ?? null
    runtime.focusedBranch = stripGitRefPrefix(workspace?.branch) ?? branch
    runtime.focusedPath = workspace?.path ?? null
  }

  async function refreshWorkspaces(): Promise<void> {
    if (!orca.host.has('workspace.list')) return
    const result = await orca.host.call('workspace.list', { includeStatus: true })
    const next = new Map(result.truncated ? workspaceListCache.map((w) => [w.id, w]) : [])
    for (const w of result.workspaces) {
      next.set(w.id, {
        id: w.id,
        name: w.name,
        branch: w.branch,
        path: w.path,
        project: w.project || path.basename(w.path),
        hostId: w.hostId,
        mayRunAgents: Boolean(w.status && (
          w.status.terminalCount > 0 ||
          w.status.state === 'working' || w.status.state === 'permission' || w.status.state === 'active'
        ))
      })
    }
    const removedIds = new Set(workspaceListCache.filter((w) => !next.has(w.id)).map((w) => w.id))
    workspaceListCache = [...next.values()]
    runtime.knownWorkspaces = workspaceListCache.filter(isLocalWorkspace)
    scanner.setKnownWorkspacePaths(runtime.knownWorkspaces.map((w) => w.path))
    const remoteIds = new Set(workspaceListCache.filter((w) => !isLocalWorkspace(w)).map((w) => w.id))
    runtime.liveAgents = runtime.liveAgents.filter((a) =>
      !a.workspaceId || (!remoteIds.has(a.workspaceId) && !removedIds.has(a.workspaceId))
    )
  }

  async function refreshWorkspaceAndAgents(forceList = false): Promise<void> {
    const now = Date.now()
    const refreshRoster = forceList || now - lastWorkspaceListMs >= 15_000
    if (refreshRoster) {
      lastWorkspaceListMs = now
      try {
        await refreshWorkspaces()
      } catch (err) {
        orca.log(`workspace.list failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const revision = contextRevision
    try {
      // workspace.changed supplies the current context, including when focus is cleared.
      if (!contextFromEvent && orca.host.has('workspace.readContext')) {
        const context = await orca.host.call('workspace.readContext', {})
        if (revision === contextRevision) lastReadContext = context
      }
    } catch (err) {
      orca.log(`workspace.readContext failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    resolveFocusedWorkspace()
    if (revision !== contextRevision || !orca.host.has('agents.list')) return

    const context = lastReadContext
    const focusedId = runtime.focusedId ?? undefined
    const focused = workspaceListCache.find((w) => w.id === focusedId)
    const previous = runtime.liveAgents
    const previousByKey = new Map(previous.map((agent) => [liveAgentKey(agent), agent]))
    const canListByWorkspace = orca.api.major > 1 || (orca.api.major === 1 && orca.api.minor >= 10)
    const backgroundIds = new Set(previous
      .filter((a) => a.workspaceId !== focusedId && a.state !== 'done')
      .map((a) => a.workspaceId))
    const background = workspaceListCache.filter((w) => isLocalWorkspace(w) && backgroundIds.has(w.id))

    async function readAgents(
      workspace: WorkspaceRow | undefined,
      isFocused: boolean
    ): Promise<{ workspaceId?: string; agents: OrcaLiveAgentInfo[] } | null> {
      const workspaceId = workspace?.id ?? (isFocused ? focusedId : undefined)
      try {
        const response = await orca.host.call('agents.list', canListByWorkspace && workspaceId
          ? { workspaceId }
          : {})
        const terminals = isFocused
          ? context?.terminals
          : response.agents.some((a) => a.terminalId)
            ? (await readTerminals(workspaceId))?.terminals
            : undefined
        const terminalTitles = new Map((terminals ?? []).map((terminal) => [terminal.id, terminal.title]))
        const tabTitles = workspace && response.agents.some((a) => a.terminalId)
          ? await readTabTitles(workspace)
          : undefined
        const agents: OrcaLiveAgentInfo[] = []
        for (const a of response.agents) {
          if (!a.terminalId && (!a.sessionId || !mapOrcaAgentKind(a.agent))) continue
          const raw = { ...a, workspaceId, workspacePath: workspace?.path ?? null }
          const cached = previousByKey.get(liveAgentKey(raw))
          const sameTurn = cached && cached.workspaceId === workspaceId &&
            cached.stateStartedAt === a.stateStartedAt && cached.state === a.state &&
            mapOrcaAgentKind(cached.agent) === mapOrcaAgentKind(a.agent)
          const sessionId = a.sessionId === undefined && sameTurn ? cached.sessionId : a.sessionId
          const prev = cached?.sessionId === sessionId && cached?.workspaceId === workspaceId
            ? cached
            : undefined
          const staleState = prev && prev.stateStartedAt > a.stateStartedAt
          const terminalTitle = a.terminalId ? tabTitles?.get(a.terminalId) ?? terminalTitles.get(a.terminalId) : undefined
          agents.push({
            ...raw,
            sessionId,
            title: terminalTitle && !isGenericTerminalTabLabel(terminalTitle)
              ? terminalTitle
              : a.title ?? prev?.title ?? terminalTitle ?? null,
            agent: a.agent ?? prev?.agent ?? null,
            state: staleState ? prev.state : a.state,
            stateStartedAt: staleState ? prev.stateStartedAt : a.stateStartedAt
          })
        }
        return { workspaceId, agents }
      } catch (err) {
        orca.log(`agents.list failed: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    }

    async function readTerminals(workspaceId?: string): Promise<HostResult<'terminal.list'> | null> {
      if (!workspaceId || !orca.host.has('terminal.list')) return null
      return await orca.host.call('terminal.list', { workspaceId }).catch(() => null)
    }

    const runningHistoryWorkspaces = new Set([...historyRows.values()]
      .filter((row) => row.running).map((row) => row.workspaceId))
    const backgroundToList = canListByWorkspace && refreshRoster
      ? workspaceListCache.filter((w) => w.id !== focusedId && isLocalWorkspace(w) &&
        (w.mayRunAgents || backgroundIds.has(w.id) || runningHistoryWorkspaces.has(w.id)))
      : []
    const rosters = await Promise.all([
      focused && isLocalWorkspace(focused) ? readAgents(focused, true) : Promise.resolve(null),
      ...backgroundToList.map((w) => readAgents(w, false))
    ])
    const validatedBackground = new Map(await Promise.all(
      background.filter((w) => (!canListByWorkspace || refreshRoster) && !rosters.some((r) => r?.workspaceId === w.id))
        .map(async (w) => [w.id, await readTerminals(w.id)] as const)
    ))
    if (revision !== contextRevision) return

    const next = new Map<string, OrcaLiveAgentInfo>()
    for (const roster of rosters) {
      for (const agent of roster?.agents ?? []) {
        const key = liveAgentKey(agent)
        if (!next.has(key)) next.set(key, agent)
      }
    }
    const staleDoneCutoff = now - 15 * 60_000
    for (const prev of previous) {
      const key = liveAgentKey(prev)
      if (next.has(key) || (prev.state === 'done' && prev.stateStartedAt < staleDoneCutoff)) continue
      if (rosters.some((r) => r && r.workspaceId === prev.workspaceId)) continue
      const roster = prev.workspaceId ? validatedBackground.get(prev.workspaceId) : undefined
      const terminal = roster?.terminals.find((t) => t.id === prev.terminalId)
      if (prev.terminalId && roster && !roster.truncated && !terminal) continue
      next.set(key, terminal?.title && !isGenericTerminalTabLabel(terminal.title)
        ? { ...prev, title: terminal.title }
        : prev)
    }
    // Preserve status updates that arrived after the roster request began.
    for (const current of runtime.liveAgents) {
      const key = liveAgentKey(current)
      const fresh = next.get(key)
      if (current !== previousByKey.get(key) && (!fresh || fresh.stateStartedAt <= current.stateStartedAt)) {
        next.set(key, current)
      }
    }
    runtime.liveAgents = [...next.values()].filter((a) => !isLiveAgentDisabled(a))
  }

  function refreshHistory(force = false): Promise<void> {
    const now = Date.now()
    if (stopped || historyRequest || (!force && now - lastHistoryRequestMs < 30_000)) return historyDone
    if (!orca.host.has('agent.listSessions') || ALL_AGENTS.every((a) => disabledAgents.has(a))) {
      // Nothing to look up when every agent is switched off.
      historyRows.clear()
      return historyDone
    }
    lastHistoryRequestMs = now
    const request = new AbortController()
    historyRequest = request
    const timeout = setTimeout(() => request.abort(), 5_000)
    const workspaceId = runtime.focusedPath ? runtime.focusedId : null
    const publishRows = (rows: Map<string, HistoryRow>) => {
      // Settings may change while a request is in flight: filter by the settings valid right now.
      const enabledRows = [...rows].filter(([, row]) => {
        const kind = mapOrcaAgentKind(row.agent)
        return !(kind && disabledAgents.has(kind))
      })
      historyRows = new Map(enabledRows.sort(([, a], [, b]) =>
        Number(Boolean(workspaceId && b.workspaceId === workspaceId)) -
        Number(Boolean(workspaceId && a.workspaceId === workspaceId)) ||
        b.updatedAt - a.updatedAt
      ).slice(0, 400))
    }
    historyDone = (async () => {
      try {
        const global = await orca.host.call('agent.listSessions', { limit: 200 }, { signal: request.signal })
        if (stopped || request.signal.aborted) return
        const rows = global.truncated ? new Map(historyRows) : new Map<string, HistoryRow>()
        for (const row of global.sessions) setHistoryRow(rows, row, disabledAgents)
        // The history endpoint may truncate and provides no pagination. Cache a bounded
        // recent metadata index alongside the transcript scanner's independent history.
        publishRows(rows)
        if (global.truncated && workspaceId) {
          const scoped = await orca.host.call('agent.listSessions', { workspaceId, limit: 200 }, { signal: request.signal })
          if (stopped || request.signal.aborted) return
          for (const row of scoped.sessions) setHistoryRow(rows, row, disabledAgents)
          publishRows(rows)
        }
      } catch (err) {
        if (stopped || request.signal.aborted) return
        if (err instanceof Error && 'code' in err &&
          (err.code === 'capability_denied' || err.code === 'consent_required' || err.code === 'not_permitted')) {
          historyRows.clear()
        }
        orca.log(`agent.listSessions failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        clearTimeout(timeout)
        if (historyRequest === request) historyRequest = null
      }
    })()
    return historyDone
  }

  function getSessionIndex(local = scanner.getJournalIndex()): JournalIndex {
    const byNativeId = new Map(local.byNativeId)
    const workspaces = new Map(workspaceListCache.filter(isLocalWorkspace).map((w) => [w.id, w.path]))
    function add(sessionId: string, agent: string | null, title: string | null, workspacePath: string | null, updatedAt: number) {
      const provider = mapOrcaAgentKind(agent)
      if (!provider) return
      const key = `${provider}:${sessionId}`
      const previous = byNativeId.get(key)
      byNativeId.set(key, {
        provider,
        title: cleanConversationTitle(title) ?? previous?.title ?? null,
        workspacePath: workspacePath ?? previous?.workspacePath ?? null,
        updatedAt: Math.max(updatedAt, previous?.updatedAt ?? 0),
        model: null
      })
    }
    for (const row of historyRows.values()) {
      add(row.sessionId, row.agent, row.title, row.workspaceId ? workspaces.get(row.workspaceId) ?? null : null, row.updatedAt)
    }
    for (const agent of runtime.liveAgents) {
      if (agent.sessionId) {
        const title = isGenericTerminalTabLabel(agent.title) ? null : agent.title
        add(agent.sessionId, agent.agent, title, agent.workspacePath ?? null, agent.stateStartedAt)
      }
    }
    return { ...local, byNativeId }
  }

  async function syncPricingAndPersist(): Promise<void> {
    const status = await pricing.syncOnline(5000)
    if (status.source === 'online') {
      const cat = pricing.toStorableCatalog()
      if (cat) {
        try {
          await orca.storage.set(PRICING_STORAGE_KEY, cat as unknown as import('orca/worker').JsonValue)
        } catch {
          // Ignore storage write error
        }
      }
    }
  }

  let quotaPersistChain: Promise<void> = Promise.resolve()
  function persistQuotaCache(): Promise<void> {
    const write = quotaPersistChain.then(async () => {
      if (stopped) return
      try {
        const cached = quotas.hasActiveProviders() ? quotas.toStorableCache() : null
        if (cached) {
          await orca.storage.set(QUOTAS_STORAGE_KEY, cached as unknown as import('orca/worker').JsonValue)
        } else {
          // Every quota provider is off: no quota data (accounts, e-mails) may stay on disk.
          await orca.storage.delete(QUOTAS_STORAGE_KEY)
        }
      } catch {
        // Ignore storage write error
      }
    })
    quotaPersistChain = write
    return write
  }

  async function refreshQuotasAndPersist(force = false): Promise<QuotasSnapshot> {
    const snap = await quotas.refresh(force, Date.now(), lastScannedSessions, pricing)
    if (!stopped && snap.source === 'live') await persistQuotaCache()
    return snap
  }

  async function flushHistoricalCache(force = false): Promise<void> {
    const now = Date.now()
    if (!force && now - lastHistPersistMs < 30_000) return
    if (!scanner.hasDirtyHistoricalCache()) return
    const dirtyHist = scanner.consumeHistoricalCacheSnapshot(now)
    if (!dirtyHist) return
    lastHistPersistMs = now
    try {
      await orca.storage.set(
        HISTORICAL_CACHE_STORAGE_KEY,
        dirtyHist as unknown as import('orca/worker').JsonValue
      )
    } catch {
      // Ignore storage cap or permission error
    }
  }

  function summarizeQuotasForStatus(quotasSnap: QuotasSnapshot | undefined): {
    maxPercent: number
    summaryParts: string[]
  } {
    const summaryParts: string[] = []
    let maxPercent = 0
    if (!quotasSnap) return { maxPercent, summaryParts }

    for (const provider of quotasSnap.providers) {
      if (provider.status !== 'ok') continue
      const inspectWindow = (
        poolLabel: string,
        winLabel: '5h' | '7d',
        win: { usedPercent: number } | null | undefined
      ): void => {
        if (!win || !Number.isFinite(win.usedPercent)) return
        const pct = Math.max(0, Math.min(100, Math.round(win.usedPercent)))
        if (pct > maxPercent) maxPercent = pct
        const tag = poolLabel ? `${provider.label} ${poolLabel} ${winLabel}` : `${provider.label} ${winLabel}`
        if (pct >= 50) summaryParts.push(`${tag}: ${pct}%`)
      }

      if (provider.pools && provider.pools.length > 0) {
        for (const pool of provider.pools) {
          inspectWindow(pool.label, '5h', pool.session)
          inspectWindow(pool.label, '7d', pool.weekly)
        }
      } else {
        inspectWindow('', '5h', provider.session)
        inspectWindow('', '7d', provider.weekly)
      }
    }

    return { maxPercent, summaryParts: summaryParts.slice(0, 4) }
  }

  async function updateStatusBar(snap: DashboardSnapshot): Promise<void> {
    if (!orca.host.has('statusBar.update')) return
    const quotaInfo = summarizeQuotasForStatus(snap.quotas)
    const msg = getMessages(currentLocale)
    const dayTokens = snap.periods.all.day.tokens
    const anyWorking = snap.live.tps.liveTps > 0 || snap.live.agents.some((a) => a.state === 'working')
    const tpsVal = anyWorking ? snap.live.tps.liveTps : snap.periods.all.day.tps.avgTps
    const tokStr = formatTokens(dayTokens.total)
    const costStr = formatUsd(dayTokens.costUsd)
    const tpsPart = tpsVal > 0 ? `${tpsVal.toFixed(1)} tok/s · ` : ''
    const text = `${tpsPart}${tokStr} (${costStr})`

    const activeModels = snap.live.agents
      .slice(0, 3)
      .map((a) => `${a.providerLabel} ${a.modelLabel} (${msg.states[a.state]})`)
      .join(' | ')
    const tooltipLines = [`${msg.appTitle} — ${msg.tabs.day}: ${tokStr} tok · ${costStr}`]
    if (activeModels) tooltipLines.push(activeModels)
    if (quotaInfo.summaryParts.length > 0) tooltipLines.push(`${msg.navShort.quotas}: ${quotaInfo.summaryParts.join(' · ')}`)
    const tooltip = tooltipLines.join('\n')

    const budgetExceeded = dailyBudgetUsd > 0 && dayTokens.costUsd >= dailyBudgetUsd
    const quotaDanger = quotaInfo.maxPercent >= 95
    const quotaWarn = quotaAlertPercent > 0 && quotaInfo.maxPercent >= quotaAlertPercent
    const tone: 'neutral' | 'accent' | 'warning' | 'danger' =
      budgetExceeded || quotaDanger
        ? 'danger'
        : quotaWarn
          ? 'warning'
          : anyWorking
            ? 'accent'
            : 'neutral'

    try {
      await orca.host.call('statusBar.update', {
        id: 'summary',
        text,
        icon: anyWorking ? 'zap' : 'activity',
        tone,
        tooltip,
        visible: true
      })
    } catch {
      // Ignore on headless or unsupported surface
    }
  }

  async function computeAndPublish(forceFullScan = false): Promise<DashboardSnapshot> {
    if (refreshInFlight) {
      if (!forceFullScan) return refreshInFlight
      return await refreshInFlight.then((snap) => stopped ? snap : computeAndPublish(true))
    }
    const run = (async () => {
      await refreshWorkspaceAndAgents(forceFullScan)
      const sessions = scanner.scan({ forceFullDiscovery: forceFullScan })
      lastScannedSessions = sessions
      refreshHistory(forceFullScan)
      const journal = getSessionIndex()

      const now = Date.now()
      const snap = buildDashboardSnapshot(sessions, journal, pricing, runtime, now)
      snap.quotas = quotas.getSnapshot(sessions, pricing, now)
      snap.disabledAgents = [...disabledAgents]
      latestSnapshot = snap

      try {
        orca.panels.post('dashboard.updated', snap)
      } catch {
        // Ignore if no panels are open
      }
      await updateStatusBar(snap)
      await flushHistoricalCache(false)
      return snap
    })()

    refreshInFlight = run
    try {
      return await run
    } finally {
      if (refreshInFlight === run) {
        refreshInFlight = null
      }
    }
  }

  function scheduleTimers(): void {
    if (pollTimer) clearInterval(pollTimer)
    if (pricingTimer) clearInterval(pricingTimer)
    if (quotaTimer) clearInterval(quotaTimer)
    if (stopped) return

    pollTimer = setInterval(() => {
      if (!stopped) {
        void computeAndPublish(false)
      }
    }, Math.max(1, livePollSeconds) * 1000)

    pricingTimer = setInterval(() => {
      if (!stopped && pricing.needsSync(pricingSyncHours)) {
        void syncPricingAndPersist().then(() => {
          if (!stopped) void computeAndPublish(false)
        })
      }
    }, 15 * 60_000)

    quotaTimer = setInterval(() => {
      if (!stopped && quotas.needsRefresh()) {
        void refreshQuotasAndPersist(false).then(() => {
          if (!stopped) void computeAndPublish(false)
        })
      }
    }, 60_000)
  }

  await loadSettings()

  let hadQuotaCache = false
  try {
    const [cachedPricing, cachedHist, cachedQuotas, savedLocale] = await Promise.all([
      orca.storage.get(PRICING_STORAGE_KEY),
      orca.storage.get(HISTORICAL_CACHE_STORAGE_KEY),
      orca.storage.get(QUOTAS_STORAGE_KEY),
      orca.storage.get(LOCALE_STORAGE_KEY)
    ])
    if (cachedPricing) pricing.loadFromCache(cachedPricing)
    if (cachedHist) scanner.hydrateHistoricalCache(cachedHist)
    if (cachedQuotas) quotas.loadFromCache(cachedQuotas)
    hadQuotaCache = Boolean(cachedQuotas)
    if (typeof savedLocale === 'string' && savedLocale.trim()) {
      currentLocale = savedLocale.trim()
    }
  } catch {
    // Proceed cleanly on cold start
  }

  if (hadQuotaCache && disabledAgents.size > 0) await persistQuotaCache()

  // Register Panel RPC handlers
  disposables.push(
    orca.panels.handle('dashboard.get', async (input) => {
      if (typeof input?.locale === 'string' && input.locale.trim() && input.locale !== currentLocale) {
        currentLocale = input.locale.trim()
        try {
          await orca.storage.set(LOCALE_STORAGE_KEY, currentLocale)
        } catch {
          // Ignore storage error
        }
      }
      if (input?.forceScan || !latestSnapshot) {
        return await computeAndPublish(Boolean(input?.forceScan))
      }
      return await computeAndPublish(false)
    })
  )

  disposables.push(
    orca.panels.handle('agent.livePoll', async (input) => {
      const now = Date.now()
      const sessionKey = typeof input?.sessionKey === 'string' ? input.sessionKey.trim() : ''
      if (!sessionKey || sessionKey.length > 512) {
        return { generatedAt: now, agent: null }
      }
      scanner.refreshJournal(now, 800)
      const sessions = scanner.pollHotFiles(now, sessionKey)
      const journal = getSessionIndex()
      const agent = pollSingleLiveAgent(
        sessionKey,
        sessions,
        journal,
        pricing,
        runtime,
        now
      )
      return { generatedAt: now, agent }
    })
  )

  disposables.push(
    orca.panels.handle('session.focus', async (input) => {
      const terminalId = typeof input?.terminalId === 'string' ? input.terminalId.trim() : ''
      const knownTerminal =
        runtime.liveAgents.some((agent) => agent.terminalId === terminalId) ||
        Boolean(lastReadContext?.terminals.some((terminal) => terminal.id === terminalId))
      if (!terminalId || terminalId.length > 512 || !knownTerminal || !orca.host.has('terminal.focus')) {
        return { focused: false }
      }
      try {
        return await orca.host.call('terminal.focus', { terminalId })
      } catch {
        return { focused: false }
      }
    })
  )

  disposables.push(
    orca.panels.handle('pricing.refresh', async () => {
      await Promise.allSettled([syncPricingAndPersist(), refreshQuotasAndPersist(true)])
      await computeAndPublish(false)
      return pricing.getStatus()
    })
  )

  disposables.push(
    orca.panels.handle('quotas.refresh', async () => {
      await refreshQuotasAndPersist(true)
      const snap = await computeAndPublish(false)
      return snap.quotas ?? quotas.getSnapshot(lastScannedSessions, pricing, Date.now())
    })
  )

  disposables.push(
    orca.panels.handle('view.set', async (input) => {
      if (input?.tab && VALID_TABS.includes(input.tab)) {
        activePanelTab = input.tab
        if (input.tab !== 'live' && input.liveAgentKey === undefined) {
          activeLiveAgentKey = null
        }
      }
      if (input && 'liveAgentKey' in input) {
        const rawKey = input.liveAgentKey
        activeLiveAgentKey =
          typeof rawKey === 'string' && rawKey.trim() && rawKey.length <= 512
            ? rawKey.trim()
            : null
        if (activeLiveAgentKey !== null) {
          activePanelTab = 'live'
        }
      }
      if (input?.scope === 'all' || input?.scope === 'worktree') {
        activePanelScope = input.scope
      }
      const localeToSend =
        typeof input?.locale === 'string' && input.locale.trim() ? input.locale.trim() : undefined
      if (localeToSend) {
        currentLocale = localeToSend
      }
      try {
        orca.panels.post('view.changed', {
          tab: activePanelTab,
          scope: activePanelScope,
          locale: localeToSend ?? null,
          liveAgentKey: activeLiveAgentKey
        })
      } catch {
        // Ignore if panel not open
      }
      if (latestSnapshot) {
        await updateStatusBar(latestSnapshot)
      }
      if (activePanelTab === 'quotas' && quotas.needsRefresh()) {
        void refreshQuotasAndPersist(false).then(() => {
          if (!stopped) void computeAndPublish(false)
        })
      }
      return {
        tab: activePanelTab,
        scope: activePanelScope,
        locale: localeToSend ?? null,
        liveAgentKey: activeLiveAgentKey
      }
    })
  )

  // Register Command Palette / Status Bar click command
  disposables.push(
    orca.commands.register('tokenPulse.refresh', async () => {
      await Promise.allSettled([syncPricingAndPersist(), refreshQuotasAndPersist(true)])
      const snap = await computeAndPublish(true)
      const dayTok = formatTokens(snap.periods.all.day.tokens.total)
      const dayCost = formatUsd(snap.periods.all.day.tokens.costUsd)
      return `Token Pulse refreshed — Today: ${dayTok} tokens (${dayCost}), Live TPS: ${snap.live.tps.liveTps.toFixed(1)} tok/s`
    })
  )

  disposables.push(
    orca.events.on('workspace.changed', async ({ context }) => {
      if (context?.workspaceId) tabTitlesByWorkspace.delete(context.workspaceId)
      lastReadContext = context
      contextFromEvent = true
      contextRevision++
      resolveFocusedWorkspace()
      await computeAndPublish(true)
    })
  )

  disposables.push(
    orca.events.on('workspace.created', async () => {
      await computeAndPublish(true)
    })
  )

  disposables.push(
    orca.events.on('workspace.removed', async (ev) => {
      const workspaceId = ev.workspaceListId ?? ev.workspaceId
      tabTitlesByWorkspace.delete(workspaceId)
      workspaceListCache = workspaceListCache.filter((workspace) => workspace.id !== workspaceId)
      runtime.liveAgents = runtime.liveAgents.filter((agent) => agent.workspaceId !== workspaceId)
      if (lastReadContext?.workspaceId === workspaceId) lastReadContext = null
      contextRevision++
      await computeAndPublish(true)
    })
  )

  disposables.push(
    orca.events.on('agent.status.changed', (ev) => {
      if (!ev.terminalId && !ev.sessionId) return
      const workspaceId = ev.workspaceListId ?? ev.workspaceId ?? undefined
      const workspace = workspaceListCache.find((w) => w.id === workspaceId)
      if (workspace && !isLocalWorkspace(workspace)) return
      const matching = runtime.liveAgents.filter((a) =>
        ev.terminalId ? a.terminalId === ev.terminalId
          : a.sessionId === ev.sessionId && a.workspaceId === workspaceId
      )
      if (matching.length > 1 || (!workspace && matching.length === 0)) return
      const previous = matching[0]
      const sessionId = ev.sessionId ?? previous?.sessionId
      const prev = previous?.sessionId === sessionId ? previous : undefined
      const startedAt = ev.mainAgent?.stateStartedAt ?? ev.receivedAt
      if (previous && previous.stateStartedAt > startedAt) return
      let kind = prev?.agent ?? inferAgentFromTerminalTitle(ev.title)
      if (!kind && sessionId) {
        const knownKinds = new Set([...historyRows.values()]
          .filter((row) => row.sessionId === sessionId && row.workspaceId === (workspaceId ?? prev?.workspaceId))
          .map((row) => mapOrcaAgentKind(row.agent)))
        if (knownKinds.size === 1) kind = knownKinds.values().next().value ?? null
      }
      const agent: OrcaLiveAgentInfo = {
        terminalId: ev.terminalId ?? prev?.terminalId ?? null,
        sessionId,
        workspaceId: workspaceId ?? prev?.workspaceId,
        workspacePath: workspace?.path ?? prev?.workspacePath ?? null,
        title: ev.title ?? prev?.title ?? null,
        agent: kind,
        state: ev.mainAgent?.state ?? ev.state,
        stateStartedAt: startedAt
      }
      runtime.liveAgents = [agent, ...runtime.liveAgents.filter((a) => a !== previous)]
      if (statusDebounceTimer) clearTimeout(statusDebounceTimer)
      statusDebounceTimer = setTimeout(() => {
        statusDebounceTimer = null
        if (!stopped) void computeAndPublish(false)
      }, 180)
    })
  )

  disposables.push(
    orca.settings.onDidChange(async () => {
      const wasDisabled = disabledAgents
      await loadSettings()
      if (stopped) return
      const reenabled = [...wasDisabled].some((a) => !disabledAgents.has(a))
      runtime.liveAgents = runtime.liveAgents.filter((a) => !isLiveAgentDisabled(a))
      historyRows = new Map(
        [...historyRows].filter(([, row]) => {
          const kind = mapOrcaAgentKind(row.agent)
          return !(kind && disabledAgents.has(kind))
        })
      )
      // Drop cached quota data of providers that were just switched off.
      void persistQuotaCache()
      if ([...disabledAgents].some((a) => !wasDisabled.has(a))) void flushHistoricalCache(true)
      scheduleTimers()
      if (reenabled) {
        historyRequest?.abort()
        historyRequest = null
        void computeAndPublish(true).then(() => historyDone).then(() => {
          if (!stopped) void computeAndPublish(false)
        })
      } else {
        void computeAndPublish(true)
      }
      // A provider switched back on needs fresh data (the quota call is skipped while all are off).
      if (!stopped && quotas.needsRefresh()) {
        void refreshQuotasAndPersist(false).then(() => {
          if (!stopped) void computeAndPublish(false)
        })
      }
    })
  )

  await computeAndPublish(true)
  scheduleTimers()
  if (pricing.needsSync(pricingSyncHours)) {
    void syncPricingAndPersist().then(() => {
      if (!stopped) void computeAndPublish(false)
    })
  }
  if (quotas.needsRefresh()) {
    void refreshQuotasAndPersist(false).then(() => {
      if (!stopped) void computeAndPublish(false)
    })
  }

  activeCleanup = async () => {
    stopped = true
    pricing.abortInFlight()
    quotas.abortInFlight()
    if (pollTimer) clearInterval(pollTimer)
    if (pricingTimer) clearInterval(pricingTimer)
    if (quotaTimer) clearInterval(quotaTimer)
    if (statusDebounceTimer) clearTimeout(statusDebounceTimer)
    historyRequest?.abort()
    tabTitlesAbort.abort()
    await flushHistoricalCache(true)
    for (const d of disposables) {
      try {
        d.dispose()
      } catch {
        // Ignore
      }
    }
  }
}

export async function deactivate(): Promise<void> {
  if (activeCleanup) {
    await activeCleanup()
    activeCleanup = null
  }
}
