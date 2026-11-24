import { runOrcaJson } from './orca-cli'
import type { SessionTranscriptState } from './parsers'
import type { PricingEngine } from './pricing'
import type {
  LocalQuotaUsageWindow,
  QuotaAccountSummary,
  QuotaPool,
  QuotaProviderKind,
  QuotaProviderSnapshot,
  QuotaProviderStatus,
  QuotaResetCredits,
  QuotasSnapshot,
  QuotaWindow
} from './protocol'

export const QUOTAS_STORAGE_KEY = 'quotasCache.v1'
export const DEFAULT_QUOTA_TTL_MS = 5 * 60_000
export const DEFAULT_QUOTA_TIMEOUT_MS = 15_000

const FIVE_HOURS_MS = 5 * 3600_000
const SEVEN_DAYS_MS = 7 * 86400_000

export const QUOTA_PROVIDERS: readonly QuotaProviderKind[] = ['codex', 'antigravity', 'claude']

const PROVIDER_LABELS: Record<QuotaProviderKind, string> = {
  codex: 'Codex',
  antigravity: 'Antigravity',
  claude: 'Claude'
}

export type ExecQuotaCli = (signal: AbortSignal) => Promise<unknown>

interface StoredQuotasCache {
  version: 1
  syncedAt: number
  providers: QuotaProviderSnapshot[]
  coveredProviders?: QuotaProviderKind[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

function normalizeEpochMs(value: unknown): number | null {
  const num = asFiniteNumber(value)
  if (num === null || num <= 0) return null
  return num < 1e12 ? num * 1000 : num
}

function clampPercent(value: unknown): number | null {
  const num = asFiniteNumber(value)
  if (num === null) return null
  const clamped = Math.min(100, Math.max(0, num))
  return Number.isInteger(clamped) ? clamped : +clamped.toFixed(1)
}

function slugifyPoolId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'default'
}

export function emptyLocalQuotaUsageWindow(): LocalQuotaUsageWindow {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    turnCount: 0,
    sessionCount: 0,
    rateLimitHits: null
  }
}

export function emptyLocalUsageByProvider(): Record<
  QuotaProviderKind,
  { window5h: LocalQuotaUsageWindow; window7d: LocalQuotaUsageWindow }
> {
  return {
    codex: { window5h: emptyLocalQuotaUsageWindow(), window7d: emptyLocalQuotaUsageWindow() },
    antigravity: {
      window5h: emptyLocalQuotaUsageWindow(),
      window7d: emptyLocalQuotaUsageWindow()
    },
    claude: { window5h: emptyLocalQuotaUsageWindow(), window7d: emptyLocalQuotaUsageWindow() }
  }
}

function parseQuotaWindow(raw: unknown): QuotaWindow | null {
  const obj = asRecord(raw)
  if (!obj) return null
  const usedPercent = clampPercent(obj.usedPercent)
  if (usedPercent === null) return null
  const windowMinutesRaw = asFiniteNumber(obj.windowMinutes)
  const windowMinutes = windowMinutesRaw !== null && windowMinutesRaw >= 0 ? windowMinutesRaw : 0
  const resetsAt = normalizeEpochMs(obj.resetsAt)
  const resetDescription = asString(obj.resetDescription)
  return {
    usedPercent,
    windowMinutes,
    resetsAt,
    resetDescription
  }
}

function parseResetCredits(raw: unknown): QuotaResetCredits | null {
  const obj = asRecord(raw)
  if (!obj) return null
  const availableCount = asFiniteNumber(obj.availableCount)
  const totalEarnedCount = asFiniteNumber(obj.totalEarnedCount)
  if (availableCount === null && totalEarnedCount === null) return null
  return {
    availableCount: Math.max(0, Math.round(availableCount ?? 0)),
    totalEarnedCount: Math.max(0, Math.round(totalEarnedCount ?? 0)),
    nextExpiresAt: normalizeEpochMs(obj.nextExpiresAt)
  }
}

function classifyBucketKind(
  windowMinutes: number,
  windowName: string | null,
  fullName: string | null
): 'session' | 'weekly' | null {
  const label = `${windowName ?? ''} ${fullName ?? ''}`.toLowerCase()
  if ((windowMinutes > 0 && windowMinutes <= 360) || /\b(5h|5-hour|five\s*hour|session)\b/.test(label)) {
    return 'session'
  }
  if (windowMinutes >= 1440 || /\b(7d|7-day|weekly|week)\b/.test(label)) {
    return 'weekly'
  }
  return null
}

function parsePoolsFromBuckets(bucketsRaw: unknown): QuotaPool[] {
  if (!Array.isArray(bucketsRaw)) return []
  const byGroup = new Map<string, QuotaPool>()

  for (const item of bucketsRaw) {
    const b = asRecord(item)
    if (!b) continue
    const win = parseQuotaWindow(b)
    if (!win) continue

    const fullName = asString(b.name)
    const windowName = asString(b.windowName)
    const groupFromName = fullName && fullName.includes('·') ? fullName.split('·')[0].trim() : null
    const groupLabel = asString(b.group) ?? groupFromName ?? 'Default'

    const kind = classifyBucketKind(win.windowMinutes, windowName, fullName)
    if (!kind) continue

    let pool = byGroup.get(groupLabel)
    if (!pool) {
      pool = {
        id: slugifyPoolId(groupLabel),
        label: groupLabel,
        session: null,
        weekly: null
      }
      byGroup.set(groupLabel, pool)
    }
    if (kind === 'session' && !pool.session) {
      pool.session = win
    } else if (kind === 'weekly' && !pool.weekly) {
      pool.weekly = win
    }
  }

  return Array.from(byGroup.values())
}

function normalizeStatus(
  rawStatus: unknown,
  session: QuotaWindow | null,
  weekly: QuotaWindow | null,
  pools: QuotaPool[],
  error: string | null
): QuotaProviderStatus {
  const s = asString(rawStatus)?.toLowerCase()
  if (s === 'ok' || s === 'unavailable' || s === 'error' || s === 'loading') {
    return s
  }
  if (session || weekly || pools.length > 0) return 'ok'
  if (error) return 'error'
  return 'unavailable'
}

function extractEmailFromMetadata(usageObj: Record<string, unknown> | null): string | null {
  if (!usageObj) return null
  const meta = asRecord(usageObj.usageMetadata)
  if (!meta) return null
  const acct = asRecord(meta.account)
  const acctEmail = asString(acct?.email)
  if (acctEmail) return acctEmail
  const prov = asString(meta.authProvenance)
  if (prov && prov.includes('@')) return prov
  return null
}

function parseAccountListEntries(
  accountsRaw: unknown,
  activeAccountId: string | null
): QuotaAccountSummary[] {
  if (!Array.isArray(accountsRaw)) return []
  const out: QuotaAccountSummary[] = []
  for (const item of accountsRaw) {
    const obj = asRecord(item)
    if (!obj) continue
    const id = asString(obj.id) ?? asString(obj.accountId)
    const email = asString(obj.email)
    const label = asString(obj.label) ?? asString(obj.workspaceLabel)
    const authKind = asString(obj.authKind) ?? asString(obj.authMethod)
    const usageObj = asRecord(obj.usage) ?? asRecord(obj.rateLimits)
    const session = parseQuotaWindow(usageObj?.session)
    const weekly = parseQuotaWindow(usageObj?.weekly)
    const pools = parsePoolsFromBuckets(usageObj?.buckets)
    const error = asString(usageObj?.error) ?? asString(obj.error)
    const status = normalizeStatus(usageObj?.status ?? obj.status, session, weekly, pools, error)
    const active =
      typeof obj.active === 'boolean'
        ? obj.active
        : Boolean(activeAccountId && id && id === activeAccountId)
    out.push({
      id,
      email,
      label,
      authKind,
      active,
      status,
      session,
      weekly,
      pools,
      error
    })
  }
  return out
}

function mergeAccounts(
  primary: QuotaAccountSummary[],
  secondary: QuotaAccountSummary[]
): QuotaAccountSummary[] {
  const byKey = new Map<string, QuotaAccountSummary>()
  const keyFor = (a: QuotaAccountSummary, idx: number): string =>
    a.id || a.email || a.label || `idx-${idx}`

  primary.forEach((a, idx) => {
    byKey.set(keyFor(a, idx), { ...a })
  })
  secondary.forEach((b, idx) => {
    const k = keyFor(b, idx + primary.length)
    const existing = byKey.get(k)
    if (!existing) {
      byKey.set(k, { ...b })
    } else {
      byKey.set(k, {
        id: existing.id ?? b.id,
        email: existing.email ?? b.email,
        label: existing.label ?? b.label,
        authKind: existing.authKind ?? b.authKind,
        active: existing.active || b.active,
        status: existing.status !== 'unavailable' ? existing.status : b.status,
        session: existing.session ?? b.session,
        weekly: existing.weekly ?? b.weekly,
        pools: existing.pools.length > 0 ? existing.pools : b.pools,
        error: existing.error ?? b.error
      })
    }
  })
  return Array.from(byKey.values())
}

function buildCodexSnapshot(result: Record<string, unknown>): QuotaProviderSnapshot {
  const rateLimits = asRecord(result.rateLimits)
  const codexLimits = asRecord(rateLimits?.codex)
  const codexSection = asRecord(result.codex)
  const systemDefault = asRecord(codexSection?.systemDefault)

  const activeId = asString(codexSection?.activeAccountId)
  const sectionAccounts = parseAccountListEntries(codexSection?.accounts, activeId)
  const inactiveAccounts = parseAccountListEntries(rateLimits?.inactiveCodexAccounts, activeId)
  const accounts = mergeAccounts(sectionAccounts, inactiveAccounts)
  const activeAccount = accounts.find((a) => a.active) ?? null

  const session = parseQuotaWindow(codexLimits?.session)
  const weekly = parseQuotaWindow(codexLimits?.weekly)
  const resetCredits = parseResetCredits(codexLimits?.rateLimitResetCredits)
  const error = asString(codexLimits?.error)
  const status = normalizeStatus(codexLimits?.status, session, weekly, [], error)
  const updatedAt = asFiniteNumber(codexLimits?.updatedAt)

  const accountEmail =
    activeAccount?.email ??
    asString(systemDefault?.email) ??
    extractEmailFromMetadata(codexLimits) ??
    null
  const authKind =
    activeAccount?.authKind ??
    asString(systemDefault?.authKind) ??
    asString(asRecord(codexLimits?.usageMetadata)?.credentialSource) ??
    null

  return {
    provider: 'codex',
    label: PROVIDER_LABELS.codex,
    status,
    error,
    accountEmail,
    authKind,
    session,
    weekly,
    pools: [],
    resetCredits,
    accounts,
    updatedAt,
    local: {
      window5h: emptyLocalQuotaUsageWindow(),
      window7d: emptyLocalQuotaUsageWindow()
    }
  }
}

function buildAntigravitySnapshot(result: Record<string, unknown>): QuotaProviderSnapshot {
  const rateLimits = asRecord(result.rateLimits)
  const agSection = asRecord(result.antigravity)
  const activeId = asString(agSection?.activeAccountId) ?? asString(agSection?.selectedAccountId)

  const sectionAccounts = parseAccountListEntries(agSection?.accounts, activeId)
  const rateLimitAccounts = parseAccountListEntries(rateLimits?.antigravityAccounts, activeId)
  const accounts = mergeAccounts(rateLimitAccounts, sectionAccounts)

  const activeAccount = accounts.find((a) => a.active) ?? accounts[0] ?? null
  const agLimits = asRecord(rateLimits?.antigravity)
  const currentAccount = asRecord(agSection?.currentAccount)

  const session = parseQuotaWindow(agLimits?.session) ?? activeAccount?.session ?? null
  const weekly = parseQuotaWindow(agLimits?.weekly) ?? activeAccount?.weekly ?? null
  const poolsFromLimits = parsePoolsFromBuckets(agLimits?.buckets)
  const pools =
    poolsFromLimits.length > 0 ? poolsFromLimits : (activeAccount?.pools ?? [])
  const error = asString(agLimits?.error) ?? activeAccount?.error ?? null
  const status = normalizeStatus(agLimits?.status ?? activeAccount?.status, session, weekly, pools, error)
  const updatedAt = asFiniteNumber(agLimits?.updatedAt)

  const accountEmail =
    asString(currentAccount?.email) ??
    activeAccount?.email ??
    extractEmailFromMetadata(agLimits) ??
    null
  const authKind =
    asString(currentAccount?.authMethod) ??
    activeAccount?.authKind ??
    asString(asRecord(agLimits?.usageMetadata)?.credentialSource) ??
    null

  return {
    provider: 'antigravity',
    label: PROVIDER_LABELS.antigravity,
    status,
    error,
    accountEmail,
    authKind,
    session,
    weekly,
    pools,
    resetCredits: null,
    accounts,
    updatedAt,
    local: {
      window5h: emptyLocalQuotaUsageWindow(),
      window7d: emptyLocalQuotaUsageWindow()
    }
  }
}

function buildClaudeSnapshot(result: Record<string, unknown>): QuotaProviderSnapshot {
  const rateLimits = asRecord(result.rateLimits)
  const claudeLimits = asRecord(rateLimits?.claude)
  const claudeSection = asRecord(result.claude)

  const activeId = asString(claudeSection?.activeAccountId)
  const sectionAccounts = parseAccountListEntries(claudeSection?.accounts, activeId)
  const inactiveAccounts = parseAccountListEntries(rateLimits?.inactiveClaudeAccounts, activeId)
  const accounts = mergeAccounts(sectionAccounts, inactiveAccounts)
  const activeAccount = accounts.find((a) => a.active) ?? null

  const session = parseQuotaWindow(claudeLimits?.session)
  const weekly = parseQuotaWindow(claudeLimits?.weekly)
  const error = asString(claudeLimits?.error)
  const status = normalizeStatus(claudeLimits?.status, session, weekly, [], error)
  const updatedAt = asFiniteNumber(claudeLimits?.updatedAt)

  const meta = asRecord(claudeLimits?.usageMetadata)
  const credSource = asString(meta?.credentialSource)
  const inferredApiKey =
    error && /api\s*key/i.test(error) ? 'api-key' : credSource && credSource !== 'none' ? credSource : null

  const accountEmail = activeAccount?.email ?? extractEmailFromMetadata(claudeLimits) ?? null
  const authKind = activeAccount?.authKind ?? inferredApiKey

  return {
    provider: 'claude',
    label: PROVIDER_LABELS.claude,
    status,
    error,
    accountEmail,
    authKind,
    session,
    weekly,
    pools: [],
    resetCredits: null,
    accounts,
    updatedAt,
    local: {
      window5h: emptyLocalQuotaUsageWindow(),
      window7d: emptyLocalQuotaUsageWindow()
    }
  }
}

export function parseOrcaAccountListPayload(payload: unknown): QuotaProviderSnapshot[] {
  const root = asRecord(payload)
  if (!root) {
    throw new Error('Invalid response from orca account list --json')
  }
  if (root.ok !== true) {
    const errObj = asRecord(root.error)
    const msg = asString(errObj?.message) ?? asString(root.error) ?? 'orca account list failed'
    throw new Error(msg)
  }
  const result = asRecord(root.result)
  if (!result) {
    throw new Error('Missing result field in orca account list --json')
  }

  return [
    buildCodexSnapshot(result),
    buildAntigravitySnapshot(result),
    buildClaudeSnapshot(result)
  ]
}

export function computeLocalRollingUsage(
  sessions: SessionTranscriptState[],
  pricing: PricingEngine,
  now = Date.now()
): Record<QuotaProviderKind, { window5h: LocalQuotaUsageWindow; window7d: LocalQuotaUsageWindow }> {
  const out = emptyLocalUsageByProvider()
  const cutoff5h = now - FIVE_HOURS_MS
  const cutoff7d = now - SEVEN_DAYS_MS

  // Match aggregator deduplication so archived/multi-home copies never double-count.
  const deduped = new Map<string, SessionTranscriptState>()
  for (const st of sessions) {
    if (st.isInternalHelper) continue
    if (st.agent !== 'codex' && st.agent !== 'antigravity' && st.agent !== 'claude') continue
    const key = `${st.agent}:${st.sessionId}`
    const prev = deduped.get(key)
    if (
      !prev ||
      st.turnsByKey.size > prev.turnsByKey.size ||
      (st.turnsByKey.size === prev.turnsByKey.size && st.updatedAtMs > prev.updatedAtMs)
    ) {
      deduped.set(key, st)
    }
  }

  for (const st of deduped.values()) {
    const provider = st.agent as QuotaProviderKind
    const target = out[provider]
    let seen5h = false
    let seen7d = false

    for (const t of st.turnsByKey.values()) {
      if (t.timestampMs < cutoff7d) continue

      const turnCost = pricing.computeCostUsd(
        st.agent,
        t.model || st.latestModel,
        {
          input: t.input,
          output: t.output,
          reasoning: t.reasoning,
          cacheRead: t.cacheRead,
          cacheWrite: t.cacheWrite
        },
        t.explicitCostUsd
      )

      const addToWindow = (win: LocalQuotaUsageWindow) => {
        win.inputTokens += t.input
        win.outputTokens += t.output
        win.reasoningTokens += t.reasoning
        win.cacheReadTokens += t.cacheRead
        win.cacheWriteTokens += t.cacheWrite
        win.totalTokens += t.total
        win.costUsd += turnCost
        win.turnCount += 1
      }

      addToWindow(target.window7d)
      seen7d = true

      if (t.timestampMs >= cutoff5h) {
        addToWindow(target.window5h)
        seen5h = true
      }
    }

    if (seen5h) target.window5h.sessionCount += 1
    if (seen7d) target.window7d.sessionCount += 1
  }

  for (const provider of QUOTA_PROVIDERS) {
    out[provider].window5h.costUsd = +out[provider].window5h.costUsd.toFixed(6)
    out[provider].window7d.costUsd = +out[provider].window7d.costUsd.toFixed(6)
  }

  return out
}

function sanitizeCachedPools(raw: unknown): QuotaPool[] {
  if (!Array.isArray(raw)) return []
  const out: QuotaPool[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    const id = asString(rec?.id)
    const label = asString(rec?.label)
    if (!rec || !id || !label) continue
    out.push({
      id,
      label,
      session: parseQuotaWindow(rec.session),
      weekly: parseQuotaWindow(rec.weekly)
    })
  }
  return out
}

function sanitizeCachedAccounts(raw: unknown): QuotaAccountSummary[] {
  if (!Array.isArray(raw)) return []
  const out: QuotaAccountSummary[] = []
  for (const item of raw) {
    const rec = asRecord(item)
    if (!rec) continue
    const session = parseQuotaWindow(rec.session)
    const weekly = parseQuotaWindow(rec.weekly)
    const pools = sanitizeCachedPools(rec.pools)
    const error = asString(rec.error)
    out.push({
      id: asString(rec.id),
      email: asString(rec.email),
      label: asString(rec.label),
      authKind: asString(rec.authKind),
      active: Boolean(rec.active),
      status: normalizeStatus(rec.status, session, weekly, pools, error),
      session,
      weekly,
      pools,
      error
    })
  }
  return out
}

export class QuotaEngine {
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly execCli: ExecQuotaCli
  private readonly nowFn: () => number
  private officialProviders: QuotaProviderSnapshot[] | null = null
  private source: QuotasSnapshot['source'] = 'loading'
  private syncedAt: number | null = null
  private lastError: string | null = null
  private refreshing = false
  private inFlight: Promise<QuotasSnapshot> | null = null
  private activeControllers = new Set<AbortController>()

  constructor(options?: {
    ttlMs?: number
    timeoutMs?: number
    execCli?: ExecQuotaCli
    nowFn?: () => number
  }) {
    this.ttlMs = Math.max(1000, options?.ttlMs ?? DEFAULT_QUOTA_TTL_MS)
    this.timeoutMs = Math.max(1000, options?.timeoutMs ?? DEFAULT_QUOTA_TIMEOUT_MS)
    this.execCli =
      options?.execCli ?? ((signal) => runOrcaJson(['account', 'list', '--json'], signal, this.timeoutMs))
    this.nowFn = options?.nowFn ?? (() => Date.now())
  }

  abortInFlight(): void {
    for (const controller of this.activeControllers) {
      try {
        controller.abort()
      } catch {
        // Ignore
      }
    }
    this.activeControllers.clear()
    this.inFlight = null
    this.refreshing = false
  }

  loadFromCache(cached: unknown): void {
    const obj = asRecord(cached)
    if (!obj || obj.version !== 1) return
    const syncedAt = asFiniteNumber(obj.syncedAt)
    if (!syncedAt || !Array.isArray(obj.providers) || obj.providers.length === 0) return

    const validProviders: QuotaProviderSnapshot[] = []
    for (const p of obj.providers) {
      const rec = asRecord(p)
      const kind = asString(rec?.provider) as QuotaProviderKind | null
      if (!rec || !kind || !QUOTA_PROVIDERS.includes(kind) || this.disabledProviders.has(kind)) continue
      const session = parseQuotaWindow(rec.session)
      const weekly = parseQuotaWindow(rec.weekly)
      const pools = sanitizeCachedPools(rec.pools)
      const error = asString(rec.error)
      validProviders.push({
        provider: kind,
        label: asString(rec.label) ?? PROVIDER_LABELS[kind],
        status: normalizeStatus(rec.status, session, weekly, pools, error),
        error,
        accountEmail: asString(rec.accountEmail),
        authKind: asString(rec.authKind),
        session,
        weekly,
        pools,
        resetCredits: parseResetCredits(rec.resetCredits),
        accounts: sanitizeCachedAccounts(rec.accounts),
        updatedAt: asFiniteNumber(rec.updatedAt),
        local: {
          window5h: emptyLocalQuotaUsageWindow(),
          window7d: emptyLocalQuotaUsageWindow()
        }
      })
    }

    if (validProviders.length > 0) {
      const covered = Array.isArray(obj.coveredProviders)
        ? obj.coveredProviders.filter((p): p is QuotaProviderKind => QUOTA_PROVIDERS.includes(p as QuotaProviderKind))
        : QUOTA_PROVIDERS
      this.officialProviders = validProviders
      this.coveredProviders = new Set(covered.filter((p) => !this.disabledProviders.has(p)))
      this.syncedAt = syncedAt
      this.source = 'cache'
    }
  }

  toStorableCache(): StoredQuotasCache | null {
    if (!this.syncedAt || !this.officialProviders) return null
    return {
      version: 1,
      syncedAt: this.syncedAt,
      coveredProviders: [...this.coveredProviders],
      providers: this.officialProviders.map((p) => ({
        ...p,
        local: {
          window5h: emptyLocalQuotaUsageWindow(),
          window7d: emptyLocalQuotaUsageWindow()
        }
      }))
    }
  }

  needsRefresh(now = this.nowFn()): boolean {
    if (!this.syncedAt || !this.officialProviders) return true
    if (this.activeProviders().some((p) => !this.coveredProviders.has(p))) return true
    return now - this.syncedAt >= this.ttlMs
  }

  async refresh(
    force = false,
    now?: number,
    sessions: SessionTranscriptState[] = [],
    pricing?: PricingEngine
  ): Promise<QuotasSnapshot> {
    const checkNow = now ?? this.nowFn()
    if (this.activeProviders().length === 0) {
      // Every provider is switched off in the settings: do not even run the account list command.
      return this.getSnapshot(sessions, pricing, checkNow)
    }
    if (!force && !this.needsRefresh(checkNow)) {
      return this.getSnapshot(sessions, pricing, checkNow)
    }
    if (this.inFlight) {
      return this.inFlight
    }

    this.refreshing = true
    const controller = new AbortController()
    this.activeControllers.add(controller)

    const run = (async () => {
      try {
        const raw = await this.execCli(controller.signal)
        // The response always carries every provider (the per-agent form has no rate limits), so what belongs
        // to a switched-off provider is discarded right here: never kept, shown or cached.
        const providers = parseOrcaAccountListPayload(raw).filter((p) => !this.disabledProviders.has(p.provider))
        if (!controller.signal.aborted) {
          this.officialProviders = providers
          this.coveredProviders = new Set(this.activeProviders())
          this.syncedAt = now ?? this.nowFn()
          this.source = 'live'
          this.lastError = null
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          this.lastError = err instanceof Error ? err.message : String(err)
          this.source = this.officialProviders ? 'cache' : 'error'
        }
      } finally {
        this.activeControllers.delete(controller)
        if (this.inFlight === run) {
          this.inFlight = null
          this.refreshing = false
        }
      }
      return this.getSnapshot(sessions, pricing, now ?? this.nowFn())
    })()

    this.inFlight = run
    return run
  }

  private disabledProviders = new Set<QuotaProviderKind>()
  private coveredProviders = new Set<QuotaProviderKind>()

  /** Providers switched off in the plugin settings are left out of every snapshot. */
  setDisabledProviders(providers: Iterable<QuotaProviderKind>): void {
    const next = new Set(providers)
    const newlyDisabled = [...next].some((p) => !this.disabledProviders.has(p))
    this.disabledProviders = next
    if (newlyDisabled && this.inFlight) this.abortInFlight()
    // Forget what was fetched for providers that are now off (so it is not cached either).
    for (const p of next) this.coveredProviders.delete(p)
    if (this.officialProviders) {
      const remaining = this.officialProviders.filter((p) => !next.has(p.provider))
      if (remaining.length > 0 || this.officialProviders.length === 0) {
        this.officialProviders = remaining
      } else {
        this.officialProviders = null
        this.coveredProviders.clear()
        this.syncedAt = null
        this.lastError = null
        this.source = 'loading'
      }
    }
  }

  /** False when every quota provider is switched off (nothing is fetched, shown or cached). */
  hasActiveProviders(): boolean {
    return this.activeProviders().length > 0
  }

  private activeProviders(): QuotaProviderKind[] {
    return QUOTA_PROVIDERS.filter((p) => !this.disabledProviders.has(p))
  }

  getSnapshot(
    sessions: SessionTranscriptState[],
    pricing?: PricingEngine,
    now = this.nowFn()
  ): QuotasSnapshot {
    if (this.activeProviders().length === 0) {
      return { source: 'disabled', syncedAt: null, refreshing: false, lastError: null, providers: [] }
    }
    const localByProvider = pricing
      ? computeLocalRollingUsage(sessions, pricing, now)
      : emptyLocalUsageByProvider()

    if (!this.officialProviders) {
      const status: QuotaProviderStatus = this.lastError ? 'error' : 'loading'
      return {
        source: this.lastError ? 'error' : 'loading',
        syncedAt: this.syncedAt,
        refreshing: this.refreshing,
        lastError: this.lastError,
        providers: this.activeProviders().map((provider) => ({
          provider,
          label: PROVIDER_LABELS[provider],
          status,
          error: this.lastError,
          accountEmail: null,
          authKind: null,
          session: null,
          weekly: null,
          pools: [],
          resetCredits: null,
          accounts: [],
          updatedAt: null,
          local: localByProvider[provider]
        }))
      }
    }

    const byKind = new Map(this.officialProviders.map((p) => [p.provider, p]))
    const providers = this.activeProviders().map((kind) => {
      const base = byKind.get(kind)
      if (!base) {
        return {
          provider: kind,
          label: PROVIDER_LABELS[kind],
          status: 'unavailable' as QuotaProviderStatus,
          error: null,
          accountEmail: null,
          authKind: null,
          session: null,
          weekly: null,
          pools: [],
          resetCredits: null,
          accounts: [],
          updatedAt: null,
          local: localByProvider[kind]
        }
      }
      return {
        ...base,
        local: localByProvider[kind]
      }
    })

    return {
      source: this.source,
      syncedAt: this.syncedAt,
      refreshing: this.refreshing,
      lastError: this.lastError,
      providers
    }
  }
}
