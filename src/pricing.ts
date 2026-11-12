import type { AgentKind, PricingStatus } from './protocol'

export interface ModelRatePerMillion {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface StoredPricingCatalog {
  version: 1
  syncedAt: number
  rates: Record<string, ModelRatePerMillion>
}

export const PRICING_STORAGE_KEY = 'pricingCatalog.v1'

/**
 * Built-in baseline rates (USD per 1M tokens) used before the first online sync
 * completes or when offline with an empty cache.
 */
export const BUILTIN_MODEL_RATES: Record<string, ModelRatePerMillion> = {
  // Anthropic Claude family
  'claude-opus-5-5': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-1': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-4': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-fable-5-1': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-fable-5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },

  // OpenAI / Codex family
  'gpt-6.1-sol': { input: 2.5, output: 12.0, cacheRead: 0.25, cacheWrite: 2.5 },
  'gpt-6.1-terra': { input: 1.25, output: 6.0, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-6-astra': { input: 2.5, output: 12.0, cacheRead: 0.25, cacheWrite: 2.5 },
  'gpt-6-sol': { input: 2.5, output: 12.0, cacheRead: 0.25, cacheWrite: 2.5 },
  'gpt-6-luna': { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.6 },
  'gpt-5.6': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.0 },
  'gpt-5.4': { input: 2.0, output: 8.0, cacheRead: 0.2, cacheWrite: 2.0 },
  'gpt-5.4-mini': { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.4 },
  'gpt-5.4-nano': { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
  'gpt-5.2-codex': { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite: 1.75 },
  'gpt-5.1-codex': { input: 1.5, output: 12.0, cacheRead: 0.15, cacheWrite: 1.5 },
  'gpt-5-codex': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-5-mini': { input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite: 0.25 },
  'gpt-4.1': { input: 2.0, output: 8.0, cacheRead: 0.5, cacheWrite: 2.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 },
  'o3': { input: 2.0, output: 8.0, cacheRead: 0.5, cacheWrite: 2.0 },
  'o4-mini': { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 },

  // Google Gemini & Antigravity family
  'gemini-4-carbon': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  'gemini-4-argon': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
  'gemini-3.5-pro': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  'gemini-3.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
  'gemini-3.5-flash-lite': { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
  'gemini-3-pro': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  'gemini-3-flash': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite: 1.25 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 }
}

const DEFAULT_AGENT_FALLBACK_MODEL: Record<AgentKind, string> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-6.1-sol',
  antigravity: 'gemini-3-pro',
  gemini: 'gemini-2.5-pro'
}

export function normalizeModelId(raw: string | null | undefined): string {
  if (!raw) return ''
  let s = raw.trim().toLowerCase()
  if (s === '<synthetic>' || s === 'unknown' || s === 'default') return ''
  // Strip Bedrock regional prefixes like "us.anthropic." or "eu.anthropic."
  s = s.replace(/^(us|eu|apac)\.(anthropic|openai|google)\./, '')
  // Strip provider prefix like "anthropic/claude-..." or "models/gemini-..."
  const slashIdx = s.lastIndexOf('/')
  if (slashIdx >= 0) s = s.slice(slashIdx + 1)
  // Strip variant suffixes like ":thinking", ":free", ":beta"
  const colonIdx = s.indexOf(':')
  if (colonIdx > 0) s = s.slice(0, colonIdx)
  // Strip Claude context window suffixes like "opus[1m]" -> "opus"
  s = s.replace(/\[[^\]]*\]/g, '')
  // Strip trailing "-latest" or date stamps like "-20250929" or "-2025-10-01"
  s = s.replace(/-latest$/, '').replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '')
  // Normalize dots between digits in claude model names (e.g., claude-sonnet-4.6 -> claude-sonnet-4-6)
  if (s.startsWith('claude-')) {
    s = s.replace(/(\d)\.(\d)/g, '$1-$2')
  }
  return s
}

export function providerLabelForAgent(agent: AgentKind, model?: string | null): string {
  const m = (model || '').toLowerCase()
  if (m.includes('claude') || m.includes('fable') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) {
    return 'Anthropic'
  }
  if (m.includes('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.includes('codex')) {
    return 'OpenAI'
  }
  if (m.includes('gemini')) {
    return 'Google'
  }
  switch (agent) {
    case 'claude':
      return 'Anthropic'
    case 'codex':
      return 'OpenAI'
    case 'antigravity':
    case 'gemini':
      return 'Google'
  }
}

function isReasonableRate(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= 1000
}

export function parseModelsDevPayload(payload: unknown): Record<string, ModelRatePerMillion> {
  const out: Record<string, ModelRatePerMillion> = {}
  if (!payload || typeof payload !== 'object') return out
  const providers = payload as Record<string, unknown>

  for (const providerName of ['anthropic', 'openai', 'google', 'google-vertex']) {
    const providerObj = providers[providerName]
    if (!providerObj || typeof providerObj !== 'object') continue
    const models = (providerObj as { models?: Record<string, unknown> }).models
    if (!models || typeof models !== 'object') continue

    for (const [rawId, entry] of Object.entries(models)) {
      if (!entry || typeof entry !== 'object') continue
      const cost = (entry as { cost?: Record<string, unknown> }).cost
      if (!cost || typeof cost !== 'object') continue
      const input = Number(cost.input)
      const output = Number(cost.output)
      if (!isReasonableRate(input) || !isReasonableRate(output) || (input <= 0 && output <= 0)) {
        continue
      }
      const crRaw = Number(cost.cache_read)
      const cwRaw = Number(cost.cache_write)
      const cacheRead = isReasonableRate(crRaw) ? crRaw : +(input * 0.1).toFixed(4)
      const cacheWrite = isReasonableRate(cwRaw) ? cwRaw : input
      const norm = normalizeModelId(rawId)
      if (norm) {
        out[norm] = { input, output, cacheRead, cacheWrite }
      }
    }
  }
  return out
}

export function parseOpenRouterPayload(payload: unknown): Record<string, ModelRatePerMillion> {
  const out: Record<string, ModelRatePerMillion> = {}
  if (!payload || typeof payload !== 'object') return out
  const data = (payload as { data?: unknown[] }).data
  if (!Array.isArray(data)) return out

  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const id = String((item as { id?: unknown }).id ?? '')
    if (!/^(anthropic|openai|google)\//i.test(id)) continue
    const pricing = (item as { pricing?: Record<string, unknown> }).pricing
    if (!pricing || typeof pricing !== 'object') continue
    // OpenRouter pricing is USD per single token -> multiply by 1_000_000 (reject negative "-1" dynamic sentinels)
    const promptPerTok = Number(pricing.prompt)
    const completionPerTok = Number(pricing.completion)
    if (!Number.isFinite(promptPerTok) || !Number.isFinite(completionPerTok)) continue
    if (promptPerTok < 0 || completionPerTok < 0) continue
    if (promptPerTok === 0 && completionPerTok === 0) continue

    const input = +(promptPerTok * 1_000_000).toFixed(4)
    const output = +(completionPerTok * 1_000_000).toFixed(4)
    if (!isReasonableRate(input) || !isReasonableRate(output)) continue

    const cacheReadRaw = Number(pricing.input_cache_read)
    const cacheWriteRaw = Number(pricing.input_cache_write)
    const cacheRead =
      Number.isFinite(cacheReadRaw) && cacheReadRaw >= 0 && cacheReadRaw * 1_000_000 <= 1000
        ? +(cacheReadRaw * 1_000_000).toFixed(4)
        : +(input * 0.1).toFixed(4)
    const cacheWrite =
      Number.isFinite(cacheWriteRaw) && cacheWriteRaw >= 0 && cacheWriteRaw * 1_000_000 <= 1000
        ? +(cacheWriteRaw * 1_000_000).toFixed(4)
        : input

    const norm = normalizeModelId(id)
    if (norm) {
      out[norm] = { input, output, cacheRead, cacheWrite }
    }
  }
  return out
}

export class PricingEngine {
  private rates: Record<string, ModelRatePerMillion> = { ...BUILTIN_MODEL_RATES }
  private source: PricingStatus['source'] = 'builtin'
  private syncedAt: number | null = null
  private lastError: string | null = null
  private fetchImpl: typeof fetch
  private activeControllers = new Set<AbortController>()

  constructor(fetchImpl: typeof fetch = globalThis.fetch) {
    this.fetchImpl = fetchImpl
  }

  abortInFlight(): void {
    for (const c of this.activeControllers) {
      try {
        c.abort()
      } catch {
        // Ignore
      }
    }
    this.activeControllers.clear()
  }

  loadFromCache(cached: unknown): void {
    if (!cached || typeof cached !== 'object') return
    const obj = cached as Partial<StoredPricingCatalog>
    if (obj.version !== 1 || !obj.rates || typeof obj.rates !== 'object') return
    const merged: Record<string, ModelRatePerMillion> = { ...BUILTIN_MODEL_RATES }
    let validCount = 0
    for (const [key, rate] of Object.entries(obj.rates)) {
      if (
        rate &&
        typeof rate === 'object' &&
        isReasonableRate(rate.input) &&
        isReasonableRate(rate.output) &&
        isReasonableRate(rate.cacheRead) &&
        isReasonableRate(rate.cacheWrite)
      ) {
        merged[key] = rate
        validCount++
      }
    }
    if (validCount > 0) {
      this.applyCliAliasPropagation(merged)
      this.rates = merged
      this.syncedAt = typeof obj.syncedAt === 'number' ? obj.syncedAt : null
      this.source = 'cache'
    }
  }

  toStorableCatalog(): StoredPricingCatalog | null {
    if (!this.syncedAt) return null
    return {
      version: 1,
      syncedAt: this.syncedAt,
      rates: this.rates
    }
  }

  getStatus(): PricingStatus {
    return {
      source: this.source,
      syncedAt: this.syncedAt,
      modelCount: Object.keys(this.rates).length,
      lastError: this.lastError
    }
  }

  needsSync(intervalHours: number, now = Date.now()): boolean {
    if (!this.syncedAt || this.source !== 'online') return true
    const maxAgeMs = Math.max(1, intervalHours) * 3600_000
    return now - this.syncedAt >= maxAgeMs
  }

  async syncOnline(timeoutMs = 5000): Promise<PricingStatus> {
    const merged: Record<string, ModelRatePerMillion> = { ...BUILTIN_MODEL_RATES }
    let fetchedAny = false
    const errors: string[] = []

    // 1. OpenRouter (live market/official rates)
    try {
      const orData = await this.fetchJson('https://openrouter.ai/api/v1/models', timeoutMs)
      const parsed = parseOpenRouterPayload(orData)
      if (Object.keys(parsed).length > 0) {
        Object.assign(merged, parsed)
        fetchedAny = true
      }
    } catch (err) {
      errors.push(`openrouter: ${err instanceof Error ? err.message : String(err)}`)
    }

    // 2. models.dev (structured official provider rates including cache_read & cache_write)
    try {
      const mdData = await this.fetchJson('https://models.dev/api.json', timeoutMs)
      const parsed = parseModelsDevPayload(mdData)
      if (Object.keys(parsed).length > 0) {
        Object.assign(merged, parsed)
        fetchedAny = true
      }
    } catch (err) {
      errors.push(`models.dev: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Propagate latest flagship rates to CLI-internal codenames if not explicitly listed online
    this.applyCliAliasPropagation(merged)

    if (fetchedAny) {
      this.rates = merged
      this.syncedAt = Date.now()
      this.source = 'online'
      this.lastError = null
    } else {
      this.lastError = errors.join('; ') || 'Pricing sync failed'
    }

    return this.getStatus()
  }

  private applyCliAliasPropagation(rates: Record<string, ModelRatePerMillion>): void {
    // Claude shorthand & Fable aliases
    if (rates['claude-opus-5-5']) {
      rates['opus'] = rates['claude-opus-5-5']
    } else if (rates['claude-opus-4-6']) {
      rates['opus'] = rates['claude-opus-4-6']
    }
    const sonnetRef = rates['claude-sonnet-4-6'] || rates['claude-sonnet-4-5']
    if (sonnetRef) {
      rates['sonnet'] = sonnetRef
      if (!rates['claude-fable-5']) rates['claude-fable-5'] = sonnetRef
      if (!rates['claude-fable-5-1']) rates['claude-fable-5-1'] = sonnetRef
      rates['fable'] = rates['claude-fable-5-1'] || sonnetRef
    }
    if (rates['claude-haiku-4-5']) {
      rates['haiku'] = rates['claude-haiku-4-5']
    }

    // Gemini 4 / Antigravity internal alias propagation from latest Gemini Pro & Flash
    const geminiProRef = rates['gemini-3-pro'] || rates['gemini-2.5-pro']
    if (geminiProRef && !rates['gemini-4-carbon']) {
      rates['gemini-4-carbon'] = geminiProRef
    }
    const geminiFlashRef = rates['gemini-3-flash'] || rates['gemini-2.5-flash']
    if (geminiFlashRef && !rates['gemini-4-argon']) {
      rates['gemini-4-argon'] = geminiFlashRef
    }
  }

  private async fetchJson(url: string, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController()
    this.activeControllers.add(controller)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'orca-token-pulse/0.1' }
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return await response.json()
    } finally {
      clearTimeout(timer)
      this.activeControllers.delete(controller)
    }
  }

  resolveRate(agent: AgentKind, rawModel?: string | null): ModelRatePerMillion {
    const norm = normalizeModelId(rawModel)
    if (norm) {
      if (this.rates[norm]) return this.rates[norm]

      // Longest-prefix hyphen-boundary match so "gpt-5-mini-preview" matches "gpt-5-mini" before "gpt-5"
      const sortedKnownIds = Object.keys(this.rates).sort((a, b) => b.length - a.length)
      for (const knownId of sortedKnownIds) {
        if (norm.startsWith(`${knownId}-`) || knownId.startsWith(`${norm}-`)) {
          return this.rates[knownId]
        }
      }

      if (norm.includes('opus')) return this.rates['claude-opus-5-5'] || BUILTIN_MODEL_RATES['claude-opus-5-5']
      if (norm.includes('fable') || norm.includes('sonnet')) {
        return this.rates['claude-sonnet-4-6'] || BUILTIN_MODEL_RATES['claude-sonnet-4-6']
      }
      if (norm.includes('haiku')) return this.rates['claude-haiku-4-5'] || BUILTIN_MODEL_RATES['claude-haiku-4-5']
      if (norm.includes('terra') || norm.includes('mini')) {
        return this.rates['gpt-6.1-terra'] || BUILTIN_MODEL_RATES['gpt-6.1-terra']
      }
      if (norm.includes('luna') || norm.includes('nano') || norm.includes('lite')) {
        return this.rates['gpt-6-luna'] || BUILTIN_MODEL_RATES['gpt-6-luna']
      }
      if (norm.includes('argon') || norm.includes('flash')) {
        return this.rates['gemini-3-flash'] || BUILTIN_MODEL_RATES['gemini-3-flash']
      }
      if (norm.includes('gemini')) {
        return this.rates['gemini-3-pro'] || BUILTIN_MODEL_RATES['gemini-3-pro']
      }
      if (norm.includes('gpt-') || norm.includes('codex')) {
        return this.rates['gpt-6.1-sol'] || BUILTIN_MODEL_RATES['gpt-6.1-sol']
      }
    }

    const fallbackModel = DEFAULT_AGENT_FALLBACK_MODEL[agent]
    return this.rates[fallbackModel] || BUILTIN_MODEL_RATES[fallbackModel]
  }

  /**
   * Computes USD cost for a turn or token bucket.
   * Note: `input` here is expected to be NON-CACHED uncached input tokens, while `cacheRead` and
   * `cacheWrite` are billed at their respective cache rates, and `output + reasoning` are billed at
   * the output rate (matching Anthropic/OpenAI/Google billing semantics).
   */
  computeCostUsd(
    agent: AgentKind,
    model: string | null | undefined,
    tokens: {
      input: number
      output: number
      reasoning?: number
      cacheRead?: number
      cacheWrite?: number
    },
    explicitCostUsd?: number | null
  ): number {
    if (typeof explicitCostUsd === 'number' && Number.isFinite(explicitCostUsd) && explicitCostUsd > 0) {
      return explicitCostUsd
    }
    const rate = this.resolveRate(agent, model)
    const uncachedInput = Math.max(0, tokens.input)
    const cacheRead = Math.max(0, tokens.cacheRead ?? 0)
    const cacheWrite = Math.max(0, tokens.cacheWrite ?? 0)
    // Output tokens in Codex `last_token_usage.output_tokens` may already include reasoning when
    // `last_usage_includes_reasoning` is true; parsers normalize `output` to non-reasoning output
    // so `output + reasoning` is always total billed output tokens.
    const totalOut = Math.max(0, tokens.output) + Math.max(0, tokens.reasoning ?? 0)

    const cost =
      (uncachedInput * rate.input +
        cacheRead * rate.cacheRead +
        cacheWrite * rate.cacheWrite +
        totalOut * rate.output) /
      1_000_000
    return Number.isFinite(cost) ? cost : 0
  }
}
