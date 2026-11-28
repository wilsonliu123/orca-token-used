import type {} from 'orca/frame'
import { buildActiveRaceSquads, renderMascotSvg, renderSessionRaceTrackHtml } from './race'
import type {
  AgentKind,
  AgentRunState,
  BackgroundTaskInfo,
  DashboardSnapshot,
  LiveAgentCard,
  LocalQuotaUsageWindow,
  PeriodSummary,
  QuotaAccountSummary,
  QuotaProviderKind,
  QuotaProviderSnapshot,
  QuotaResetCredits,
  QuotasSnapshot,
  QuotaWindow,
  ScopeMode,
  StatsBreakdownMode,
  TimeBucket,
  TokenBreakdown,
  ViewTab,
  WorktreeSessionItem
} from '../protocol'
import {
  formatCountdown,
  formatDurationSpan,
  formatElapsedDuration,
  formatRateTokPerSec,
  formatRelativeTime,
  formatScaleTokPerSec,
  formatTokens,
  formatUsd,
  getMessages,
  type UiMessages
} from './i18n'
import { PROVIDER_LOGO_DATA } from './provider-logos'

const AGENT_COLORS: Record<AgentKind, string> = {
  claude: '#f97316',
  codex: '#10b981',
  antigravity: '#a855f7',
  gemini: '#38bdf8'
}

export const TAB_ORDER: readonly ViewTab[] = ['live', 'sessions', 'day', 'week', 'month', 'quotas']

const STATS_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`

function isPeriodTab(tab: ViewTab): tab is 'day' | 'week' | 'month' {
  return tab === 'day' || tab === 'week' || tab === 'month'
}

/** Pure SVG icons for the 6 view tabs */
export const TAB_ICONS_SVG: Record<ViewTab, string> = {
  // Lightning pulse / Live activity
  live: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  // Conversation bubbles (Current Worktree Sessions)
  sessions: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/></svg>`,
  // Today (Sun / 24h)
  day: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`,
  // Week (7-day bar calendar)
  week: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M8 14h8"/></svg>`,
  // Month (30-day grid calendar)
  month: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="8" cy="14" r="1" fill="currentColor"/><circle cx="12" cy="14" r="1" fill="currentColor"/><circle cx="16" cy="14" r="1" fill="currentColor"/><circle cx="8" cy="18" r="1" fill="currentColor"/><circle cx="12" cy="18" r="1" fill="currentColor"/><circle cx="16" cy="18" r="1" fill="currentColor"/></svg>`,
  // Quotas (240-degree gauge arc + needle)
  quotas: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.64 19.36a9 9 0 1 1 12.72 0"/><path d="M12 13l3.5-3.5"/><circle cx="12" cy="13" r="1.5" fill="currentColor" stroke="none"/></svg>`
}

/** Dynamic multi-wave + energy spark emblem for header branding */
const BRAND_EMBLEM_SVG = `<svg viewBox="0 0 24 24" fill="none"><path class="tp-wave-path" d="M2 14.5C4.5 14.5 5.2 7.5 7.8 7.5C10.4 7.5 11.2 17.5 13.8 17.5C16.4 17.5 17.2 9.5 19.6 9.5C21 9.5 21.5 12 22 12" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.2 2.8L9.6 9.4H13.4L11.2 15.6L16.4 8.2H12.6L13.2 2.8Z" fill="#facc15" fill-opacity="0.92"/></svg>`


const REFRESH_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>`

const WAVE_SECONDS = 60

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function providerLogoHtml(providerLabel: string, agent?: AgentKind): string {
  if (agent === 'antigravity') {
    return `<img class="tp-provider-logo tp-provider-logo-antigravity" src="${PROVIDER_LOGO_DATA.antigravity}" alt="" aria-hidden="true" />`
  }
  const provider = providerLabel.toLowerCase()
  const key = provider.includes('openai')
    ? 'openai'
    : provider.includes('anthropic')
      ? 'anthropic'
      : provider.includes('google')
        ? 'google'
        : null
  if (!key) return ''
  return `<img class="tp-provider-logo tp-provider-logo-${key}" src="${PROVIDER_LOGO_DATA[key]}" alt="" aria-hidden="true" />`
}

function reasoningBadgeHtml(levels: string[] | undefined, msg: UiMessages): string {
  const values = Array.from(new Set((levels ?? []).filter((level) => level.trim())))
  const current = values.at(-1) ?? msg.reasoningNotRecorded
  const title = values.length > 0
    ? `${msg.reasoningLabel}: ${values.join(' → ')}`
    : `${msg.reasoningLabel}: ${msg.reasoningNotRecorded}`
  return `<span class="tp-reasoning-chip" title="${escapeHtml(title)}">${escapeHtml(current)}</span>`
}

type CollapsedGroups = Readonly<Record<string, boolean>>

function renderCollapseGroup(
  key: string,
  label: string,
  count: number,
  content: string,
  collapsed: boolean
): string {
  return `
    <details class="tp-collapse-group" data-collapse-key="${escapeHtml(key)}"${collapsed ? '' : ' open'}>
      <summary class="tp-collapse-summary">
        <span>${escapeHtml(label)} (${count})</span>
        <span class="tp-collapse-chevron" aria-hidden="true">⌄</span>
      </summary>
      ${content}
    </details>
  `
}

function allLiveAgents(snap: DashboardSnapshot): LiveAgentCard[] {
  return [...snap.live.agents, ...(snap.live.subagents ?? [])]
}

function findLiveAgent(snap: DashboardSnapshot, key: string): LiveAgentCard | null {
  return (
    allLiveAgents(snap).find((agent) => agent.sessionKey === key || agent.id === key) ?? null
  )
}

export function formatProjectWorktreeLabel(
  project: string | null | undefined,
  worktree: string | null | undefined,
  branch?: string | null
): string {
  const p = project?.trim() || ''
  const w = worktree?.trim() || ''
  const b = branch?.trim() || ''

  if (p && w && p !== w) {
    return b && b !== w ? `${p} / ${w} (${b})` : `${p} / ${w}`
  }
  if (p && b && p !== b) {
    return `${p} / ${b}`
  }
  if (w && b && w !== b) {
    return `${w} (${b})`
  }
  return p || w || 'local'
}

export function renderTricolorBar(tokens: TokenBreakdown, msg: UiMessages, showLegend = true): string {
  const inputTotal = Math.max(0, tokens.input + tokens.cacheWrite)
  const cacheTotal = Math.max(0, tokens.cacheRead)
  const outTotal = Math.max(0, tokens.output + tokens.reasoning)
  const sum = inputTotal + cacheTotal + outTotal

  const inPct = sum > 0 ? Math.max(inputTotal > 0 ? 2 : 0, (inputTotal / sum) * 100) : 33
  const cachePct = sum > 0 ? Math.max(cacheTotal > 0 ? 2 : 0, (cacheTotal / sum) * 100) : 34
  const outPct = sum > 0 ? Math.max(outTotal > 0 ? 2 : 0, (outTotal / sum) * 100) : 33

  const bar = `
    <div class="tp-tribar">
      <div class="tp-tri-in" style="width:${inPct.toFixed(1)}%"></div>
      <div class="tp-tri-cache" style="width:${cachePct.toFixed(1)}%"></div>
      <div class="tp-tri-out" style="width:${outPct.toFixed(1)}%"></div>
    </div>
  `
  if (!showLegend) return bar

  return `
    ${bar}
    <div class="tp-tri-legend">
      <span><i class="tp-dot" style="background:var(--tp-in)"></i>${escapeHtml(msg.inputShort)} ${formatTokens(inputTotal)}</span>
      <span><i class="tp-dot" style="background:var(--tp-cache)"></i>${escapeHtml(msg.cacheShort)} ${formatTokens(cacheTotal)}</span>
      <span><i class="tp-dot" style="background:var(--tp-out)"></i>${escapeHtml(msg.outputShort)} ${formatTokens(outTotal)}</span>
    </div>
  `
}

export function renderSparklineSvg(points: number[], color: string): string {
  const w = 78
  const h = 20
  if (!points || points.length === 0) {
    return `<svg class="tp-spark-svg" viewBox="0 0 ${w} ${h}"><line x1="2" y1="${h - 4}" x2="${w - 2}" y2="${h - 4}" stroke="currentColor" stroke-opacity="0.22" stroke-width="1.5"/></svg>`
  }
  const vals = points.length === 1 ? [points[0], points[0]] : points
  const maxV = Math.max(...vals, 1)
  const minV = Math.min(...vals, 0)
  const span = Math.max(maxV - minV, 1)

  const xs: number[] = new Array(vals.length)
  const ys: number[] = new Array(vals.length)
  for (let idx = 0; idx < vals.length; idx++) {
    xs[idx] = 2 + (idx / (vals.length - 1)) * (w - 4)
    ys[idx] = h - 3 - ((vals[idx] - minV) / span) * (h - 6)
  }
  const smoothPath = buildSmoothSplinePath(xs, ys, 1.5, h - 2)

  return `
    <svg class="tp-spark-svg" viewBox="0 0 ${w} ${h}">
      <path
        fill="none"
        stroke="${color}"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        d="${smoothPath}"
      />
    </svg>
  `
}

const IO_WAVE_WIDTH = 320
const IO_WAVE_HEIGHT = 146
const IO_WAVE_PAD_TOP = 8
const IO_WAVE_PAD_BOTTOM = 6
const IO_WAVE_USABLE_H = IO_WAVE_HEIGHT - IO_WAVE_PAD_TOP - IO_WAVE_PAD_BOTTOM
const IO_WAVE_BOTTOM_Y = IO_WAVE_HEIGHT - IO_WAVE_PAD_BOTTOM
const IO_VISIBLE_SPAN_SEC = 56

function computeNiceEvenCeiling(rawMax: number): number {
  if (!Number.isFinite(rawMax) || rawMax <= 0) return 20
  const padded = rawMax * 1.12
  if (padded <= 10) return Math.max(4, Math.ceil(padded / 2) * 2)
  if (padded <= 100) return Math.ceil(padded / 4) * 4
  if (padded <= 1_000) return Math.ceil(padded / 20) * 20
  if (padded <= 10_000) return Math.ceil(padded / 200) * 200
  return Math.ceil(padded / 2_000) * 2_000
}

/**
 * Smooth Cardinal / Catmull-Rom cubic Bezier spline (`tension = 0.92` of central difference):
 * Produces silky, flowing Smoothed Line Chart waves with rounded domes while keeping
 * `0 tok/s` baseline segments flat with zero negative overshoot.
 */
export function buildSmoothSplinePath(
  xs: readonly number[],
  ys: readonly number[],
  minY: number,
  maxY: number
): string {
  const n = xs.length
  if (n === 0) return ''
  if (n === 1) return `M ${xs[0].toFixed(2)},${ys[0].toFixed(2)}`

  const slopes = new Float64Array(n)
  const baselineEps = 0.08
  const tension = 0.92

  for (let i = 0; i < n; i++) {
    if (ys[i] >= maxY - baselineEps) {
      slopes[i] = 0
      continue
    }
    if (i === 0) {
      const dx = xs[1] - xs[0]
      slopes[0] = dx > 0 ? ((ys[1] - ys[0]) / dx) * 0.75 : 0
    } else if (i === n - 1) {
      const dx = xs[n - 1] - xs[n - 2]
      slopes[n - 1] = dx > 0 ? ((ys[n - 1] - ys[n - 2]) / dx) * 0.75 : 0
    } else {
      const dx = xs[i + 1] - xs[i - 1]
      slopes[i] = dx > 0 ? ((ys[i + 1] - ys[i - 1]) / dx) * tension : 0
    }
  }

  const clampY = (v: number): number => Math.min(maxY, Math.max(minY, v))
  const segs: string[] = [`M ${xs[0].toFixed(2)},${ys[0].toFixed(2)}`]

  for (let i = 0; i < n - 1; i++) {
    const x0 = xs[i]
    const x1 = xs[i + 1]
    const y0 = ys[i]
    const y1 = ys[i + 1]
    const dx = x1 - x0
    const segMinY = Math.max(minY, Math.min(y0, y1) - 2.4)
    const segMaxY = Math.min(maxY, Math.max(y0, y1) + 2.4)
    const cp1x = x0 + dx / 3
    const cp1y = Math.min(segMaxY, Math.max(segMinY, clampY(y0 + (slopes[i] * dx) / 3)))
    const cp2x = x1 - dx / 3
    const cp2y = Math.min(segMaxY, Math.max(segMinY, clampY(y1 - (slopes[i + 1] * dx) / 3)))
    segs.push(
      `C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`
    )
  }

  return segs.join(' ')
}

function buildWavePathsFromCoords(
  xs: readonly number[],
  ys: readonly number[]
): { strokePath: string; areaPath: string } {
  const strokePath = buildSmoothSplinePath(xs, ys, IO_WAVE_PAD_TOP, IO_WAVE_BOTTOM_Y)
  if (!strokePath || xs.length === 0) {
    return { strokePath: '', areaPath: '' }
  }
  const firstX = xs[0].toFixed(2)
  const lastX = xs[xs.length - 1].toFixed(2)
  const bottomStr = IO_WAVE_BOTTOM_Y.toFixed(2)
  const areaPath = `${strokePath} L ${lastX},${bottomStr} L ${firstX},${bottomStr} Z`
  return { strokePath, areaPath }
}

export function renderIoWaveformSvg(
  rawSeries: readonly number[] | undefined,
  channel: 'out' | 'in'
): { html: string; scaleMax: number } {
  const vals = new Array<number>(WAVE_SECONDS).fill(0)
  if (Array.isArray(rawSeries) && rawSeries.length > 0) {
    const tail = rawSeries.slice(-WAVE_SECONDS)
    const offset = WAVE_SECONDS - tail.length
    for (let i = 0; i < tail.length; i++) {
      const v = tail[i]
      vals[offset + i] = Number.isFinite(v) && v > 0 ? v : 0
    }
  }

  // Initial static frame aligns with `[endSec - 57 .. endSec - 1]` so 60fps RAF continues seamlessly without jump
  const endIdx = WAVE_SECONDS - 1
  const playheadIdx = endIdx - 1.05
  const pxPerSec = IO_WAVE_WIDTH / IO_VISIBLE_SPAN_SEC

  let visibleMax = 0
  for (let i = Math.max(0, Math.floor(playheadIdx - IO_VISIBLE_SPAN_SEC)); i <= endIdx; i++) {
    if (vals[i] > visibleMax) visibleMax = vals[i]
  }
  const scaleMax = computeNiceEvenCeiling(visibleMax)

  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < WAVE_SECONDS; i++) {
    xs.push(IO_WAVE_WIDTH - (playheadIdx - i) * pxPerSec)
    const ratio = Math.min(1, Math.max(0, vals[i] / scaleMax))
    ys.push(IO_WAVE_PAD_TOP + IO_WAVE_USABLE_H * (1 - ratio))
  }

  const { strokePath, areaPath } = buildWavePathsFromCoords(xs, ys)
  const midY = IO_WAVE_PAD_TOP + IO_WAVE_USABLE_H * 0.5
  const strokeGradId = `tp-io-stroke-${channel}`
  const fillGradId = `tp-io-fill-${channel}`
  const clipId = `tp-io-clip-${channel}`
  const midLabel = formatScaleTokPerSec(scaleMax * 0.5)
  const midTopPct = (midY / IO_WAVE_HEIGHT) * 100

  const html = `
    <div class="tp-io-wave-wrap">
      <svg class="tp-io-wave-svg" viewBox="0 0 ${IO_WAVE_WIDTH} ${IO_WAVE_HEIGHT}" preserveAspectRatio="none">
        <defs>
          <clipPath id="${clipId}">
            <rect x="0" y="0" width="${IO_WAVE_WIDTH}" height="${IO_WAVE_HEIGHT}"/>
          </clipPath>
          <linearGradient id="${strokeGradId}" gradientUnits="userSpaceOnUse" x1="0" y1="${IO_WAVE_PAD_TOP}" x2="0" y2="${IO_WAVE_BOTTOM_Y}">
            <stop offset="0%" stop-color="#facc15"/>
            <stop offset="34%" stop-color="#a3e635"/>
            <stop offset="64%" stop-color="#10b981"/>
            <stop offset="100%" stop-color="#10b981"/>
          </linearGradient>
          <linearGradient id="${fillGradId}" gradientUnits="userSpaceOnUse" x1="0" y1="${IO_WAVE_PAD_TOP}" x2="0" y2="${IO_WAVE_BOTTOM_Y}">
            <stop offset="0%" stop-color="#facc15" stop-opacity="0.22"/>
            <stop offset="46%" stop-color="#10b981" stop-opacity="0.11"/>
            <stop offset="100%" stop-color="#10b981" stop-opacity="0.0"/>
          </linearGradient>
        </defs>
        <line
          x1="0"
          y1="${midY.toFixed(1)}"
          x2="${IO_WAVE_WIDTH}"
          y2="${midY.toFixed(1)}"
          stroke="var(--tp-io-grid)"
          stroke-width="1"
          stroke-dasharray="2.5 3.5"
          vector-effect="non-scaling-stroke"
        />
        <g clip-path="url(#${clipId})">
          <path data-io-path="${channel}-area" d="${areaPath}" fill="url(#${fillGradId})"/>
          <path
            data-io-path="${channel}-stroke"
            d="${strokePath}"
            fill="none"
            stroke="url(#${strokeGradId})"
            stroke-width="1.95"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
        </g>
      </svg>
      <span class="tp-io-mid-label" data-io-text="${channel}-mid" style="top:${midTopPct.toFixed(2)}%">${escapeHtml(midLabel)}</span>
    </div>
  `

  return { html, scaleMax }
}

export function computeCacheHitPercent(tokens: TokenBreakdown): number | null {
  const denom = tokens.input + tokens.cacheRead + tokens.cacheWrite
  if (denom < 1000) return null
  return Math.max(0, Math.min(100, Math.round((tokens.cacheRead / denom) * 100)))
}

function bgTasksSignature(tasks: readonly BackgroundTaskInfo[] | undefined): string {
  if (!tasks || tasks.length === 0) return ''
  return JSON.stringify(tasks.map((t) => [t.id, t.startedAt, t.label]))
}

function renderBgTaskStripHtml(
  tasks: readonly BackgroundTaskInfo[] | undefined,
  nowMs: number
): string {
  if (!tasks || tasks.length === 0) return ''
  const primary = tasks[0]
  const extraCount = tasks.length - 1
  const tooltip = tasks
    .map((t) => `>_ ${t.label} (${formatElapsedDuration(nowMs - t.startedAt)})`)
    .join('\n')
  const elapsedText = formatElapsedDuration(nowMs - primary.startedAt)
  return `
    <div class="tp-bg-strip" title="${escapeHtml(tooltip)}">
      <span class="tp-bg-prompt" aria-hidden="true">&gt;_</span>
      <span class="tp-bg-cmd">${escapeHtml(primary.label)}</span>
      ${extraCount > 0 ? `<span class="tp-bg-more">+${extraCount}</span>` : ''}
      <span class="tp-bg-elapsed" data-bg-started-at="${primary.startedAt}">${escapeHtml(elapsedText)}</span>
    </div>
  `
}

function renderDetailBgTasksSectionHtml(
  tasks: readonly BackgroundTaskInfo[] | undefined,
  msg: UiMessages,
  nowMs: number
): string {
  if (!tasks || tasks.length === 0) return ''
  const rows = tasks
    .map((t) => {
      const elapsedText = formatElapsedDuration(nowMs - t.startedAt)
      return `
        <div class="tp-bg-strip tp-io-bg-item" title="${escapeHtml(t.label)}">
          <span class="tp-bg-prompt" aria-hidden="true">&gt;_</span>
          <span class="tp-bg-cmd">${escapeHtml(t.label)}</span>
          <span class="tp-bg-elapsed" data-bg-started-at="${t.startedAt}">${escapeHtml(elapsedText)}</span>
        </div>
      `
    })
    .join('')
  return `
    <section class="tp-io-bg-section" data-io-bg-tasks data-bg-sig="${escapeHtml(bgTasksSignature(tasks))}" aria-label="${escapeHtml(msg.backgroundTasksHeader)}">
      <div class="tp-io-panel-hdr">
        <span class="tp-io-panel-title">${escapeHtml(msg.backgroundTasksHeader)} (${tasks.length})</span>
      </div>
      <div class="tp-io-bg-list">${rows}</div>
    </section>
  `
}

export function updateBgElapsedNodes(root: ParentNode, nowMs = Date.now()): number {
  const nodes = root.querySelectorAll<HTMLElement>('[data-bg-started-at]')
  let updated = 0
  for (const node of nodes) {
    const raw = node.dataset?.bgStartedAt ?? node.getAttribute('data-bg-started-at')
    const startedAt = Number(raw)
    if (!Number.isFinite(startedAt) || startedAt <= 0) continue
    const nextText = formatElapsedDuration(nowMs - startedAt)
    if (node.textContent !== nextText) {
      node.textContent = nextText
    }
    updated++
  }
  return updated
}

export function renderLiveAgentDetailHtml(
  agent: LiveAgentCard,
  msg: UiMessages,
  nowMs = Date.now()
): string {
  const providerModel = `${agent.providerLabel} · ${agent.modelLabel}`
  const projWt = formatProjectWorktreeLabel(agent.projectName, agent.workspaceName)
  const outTotal = Math.max(0, agent.tokens.output + agent.tokens.reasoning)
  const inTotal = Math.max(0, agent.tokens.input + agent.tokens.cacheWrite)
  const cacheTotal = Math.max(0, agent.tokens.cacheRead)
  const cacheHitPct = computeCacheHitPercent(agent.tokens)
  const cacheHitHtml =
    cacheHitPct !== null
      ? `<span class="tp-cache-hit${cacheHitPct < 50 ? ' tp-cache-hit-low' : ''}" data-io-text="cache-hit">${escapeHtml(msg.cacheShort)} ${cacheHitPct}%</span>`
      : ''

  const outWave = renderIoWaveformSvg(agent.outSeries, 'out')
  const inWave = renderIoWaveformSvg(agent.inSeries, 'in')

  return `
    <div class="tp-io-monitor" data-detail-session-key="${escapeHtml(agent.sessionKey)}">
      <div class="tp-io-topbar">
        <button type="button" class="tp-io-back-btn" data-live-back="1" aria-label="Back">← ${escapeHtml(msg.navShort.live)}</button>
        <span class="tp-live-1s-pill">
          <span class="tp-live-1s-dot"></span>${escapeHtml(msg.live1sBadge)}
        </span>
      </div>

      <div class="tp-io-meta-stack">
        <div class="tp-io-meta-line">
          <span class="tp-agent-badge tp-agent-${agent.agent}">${escapeHtml(msg.agentNames[agent.agent])}</span>
          <span class="tp-state tp-state-${agent.state}" data-io-state-wrap>
            <span class="tp-state-dot"></span><span data-io-text="state-label">${escapeHtml(msg.states[agent.state])}</span>
          </span>
          <span class="tp-row-left" style="gap:5px">
            <span class="tp-model-chip" title="${escapeHtml(providerModel)}">${providerLogoHtml(agent.providerLabel, agent.agent)}<span data-io-text="model">${escapeHtml(agent.modelLabel)}</span></span>
            ${reasoningBadgeHtml(agent.reasoningLevels, msg)}
          </span>
        </div>
        <div class="tp-row-between">
          <div class="tp-session-title tp-title-${agent.state}" data-io-text="title" title="${escapeHtml(agent.title)}">${escapeHtml(agent.title)}</div>
          <span class="tp-project-tag" data-io-text="proj" title="${escapeHtml(agent.workspacePath || projWt)}">${escapeHtml(projWt)}</span>
        </div>
        <div class="tp-io-meta-line">
          <span>${escapeHtml(msg.peakLabel)} <span class="tp-io-accent-peak" data-io-text="peak">${agent.tps.peakTps.toFixed(1)}/s</span></span>
          <span>${escapeHtml(msg.outputShort)} <strong data-io-text="tok-out">${formatTokens(outTotal)}</strong></span>
          <span>${escapeHtml(msg.inputShort)} <strong data-io-text="tok-in">${formatTokens(inTotal)}</strong></span>
          <span>${escapeHtml(msg.cacheShort)} <strong data-io-text="tok-cache">${formatTokens(cacheTotal)}</strong></span>
          ${cacheHitHtml}
          <span>${escapeHtml(msg.costShort)} <span class="tp-cost-pill" data-io-text="cost">${formatUsd(agent.tokens.costUsd)}</span></span>
        </div>
      </div>

      ${renderDetailBgTasksSectionHtml(agent.backgroundTasks, msg, nowMs)}

      <section class="tp-io-panel" aria-label="${escapeHtml(msg.outputStreamLabel)}">
        <div class="tp-io-panel-hdr">
          <span class="tp-io-panel-title">${escapeHtml(msg.outputStreamLabel)}</span>
          <span class="tp-io-panel-rate" data-io-text="out-rate">${escapeHtml(formatRateTokPerSec(agent.liveOutRate))}</span>
        </div>
        <div class="tp-row-between">
          <span class="tp-io-scale-max" data-io-text="out-max">${escapeHtml(formatScaleTokPerSec(outWave.scaleMax))}</span>
          <span class="tp-session-avg">${escapeHtml(msg.avgLabel)} <span data-io-text="avg">${formatRateTokPerSec(agent.tps.avgTps)}</span></span>
        </div>
        ${outWave.html}
      </section>

      <section class="tp-io-panel" aria-label="${escapeHtml(msg.inputStreamLabel)}">
        <div class="tp-io-panel-hdr">
          <span class="tp-io-panel-title">${escapeHtml(msg.inputStreamLabel)}</span>
          <span class="tp-io-panel-rate" data-io-text="in-rate">${escapeHtml(formatRateTokPerSec(agent.liveInRate))}</span>
        </div>
        <div class="tp-io-scale-max" data-io-text="in-max">${escapeHtml(formatScaleTokPerSec(inWave.scaleMax))}</div>
        ${inWave.html}
      </section>
    </div>
  `
}

export function renderStackedChartSvg(buckets: TimeBucket[], msg: UiMessages): string {
  const width = 320
  const height = 112
  const padTop = 6
  const padBottom = 6
  const usableH = height - padTop - padBottom

  const maxBucket = Math.max(...buckets.map((b) => b.totalTokens), 1)
  const n = Math.max(buckets.length, 1)
  const slotW = width / n
  const barW = Math.max(3, Math.min(22, slotW * 0.68))

  const gridLines = [0.25, 0.5, 0.75]
    .map((ratio) => {
      const y = (padTop + usableH * (1 - ratio)).toFixed(1)
      return `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="currentColor" stroke-opacity="0.08" stroke-width="1"/>`
    })
    .join('')

  const agentStackOrder: readonly AgentKind[] = ['claude', 'codex', 'antigravity', 'gemini']
  const barsSvg: string[] = []

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]
    const x = i * slotW + (slotW - barW) / 2
    let currentBottom = height - padBottom

    const tooltipParts = [
      `${b.label}: ${formatTokens(b.totalTokens)} tok (${formatUsd(b.costUsd)})`
    ]
    for (const ak of agentStackOrder) {
      if (b.byAgent[ak] > 0) {
        tooltipParts.push(`${msg.agentNames[ak]}: ${formatTokens(b.byAgent[ak])}`)
      }
    }
    const tooltip = escapeHtml(tooltipParts.join(' · '))

    if (b.totalTokens <= 0) {
      barsSvg.push(
        `<rect x="${x.toFixed(1)}" y="${(height - padBottom - 1.5).toFixed(1)}" width="${barW.toFixed(1)}" height="1.5" rx="0.75" fill="currentColor" fill-opacity="0.12"><title>${tooltip}</title></rect>`
      )
      continue
    }

    const groupRects: string[] = []
    for (const ak of agentStackOrder) {
      const val = b.byAgent[ak]
      if (val <= 0) continue
      const segH = Math.max(1.5, (val / maxBucket) * usableH)
      const y = Math.max(padTop, currentBottom - segH)
      groupRects.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(currentBottom - y).toFixed(1)}" rx="1.5" fill="${AGENT_COLORS[ak]}"/>`
      )
      currentBottom = y
    }

    barsSvg.push(`<g><title>${tooltip}</title>${groupRects.join('')}</g>`)
  }

  let axisLabels: string[] = []
  if (buckets.length === 24) {
    axisLabels = ['00:00', '06:00', '12:00', '18:00', '23:00']
  } else if (buckets.length === 7) {
    axisLabels = buckets.map((b) => b.label)
  } else if (buckets.length > 0) {
    const mid = Math.floor(buckets.length / 2)
    axisLabels = [buckets[0].label, buckets[mid].label, buckets[buckets.length - 1].label]
  }

  return `
    <div class="tp-chart-wrap">
      <svg class="tp-chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        ${gridLines}
        ${barsSvg.join('')}
      </svg>
      <div class="tp-chart-labels">
        ${axisLabels.map((lbl) => `<span>${escapeHtml(lbl)}</span>`).join('')}
      </div>
    </div>
  `
}

function renderLiveView(
  snap: DashboardSnapshot,
  msg: UiMessages,
  collapsedGroups: CollapsedGroups = {},
  nowMs = Date.now()
): string {
  const { tokens, tps, agents, subagents = [] } = snap.live
  const todayCost = snap.periods.all.day.tokens.costUsd

  const { squads, mascotByKey } = buildActiveRaceSquads(agents, subagents)
  const raceTrackHtml = renderSessionRaceTrackHtml(squads, mascotByKey, formatRateTokPerSec, msg)

  const kpiHtml = `
    <div class="tp-live-kpi-sticky">
      <div class="tp-kpi-grid">
        <div class="tp-card">
          <div class="tp-kpi-label">${escapeHtml(msg.liveTpsLabel)}</div>
          <div class="tp-kpi-value tp-kpi-tps">${tps.liveTps.toFixed(1)} <span style="font-size:12px;font-weight:600">tok/s</span></div>
          <div class="tp-kpi-meta">${escapeHtml(msg.peakLabel)} ${tps.peakTps.toFixed(1)} · ${escapeHtml(msg.avgLabel)} ${tps.avgTps.toFixed(1)}</div>
        </div>
        <div class="tp-card">
          <div class="tp-kpi-label">${escapeHtml(msg.liveCostLabel)}</div>
          <div class="tp-kpi-value tp-kpi-cost">${formatUsd(tokens.costUsd)}</div>
          <div class="tp-kpi-meta">${escapeHtml(msg.todayCostLabel)}: ${formatUsd(todayCost)}</div>
          <div class="tp-kpi-meta">${escapeHtml(msg.activeTokensLabel)}: ${formatTokens(tokens.total)}</div>
        </div>
      </div>
      <div class="tp-live-token-bar">
        ${renderTricolorBar(tokens, msg, true)}
      </div>
      ${raceTrackHtml}
    </div>
  `

  const renderAgentCard = (a: LiveAgentCard, nested = false): string => {
    const color = AGENT_COLORS[a.agent]
    const providerModel = `${a.providerLabel} · ${a.modelLabel}`
    const projWt = formatProjectWorktreeLabel(a.projectName, a.workspaceName)
    const mascot = mascotByKey.get(a.sessionKey)
    const avatarHtml = mascot
      ? `<span class="tp-racer-avatar${nested ? ' tp-racer-avatar-sub' : ''}" style="background:${mascot.palette.tint}" aria-hidden="true">${renderMascotSvg(mascot, 'tp-racer-avatar-svg')}</span>`
      : ''
    return `
      <div
        class="tp-item-card tp-live-card-clickable${nested ? ' tp-subagent-card' : ''}"
        role="button"
        tabindex="0"
        data-live-agent-key="${escapeHtml(a.sessionKey)}"
        aria-label="${escapeHtml(`${nested ? `${msg.subagentsHeader} · ` : ''}${msg.agentNames[a.agent]} · ${a.title}`)}"
      >
        <div class="tp-row-between">
          <div class="tp-row-left">
            ${nested ? '<span class="tp-subagent-marker" aria-hidden="true">↳</span>' : ''}
            ${avatarHtml}
            <span class="tp-agent-badge tp-agent-${a.agent}">${escapeHtml(msg.agentNames[a.agent])}</span>
            <span class="tp-state tp-state-${a.state}">
              <span class="tp-state-dot"></span>${escapeHtml(msg.states[a.state])}
            </span>
          </div>
          <span class="tp-mono-stat" style="color:${color}">
            ${formatRateTokPerSec(a.liveOutRate)}<span class="tp-expand-chevron">›</span>
          </span>
        </div>
        <div class="tp-row-between">
          <div class="tp-row-left">
            <span class="tp-model-chip" title="${escapeHtml(providerModel)}">${providerLogoHtml(a.providerLabel, a.agent)}<span>${escapeHtml(a.modelLabel)}</span></span>
            ${reasoningBadgeHtml(a.reasoningLevels, msg)}
          </div>
          ${renderSparklineSvg(a.sparkline, color)}
        </div>
        <div class="tp-row-between">
          <div class="tp-session-title tp-title-${a.state}" title="${escapeHtml(a.title)}">${escapeHtml(a.title)}</div>
          <span class="tp-session-avg">${escapeHtml(msg.avgLabel)} ${formatRateTokPerSec(a.tps.avgTps)}</span>
        </div>
        ${renderBgTaskStripHtml(a.backgroundTasks, nowMs)}
        <div class="tp-row-between" style="font-size:11px;color:var(--tp-muted)">
          <span class="tp-project-tag" title="${escapeHtml(a.workspacePath || projWt)}">${escapeHtml(projWt)}</span>
          <span>
            ${(() => {
              const hit = computeCacheHitPercent(a.tokens)
              return hit !== null && a.tokens.total >= 5000
                ? `<span class="tp-cache-hit${hit < 50 ? ' tp-cache-hit-low' : ''}">${escapeHtml(msg.cacheShort)} ${hit}%</span> · `
                : ''
            })()}<strong style="color:var(--tp-fg);font-family:var(--tp-font-mono)">${formatTokens(a.tokens.total)}</strong> tok ·
            <span class="tp-cost-pill">${formatUsd(a.tokens.costUsd)}</span>
          </span>
        </div>
      </div>
    `
  }

  const allSessionKeys = new Set([...agents, ...subagents].map((agent) => agent.sessionKey))
  const parentByChild = new Map<string, string>()
  const childrenByParent = new Map<string, LiveAgentCard[]>()
  const orphanSubagents: LiveAgentCard[] = []
  for (const child of subagents) {
    const parent = child.parentSessionKey
    // Drop the edge that would close a malformed parent cycle.
    let ancestor = parent
    while (ancestor && ancestor !== child.sessionKey) ancestor = parentByChild.get(ancestor)
    if (!parent || !allSessionKeys.has(parent) || ancestor === child.sessionKey) {
      orphanSubagents.push(child)
      continue
    }
    parentByChild.set(child.sessionKey, parent)
    const children = childrenByParent.get(parent) ?? []
    children.push(child)
    childrenByParent.set(parent, children)
  }

  const renderAgentCards = (items: LiveAgentCard[], nested = false): string => {
    const renderSubagentGroups = (
      parent: LiveAgentCard,
      children: LiveAgentCard[],
      depth: number
    ): string => {
      const parentKey = `subagents:${parent.sessionKey}`
      const groups = groupOrder
        .map((state) => ({
          state,
          items: children.filter((child) => child.state === state)
        }))
        .filter((group) => group.items.length > 0)
      const stateSummary = groups
        .map((group) => `${msg.states[group.state]} ${group.items.length}`)
        .join(' · ')
      const collapsed = collapsedGroups[parentKey] ?? groups.every((group) => group.state === 'done')
      const content = groups
        .map((group) => {
          const stateKey = `${parentKey}:${group.state}`
          return renderCollapseGroup(
            stateKey,
            msg.states[group.state],
            group.items.length,
            `<div class="tp-subagent-status-cards">${group.items
              .map((child) => renderTree(child, depth + 1))
              .join('')}</div>`,
            collapsedGroups[stateKey] ?? group.state === 'done'
          )
        })
        .join('')
      return `
        <details class="tp-subagent-details" data-collapse-key="${escapeHtml(parentKey)}"${collapsed ? '' : ' open'}>
          <summary class="tp-collapse-summary tp-subagent-summary">
            <span>↳ ${escapeHtml(msg.subagentsHeader)} (${children.length})</span>
            <span class="tp-subagent-state-summary">${escapeHtml(stateSummary)}</span>
            <span class="tp-collapse-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="tp-subagent-children">${content}</div>
        </details>
      `
    }

    const renderTree = (agent: LiveAgentCard, depth = 0): string => {
      const children = childrenByParent.get(agent.sessionKey) ?? []
      return `${renderAgentCard(agent, depth > 0)}${
        children.length > 0 ? renderSubagentGroups(agent, children, depth) : ''
      }`
    }

    const className = nested ? 'tp-subagent-orphans' : 'tp-list'
    return `<div class="${className}">${items.map((agent) => renderTree(agent, nested ? 1 : 0)).join('')}</div>`
  }

  const groupOrder: AgentRunState[] = ['working', 'waiting', 'blocked', 'done']
  const rootCount = agents.length + orphanSubagents.length
  const cardsHtml =
    rootCount === 0
      ? `<div class="tp-empty">${escapeHtml(msg.noLiveAgents)}</div>`
      : groupOrder
          .map((state) => {
            const rootItems = agents.filter((agent) => agent.state === state)
            const orphanItems = orphanSubagents.filter((agent) => agent.state === state)
            const totalItems = rootItems.length + orphanItems.length
            if (totalItems === 0) return ''
            const key = `live:${state}`
            const content = [
              rootItems.length > 0 ? renderAgentCards(rootItems) : '',
              orphanItems.length > 0 ? renderAgentCards(orphanItems, true) : ''
            ].join('')
            return renderCollapseGroup(
              key,
              msg.states[state],
              totalItems,
              content,
              collapsedGroups[key] ?? state === 'done'
            )
          })
          .join('')

  return `
    ${kpiHtml}
    <div class="tp-section-hdr">
      <span>${escapeHtml(msg.runningAgentsHeader)} (${rootCount})</span>
    </div>
    ${cardsHtml}
  `
}

function renderSessionsView(
  snap: DashboardSnapshot,
  msg: UiMessages,
  nowMs: number,
  collapsedGroups: CollapsedGroups = {}
): string {
  const list = snap.sessions
  const totalWorktreeCost = list.reduce((acc, s) => acc + s.tokens.costUsd, 0)
  const totalWorktreeTok = list.reduce((acc, s) => acc + s.tokens.total, 0)
  const currentProjWt = formatProjectWorktreeLabel(
    snap.workspace.project,
    snap.workspace.name,
    snap.workspace.branch
  )

  const summaryStrip = `
    <div class="tp-card">
      <div class="tp-row-between">
        <span class="tp-kpi-label">${escapeHtml(currentProjWt)} · ${list.length} ${escapeHtml(msg.sessionsCountSuffix)}</span>
        <span class="tp-cost-pill">${formatUsd(totalWorktreeCost)}</span>
      </div>
      <div class="tp-kpi-meta">${escapeHtml(msg.sortedNewestHint)} · ${escapeHtml(msg.totalTokensLabel)}: ${formatTokens(totalWorktreeTok)} tok</div>
    </div>
  `

  if (list.length === 0) {
    return `${summaryStrip}<div class="tp-empty">${escapeHtml(msg.noSessionsInWorktree)}</div>`
  }

  const renderSessionItems = (items: WorktreeSessionItem[]): string =>
    `<div class="tp-list">${items
      .map((s) => {
      const rel = formatRelativeTime(s.updatedAt, nowMs, msg)
      const providerModel = `${s.providerLabel} · ${s.modelLabel}`
      const projWt = formatProjectWorktreeLabel(s.projectName, s.workspaceName)
      return `
        <div class="tp-item-card">
          <div class="tp-session-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</div>
          <div class="tp-row-between">
            <div class="tp-row-left">
              <span class="tp-agent-badge tp-agent-${s.agent}">${escapeHtml(msg.agentNames[s.agent])}</span>
            <span class="tp-model-chip" title="${escapeHtml(providerModel)}">${providerLogoHtml(s.providerLabel, s.agent)}<span>${escapeHtml(s.modelLabel)}</span></span>
            ${reasoningBadgeHtml(s.reasoningLevels, msg)}
            </div>
            <span class="tp-mono-stat">${s.tps.avgTps.toFixed(1)} tok/s</span>
          </div>
          <div class="tp-row-between" style="font-size:11px;color:var(--tp-muted)">
            <span class="tp-row-left" style="gap:5px">
              <span class="tp-project-tag" title="${escapeHtml(s.workspacePath || projWt)}">${escapeHtml(projWt)}</span>
              <span>${escapeHtml(rel)}${s.active ? ` · <strong style="color:#10b981">${escapeHtml(msg.activeBadge)}</strong>` : ''}</span>
            </span>
            <span>
              ${(() => {
                const hit = computeCacheHitPercent(s.tokens)
                return hit !== null && s.tokens.total >= 5000
                  ? `<span class="tp-cache-hit${hit < 50 ? ' tp-cache-hit-low' : ''}">${escapeHtml(msg.cacheShort)} ${hit}%</span> · `
                  : ''
              })()}<strong style="color:var(--tp-fg);font-family:var(--tp-font-mono)">${formatTokens(s.tokens.total)} tok</strong> ·
              <span class="tp-cost-pill">${formatUsd(s.tokens.costUsd)}</span>
            </span>
          </div>
          ${renderTricolorBar(s.tokens, msg, false)}
        </div>
      `
      })
      .join('')}</div>`

  return `${summaryStrip}${renderSessionItems(list)}`
}

function renderPeriodView(
  periodKey: 'day' | 'week' | 'month',
  period: PeriodSummary,
  snap: DashboardSnapshot,
  scope: ScopeMode,
  msg: UiMessages,
  breakdown: StatsBreakdownMode = 'agent'
): string {
  const chartHeader =
    periodKey === 'day'
      ? msg.chartHourHeader
      : periodKey === 'week'
        ? msg.chartWeekHeader
        : msg.chartMonthHeader

  let deltaHtml = ''
  if (period.deltaPercent !== null) {
    const sign = period.deltaPercent >= 0 ? '+' : ''
    const cls = period.deltaPercent >= 0 ? 'tp-delta-pos' : 'tp-delta-neg'
    deltaHtml = `<span class="${cls}">${sign}${period.deltaPercent.toFixed(1)}%</span> ${escapeHtml(msg.vsPrevious)}`
  }

  const periodSwitchHtml = `
    <div class="tp-period-controls">
      <div class="tp-scope-switch" role="tablist" aria-label="${escapeHtml(msg.navShort.stats)}">
        ${(['day', 'week', 'month'] as const)
          .map(
            (p) => `
          <button type="button" class="tp-scope-btn ${periodKey === p ? 'active' : ''}" data-tab="${p}">
            ${escapeHtml(msg.navShort[p])}
          </button>`
          )
          .join('')}
      </div>
      <div class="tp-scope-switch">
        <button type="button" class="tp-scope-btn ${scope === 'all' ? 'active' : ''}" data-scope="all">
          ${escapeHtml(msg.scopeAll)}
        </button>
        <button type="button" class="tp-scope-btn ${scope === 'worktree' ? 'active' : ''}" data-scope="worktree">
          ${escapeHtml(msg.scopeWorktree)}
        </button>
      </div>
    </div>
    ${
      scope === 'worktree' && (snap.workspace.project || snap.workspace.name)
        ? `<div class="tp-kpi-meta" style="margin-top:-2px">${escapeHtml(
            formatProjectWorktreeLabel(snap.workspace.project, snap.workspace.name, snap.workspace.branch)
          )}</div>`
        : ''
    }
  `

  const kpiHtml = `
    ${periodSwitchHtml}
    <div class="tp-kpi-grid">
      <div class="tp-card">
        <div class="tp-kpi-label">${escapeHtml(msg.totalTokensLabel)}</div>
        <div class="tp-kpi-value">${formatTokens(period.tokens.total)}</div>
        <div class="tp-kpi-meta">${deltaHtml || `${escapeHtml(msg.avgLabel)} ${period.tps.avgTps.toFixed(1)} tok/s`}</div>
      </div>
      <div class="tp-card">
        <div class="tp-kpi-label">${escapeHtml(msg.periodCostLabel)}</div>
        <div class="tp-kpi-value tp-kpi-cost">${formatUsd(period.tokens.costUsd)}</div>
        <div class="tp-kpi-meta">${escapeHtml(msg.avgLabel)} ${period.tps.avgTps.toFixed(1)} · ${escapeHtml(msg.peakLabel)} ${period.tps.peakTps.toFixed(1)} tok/s</div>
      </div>
    </div>
    <div class="tp-card">
      ${(() => {
        const hit = computeCacheHitPercent(period.tokens)
        return hit !== null
          ? `<div class="tp-row-between" style="margin-bottom:4px"><span class="tp-kpi-label">${escapeHtml(msg.cacheShort)}</span><span class="tp-cache-hit${hit < 50 ? ' tp-cache-hit-low' : ''}">${hit}%</span></div>`
          : ''
      })()}${renderTricolorBar(period.tokens, msg, true)}
    </div>
  `

  const chartCard = `
    <div class="tp-card">
      <div class="tp-kpi-label">${escapeHtml(chartHeader)}</div>
      ${renderStackedChartSvg(period.buckets, msg)}
    </div>
  `

  const breakdownSwitchHtml = `
    <div class="tp-row-between" style="margin-bottom:6px">
      <div class="tp-kpi-label">${escapeHtml(msg.byAgentHeader)}</div>
      <div class="tp-scope-switch">
        ${(['agent', 'model', 'project'] as const)
          .map(
            (mode) => `
          <button type="button" class="tp-scope-btn ${breakdown === mode ? 'active' : ''}" data-breakdown="${mode}">
            ${escapeHtml(msg.breakdownModes[mode])}
          </button>`
          )
          .join('')}
      </div>
    </div>
  `

  let rowsHtml = ''
  if (breakdown === 'model') {
    const models = period.byModel ?? []
    rowsHtml = models
      .map((row) => {
        const color = AGENT_COLORS[row.agent]
        const providerModel = `${row.providerLabel} · ${row.modelLabel}`
        return `
          <div class="tp-agent-row">
            <div class="tp-row-between">
              <div class="tp-row-left" style="min-width:0">
                <span class="tp-model-inline" title="${escapeHtml(providerModel)}">${providerLogoHtml(row.providerLabel, row.agent)}<strong style="font-size:11.5px;color:var(--tp-fg)">${escapeHtml(row.modelLabel)}</strong></span>
                <span style="font-size:11px;color:var(--tp-muted);font-family:var(--tp-font-mono)">${row.sharePercent.toFixed(0)}%</span>
              </div>
              <div class="tp-row-left" style="gap:8px;flex-shrink:0">
                <span class="tp-mono-stat">${formatTokens(row.tokens.total)}</span>
                <span class="tp-cost-pill">${formatUsd(row.tokens.costUsd)}</span>
              </div>
            </div>
            <div class="tp-share-track">
              <div class="tp-share-fill" style="width:${Math.min(100, row.sharePercent).toFixed(1)}%;background:${color}"></div>
            </div>
            <div class="tp-row-between" style="font-size:10.5px;color:var(--tp-muted);font-family:var(--tp-font-mono)">
              <span>${escapeHtml(msg.agentNames[row.agent])}</span>
              <span>${escapeHtml(msg.avgLabel)} ${row.tps.avgTps.toFixed(1)} · ${escapeHtml(msg.peakLabel)} ${row.tps.peakTps.toFixed(1)} tok/s</span>
            </div>
          </div>
        `
      })
      .join('')
  } else if (breakdown === 'project') {
    const projects = period.byProject ?? []
    rowsHtml = projects
      .map((row) => `
        <div class="tp-agent-row">
          <div class="tp-row-between">
            <div class="tp-row-left" style="min-width:0">
              <strong style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</strong>
              <span style="font-size:11px;color:var(--tp-muted);font-family:var(--tp-font-mono)">${row.sharePercent.toFixed(0)}%</span>
            </div>
            <div class="tp-row-left" style="gap:8px;flex-shrink:0">
              <span class="tp-mono-stat">${formatTokens(row.tokens.total)}</span>
              <span class="tp-cost-pill">${formatUsd(row.tokens.costUsd)}</span>
            </div>
          </div>
          <div class="tp-share-track">
            <div class="tp-share-fill" style="width:${Math.min(100, row.sharePercent).toFixed(1)}%;background:var(--tp-accent)"></div>
          </div>
          <div class="tp-row-between" style="font-size:10.5px;color:var(--tp-muted);font-family:var(--tp-font-mono)">
            <span>${row.sessionCount} ${escapeHtml(msg.sessionsCountSuffix)}</span>
            <span>${escapeHtml(msg.outputShort)} ${formatTokens(row.tokens.output + row.tokens.reasoning)}</span>
          </div>
        </div>
      `)
      .join('')
  } else {
    rowsHtml = period.byAgent
      .map((row) => {
        const color = AGENT_COLORS[row.agent]
        const providerModel = `${row.providerLabel} · ${row.topModel}`
        return `
          <div class="tp-agent-row">
            <div class="tp-row-between">
              <div class="tp-row-left">
                <i class="tp-dot" style="background:${color}"></i>
                <strong style="font-size:12px">${escapeHtml(msg.agentNames[row.agent])}</strong>
                <span style="font-size:11px;color:var(--tp-muted);font-family:var(--tp-font-mono)">${row.sharePercent.toFixed(0)}%</span>
              </div>
              <div class="tp-row-left" style="gap:8px">
                <span class="tp-mono-stat">${formatTokens(row.tokens.total)}</span>
                <span class="tp-cost-pill">${formatUsd(row.tokens.costUsd)}</span>
              </div>
            </div>
            <div class="tp-share-track">
              <div class="tp-share-fill" style="width:${Math.min(100, row.sharePercent).toFixed(1)}%;background:${color}"></div>
            </div>
            <div class="tp-row-between" style="font-size:10.5px;color:var(--tp-muted);font-family:var(--tp-font-mono)">
              <span class="tp-model-inline" title="${escapeHtml(providerModel)}">${providerLogoHtml(row.providerLabel, row.agent)}<span>${escapeHtml(row.topModel)}</span></span>
              <span>${escapeHtml(msg.avgLabel)} ${row.tps.avgTps.toFixed(1)} · ${escapeHtml(msg.peakLabel)} ${row.tps.peakTps.toFixed(1)} tok/s</span>
            </div>
          </div>
        `
      })
      .join('')
  }

  return `
    ${kpiHtml}
    ${chartCard}
    <div class="tp-card">
      ${breakdownSwitchHtml}
      ${period.tokens.total <= 0 || !rowsHtml ? `<div class="tp-empty" style="margin-top:6px">${escapeHtml(msg.noPeriodData)}</div>` : rowsHtml}
    </div>
  `
}

const QUOTA_ARC_RADIUS = 38
const QUOTA_ARC_LEN = (240 / 360) * 2 * Math.PI * QUOTA_ARC_RADIUS
const QUOTA_ARC_PATH = 'M 17.09 71.00 A 38 38 0 1 1 82.91 71.00'

export function getQuotaSeverity(usedPercent: number): 'normal' | 'warn' | 'crit' {
  const pct = Number.isFinite(usedPercent) ? usedPercent : 0
  if (pct >= 90) return 'crit'
  if (pct >= 75) return 'warn'
  return 'normal'
}

export function renderQuotaGaugeSvg(usedPercent: number, usedLabel: string): string {
  const pct = Math.max(0, Math.min(100, Number.isFinite(usedPercent) ? usedPercent : 0))
  const severity = getQuotaSeverity(pct)
  const pctDisplay = Math.round(pct)
  const dashOffset = QUOTA_ARC_LEN * (1 - pct / 100)
  const fillPath =
    pct > 0
      ? `<path class="tp-quota-arc-fill tp-quota-arc-${severity}" d="${QUOTA_ARC_PATH}" fill="none" stroke-width="7.5" stroke-linecap="round" stroke-dasharray="${QUOTA_ARC_LEN.toFixed(2)} ${QUOTA_ARC_LEN.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}"/>`
      : ''

  return `
    <svg class="tp-quota-gauge-svg" viewBox="0 0 100 86" role="img" aria-label="${pctDisplay}% ${escapeHtml(usedLabel)}">
      <path class="tp-quota-arc-track" d="${QUOTA_ARC_PATH}" fill="none" stroke-width="7.5" stroke-linecap="round"/>
      ${fillPath}
      <text class="tp-quota-pct-text tp-quota-pct-${severity}" x="50" y="52" text-anchor="middle" dominant-baseline="central">${pctDisplay}%</text>
      <text class="tp-quota-pct-sub" x="50" y="69" text-anchor="middle">${escapeHtml(usedLabel)}</text>
    </svg>
  `
}

function quotaProviderLogoHtml(provider: QuotaProviderKind): string {
  if (provider === 'codex') return providerLogoHtml('OpenAI', 'codex')
  if (provider === 'claude') return providerLogoHtml('Anthropic', 'claude')
  return providerLogoHtml('Antigravity', 'antigravity')
}

function formatResetCreditsSummary(
  credits: QuotaResetCredits,
  nowMs: number,
  msg: UiMessages
): string {
  const countText = msg.quotaResetCredits(credits.availableCount)
  if (!credits.nextExpiresAt || !Number.isFinite(credits.nextExpiresAt)) return countText
  if (credits.nextExpiresAt > nowMs) {
    const span = formatDurationSpan(credits.nextExpiresAt - nowMs)
    return span ? `${countText} · ${msg.quotaNextExpiry(span)}` : countText
  }
  const expText = formatRelativeTime(credits.nextExpiresAt, nowMs, msg)
  return expText ? `${countText} · ${msg.quotaNextExpiry(expText)}` : countText
}

function renderQuotaWindowTile(
  windowData: QuotaWindow,
  windowLabel: string,
  msg: UiMessages,
  nowMs: number
): string {
  const countdown = formatCountdown(windowData.resetsAt, nowMs, msg)
  const desc = windowData.resetDescription?.trim() || ''
  const primaryMeta = countdown || desc || '—'
  const secondaryMeta = countdown && desc ? desc : ''
  const metaTitle = [countdown, desc].filter(Boolean).join(' · ')

  return `
    <div class="tp-quota-gauge-tile">
      ${renderQuotaGaugeSvg(windowData.usedPercent, msg.quotaUsedLabel)}
      <div class="tp-quota-window-title">${escapeHtml(windowLabel)}</div>
      <div class="tp-quota-reset-meta" title="${escapeHtml(metaTitle)}">${escapeHtml(primaryMeta)}</div>
      ${secondaryMeta ? `<div class="tp-quota-reset-meta" title="${escapeHtml(secondaryMeta)}">${escapeHtml(secondaryMeta)}</div>` : ''}
    </div>
  `
}

function renderQuotaNaTile(
  windowLabel: string,
  hint: string,
  resetCredits: QuotaResetCredits | null,
  msg: UiMessages,
  nowMs: number
): string {
  const creditsHtml = resetCredits
    ? `<div class="tp-quota-credits-pill">${escapeHtml(formatResetCreditsSummary(resetCredits, nowMs, msg))}</div>`
    : ''
  return `
    <div class="tp-quota-na-tile">
      <div class="tp-quota-na-head">
        <span class="tp-quota-window-title">${escapeHtml(windowLabel)}</span>
        <span class="tp-quota-na-badge">${escapeHtml(msg.quotaNotApplicable)}</span>
      </div>
      <div class="tp-quota-na-hint">${escapeHtml(hint)}</div>
      ${creditsHtml}
    </div>
  `
}

function renderLocalUsageTiles(
  local: { window5h: LocalQuotaUsageWindow; window7d: LocalQuotaUsageWindow },
  msg: UiMessages
): string {
  const entries: Array<{ label: string; data: LocalQuotaUsageWindow }> = [
    { label: msg.quotaLocalUsage5h, data: local.window5h },
    { label: msg.quotaLocalUsage7d, data: local.window7d }
  ]
  return `
    <div class="tp-quota-local-grid">
      ${entries
        .map(({ label, data }) => {
          const hitsHtml =
            data.rateLimitHits !== null && data.rateLimitHits > 0
              ? `<span class="tp-quota-429-badge">${escapeHtml(msg.quotaRateLimitsShort(data.rateLimitHits))}</span>`
              : ''
          return `
            <div class="tp-quota-local-tile">
              <div class="tp-quota-local-head">
                <span>${escapeHtml(label)}</span>
                ${hitsHtml}
              </div>
              <div class="tp-quota-local-val">${formatTokens(data.totalTokens)} tok</div>
              <div class="tp-quota-local-meta">
                <span class="tp-cost-pill">${formatUsd(data.costUsd)}</span>
                <span>${escapeHtml(msg.quotaTurnsShort(data.turnCount))}</span>
              </div>
            </div>
          `
        })
        .join('')}
    </div>
  `
}

function renderLocalUsageCompactStrip(
  local: { window5h: LocalQuotaUsageWindow; window7d: LocalQuotaUsageWindow },
  msg: UiMessages
): string {
  const hits5h = local.window5h.rateLimitHits ?? 0
  const hits7d = local.window7d.rateLimitHits ?? 0
  const totalHits = hits5h + hits7d
  return `
    <div class="tp-quota-local-strip">
      <span>${escapeHtml(msg.quotaLocalUsage5h)}: <strong style="color:var(--tp-fg)">${formatTokens(local.window5h.totalTokens)}</strong> · <span class="tp-cost-pill">${formatUsd(local.window5h.costUsd)}</span></span>
      <span>${escapeHtml(msg.quotaLocalUsage7d)}: <strong style="color:var(--tp-fg)">${formatTokens(local.window7d.totalTokens)}</strong> · <span class="tp-cost-pill">${formatUsd(local.window7d.costUsd)}</span></span>
      ${totalHits > 0 ? `<span class="tp-quota-429-badge">${escapeHtml(msg.quotaRateLimitsShort(totalHits))}</span>` : ''}
    </div>
  `
}

function renderQuotaPoolSection(
  pool: QuotaPool,
  msg: UiMessages,
  nowMs: number
): string {
  const leftTile = pool.session
    ? renderQuotaWindowTile(pool.session, msg.quota5hLabel, msg, nowMs)
    : renderQuotaNaTile(msg.quota5hLabel, msg.quotaWeeklyOnlyHint, null, msg, nowMs)
  const rightTile = pool.weekly
    ? renderQuotaWindowTile(pool.weekly, msg.quotaWeeklyLabel, msg, nowMs)
    : renderQuotaNaTile(msg.quotaWeeklyLabel, msg.quotaNotApplicable, null, msg, nowMs)

  return `
    <div class="tp-quota-pool-block">
      <div class="tp-quota-pool-title">
        <span>${escapeHtml(pool.label)}</span>
      </div>
      <div class="tp-quota-gauge-grid">
        ${leftTile}
        ${rightTile}
      </div>
    </div>
  `
}

function formatAccountMiniSummary(acc: QuotaAccountSummary, msg: UiMessages): string {
  if (acc.pools.length > 0) {
    return acc.pools
      .map((pool) => {
        const s = pool.session ? `${Math.round(pool.session.usedPercent)}%` : msg.quotaNotApplicable
        const w = pool.weekly ? `${Math.round(pool.weekly.usedPercent)}%` : msg.quotaNotApplicable
        return `${pool.label}: ${s}/${w}`
      })
      .join(' · ')
  }
  if (acc.session || acc.weekly) {
    const s = acc.session ? `5h ${Math.round(acc.session.usedPercent)}%` : `5h ${msg.quotaNotApplicable}`
    const w = acc.weekly ? `7d ${Math.round(acc.weekly.usedPercent)}%` : `7d ${msg.quotaNotApplicable}`
    return `${s} · ${w}`
  }
  return acc.error || acc.status
}

function renderQuotaProviderCard(
  p: QuotaProviderSnapshot,
  msg: UiMessages,
  nowMs: number,
  collapsedGroups: CollapsedGroups
): string {
  const localOnly =
    p.provider === 'antigravity' &&
    p.officialQuotaAvailable === false &&
    !p.error &&
    (p.accounts.length > 0 || p.local.window5h.totalTokens > 0 || p.local.window7d.totalTokens > 0)
  const statusLabel =
    localOnly
      ? msg.quotaLocalOnlyLabel
      : p.status === 'ok'
      ? msg.quotaStatusOk
      : p.status === 'loading'
        ? msg.quotaSourceLoading
        : p.status === 'error'
          ? msg.quotaErrorLabel
          : msg.quotaNotApplicable

  const authChip = p.authKind
    ? `<span class="tp-quota-auth-chip">${escapeHtml(p.authKind)}</span>`
    : ''
  const emailRow = p.accountEmail
    ? `<div class="tp-quota-email" title="${escapeHtml(p.accountEmail)}">${escapeHtml(p.accountEmail)}</div>`
    : ''

  let bodyHtml = ''
  if (localOnly) {
    bodyHtml = `
      <div class="tp-quota-reason-banner">${escapeHtml(msg.quotaLocalOnlyHint)}</div>
      ${renderLocalUsageTiles(p.local, msg)}
    `
  } else if (p.pools.length > 0) {
    bodyHtml = `
      ${p.pools.map((pool) => renderQuotaPoolSection(pool, msg, nowMs)).join('')}
      ${renderLocalUsageCompactStrip(p.local, msg)}
    `
  } else if (p.status === 'ok' && (p.session !== null || p.weekly !== null)) {
    const leftTile = p.session
      ? renderQuotaWindowTile(p.session, msg.quota5hLabel, msg, nowMs)
      : renderQuotaNaTile(msg.quota5hLabel, msg.quotaWeeklyOnlyHint, p.resetCredits, msg, nowMs)
    const rightTile = p.weekly
      ? renderQuotaWindowTile(p.weekly, msg.quotaWeeklyLabel, msg, nowMs)
      : renderQuotaNaTile(msg.quotaWeeklyLabel, msg.quotaNotApplicable, null, msg, nowMs)
    const extraCreditsHtml =
      p.session !== null && p.resetCredits
        ? `<div class="tp-quota-credits-pill">${escapeHtml(formatResetCreditsSummary(p.resetCredits, nowMs, msg))}</div>`
        : ''

    bodyHtml = `
      <div class="tp-quota-gauge-grid">
        ${leftTile}
        ${rightTile}
      </div>
      ${extraCreditsHtml}
      ${renderLocalUsageCompactStrip(p.local, msg)}
    `
  } else {
    const reasonText =
      p.status === 'loading'
        ? msg.quotaLoadingLabel
        : p.error || (p.status === 'error' ? msg.quotaErrorLabel : msg.quotaUnavailableLabel)
    const reasonCls =
      p.status === 'error' ? 'tp-quota-reason-banner tp-quota-reason-error' : 'tp-quota-reason-banner'
    bodyHtml = `
      <div class="${reasonCls}">${escapeHtml(reasonText)}</div>
      ${renderLocalUsageTiles(p.local, msg)}
    `
  }

  let accountsHtml = ''
  if (p.accounts.length > 1) {
    const groupKey = `quotas:accounts:${p.provider}`
    const rows = p.accounts
      .map((acc) => {
        const name = acc.email || acc.label || acc.id || acc.authKind || 'account'
        const summary = localOnly ? '' : formatAccountMiniSummary(acc, msg)
        return `
          <div class="tp-quota-account-row">
            <div class="tp-quota-account-hdr">
              <span class="tp-quota-account-email" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
              ${acc.active ? `<span class="tp-quota-account-active">${escapeHtml(msg.quotaActiveAccountBadge)}</span>` : ''}
            </div>
            ${summary ? `<div class="tp-quota-account-summary" title="${escapeHtml(summary)}">${escapeHtml(summary)}</div>` : ''}
          </div>
        `
      })
      .join('')
    accountsHtml = renderCollapseGroup(
      groupKey,
      msg.quotaOtherAccounts,
      p.accounts.length,
      `<div class="tp-list" style="gap:4px">${rows}</div>`,
      collapsedGroups[groupKey] ?? true
    )
  }

  return `
    <section class="tp-quota-card" aria-label="${escapeHtml(p.label)}">
      <div class="tp-quota-card-hdr">
        <div class="tp-quota-provider-id">
          ${quotaProviderLogoHtml(p.provider)}
          <div class="tp-quota-provider-meta">
            <div class="tp-quota-provider-name-row">
              <span class="tp-quota-provider-name">${escapeHtml(p.label)}</span>
              ${authChip}
            </div>
            ${emailRow}
          </div>
        </div>
        <span class="tp-quota-status-pill tp-quota-status-${escapeHtml(p.status)}">${escapeHtml(statusLabel)}</span>
      </div>
      ${bodyHtml}
      ${accountsHtml}
    </section>
  `
}

export function renderQuotasView(
  snap: DashboardSnapshot,
  msg: UiMessages,
  nowMs: number,
  collapsedGroups: CollapsedGroups = {},
  isRefreshingQuotas = false,
  quotasError: string | null = null
): string {
  const quotas: QuotasSnapshot | undefined = snap.quotas
  const quotasOff = quotas?.source === 'disabled'
  const syncing = !quotasOff && (isRefreshingQuotas || Boolean(quotas?.refreshing) || quotas?.source === 'loading')

  const sourceLabel = quotasOff
    ? msg.quotaSourceOff
    : syncing
    ? msg.quotaSourceLoading
    : quotas?.source === 'live'
      ? msg.quotaSourceLive
      : quotas?.source === 'cache'
        ? msg.quotaSourceCache
        : quotas?.source === 'error'
          ? msg.quotaSourceError
          : msg.quotaNoDataLabel

  const syncRel = quotas?.syncedAt ? formatRelativeTime(quotas.syncedAt, nowMs, msg) : ''
  const dotColor = syncing
    ? 'var(--tp-quota-warn)'
    : quotas?.source === 'live'
      ? 'var(--tp-quota-ok)'
      : quotas?.source === 'error'
        ? 'var(--tp-quota-crit)'
        : 'var(--tp-muted)'

  const toolbarHtml = `
    <div class="tp-quota-toolbar">
      <span class="tp-quota-source-pill">
        <i class="tp-dot" style="background:${dotColor};margin-right:0"></i>
        <span>${escapeHtml(sourceLabel)}${syncRel ? ` · ${escapeHtml(syncRel)}` : ''}</span>
      </span>
      <button
        type="button"
        class="tp-quota-refresh-btn ${syncing ? 'tp-spinning' : ''}"
        data-quotas-refresh="1"
        ${syncing || quotasOff ? 'disabled' : ''}
        title="${escapeHtml(msg.quotaRefreshAction)}"
      >
        ${REFRESH_ICON_SVG}
        <span>${escapeHtml(msg.quotaRefreshAction)}</span>
      </button>
    </div>
  `

  const effectiveError = quotasError || quotas?.lastError || null
  const errorBannerHtml = effectiveError
    ? `<div class="tp-quota-reason-banner tp-quota-reason-error">${escapeHtml(effectiveError)}</div>`
    : ''

  if (!quotas) {
    return `
      <div class="tp-quota-list">
        ${toolbarHtml}
        ${errorBannerHtml}
        <div class="tp-empty">${escapeHtml(msg.quotaLoadingLabel)}</div>
      </div>
    `
  }

  const cardsHtml = quotas.providers
    .map((p) => renderQuotaProviderCard(p, msg, nowMs, collapsedGroups))
    .join('')

  return `
    <div class="tp-quota-list">
      ${toolbarHtml}
      ${errorBannerHtml}
      ${cardsHtml || `<div class="tp-empty">${escapeHtml(quotasOff ? msg.quotaSourceOff : msg.quotaNoDataLabel)}</div>`}
    </div>
  `
}

export function renderDashboardShellHtml(params: {
  snap: DashboardSnapshot | null
  tab: ViewTab
  scope: ScopeMode
  locale: string
  lastPeriodTab?: 'day' | 'week' | 'month'
  statsBreakdown?: StatsBreakdownMode
  selectedLiveAgentKey?: string | null
  liveDetailAgent?: LiveAgentCard | null
  isRefreshing?: boolean
  isRefreshingQuotas?: boolean
  isSyncingPricing?: boolean
  quotasError?: string | null
  collapsedGroups?: CollapsedGroups
  nowMs?: number
}): string {
  const {
    snap,
    tab,
    scope,
    locale,
    lastPeriodTab = 'day',
    statsBreakdown = 'agent',
    selectedLiveAgentKey = null,
    liveDetailAgent = null,
    isRefreshing = false,
    isRefreshingQuotas = false,
    isSyncingPricing = false,
    quotasError = null,
    collapsedGroups = {}
  } = params
  const nowMs = params.nowMs ?? Date.now()
  const msg = getMessages(locale)

  // 4 primary navigation tabs: Live · Sessions · Stats (Day/Week/Month) · Quotas
  const primaryNavEntries: Array<{
    targetTab: ViewTab
    isActive: boolean
    icon: string
    shortLabel: string
    fullLabel: string
  }> = [
    {
      targetTab: 'live',
      isActive: tab === 'live',
      icon: TAB_ICONS_SVG.live,
      shortLabel: msg.navShort.live,
      fullLabel: msg.tabs.live
    },
    {
      targetTab: 'sessions',
      isActive: tab === 'sessions',
      icon: TAB_ICONS_SVG.sessions,
      shortLabel: msg.navShort.sessions,
      fullLabel: msg.tabs.sessions
    },
    {
      targetTab: isPeriodTab(tab) ? tab : lastPeriodTab,
      isActive: isPeriodTab(tab),
      icon: STATS_ICON_SVG,
      shortLabel: msg.navShort.stats,
      fullLabel: msg.tabs[isPeriodTab(tab) ? tab : lastPeriodTab]
    },
    {
      targetTab: 'quotas',
      isActive: tab === 'quotas',
      icon: TAB_ICONS_SVG.quotas,
      shortLabel: msg.navShort.quotas,
      fullLabel: msg.tabs.quotas
    }
  ]

  const navButtonsHtml = primaryNavEntries
    .map((entry) => {
      const btnCls = entry.isActive ? 'tp-nav-btn active' : 'tp-nav-btn'
      const innerHtml = entry.isActive
        ? `${entry.icon}<span class="tp-nav-label">${escapeHtml(entry.shortLabel)}</span>`
        : entry.icon
      return `<button type="button" role="tab" aria-selected="${entry.isActive ? 'true' : 'false'}" class="${btnCls}" data-tab="${entry.targetTab}" title="${escapeHtml(entry.fullLabel)}" aria-label="${escapeHtml(entry.fullLabel)}">${innerHtml}</button>`
    })
    .join('')

  const resolvedExpandedAgent: LiveAgentCard | null =
    tab === 'live' && selectedLiveAgentKey
      ? (liveDetailAgent &&
        (liveDetailAgent.sessionKey === selectedLiveAgentKey ||
          liveDetailAgent.id === selectedLiveAgentKey)
          ? liveDetailAgent
          : snap
            ? findLiveAgent(snap, selectedLiveAgentKey)
            : null)
      : null

  let mainBodyHtml = `<div class="tp-empty">${escapeHtml(tab === 'quotas' ? msg.quotaLoadingLabel : 'Loading…')}</div>`
  let pricingFooterHtml = ''

  if (snap) {
    if (tab === 'live') {
      if (resolvedExpandedAgent) {
        mainBodyHtml = `<div id="tp-live-detail-root">${renderLiveAgentDetailHtml(resolvedExpandedAgent, msg, nowMs)}</div>`
      } else {
        mainBodyHtml = renderLiveView(snap, msg, collapsedGroups, nowMs)
      }
    } else if (tab === 'sessions') {
      mainBodyHtml = renderSessionsView(snap, msg, nowMs, collapsedGroups)
    } else if (tab === 'quotas') {
      mainBodyHtml = renderQuotasView(
        snap,
        msg,
        nowMs,
        collapsedGroups,
        isRefreshingQuotas,
        quotasError
      )
    } else {
      const scopeBag = snap.periods[scope]
      mainBodyHtml = renderPeriodView(tab, scopeBag[tab], snap, scope, msg, statsBreakdown)
    }

    const p = snap.pricing
    const pSourceLabel =
      p.source === 'online'
        ? msg.pricingOnline
        : p.source === 'cache'
          ? msg.pricingCached
          : msg.pricingBuiltin
    const syncTime = p.syncedAt ? formatRelativeTime(p.syncedAt, nowMs, msg) : ''

    pricingFooterHtml = `
      <div class="tp-footer">
        <button
          type="button"
          id="btn-sync-pricing"
          class="tp-footer-sync-btn ${isSyncingPricing ? 'tp-spinning' : ''}"
          title="${escapeHtml(msg.syncPricingTooltip)}"
          aria-label="${escapeHtml(msg.syncPricingTooltip)}"
        >
          <i class="tp-dot" style="background:${p.source === 'online' ? '#10b981' : '#f59e0b'}"></i>
          <span>${escapeHtml(pSourceLabel)}${syncTime ? ` · ${escapeHtml(syncTime)}` : ''}</span>
        </button>
        <span title="${escapeHtml(msg.pricingModelsTooltip)}">${escapeHtml(msg.pricingModelsLoaded(p.modelCount))}</span>
      </div>
    `
  }

  const anyWorking = Boolean(snap?.live.agents.some((a) => a.state === 'working'))

  return `
    <header class="tp-header">
      <div class="tp-title-wrap">
        <span class="tp-brand-emblem ${anyWorking ? 'tp-brand-live' : ''}" aria-hidden="true">${BRAND_EMBLEM_SVG}</span>
        <h1 class="tp-title">${escapeHtml(msg.appTitle)}</h1>
      </div>
      <div class="tp-header-actions">
        <button
          type="button"
          id="btn-refresh"
          class="tp-icon-btn ${isRefreshing ? 'tp-spinning' : ''}"
          title="${escapeHtml(msg.refreshTooltip)}"
          aria-label="${escapeHtml(msg.refreshTooltip)}"
        >
          ${REFRESH_ICON_SVG}
        </button>
      </div>
    </header>

    <div class="tp-nav-sticky">
      <nav class="tp-nav" role="tablist">
        ${navButtonsHtml}
      </nav>
    </div>

    <main style="display:flex;flex-direction:column;gap:8px">
      ${mainBodyHtml}
    </main>

    ${pricingFooterHtml}
  `
}

function initBrowserPanel(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const appRoot = document.getElementById('app')
  if (!appRoot) return

  let currentTab: ViewTab = 'live'
  let lastPeriodTab: 'day' | 'week' | 'month' = 'day'
  let statsBreakdown: StatsBreakdownMode = 'agent'
  let currentScope: ScopeMode = 'all'
  let overrideLocale: string | null = null
  let selectedLiveAgentKey: string | null = null
  let liveDetailAgent: LiveAgentCard | null = null
  let liveDetailGeneratedAt = 0
  let livePollTimer: ReturnType<typeof setInterval> | null = null
  let bgElapsedTimer: ReturnType<typeof setInterval> | null = null
  let localeSyncTimer: ReturnType<typeof setInterval> | null = null
  let localeSyncInFlight = false
  let livePollInFlight = false
  let collapsedGroups: Record<string, boolean> = {}

  interface StreamSecSample {
    outTarget: number
    outCur: number
    inTarget: number
    inCur: number
  }

  let streamSessionKey: string | null = null
  const streamSamples = new Map<number, StreamSecSample>()
  let streamLatestEndSec = 0
  let streamLatestEndPerfSec = 0
  let streamPlayheadSec = 0
  let streamOutDisplayScale = 20
  let streamInDisplayScale = 20
  let streamRafId: number | null = null
  let streamLastFramePerfMs = 0

  try {
    const savedTab = localStorage.getItem('tp.activeTab') as ViewTab | null
    if (savedTab && TAB_ORDER.includes(savedTab)) {
      currentTab = savedTab
      if (isPeriodTab(savedTab)) lastPeriodTab = savedTab
    }
    const savedBreakdown = localStorage.getItem('tp.statsBreakdown')
    if (savedBreakdown === 'agent' || savedBreakdown === 'model' || savedBreakdown === 'project') {
      statsBreakdown = savedBreakdown
    }
    if (localStorage.getItem('tp.scope') === 'worktree') currentScope = 'worktree'
    const savedGroups = localStorage.getItem('tp.collapsedGroups')
    if (savedGroups) {
      const parsed = JSON.parse(savedGroups)
      if (parsed && typeof parsed === 'object') collapsedGroups = parsed
    }
  } catch {
    // Ignore storage access errors in strict frames
  }

  let snapshot: DashboardSnapshot | null = null
  let isRefreshing = false
  let isRefreshingQuotas = false
  let isSyncingPricing = false
  let quotasError: string | null = null

  function resolveEffectiveLocale(): string {
    return typeof window.orca?.locale === 'string' && window.orca.locale
      ? window.orca.locale
      : overrideLocale || navigator.language || 'en'
  }

  function resetStreamState(): void {
    streamSessionKey = null
    streamSamples.clear()
    streamLatestEndSec = 0
    streamLatestEndPerfSec = 0
    streamPlayheadSec = 0
    streamOutDisplayScale = 20
    streamInDisplayScale = 20
    liveDetailGeneratedAt = 0
  }

  function stopBgElapsedTimer(): void {
    if (bgElapsedTimer !== null) {
      clearInterval(bgElapsedTimer)
      bgElapsedTimer = null
    }
  }

  function tickBgElapsedTimers(): void {
    if (document.hidden || updateBgElapsedNodes(appRoot!, Date.now()) === 0) {
      stopBgElapsedTimer()
    }
  }

  function syncBgElapsedTimer(): void {
    const hasNodes = !document.hidden && appRoot!.querySelector('[data-bg-started-at]') !== null
    if (!hasNodes) {
      stopBgElapsedTimer()
      return
    }
    if (bgElapsedTimer === null) {
      bgElapsedTimer = setInterval(tickBgElapsedTimers, 1000)
    }
  }

  function stopStreamRaf(): void {
    if (streamRafId !== null) {
      cancelAnimationFrame(streamRafId)
      streamRafId = null
    }
    streamLastFramePerfMs = 0
  }

  function ingestStreamAgent(agent: LiveAgentCard, generatedAtMs?: number): void {
    const nowPerfSec = performance.now() / 1000
    const endSec =
      typeof agent.seriesEndSec === 'number' && Number.isFinite(agent.seriesEndSec)
        ? agent.seriesEndSec
        : Math.floor((generatedAtMs ?? Date.now()) / 1000)
    const startSec = endSec - (WAVE_SECONDS - 1)

    if (streamSessionKey !== agent.sessionKey || streamSamples.size === 0) {
      streamSamples.clear()
      streamSessionKey = agent.sessionKey
      let maxOut = 0
      let maxIn = 0
      for (let i = 0; i < WAVE_SECONDS; i++) {
        const s = startSec + i
        const outV = Math.max(0, Number(agent.outSeries?.[i]) || 0)
        const inV = Math.max(0, Number(agent.inSeries?.[i]) || 0)
        streamSamples.set(s, {
          outTarget: outV,
          outCur: outV,
          inTarget: inV,
          inCur: inV
        })
        if (i >= WAVE_SECONDS - 1 - IO_VISIBLE_SPAN_SEC) {
          if (outV > maxOut) maxOut = outV
          if (inV > maxIn) maxIn = inV
        }
      }
      streamLatestEndSec = endSec
      streamLatestEndPerfSec = nowPerfSec
      streamPlayheadSec = endSec - 1.05
      streamOutDisplayScale = computeNiceEvenCeiling(maxOut)
      streamInDisplayScale = computeNiceEvenCeiling(maxIn)
      return
    }

    if (endSec < streamLatestEndSec) {
      return
    }

    for (let i = 0; i < WAVE_SECONDS; i++) {
      const s = startSec + i
      const outV = Math.max(0, Number(agent.outSeries?.[i]) || 0)
      const inV = Math.max(0, Number(agent.inSeries?.[i]) || 0)
      const existing = streamSamples.get(s)
      if (existing) {
        existing.outTarget = outV
        existing.inTarget = inV
        // Offscreen lookahead samples to the right of `x = width` take target immediately
        if (s > streamPlayheadSec + 0.25) {
          existing.outCur = outV
          existing.inCur = inV
        }
      } else {
        streamSamples.set(s, {
          outTarget: outV,
          outCur: outV,
          inTarget: inV,
          inCur: inV
        })
      }
    }

    if (endSec > streamLatestEndSec) {
      streamLatestEndSec = endSec
      streamLatestEndPerfSec = nowPerfSec
    }

    const pruneBefore = Math.floor(streamPlayheadSec) - 70
    for (const k of streamSamples.keys()) {
      if (k < pruneBefore) {
        streamSamples.delete(k)
      }
    }
  }

  function readSampleChannel(s: number, channel: 'out' | 'in'): number {
    const hit = streamSamples.get(s)
    if (hit) {
      return channel === 'out' ? hit.outCur : hit.inCur
    }
    if (s > streamLatestEndSec && streamLatestEndSec > 0) {
      const last = streamSamples.get(streamLatestEndSec)
      const base = last ? (channel === 'out' ? last.outCur : last.inCur) : 0
      return base > 0.05 ? base * Math.exp(-(s - streamLatestEndSec) * 0.85) : 0
    }
    return 0
  }

  function setIoText(root: ParentNode, key: string, nextText: string): void {
    const el = root.querySelector<HTMLElement>(`[data-io-text="${key}"]`)
    if (el && el.textContent !== nextText) {
      el.textContent = nextText
    }
  }

  function renderStreamWaveFrame(dtSec: number): void {
    const detailRoot = document.getElementById('tp-live-detail-root')
    if (!detailRoot || streamSamples.size === 0) return

    if (dtSec > 0) {
      const nowPerfSec = performance.now() / 1000
      const estServerSec =
        streamLatestEndSec + Math.min(2.2, Math.max(0, nowPerfSec - streamLatestEndPerfSec))
      const idealPlayhead = estServerSec - 1.05
      const drift = idealPlayhead - streamPlayheadSec
      if (Math.abs(drift) > 4.5) {
        streamPlayheadSec = idealPlayhead
      } else {
        const speed = Math.min(1.35, Math.max(0.72, 1.0 + drift * 0.5))
        streamPlayheadSec += dtSec * speed
      }

      const easeVal = 1 - Math.exp(-dtSec / 0.18)
      for (const sample of streamSamples.values()) {
        const dOut = sample.outTarget - sample.outCur
        if (Math.abs(dOut) > 0.005) {
          sample.outCur += dOut * easeVal
        } else {
          sample.outCur = sample.outTarget
        }
        const dIn = sample.inTarget - sample.inCur
        if (Math.abs(dIn) > 0.005) {
          sample.inCur += dIn * easeVal
        } else {
          sample.inCur = sample.inTarget
        }
      }
    }

    const pxPerSec = IO_WAVE_WIDTH / IO_VISIBLE_SPAN_SEC
    const sFrom = Math.floor(streamPlayheadSec - IO_VISIBLE_SPAN_SEC) - 2
    const sTo = Math.ceil(streamPlayheadSec) + 2
    const count = sTo - sFrom + 1
    if (count < 2) return

    const xs = new Array<number>(count)
    const outVals = new Array<number>(count)
    const inVals = new Array<number>(count)
    let visibleOutMax = 0
    let visibleInMax = 0
    const visStartSec = streamPlayheadSec - IO_VISIBLE_SPAN_SEC - 0.5
    const visEndSec = streamPlayheadSec + 0.5

    for (let i = 0; i < count; i++) {
      const s = sFrom + i
      xs[i] = IO_WAVE_WIDTH - (streamPlayheadSec - s) * pxPerSec
      const ov = readSampleChannel(s, 'out')
      const iv = readSampleChannel(s, 'in')
      outVals[i] = ov
      inVals[i] = iv
      if (s >= visStartSec && s <= visEndSec) {
        if (ov > visibleOutMax) visibleOutMax = ov
        if (iv > visibleInMax) visibleInMax = iv
      }
    }

    const outTargetScale = computeNiceEvenCeiling(visibleOutMax)
    const inTargetScale = computeNiceEvenCeiling(visibleInMax)
    if (dtSec > 0) {
      const easeScale = 1 - Math.exp(-dtSec / 0.24)
      streamOutDisplayScale += (outTargetScale - streamOutDisplayScale) * easeScale
      if (Math.abs(outTargetScale - streamOutDisplayScale) < 0.05) {
        streamOutDisplayScale = outTargetScale
      }
      streamInDisplayScale += (inTargetScale - streamInDisplayScale) * easeScale
      if (Math.abs(inTargetScale - streamInDisplayScale) < 0.05) {
        streamInDisplayScale = inTargetScale
      }
    } else {
      streamOutDisplayScale = outTargetScale
      streamInDisplayScale = inTargetScale
    }

    const outScaleSafe = Math.max(4, streamOutDisplayScale)
    const inScaleSafe = Math.max(4, streamInDisplayScale)
    const outYs = new Array<number>(count)
    const inYs = new Array<number>(count)
    for (let i = 0; i < count; i++) {
      const outRatio = Math.min(1, Math.max(0, outVals[i] / outScaleSafe))
      const inRatio = Math.min(1, Math.max(0, inVals[i] / inScaleSafe))
      outYs[i] = IO_WAVE_PAD_TOP + IO_WAVE_USABLE_H * (1 - outRatio)
      inYs[i] = IO_WAVE_PAD_TOP + IO_WAVE_USABLE_H * (1 - inRatio)
    }

    const outPaths = buildWavePathsFromCoords(xs, outYs)
    const inPaths = buildWavePathsFromCoords(xs, inYs)

    const outAreaEl = detailRoot.querySelector<SVGPathElement>('[data-io-path="out-area"]')
    const outStrokeEl = detailRoot.querySelector<SVGPathElement>('[data-io-path="out-stroke"]')
    const inAreaEl = detailRoot.querySelector<SVGPathElement>('[data-io-path="in-area"]')
    const inStrokeEl = detailRoot.querySelector<SVGPathElement>('[data-io-path="in-stroke"]')

    if (outAreaEl) outAreaEl.setAttribute('d', outPaths.areaPath)
    if (outStrokeEl) outStrokeEl.setAttribute('d', outPaths.strokePath)
    if (inAreaEl) inAreaEl.setAttribute('d', inPaths.areaPath)
    if (inStrokeEl) inStrokeEl.setAttribute('d', inPaths.strokePath)

    setIoText(detailRoot, 'out-max', formatScaleTokPerSec(outTargetScale))
    setIoText(detailRoot, 'out-mid', formatScaleTokPerSec(outTargetScale * 0.5))
    setIoText(detailRoot, 'in-max', formatScaleTokPerSec(inTargetScale))
    setIoText(detailRoot, 'in-mid', formatScaleTokPerSec(inTargetScale * 0.5))
  }

  function stepStreamRaf(nowPerfMs: number): void {
    if (currentTab !== 'live' || !selectedLiveAgentKey || document.hidden) {
      stopStreamRaf()
      return
    }
    const dtSec =
      streamLastFramePerfMs > 0
        ? Math.min(0.08, Math.max(0.001, (nowPerfMs - streamLastFramePerfMs) / 1000))
        : 0
    streamLastFramePerfMs = nowPerfMs
    renderStreamWaveFrame(dtSec)
    streamRafId = requestAnimationFrame(stepStreamRaf)
  }

  function syncLiveStreamEngines(): void {
    const shouldRun =
      currentTab === 'live' && Boolean(selectedLiveAgentKey) && !document.hidden
    if (!shouldRun) {
      if (livePollTimer !== null) {
        clearInterval(livePollTimer)
        livePollTimer = null
      }
      stopStreamRaf()
      if (!selectedLiveAgentKey || currentTab !== 'live') {
        resetStreamState()
      }
      return
    }
    if (livePollTimer === null) {
      livePollTimer = setInterval(() => {
        void pollSelectedAgentOnce()
      }, 1000)
    }
    if (streamRafId === null) {
      streamLastFramePerfMs = performance.now()
      streamRafId = requestAnimationFrame(stepStreamRaf)
    }
  }

  function patchLiveDetailDomInPlace(agent: LiveAgentCard, generatedAtMs?: number): boolean {
    const detailRoot = document.getElementById('tp-live-detail-root')
    const monitorEl = detailRoot?.querySelector<HTMLElement>('.tp-io-monitor')
    if (!detailRoot || !monitorEl || monitorEl.dataset.detailSessionKey !== agent.sessionKey) {
      return false
    }

    ingestStreamAgent(agent, generatedAtMs)

    const msg = getMessages(resolveEffectiveLocale())
    const providerModel = `${agent.providerLabel} · ${agent.modelLabel}`
    const projWt = formatProjectWorktreeLabel(agent.projectName, agent.workspaceName)
    const outTotal = Math.max(0, agent.tokens.output + agent.tokens.reasoning)
    const inTotal = Math.max(0, agent.tokens.input + agent.tokens.cacheWrite)
    const cacheTotal = Math.max(0, agent.tokens.cacheRead)

    setIoText(detailRoot, 'out-rate', formatRateTokPerSec(agent.liveOutRate))
    setIoText(detailRoot, 'in-rate', formatRateTokPerSec(agent.liveInRate))
    setIoText(detailRoot, 'state-label', msg.states[agent.state])
    setIoText(detailRoot, 'model', agent.modelLabel)
    setIoText(detailRoot, 'title', agent.title)
    setIoText(detailRoot, 'proj', projWt)
    setIoText(detailRoot, 'avg', formatRateTokPerSec(agent.tps.avgTps))
    setIoText(detailRoot, 'peak', `${agent.tps.peakTps.toFixed(1)}/s`)
    setIoText(detailRoot, 'tok-out', formatTokens(outTotal))
    setIoText(detailRoot, 'tok-in', formatTokens(inTotal))
    setIoText(detailRoot, 'tok-cache', formatTokens(cacheTotal))
    const cacheHit = computeCacheHitPercent(agent.tokens)
    if (cacheHit !== null) {
      setIoText(detailRoot, 'cache-hit', `${msg.cacheShort} ${cacheHit}%`)
    }
    setIoText(detailRoot, 'cost', formatUsd(agent.tokens.costUsd))

    const stateWrap = detailRoot.querySelector<HTMLElement>('[data-io-state-wrap]')
    if (stateWrap) {
      const nextCls = `tp-state tp-state-${agent.state}`
      if (stateWrap.className !== nextCls) {
        stateWrap.className = nextCls
      }
    }

    const nextBgSig = bgTasksSignature(agent.backgroundTasks)
    const existingBgSection = monitorEl.querySelector<HTMLElement>('[data-io-bg-tasks]')
    const prevBgSig = existingBgSection?.dataset.bgSig ?? ''
    if (nextBgSig !== prevBgSig) {
      if (existingBgSection) existingBgSection.remove()
      if (nextBgSig) {
        const metaStack = monitorEl.querySelector<HTMLElement>('.tp-io-meta-stack')
        const html = renderDetailBgTasksSectionHtml(agent.backgroundTasks, msg, Date.now())
        if (metaStack && html) {
          metaStack.insertAdjacentHTML('afterend', html)
        }
      }
    }
    syncBgElapsedTimer()

    return true
  }

  function renderApp(): void {
    const locale = resolveEffectiveLocale()
    document.documentElement.lang = locale

    const activeExpandedAgent =
      currentTab === 'live' && selectedLiveAgentKey
        ? (liveDetailAgent &&
          (liveDetailAgent.sessionKey === selectedLiveAgentKey ||
            liveDetailAgent.id === selectedLiveAgentKey)
            ? liveDetailAgent
            : snapshot
              ? findLiveAgent(snapshot, selectedLiveAgentKey)
              : null)
        : null

    if (activeExpandedAgent) {
      ingestStreamAgent(activeExpandedAgent, snapshot?.generatedAt)
    }

    appRoot!.innerHTML = renderDashboardShellHtml({
      snap: snapshot,
      tab: currentTab,
      scope: currentScope,
      locale,
      lastPeriodTab,
      statsBreakdown,
      selectedLiveAgentKey,
      liveDetailAgent,
      isRefreshing,
      isRefreshingQuotas,
      isSyncingPricing,
      quotasError,
      collapsedGroups
    })

    if (activeExpandedAgent) {
      renderStreamWaveFrame(0)
      syncLiveStreamEngines()
    }
    syncBgElapsedTimer()
  }

  async function pollSelectedAgentOnce(): Promise<void> {
    if (typeof window.orca === 'undefined') return
    if (currentTab !== 'live' || !selectedLiveAgentKey || document.hidden) return
    if (livePollInFlight) return

    const requestedKey = selectedLiveAgentKey
    livePollInFlight = true
    try {
      const res = await window.orca.plugin.request('agent.livePoll', {
        sessionKey: requestedKey
      })
      if (currentTab !== 'live' || selectedLiveAgentKey !== requestedKey) {
        return
      }
      if (dropDisabledLiveDetail()) {
        renderApp()
        return
      }
      if (res?.agent) {
        const genAt = typeof res.generatedAt === 'number' ? res.generatedAt : Date.now()
        if (genAt >= liveDetailGeneratedAt) {
          liveDetailGeneratedAt = genAt
          liveDetailAgent = res.agent
          if (!patchLiveDetailDomInPlace(res.agent, genAt)) {
            renderApp()
          }
        }
      } else if (!liveDetailAgent) {
        // Requested session does not exist anymore; fall back cleanly to Live list
        selectedLiveAgentKey = null
        syncLiveStreamEngines()
        renderApp()
      }
    } catch {
      // Ignore transient poll error during reload
    } finally {
      livePollInFlight = false
    }
  }

  /** Closes an open Live detail whose agent was switched off in the plugin settings. */
  function dropDisabledLiveDetail(): boolean {
    const disabled = snapshot?.disabledAgents
    if (!selectedLiveAgentKey || !disabled || disabled.length === 0) return false
    const key = selectedLiveAgentKey
    const hit =
      (liveDetailAgent !== null && disabled.includes(liveDetailAgent.agent)) ||
      disabled.some((agent) => key.startsWith(`${agent}:`))
    if (!hit) return false
    selectedLiveAgentKey = null
    liveDetailAgent = null
    liveDetailGeneratedAt = 0
    resetStreamState()
    syncLiveStreamEngines()
    return true
  }

  function selectLiveAgent(sessionKey: string | null): void {
    if (selectedLiveAgentKey !== sessionKey) {
      resetStreamState()
    }
    selectedLiveAgentKey = sessionKey
    if (!sessionKey) {
      liveDetailAgent = null
      liveDetailGeneratedAt = 0
    } else {
      liveDetailAgent = snapshot ? findLiveAgent(snapshot, sessionKey) : null
      liveDetailGeneratedAt = liveDetailAgent && snapshot ? snapshot.generatedAt : 0
    }
    syncLiveStreamEngines()
    renderApp()
    if (sessionKey) {
      void pollSelectedAgentOnce()
    }
  }

  async function focusLiveAgent(agent: LiveAgentCard | null): Promise<void> {
    if (!agent?.terminalId || typeof window.orca === 'undefined') return
    try {
      await window.orca.plugin.request('session.focus', { terminalId: agent.terminalId })
    } catch {
      // Chat UI sessions and older Orca hosts may not expose a focusable terminal.
    }
  }

  appRoot.addEventListener(
    'toggle',
    (ev) => {
      const group = (ev.target as HTMLElement | null)?.closest<HTMLDetailsElement>(
        'details[data-collapse-key]'
      )
      const key = group?.dataset.collapseKey
      if (!key || !group) return
      collapsedGroups[key] = !group.open
      try {
        localStorage.setItem('tp.collapsedGroups', JSON.stringify(collapsedGroups))
      } catch {
        // Ignore storage access errors in strict frames
      }
    },
    true
  )

  appRoot.addEventListener('click', async (ev) => {
    const target = ev.target as HTMLElement | null
    if (!target) return

    if (target.closest('[data-live-back]')) {
      selectLiveAgent(null)
      return
    }

    const liveCard = target.closest<HTMLElement>('[data-live-agent-key], [data-race-agent-key]')
    if (liveCard && currentTab === 'live') {
      const key = (liveCard.dataset.liveAgentKey ?? liveCard.dataset.raceAgentKey ?? '').trim()
      if (key) {
        const agent = snapshot ? findLiveAgent(snapshot, key) : null
        void focusLiveAgent(agent)
        selectLiveAgent(key)
      }
      return
    }

    const tabBtn = target.closest<HTMLButtonElement>('[data-tab]')
    if (tabBtn) {
      const nextTab = tabBtn.dataset.tab as ViewTab
      if (TAB_ORDER.includes(nextTab)) {
        if (nextTab === 'live' && currentTab === 'live' && selectedLiveAgentKey) {
          // Clicking the active Live tab while inside an expanded agent returns to Live overview
          selectLiveAgent(null)
          return
        }
        currentTab = nextTab
        if (isPeriodTab(nextTab)) lastPeriodTab = nextTab
        if (currentTab !== 'live') {
          selectedLiveAgentKey = null
          liveDetailAgent = null
        }
        try {
          localStorage.setItem('tp.activeTab', currentTab)
        } catch {
          // Ignore
        }
        syncLiveStreamEngines()
        renderApp()
      }
      return
    }

    const scopeBtn = target.closest<HTMLButtonElement>('[data-scope]')
    if (scopeBtn) {
      const nextScope: ScopeMode = scopeBtn.dataset.scope === 'worktree' ? 'worktree' : 'all'
      currentScope = nextScope
      try {
        localStorage.setItem('tp.scope', currentScope)
      } catch {
        // Ignore
      }
      renderApp()
      return
    }

    const breakdownBtn = target.closest<HTMLButtonElement>('[data-breakdown]')
    if (breakdownBtn) {
      const nextMode = breakdownBtn.dataset.breakdown
      if (nextMode === 'agent' || nextMode === 'model' || nextMode === 'project') {
        statsBreakdown = nextMode
        try {
          localStorage.setItem('tp.statsBreakdown', statsBreakdown)
        } catch {
          // Ignore
        }
        renderApp()
      }
      return
    }

    if (target.closest('[data-quotas-refresh]')) {
      if (isRefreshingQuotas || typeof window.orca === 'undefined') return
      isRefreshingQuotas = true
      quotasError = null
      renderApp()
      try {
        const freshQuotas = await window.orca.plugin.request('quotas.refresh', {})
        if (snapshot) {
          snapshot = { ...snapshot, quotas: freshQuotas }
        } else {
          const nextSnap = await window.orca.plugin.request('dashboard.get', {
            forceScan: false,
            locale: resolveEffectiveLocale()
          })
          snapshot = { ...nextSnap, quotas: freshQuotas }
        }
      } catch (err) {
        quotasError = err instanceof Error ? err.message : String(err)
        console.error('Failed to refresh quotas:', err)
      } finally {
        isRefreshingQuotas = false
        renderApp()
      }
      return
    }

    if (target.closest('#btn-refresh')) {
      if (isRefreshing || typeof window.orca === 'undefined') return
      isRefreshing = true
      const refreshingQuotasToo = currentTab === 'quotas'
      if (refreshingQuotasToo) {
        isRefreshingQuotas = true
        quotasError = null
      }
      renderApp()
      try {
        if (refreshingQuotasToo) {
          const [snapRes, quotasRes] = await Promise.allSettled([
            window.orca.plugin.request('dashboard.get', {
              forceScan: true,
              locale: resolveEffectiveLocale()
            }),
            window.orca.plugin.request('quotas.refresh', {})
          ])
          if (snapRes.status === 'fulfilled') {
            snapshot = snapRes.value
          }
          if (quotasRes.status === 'fulfilled') {
            if (snapshot) {
              snapshot = { ...snapshot, quotas: quotasRes.value }
            }
          } else {
            quotasError =
              quotasRes.reason instanceof Error
                ? quotasRes.reason.message
                : String(quotasRes.reason)
            console.error('Failed to refresh quotas:', quotasRes.reason)
          }
          if (snapRes.status === 'rejected') {
            console.error('Failed to refresh dashboard:', snapRes.reason)
          }
        } else {
          snapshot = await window.orca.plugin.request('dashboard.get', {
            forceScan: true,
            locale: resolveEffectiveLocale()
          })
          if (selectedLiveAgentKey && snapshot) {
            const hit = findLiveAgent(snapshot, selectedLiveAgentKey)
            if (hit) liveDetailAgent = hit
          }
        }
      } catch (err) {
        console.error('Failed to refresh dashboard:', err)
      } finally {
        isRefreshing = false
        if (refreshingQuotasToo) {
          isRefreshingQuotas = false
        }
        renderApp()
      }
      return
    }

    if (target.closest('#btn-sync-pricing')) {
      if (isSyncingPricing) return
      isSyncingPricing = true
      renderApp()
      try {
        await window.orca.plugin.request('pricing.refresh', {})
        snapshot = await window.orca.plugin.request('dashboard.get', {
          forceScan: false,
          locale: resolveEffectiveLocale()
        })
      } catch (err) {
        console.error('Failed to sync live pricing:', err)
      } finally {
        isSyncingPricing = false
        renderApp()
      }
    }
  })

  appRoot.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && currentTab === 'live' && selectedLiveAgentKey) {
      ev.preventDefault()
      selectLiveAgent(null)
      return
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      const target = ev.target as HTMLElement | null
      const liveCard = target?.closest<HTMLElement>('[data-live-agent-key], [data-race-agent-key]')
      if (liveCard && currentTab === 'live') {
        ev.preventDefault()
        const key = (liveCard.dataset.liveAgentKey ?? liveCard.dataset.raceAgentKey ?? '').trim()
        if (key) selectLiveAgent(key)
      }
    }
  })

  document.addEventListener('visibilitychange', () => {
    syncLiveStreamEngines()
    syncBgElapsedTimer()
    if (!document.hidden) {
      tickBgElapsedTimers()
      if (currentTab === 'live' && selectedLiveAgentKey) {
        void pollSelectedAgentOnce()
      }
    }
  })

  window.addEventListener('pagehide', () => {
    if (livePollTimer !== null) {
      clearInterval(livePollTimer)
      livePollTimer = null
    }
    stopBgElapsedTimer()
    if (localeSyncTimer !== null) {
      clearInterval(localeSyncTimer)
      localeSyncTimer = null
    }
    stopStreamRaf()
  })

  renderApp()

  if (typeof window.orca !== 'undefined') {
    let lastOrcaLocale = resolveEffectiveLocale()

    localeSyncTimer = setInterval(() => {
      const nextLocale = resolveEffectiveLocale()
      if (nextLocale === lastOrcaLocale) return
      lastOrcaLocale = nextLocale
      overrideLocale = null
      renderApp()
      if (localeSyncInFlight) return

      localeSyncInFlight = true
      void window.orca.plugin
        .request('dashboard.get', { forceScan: false, locale: nextLocale })
        .then((nextSnap) => {
          snapshot = nextSnap
          renderApp()
        })
        .catch(() => {
          // Ignore transient locale sync errors; the panel already uses the new locale.
        })
        .finally(() => {
          localeSyncInFlight = false
        })
    }, 1000)

    window.orca.on('theme', () => {
      renderApp()
    })

    window.orca.plugin.on('dashboard.updated', (nextSnap) => {
      snapshot = nextSnap
      if (dropDisabledLiveDetail()) {
        renderApp()
        return
      }
      if (nextSnap.quotas && nextSnap.quotas.source !== 'error' && !nextSnap.quotas.lastError) {
        quotasError = null
      }
      if (currentTab === 'live' && selectedLiveAgentKey) {
        // Keep header emblem synced without tearing down the 60fps SVG stream
        const emblem = document.querySelector('.tp-brand-emblem')
        const anyWorking = nextSnap.live.agents.some((a) => a.state === 'working')
        if (emblem) {
          emblem.classList.toggle('tp-brand-live', anyWorking)
        }
        if (nextSnap.generatedAt >= liveDetailGeneratedAt) {
          const updatedAgent = findLiveAgent(nextSnap, selectedLiveAgentKey)
          if (updatedAgent) {
            liveDetailGeneratedAt = nextSnap.generatedAt
            liveDetailAgent = updatedAgent
          }
          if (liveDetailAgent && patchLiveDetailDomInPlace(liveDetailAgent, nextSnap.generatedAt)) {
            return
          }
        } else if (document.getElementById('tp-live-detail-root')) {
          return
        }
      }
      renderApp()
    })

    window.orca.plugin.on('view.changed', (nextView) => {
      const prevKey = selectedLiveAgentKey
      if (nextView.tab && TAB_ORDER.includes(nextView.tab)) {
        currentTab = nextView.tab
      }
      if (nextView.scope === 'all' || nextView.scope === 'worktree') {
        currentScope = nextView.scope
      }
      if (typeof nextView.locale === 'string' && nextView.locale.trim()) {
        overrideLocale = nextView.locale.trim()
      } else if (nextView.locale === null) {
        overrideLocale = null
      }
      if ('liveAgentKey' in nextView) {
        selectedLiveAgentKey = nextView.liveAgentKey ?? null
        if (selectedLiveAgentKey && snapshot) {
          liveDetailAgent = findLiveAgent(snapshot, selectedLiveAgentKey) ?? liveDetailAgent
        } else if (!selectedLiveAgentKey) {
          liveDetailAgent = null
        }
      } else if (currentTab !== 'live') {
        selectedLiveAgentKey = null
        liveDetailAgent = null
      }
      dropDisabledLiveDetail()
      if (prevKey !== selectedLiveAgentKey) {
        resetStreamState()
      }
      syncLiveStreamEngines()
      renderApp()
      if (currentTab === 'live' && selectedLiveAgentKey) {
        void pollSelectedAgentOnce()
      }
    })

    void window.orca.plugin
      .request('dashboard.get', {
        forceScan: true,
        locale: resolveEffectiveLocale()
      })
      .then((snap) => {
        snapshot = snap
        if (selectedLiveAgentKey) {
          liveDetailAgent = findLiveAgent(snap, selectedLiveAgentKey) ?? liveDetailAgent
          dropDisabledLiveDetail()
        }
        renderApp()
      })
      .catch((err) => {
        console.error('Initial dashboard.get failed:', err)
      })
  }
}

initBrowserPanel()
