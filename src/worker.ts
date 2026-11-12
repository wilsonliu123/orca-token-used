import path from 'node:path'
import type { Disposable, OrcaWorkerApi } from 'orca/worker'
import {
  buildDashboardSnapshot,
  isSameOrChildWorktreePath,
  type KnownOrcaWorkspace,
  normalizeFsPath,
  type OrcaLiveAgentInfo,
  pollSingleLiveAgent,
  stripGitRefPrefix,
  type WorkspaceRuntimeContext
} from './aggregator'
import {
  extractWorkspacePathFromId,
  type JournalIndex,
  readOrcaActiveWorktreeSelection
} from './journal'
import { formatTokens, formatUsd, getMessages } from './panel/i18n'
import type { SessionTranscriptState } from './parsers'
import { PRICING_STORAGE_KEY, PricingEngine } from './pricing'
import type { DashboardSnapshot, ScopeMode, ViewTab } from './protocol'
import { HISTORICAL_CACHE_STORAGE_KEY, TranscriptScanner } from './scanner'

const LOCALE_STORAGE_KEY = 'lastLocale.v1'
const VALID_TABS: readonly ViewTab[] = ['live', 'sessions', 'day', 'week', 'month']

let activeCleanup: (() => Promise<void>) | null = null

interface ReadContextResult {
  branch: string
  displayName: string
  terminals: { id: string; title?: string }[]
}

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const disposables: Disposable[] = []
  const pricing = new PricingEngine()
  const scanner = new TranscriptScanner()

  let pricingSyncHours = 6
  let livePollSeconds = 2
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pricingTimer: ReturnType<typeof setInterval> | null = null
  let statusDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let focusSettleTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let refreshInFlight: Promise<DashboardSnapshot> | null = null
  let latestSnapshot: DashboardSnapshot | null = null
  let lastHistPersistMs = 0
  let currentLocale = 'zh-TW'
  let activePanelTab: ViewTab = 'live'
  let activePanelScope: ScopeMode = 'all'
  let activeLiveAgentKey: string | null = null

  const terminalToWorkspacePath = new Map<string, string>()
  let lastReadContext: ReadContextResult | null = null

  const runtime: WorkspaceRuntimeContext = {
    focusedId: null,
    focusedProject: null,
    focusedName: null,
    focusedBranch: null,
    focusedPath: null,
    knownWorkspaces: [],
    liveAgents: []
  }

  let workspaceListCache: KnownOrcaWorkspace[] = []
  let lastWorkspaceListMs = 0

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
    } catch {
      // Use defaults if settings:own unavailable
    }
  }

  async function refreshWorkspaceAndAgents(forceList = false): Promise<void> {
    const now = Date.now()
    try {
      if (orca.host.has('workspace.list') && (forceList || now - lastWorkspaceListMs >= 15_000)) {
        const res = await orca.host.call('workspace.list', {})
        workspaceListCache = res.workspaces.map((w) => ({
          id: w.id,
          project: w.project || path.basename(w.path),
          name: w.name,
          path: w.path,
          branch: w.branch
        }))
        runtime.knownWorkspaces = workspaceListCache
        scanner.setKnownWorkspacePaths(workspaceListCache.map((w) => w.path))
        lastWorkspaceListMs = now
      }
    } catch (err) {
      orca.log(`workspace.list failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    try {
      if (orca.host.has('workspace.readContext')) {
        lastReadContext = await orca.host.call('workspace.readContext', {})
      }
    } catch (err) {
      orca.log(`workspace.readContext failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    try {
      if (orca.host.has('agents.list')) {
        const res = await orca.host.call('agents.list', {})
        const freshIds = new Set<string>()
        const nextAgents: OrcaLiveAgentInfo[] = res.agents.map((a) => {
          if (a.terminalId) freshIds.add(a.terminalId)
          return {
            terminalId: a.terminalId,
            title: a.title,
            agent: a.agent,
            state: a.state,
            stateStartedAt: a.stateStartedAt
          }
        })
        const staleDoneCutoff = now - 15 * 60_000
        for (const prev of runtime.liveAgents) {
          if (!prev.terminalId || freshIds.has(prev.terminalId)) continue
          if (prev.state === 'done' && prev.stateStartedAt > 0 && prev.stateStartedAt < staleDoneCutoff) {
            continue
          }
          nextAgents.push(prev)
        }
        runtime.liveAgents = nextAgents
      }
    } catch (err) {
      orca.log(`agents.list failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function resolveFocusedWorkspace(
    ctx: ReadContextResult | null,
    journal: JournalIndex,
    sessions: SessionTranscriptState[]
  ): void {
    // 1) Read Orca's authoritative left-sidebar selection (`workspaceSession.activeWorktreeId`) from `profile-state.db`
    const activeSel = readOrcaActiveWorktreeSelection(scanner.getOrcaAppDirs())

    if (!ctx && !activeSel.activeWorktreeId) {
      runtime.focusedId = null
      runtime.focusedProject = null
      runtime.focusedName = null
      runtime.focusedBranch = null
      runtime.focusedPath = null
      return
    }

    const cleanBranch = ctx ? stripGitRefPrefix(ctx.branch) : null

    // 2) Focused workspace's own terminals from `workspace.readContext` (strictly scoped to focused worktree)
    let ctxTerminalPathHint: string | null = null
    if (ctx && Array.isArray(ctx.terminals)) {
      for (const term of ctx.terminals) {
        const mapped = terminalToWorkspacePath.get(term.id) ?? extractWorkspacePathFromId(term.id)
        if (mapped) {
          ctxTerminalPathHint = mapped
          break
        }
      }
    }

    // Primary source of truth: Orca's left-sidebar selection (`workspaceSession.activeWorktreeId`)
    const matchFromActiveDb = activeSel.activeWorktreeId
      ? workspaceListCache.find(
          (w) =>
            w.id === activeSel.activeWorktreeId ||
            (activeSel.activeWorktreePath &&
              normalizeFsPath(w.path) === normalizeFsPath(activeSel.activeWorktreePath))
        )
      : undefined

    if (matchFromActiveDb && (!ctx || matchFromActiveDb.name === ctx.displayName)) {
      runtime.focusedId = matchFromActiveDb.id
      runtime.focusedProject = matchFromActiveDb.project
      runtime.focusedName = matchFromActiveDb.name
      runtime.focusedBranch = stripGitRefPrefix(matchFromActiveDb.branch) ?? cleanBranch
      runtime.focusedPath = matchFromActiveDb.path
      return
    }

    const matchFromCtxTerminals = ctxTerminalPathHint
      ? workspaceListCache.find((w) => isSameOrChildWorktreePath(ctxTerminalPathHint, w.path))
      : undefined

    if (matchFromCtxTerminals && (!ctx || matchFromCtxTerminals.name === ctx.displayName)) {
      runtime.focusedId = matchFromCtxTerminals.id
      runtime.focusedProject = matchFromCtxTerminals.project
      runtime.focusedName = matchFromCtxTerminals.name
      runtime.focusedBranch = stripGitRefPrefix(matchFromCtxTerminals.branch) ?? cleanBranch
      runtime.focusedPath = matchFromCtxTerminals.path
      return
    }

    // If `activeSel` has a direct filesystem path not yet in `workspaceListCache`
    if (activeSel.activeWorktreePath && !ctx) {
      runtime.focusedId = activeSel.activeWorktreeId
      runtime.focusedPath = activeSel.activeWorktreePath
      runtime.focusedName = path.basename(activeSel.activeWorktreePath)
      runtime.focusedProject = path.basename(activeSel.activeWorktreePath)
      runtime.focusedBranch = null
      return
    }

    if (!ctx) return

    runtime.focusedName = ctx.displayName
    runtime.focusedBranch = cleanBranch

    // 3) Fallback when running in isolated mock tests without `profile-state.db`
    const byNameAndBranch = workspaceListCache.filter(
      (w) =>
        w.name === ctx.displayName &&
        (!cleanBranch || stripGitRefPrefix(w.branch) === cleanBranch)
    )
    const byName = workspaceListCache.filter((w) => w.name === ctx.displayName)
    const candidates =
      byNameAndBranch.length > 0
        ? byNameAndBranch
        : byName.length > 0
          ? byName
          : cleanBranch
            ? workspaceListCache.filter((w) => stripGitRefPrefix(w.branch) === cleanBranch)
            : []

    if (candidates.length === 0) return

    if (candidates.length === 1) {
      runtime.focusedId = candidates[0].id
      runtime.focusedPath = candidates[0].path
      runtime.focusedProject = candidates[0].project
      return
    }

    const scoreCandidate = (w: KnownOrcaWorkspace): number => {
      let best = journal.workspaceActivityMs.get(w.path) ?? 0
      const normW = normalizeFsPath(w.path)
      if (normW) {
        for (const [jp, sc] of journal.workspaceActivityMs.entries()) {
          if (isSameOrChildWorktreePath(jp, normW) && sc > best) best = sc
        }
        for (const s of sessions) {
          const sPath = journal.byNativeId.get(s.sessionId)?.workspacePath || s.cwd
          if (sPath && isSameOrChildWorktreePath(sPath, normW) && s.updatedAtMs > best) {
            best = s.updatedAtMs
          }
        }
      }
      return best
    }

    const ranked = [...candidates].sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    runtime.focusedId = ranked[0].id
    runtime.focusedPath = ranked[0].path
    runtime.focusedProject = ranked[0].project
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

  async function updateStatusBar(snap: DashboardSnapshot): Promise<void> {
    if (!orca.host.has('statusBar.update')) return
    const msg = getMessages(currentLocale)
    const dayTokens = snap.periods.all.day.tokens
    const anyWorking = snap.live.agents.some((a) => a.state === 'working')
    const tpsVal = anyWorking ? snap.live.tps.liveTps : snap.periods.all.day.tps.avgTps
    const tokStr = formatTokens(dayTokens.total)
    const costStr = formatUsd(dayTokens.costUsd)
    const tpsPart = tpsVal > 0 ? `${tpsVal.toFixed(1)} tok/s · ` : ''
    const text = `${tpsPart}${tokStr} (${costStr})`

    const activeModels = snap.live.agents
      .slice(0, 3)
      .map((a) => `${a.providerLabel} ${a.modelLabel} (${msg.states[a.state]})`)
      .join(' | ')
    const tooltip = activeModels
      ? `${msg.appTitle} — ${msg.tabs.day}: ${tokStr} tok · ${costStr}\n${activeModels}`
      : `${msg.appTitle} — ${msg.tabs.day}: ${tokStr} tok · ${costStr}`

    try {
      await orca.host.call('statusBar.update', {
        id: 'summary',
        text,
        icon: anyWorking ? 'zap' : 'activity',
        tone: anyWorking ? 'accent' : 'neutral',
        tooltip,
        visible: true
      })
    } catch {
      // Ignore on headless or unsupported surface
    }
  }

  async function computeAndPublish(forceFullScan = false): Promise<DashboardSnapshot> {
    if (refreshInFlight && !forceFullScan) {
      return refreshInFlight
    }
    const run = (async () => {
      await refreshWorkspaceAndAgents(forceFullScan)
      const sessions = scanner.scan({ forceFullDiscovery: forceFullScan })
      const journal = scanner.getJournalIndex()
      resolveFocusedWorkspace(lastReadContext, journal, sessions)

      const snap = buildDashboardSnapshot(sessions, journal, pricing, runtime, Date.now())
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
  }

  try {
    const [cachedPricing, cachedHist, savedLocale] = await Promise.all([
      orca.storage.get(PRICING_STORAGE_KEY),
      orca.storage.get(HISTORICAL_CACHE_STORAGE_KEY),
      orca.storage.get(LOCALE_STORAGE_KEY)
    ])
    if (cachedPricing) pricing.loadFromCache(cachedPricing)
    if (cachedHist) scanner.hydrateHistoricalCache(cachedHist)
    if (typeof savedLocale === 'string' && savedLocale.trim()) {
      currentLocale = savedLocale.trim()
    }
  } catch {
    // Proceed cleanly on cold start
  }

  await loadSettings()

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
      const sessions = scanner.pollHotFiles(now, sessionKey)
      const journal = scanner.refreshJournal(now, 800)
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
    orca.panels.handle('pricing.refresh', async () => {
      await syncPricingAndPersist()
      await computeAndPublish(false)
      return pricing.getStatus()
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
      await syncPricingAndPersist()
      const snap = await computeAndPublish(true)
      const dayTok = formatTokens(snap.periods.all.day.tokens.total)
      const dayCost = formatUsd(snap.periods.all.day.tokens.costUsd)
      return `Token Pulse refreshed — Today: ${dayTok} tokens (${dayCost}), Live TPS: ${snap.live.tps.liveTps.toFixed(1)} tok/s`
    })
  )

  // Subscribe to Orca left-sidebar focus changes: compute immediately + 250ms settle pass after WAL flush
  disposables.push(
    orca.events.on('workspace.changed', async ({ context }) => {
      if (context) {
        lastReadContext = context
      }
      await computeAndPublish(true)
      if (focusSettleTimer) clearTimeout(focusSettleTimer)
      focusSettleTimer = setTimeout(() => {
        focusSettleTimer = null
        if (!stopped) void computeAndPublish(false)
      }, 250)
    })
  )

  disposables.push(
    orca.events.on('workspace.created', async () => {
      await computeAndPublish(true)
    })
  )

  disposables.push(
    orca.events.on('workspace.removed', async () => {
      await computeAndPublish(true)
    })
  )

  disposables.push(
    orca.events.on('agent.status.changed', async (ev) => {
      if (ev.terminalId && ev.workspaceId) {
        const wsPath = extractWorkspacePathFromId(ev.workspaceId)
        if (wsPath) {
          terminalToWorkspacePath.set(ev.terminalId, wsPath)
        }
      }
      const prev = runtime.liveAgents.find((a) => ev.terminalId && a.terminalId === ev.terminalId)
      const nextList: OrcaLiveAgentInfo[] = runtime.liveAgents.filter(
        (a) => !ev.terminalId || a.terminalId !== ev.terminalId
      )
      if (ev.terminalId) {
        nextList.unshift({
          terminalId: ev.terminalId,
          title: ev.title ?? prev?.title ?? null,
          agent: prev?.agent ?? null,
          state: ev.state,
          stateStartedAt: ev.receivedAt
        })
      }
      runtime.liveAgents = nextList

      if (statusDebounceTimer) clearTimeout(statusDebounceTimer)
      statusDebounceTimer = setTimeout(() => {
        statusDebounceTimer = null
        if (!stopped) void computeAndPublish(false)
      }, 180)
    })
  )

  disposables.push(
    orca.settings.onDidChange(async () => {
      await loadSettings()
      scheduleTimers()
    })
  )

  await computeAndPublish(true)
  scheduleTimers()
  if (pricing.needsSync(pricingSyncHours)) {
    void syncPricingAndPersist().then(() => {
      if (!stopped) void computeAndPublish(false)
    })
  }

  activeCleanup = async () => {
    stopped = true
    pricing.abortInFlight()
    if (pollTimer) clearInterval(pollTimer)
    if (pricingTimer) clearInterval(pricingTimer)
    if (statusDebounceTimer) clearTimeout(statusDebounceTimer)
    if (focusSettleTimer) clearTimeout(focusSettleTimer)
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
