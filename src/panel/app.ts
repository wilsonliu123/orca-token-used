import type {} from 'orca/frame'
import type {
  AgentKind,
  DashboardSnapshot,
  LiveAgentCard,
  PeriodSummary,
  ScopeMode,
  TimeBucket,
  TokenBreakdown,
  ViewTab
} from '../protocol'
import {
  formatRateTokPerSec,
  formatRelativeTime,
  formatScaleTokPerSec,
  formatTokens,
  formatUsd,
  getMessages,
  type UiMessages
} from './i18n'

const AGENT_COLORS: Record<AgentKind, string> = {
  claude: '#f97316',
  codex: '#10b981',
  antigravity: '#a855f7',
  gemini: '#38bdf8'
}

export const TAB_ORDER: readonly ViewTab[] = ['live', 'sessions', 'day', 'week', 'month']

/** Pure SVG icons for the 5 view tabs */
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
  month: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="8" cy="14" r="1" fill="currentColor"/><circle cx="12" cy="14" r="1" fill="currentColor"/><circle cx="16" cy="14" r="1" fill="currentColor"/><circle cx="8" cy="18" r="1" fill="currentColor"/><circle cx="12" cy="18" r="1" fill="currentColor"/><circle cx="16" cy="18" r="1" fill="currentColor"/></svg>`
}

/** Dynamic multi-wave + energy spark emblem for header branding */
const BRAND_EMBLEM_SVG = `<svg viewBox="0 0 24 24" fill="none"><path class="tp-wave-path" d="M2 14.5C4.5 14.5 5.2 7.5 7.8 7.5C10.4 7.5 11.2 17.5 13.8 17.5C16.4 17.5 17.2 9.5 19.6 9.5C21 9.5 21.5 12 22 12" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.2 2.8L9.6 9.4H13.4L11.2 15.6L16.4 8.2H12.6L13.2 2.8Z" fill="#facc15" fill-opacity="0.92"/></svg>`

const BACK_ARROW_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`

const REFRESH_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>`
const DOLLAR_SYNC_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`

const WAVE_SECONDS = 60

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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

export function renderLiveAgentDetailHtml(agent: LiveAgentCard, msg: UiMessages): string {
  const providerModel = `${agent.providerLabel} · ${agent.modelLabel}`
  const projWt = formatProjectWorktreeLabel(agent.projectName, agent.workspaceName)
  const outTotal = Math.max(0, agent.tokens.output + agent.tokens.reasoning)
  const inTotal = Math.max(0, agent.tokens.input + agent.tokens.cacheWrite)
  const cacheTotal = Math.max(0, agent.tokens.cacheRead)

  const outWave = renderIoWaveformSvg(agent.outSeries, 'out')
  const inWave = renderIoWaveformSvg(agent.inSeries, 'in')

  return `
    <div class="tp-io-monitor" data-detail-session-key="${escapeHtml(agent.sessionKey)}">
      <div class="tp-io-topbar">
        <button type="button" class="tp-back-btn" id="btn-live-back">
          ${BACK_ARROW_SVG}
          <span>${escapeHtml(msg.backToAgents)}</span>
        </button>
        <span class="tp-live-1s-pill">
          <span class="tp-live-1s-dot"></span>${escapeHtml(msg.live1sBadge)}
        </span>
      </div>

      <div class="tp-io-hero-rates" role="group" aria-label="${escapeHtml(`${msg.outputStreamLabel} / ${msg.inputStreamLabel}`)}">
        <div class="tp-io-rate-card tp-io-rate-output">
          <span class="tp-io-rate-label">${escapeHtml(msg.outputStreamLabel)}</span>
          <strong class="tp-io-rate-value" data-io-text="hero-out">${escapeHtml(formatRateTokPerSec(agent.liveOutRate))}</strong>
        </div>
        <div class="tp-io-rate-card tp-io-rate-input">
          <span class="tp-io-rate-label">${escapeHtml(msg.inputStreamLabel)}</span>
          <strong class="tp-io-rate-value" data-io-text="hero-in">${escapeHtml(formatRateTokPerSec(agent.liveInRate))}</strong>
        </div>
      </div>

      <div class="tp-io-meta-stack">
        <div class="tp-io-meta-line">
          <span class="tp-agent-badge tp-agent-${agent.agent}">${escapeHtml(msg.agentNames[agent.agent])}</span>
          <span class="tp-state tp-state-${agent.state}" data-io-state-wrap>
            <span class="tp-state-dot"></span><span data-io-text="state-label">${escapeHtml(msg.states[agent.state])}</span>
          </span>
          <span class="tp-model-chip" data-io-text="model" title="${escapeHtml(providerModel)}">${escapeHtml(providerModel)}</span>
        </div>
        <div class="tp-row-between">
          <div class="tp-session-title" data-io-text="title" title="${escapeHtml(agent.title)}">${escapeHtml(agent.title)}</div>
          <span class="tp-project-tag" data-io-text="proj" title="${escapeHtml(agent.workspacePath || projWt)}">${escapeHtml(projWt)}</span>
        </div>
        <div class="tp-io-meta-line">
          <span>${escapeHtml(msg.avgLabel)} <span class="tp-io-accent-out" data-io-text="avg">${agent.tps.avgTps.toFixed(1)}/s</span></span>
          <span>${escapeHtml(msg.peakLabel)} <span class="tp-io-accent-peak" data-io-text="peak">${agent.tps.peakTps.toFixed(1)}/s</span></span>
          <span>${escapeHtml(msg.outputShort)} <strong data-io-text="tok-out">${formatTokens(outTotal)}</strong></span>
          <span>${escapeHtml(msg.inputShort)} <strong data-io-text="tok-in">${formatTokens(inTotal)}</strong></span>
          <span>${escapeHtml(msg.cacheShort)} <strong data-io-text="tok-cache">${formatTokens(cacheTotal)}</strong></span>
          <span>${escapeHtml(msg.costShort)} <span class="tp-cost-pill" data-io-text="cost">${formatUsd(agent.tokens.costUsd)}</span></span>
        </div>
      </div>

      <section class="tp-io-panel" aria-label="${escapeHtml(msg.outputStreamLabel)}">
        <div class="tp-io-panel-hdr">
          <span class="tp-io-panel-title">${escapeHtml(msg.outputStreamLabel)}</span>
          <span class="tp-io-panel-rate" data-io-text="out-rate">${escapeHtml(formatRateTokPerSec(agent.liveOutRate))}</span>
        </div>
        <div class="tp-io-scale-max" data-io-text="out-max">${escapeHtml(formatScaleTokPerSec(outWave.scaleMax))}</div>
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

function renderLiveView(snap: DashboardSnapshot, msg: UiMessages): string {
  const { tokens, tps, agents } = snap.live

  const kpiHtml = `
    <div class="tp-kpi-grid">
      <div class="tp-card">
        <div class="tp-kpi-label">${escapeHtml(msg.liveTpsLabel)}</div>
        <div class="tp-kpi-value tp-kpi-tps">${tps.liveTps.toFixed(1)} <span style="font-size:12px;font-weight:600">tok/s</span></div>
        <div class="tp-kpi-meta">${escapeHtml(msg.peakLabel)} ${tps.peakTps.toFixed(1)} · ${escapeHtml(msg.avgLabel)} ${tps.avgTps.toFixed(1)}</div>
      </div>
      <div class="tp-card">
        <div class="tp-kpi-label">${escapeHtml(msg.liveCostLabel)}</div>
        <div class="tp-kpi-value tp-kpi-cost">${formatUsd(tokens.costUsd)}</div>
        <div class="tp-kpi-meta">${escapeHtml(msg.activeTokensLabel)}: ${formatTokens(tokens.total)}</div>
      </div>
    </div>
    <div class="tp-card">
      <div class="tp-row-between">
        <span class="tp-kpi-label">${escapeHtml(msg.activeTokensLabel)}</span>
        <span class="tp-mono-stat">${formatTokens(tokens.total)} tok</span>
      </div>
      ${renderTricolorBar(tokens, msg, true)}
    </div>
  `

  const cardsHtml =
    agents.length === 0
      ? `<div class="tp-empty">${escapeHtml(msg.noLiveAgents)}</div>`
      : `<div class="tp-list">
          ${agents
            .map((a) => {
              const color = AGENT_COLORS[a.agent]
              const shownTps = a.state === 'working' ? a.tps.liveTps : a.tps.avgTps
              const providerModel = `${a.providerLabel} · ${a.modelLabel}`
              const projWt = formatProjectWorktreeLabel(a.projectName, a.workspaceName)
              return `
                <div
                  class="tp-item-card tp-live-card-clickable"
                  role="button"
                  tabindex="0"
                  data-live-agent-key="${escapeHtml(a.sessionKey)}"
                  aria-label="${escapeHtml(`${msg.agentNames[a.agent]} · ${a.title}`)}"
                >
                  <div class="tp-row-between">
                    <div class="tp-row-left">
                      <span class="tp-agent-badge tp-agent-${a.agent}">${escapeHtml(msg.agentNames[a.agent])}</span>
                      <span class="tp-state tp-state-${a.state}">
                        <span class="tp-state-dot"></span>${escapeHtml(msg.states[a.state])}
                      </span>
                    </div>
                    <span class="tp-mono-stat" style="color:${color}">
                      ${shownTps.toFixed(1)} tok/s<span class="tp-expand-chevron">›</span>
                    </span>
                  </div>
                  <div class="tp-row-between">
                    <span class="tp-model-chip" title="${escapeHtml(providerModel)}">${escapeHtml(providerModel)}</span>
                    ${renderSparklineSvg(a.sparkline, color)}
                  </div>
                  <div class="tp-session-title" title="${escapeHtml(a.title)}">${escapeHtml(a.title)}</div>
                  <div class="tp-row-between" style="font-size:11px;color:var(--tp-muted)">
                    <span class="tp-project-tag" title="${escapeHtml(a.workspacePath || projWt)}">${escapeHtml(projWt)}</span>
                    <span>
                      <strong style="color:var(--tp-fg);font-family:var(--tp-font-mono)">${formatTokens(a.tokens.total)}</strong> tok ·
                      <span class="tp-cost-pill">${formatUsd(a.tokens.costUsd)}</span>
                    </span>
                  </div>
                </div>
              `
            })
            .join('')}
        </div>`

  return `
    ${kpiHtml}
    <div class="tp-section-hdr">
      <span>${escapeHtml(msg.runningAgentsHeader)} (${agents.length})</span>
      ${agents.length > 0 ? `<span class="tp-section-hint">${escapeHtml(msg.clickToInspectHint)}</span>` : ''}
    </div>
    ${cardsHtml}
  `
}

function renderSessionsView(snap: DashboardSnapshot, msg: UiMessages, nowMs: number): string {
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

  const itemsHtml = list
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
              <span class="tp-model-chip" title="${escapeHtml(providerModel)}">${escapeHtml(providerModel)}</span>
            </div>
            <span class="tp-mono-stat">${s.tps.avgTps.toFixed(1)} tok/s</span>
          </div>
          <div class="tp-row-between" style="font-size:11px;color:var(--tp-muted)">
            <span class="tp-row-left" style="gap:5px">
              <span class="tp-project-tag" title="${escapeHtml(s.workspacePath || projWt)}">${escapeHtml(projWt)}</span>
              <span>${escapeHtml(rel)}${s.active ? ` · <strong style="color:#10b981">${escapeHtml(msg.activeBadge)}</strong>` : ''}</span>
            </span>
            <span>
              <strong style="color:var(--tp-fg);font-family:var(--tp-font-mono)">${formatTokens(s.tokens.total)} tok</strong> ·
              <span class="tp-cost-pill">${formatUsd(s.tokens.costUsd)}</span>
            </span>
          </div>
          ${renderTricolorBar(s.tokens, msg, false)}
        </div>
      `
    })
    .join('')

  return `${summaryStrip}<div class="tp-list">${itemsHtml}</div>`
}

function renderPeriodView(
  periodKey: 'day' | 'week' | 'month',
  period: PeriodSummary,
  snap: DashboardSnapshot,
  scope: ScopeMode,
  msg: UiMessages
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

  const focusedBannerHtml =
    scope === 'worktree' && (snap.workspace.project || snap.workspace.name)
      ? `<div class="tp-kpi-meta" style="margin-top:-2px">${escapeHtml(msg.worktreePrefix)}: ${escapeHtml(
          formatProjectWorktreeLabel(snap.workspace.project, snap.workspace.name, snap.workspace.branch)
        )}</div>`
      : ''

  const kpiHtml = `
    ${focusedBannerHtml}
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
      ${renderTricolorBar(period.tokens, msg, true)}
    </div>
  `

  const chartCard = `
    <div class="tp-card">
      <div class="tp-kpi-label">${escapeHtml(chartHeader)}</div>
      ${renderStackedChartSvg(period.buckets, msg)}
    </div>
  `

  const rowsHtml = period.byAgent
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
            <span title="${escapeHtml(providerModel)}">${escapeHtml(providerModel)}</span>
            <span>${escapeHtml(msg.avgLabel)} ${row.tps.avgTps.toFixed(1)} · ${escapeHtml(msg.peakLabel)} ${row.tps.peakTps.toFixed(1)} tok/s</span>
          </div>
        </div>
      `
    })
    .join('')

  return `
    ${kpiHtml}
    ${chartCard}
    <div class="tp-card">
      <div class="tp-kpi-label" style="margin-bottom:4px">${escapeHtml(msg.byAgentHeader)}</div>
      ${period.tokens.total <= 0 ? `<div class="tp-empty" style="margin-top:6px">${escapeHtml(msg.noPeriodData)}</div>` : rowsHtml}
    </div>
  `
}

export function renderDashboardShellHtml(params: {
  snap: DashboardSnapshot | null
  tab: ViewTab
  scope: ScopeMode
  locale: string
  selectedLiveAgentKey?: string | null
  liveDetailAgent?: LiveAgentCard | null
  isRefreshing?: boolean
  isSyncingPricing?: boolean
  nowMs?: number
}): string {
  const {
    snap,
    tab,
    scope,
    locale,
    selectedLiveAgentKey = null,
    liveDetailAgent = null,
    isRefreshing = false,
    isSyncingPricing = false
  } = params
  const nowMs = params.nowMs ?? Date.now()
  const msg = getMessages(locale)

  // Inactive tabs render ONLY the SVG icon; the active tab renders SVG icon + localized short label
  const navButtonsHtml = TAB_ORDER.map((t) => {
    const isActive = t === tab
    const btnCls = isActive ? 'tp-nav-btn active' : 'tp-nav-btn'
    const fullLabel = msg.tabs[t]
    const innerHtml = isActive
      ? `${TAB_ICONS_SVG[t]}<span class="tp-nav-label">${escapeHtml(msg.navShort[t])}</span>`
      : TAB_ICONS_SVG[t]
    return `<button type="button" role="tab" aria-selected="${isActive ? 'true' : 'false'}" class="${btnCls}" data-tab="${t}" title="${escapeHtml(fullLabel)}" aria-label="${escapeHtml(fullLabel)}">${innerHtml}</button>`
  }).join('')

  const resolvedExpandedAgent: LiveAgentCard | null =
    tab === 'live' && selectedLiveAgentKey
      ? (liveDetailAgent &&
        (liveDetailAgent.sessionKey === selectedLiveAgentKey ||
          liveDetailAgent.id === selectedLiveAgentKey)
          ? liveDetailAgent
          : snap?.live.agents.find(
              (a) => a.sessionKey === selectedLiveAgentKey || a.id === selectedLiveAgentKey
            ) ?? null)
      : null

  let rightControlHtml = ''
  if (tab === 'day' || tab === 'week' || tab === 'month') {
    rightControlHtml = `
      <div class="tp-scope-switch">
        <button type="button" class="tp-scope-btn ${scope === 'all' ? 'active' : ''}" data-scope="all">
          ${escapeHtml(msg.scopeAll)}
        </button>
        <button type="button" class="tp-scope-btn ${scope === 'worktree' ? 'active' : ''}" data-scope="worktree">
          ${escapeHtml(msg.scopeWorktree)}
        </button>
      </div>
    `
  } else if (snap?.workspace.name || snap?.workspace.project) {
    const wtText = formatProjectWorktreeLabel(
      snap.workspace.project,
      snap.workspace.name,
      snap.workspace.branch
    )
    rightControlHtml = `<span class="tp-worktree-pill" title="${escapeHtml(snap.workspace.path || wtText)}">${escapeHtml(wtText)}</span>`
  } else {
    rightControlHtml = `<span class="tp-worktree-pill">${escapeHtml(msg.allWorkspacesFallback)}</span>`
  }

  let mainBodyHtml = `<div class="tp-empty">Loading…</div>`
  let pricingFooterHtml = ''

  if (snap) {
    if (tab === 'live') {
      if (resolvedExpandedAgent) {
        mainBodyHtml = `<div id="tp-live-detail-root">${renderLiveAgentDetailHtml(resolvedExpandedAgent, msg)}</div>`
      } else {
        mainBodyHtml = renderLiveView(snap, msg)
      }
    } else if (tab === 'sessions') {
      mainBodyHtml = renderSessionsView(snap, msg, nowMs)
    } else {
      const scopeBag = snap.periods[scope]
      mainBodyHtml = renderPeriodView(tab, scopeBag[tab], snap, scope, msg)
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
        <span>
          <i class="tp-dot" style="background:${p.source === 'online' ? '#10b981' : '#f59e0b'}"></i>
          ${escapeHtml(pSourceLabel)}${syncTime ? ` · ${escapeHtml(syncTime)}` : ''}
        </span>
        <span>${p.modelCount} models</span>
      </div>
    `
  }

  const anyWorking = Boolean(snap?.live.agents.some((a) => a.state === 'working'))
  const subheaderHtml = resolvedExpandedAgent
    ? ''
    : `
    <div class="tp-subheader">
      <div class="tp-view-heading">
        <div class="tp-view-name">${escapeHtml(msg.tabs[tab])}</div>
        <div class="tp-view-sub">${escapeHtml(msg.tabSubtitles[tab])}</div>
      </div>
      ${rightControlHtml}
    </div>
  `

  return `
    <header class="tp-header">
      <div class="tp-title-wrap">
        <span class="tp-brand-emblem ${anyWorking ? 'tp-brand-live' : ''}" aria-hidden="true">${BRAND_EMBLEM_SVG}</span>
        <h1 class="tp-title">${escapeHtml(msg.appTitle)}</h1>
      </div>
      <div class="tp-header-actions">
        <button
          type="button"
          id="btn-sync-pricing"
          class="tp-icon-btn ${isSyncingPricing ? 'tp-spinning' : ''}"
          title="${escapeHtml(msg.syncPricingTooltip)}"
          aria-label="${escapeHtml(msg.syncPricingTooltip)}"
        >
          ${DOLLAR_SYNC_SVG}
        </button>
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

    <nav class="tp-nav" role="tablist">
      ${navButtonsHtml}
    </nav>

    ${subheaderHtml}

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
  let currentScope: ScopeMode = 'all'
  let overrideLocale: string | null = null
  let selectedLiveAgentKey: string | null = null
  let liveDetailAgent: LiveAgentCard | null = null
  let liveDetailGeneratedAt = 0
  let livePollTimer: ReturnType<typeof setInterval> | null = null
  let livePollInFlight = false

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
    if (savedTab && TAB_ORDER.includes(savedTab)) currentTab = savedTab
    if (localStorage.getItem('tp.scope') === 'worktree') currentScope = 'worktree'
  } catch {
    // Ignore storage access errors in strict frames
  }

  let snapshot: DashboardSnapshot | null = null
  let isRefreshing = false
  let isSyncingPricing = false

  function resolveEffectiveLocale(): string {
    if (overrideLocale) return overrideLocale
    return typeof window.orca?.locale === 'string' && window.orca.locale
      ? window.orca.locale
      : navigator.language || 'en'
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

    setIoText(detailRoot, 'hero-out', formatRateTokPerSec(agent.liveOutRate))
    setIoText(detailRoot, 'hero-in', formatRateTokPerSec(agent.liveInRate))
    setIoText(detailRoot, 'out-rate', formatRateTokPerSec(agent.liveOutRate))
    setIoText(detailRoot, 'in-rate', formatRateTokPerSec(agent.liveInRate))
    setIoText(detailRoot, 'state-label', msg.states[agent.state])
    setIoText(detailRoot, 'model', providerModel)
    setIoText(detailRoot, 'title', agent.title)
    setIoText(detailRoot, 'proj', projWt)
    setIoText(detailRoot, 'avg', `${agent.tps.avgTps.toFixed(1)}/s`)
    setIoText(detailRoot, 'peak', `${agent.tps.peakTps.toFixed(1)}/s`)
    setIoText(detailRoot, 'tok-out', formatTokens(outTotal))
    setIoText(detailRoot, 'tok-in', formatTokens(inTotal))
    setIoText(detailRoot, 'tok-cache', formatTokens(cacheTotal))
    setIoText(detailRoot, 'cost', formatUsd(agent.tokens.costUsd))

    const stateWrap = detailRoot.querySelector<HTMLElement>('[data-io-state-wrap]')
    if (stateWrap) {
      const nextCls = `tp-state tp-state-${agent.state}`
      if (stateWrap.className !== nextCls) {
        stateWrap.className = nextCls
      }
    }

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
            : snapshot?.live.agents.find(
                (a) => a.sessionKey === selectedLiveAgentKey || a.id === selectedLiveAgentKey
              ) ?? null)
        : null

    if (activeExpandedAgent) {
      ingestStreamAgent(activeExpandedAgent, snapshot?.generatedAt)
    }

    appRoot!.innerHTML = renderDashboardShellHtml({
      snap: snapshot,
      tab: currentTab,
      scope: currentScope,
      locale,
      selectedLiveAgentKey,
      liveDetailAgent,
      isRefreshing,
      isSyncingPricing
    })

    if (activeExpandedAgent) {
      renderStreamWaveFrame(0)
      syncLiveStreamEngines()
    }
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

  function selectLiveAgent(sessionKey: string | null): void {
    if (selectedLiveAgentKey !== sessionKey) {
      resetStreamState()
    }
    selectedLiveAgentKey = sessionKey
    if (!sessionKey) {
      liveDetailAgent = null
      liveDetailGeneratedAt = 0
    } else {
      liveDetailAgent =
        snapshot?.live.agents.find(
          (a) => a.sessionKey === sessionKey || a.id === sessionKey
        ) ?? null
      liveDetailGeneratedAt = liveDetailAgent && snapshot ? snapshot.generatedAt : 0
    }
    syncLiveStreamEngines()
    renderApp()
    if (sessionKey) {
      void pollSelectedAgentOnce()
    }
  }

  appRoot.addEventListener('click', async (ev) => {
    const target = ev.target as HTMLElement | null
    if (!target) return

    if (target.closest('#btn-live-back')) {
      selectLiveAgent(null)
      return
    }

    const liveCard = target.closest<HTMLElement>('[data-live-agent-key]')
    if (liveCard && currentTab === 'live') {
      const key = liveCard.dataset.liveAgentKey?.trim() || ''
      if (key) {
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

    if (target.closest('#btn-refresh')) {
      if (isRefreshing) return
      isRefreshing = true
      renderApp()
      try {
        snapshot = await window.orca.plugin.request('dashboard.get', {
          forceScan: true,
          locale: resolveEffectiveLocale()
        })
        if (selectedLiveAgentKey && snapshot) {
          const hit = snapshot.live.agents.find(
            (a) => a.sessionKey === selectedLiveAgentKey || a.id === selectedLiveAgentKey
          )
          if (hit) liveDetailAgent = hit
        }
      } catch (err) {
        console.error('Failed to refresh dashboard:', err)
      } finally {
        isRefreshing = false
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
      const liveCard = target?.closest<HTMLElement>('[data-live-agent-key]')
      if (liveCard && currentTab === 'live') {
        ev.preventDefault()
        const key = liveCard.dataset.liveAgentKey?.trim() || ''
        if (key) selectLiveAgent(key)
      }
    }
  })

  document.addEventListener('visibilitychange', () => {
    syncLiveStreamEngines()
    if (!document.hidden && currentTab === 'live' && selectedLiveAgentKey) {
      void pollSelectedAgentOnce()
    }
  })

  window.addEventListener('pagehide', () => {
    if (livePollTimer !== null) {
      clearInterval(livePollTimer)
      livePollTimer = null
    }
    stopStreamRaf()
  })

  renderApp()

  if (typeof window.orca !== 'undefined') {
    window.orca.on('theme', () => {
      renderApp()
    })

    window.orca.plugin.on('dashboard.updated', (nextSnap) => {
      snapshot = nextSnap
      if (currentTab === 'live' && selectedLiveAgentKey) {
        // Keep header emblem synced without tearing down the 60fps SVG stream
        const emblem = document.querySelector('.tp-brand-emblem')
        const anyWorking = nextSnap.live.agents.some((a) => a.state === 'working')
        if (emblem) {
          emblem.classList.toggle('tp-brand-live', anyWorking)
        }
        if (nextSnap.generatedAt >= liveDetailGeneratedAt) {
          const updatedAgent = nextSnap.live.agents.find(
            (a) => a.sessionKey === selectedLiveAgentKey || a.id === selectedLiveAgentKey
          )
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
          liveDetailAgent =
            snapshot.live.agents.find(
              (a) => a.sessionKey === selectedLiveAgentKey || a.id === selectedLiveAgentKey
            ) ?? liveDetailAgent
        } else if (!selectedLiveAgentKey) {
          liveDetailAgent = null
        }
      } else if (currentTab !== 'live') {
        selectedLiveAgentKey = null
        liveDetailAgent = null
      }
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
          liveDetailAgent =
            snap.live.agents.find(
              (a) => a.sessionKey === selectedLiveAgentKey || a.id === selectedLiveAgentKey
            ) ?? liveDetailAgent
        }
        renderApp()
      })
      .catch((err) => {
        console.error('Initial dashboard.get failed:', err)
      })
  }
}

initBrowserPanel()
