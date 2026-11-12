import fs from 'node:fs'
import path from 'node:path'
import type { AgentKind } from './protocol'

export interface ParsedTurnUsage {
  turnKey: string
  timestampMs: number
  /** Non-cached input tokens */
  input: number
  /** Non-reasoning output tokens */
  output: number
  /** Reasoning output tokens */
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** Total tokens for display */
  total: number
  /** Inference duration in seconds, or null if unknown / out of bounds */
  durationSec: number | null
  /** Computed generation TPS ((output + reasoning) / durationSec), or null */
  tps: number | null
  model: string | null
  explicitCostUsd: number | null
}

export type TranscriptEventState = 'working' | 'waiting' | 'done'

export interface SessionTranscriptState {
  sessionId: string
  agent: AgentKind
  filePath: string
  offsetBytes: number
  lastSizeBytes: number
  lastMtimeMs: number
  cwd: string | null
  titleHint: string | null
  isInternalHelper: boolean
  isSubagent: boolean
  latestModel: string | null
  createdAtMs: number
  updatedAtMs: number
  /** Authoritative turn state inferred from the latest transcript step (`working` | `waiting` | `done`) */
  lastEventState: TranscriptEventState | null
  turnsByKey: Map<string, ParsedTurnUsage>
  // Incremental parser cursor state across byte-offset reads
  lastInferenceStartMs: number | null
  turnStartMs: Map<string, number>
  lastCodexCumulativeTotal: number | null
  agStepCreatedMs: Map<number, number>
  maxAgStepIndex: number
}

export function createEmptySessionState(
  sessionId: string,
  agent: AgentKind,
  filePath: string
): SessionTranscriptState {
  return {
    sessionId,
    agent,
    filePath,
    offsetBytes: 0,
    lastSizeBytes: 0,
    lastMtimeMs: 0,
    cwd: null,
    titleHint: null,
    isInternalHelper: false,
    isSubagent: false,
    latestModel: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    lastEventState: null,
    turnsByKey: new Map(),
    lastInferenceStartMs: null,
    turnStartMs: new Map(),
    lastCodexCumulativeTotal: null,
    agStepCreatedMs: new Map(),
    maxAgStepIndex: -1
  }
}

const STREAM_WINDOW_BYTES = 2 * 1024 * 1024 // 2 MiB read window
const MAX_SINGLE_LINE_BYTES = 16 * 1024 * 1024 // Skip pathological >16 MiB base64 lines without OOM

/**
 * Reads newly appended complete UTF-8 lines starting at `fromOffset` up to the last `\n` byte
 * using bounded 2 MiB windows so huge transcript files never cause V8 heap spikes.
 * If the trailing line has no `\n` yet (active streaming write), `nextOffset` stops right before
 * that incomplete line so the next poll reads it whole without JSON parse failures or lost data.
 */
export function readCompleteJsonlChunk(
  filePath: string,
  fromOffset: number
): { lines: string[]; nextOffset: number; fileSize: number; mtimeMs: number } {
  const stat = fs.statSync(filePath)
  const fileSize = stat.size
  const mtimeMs = stat.mtimeMs

  // Handle file truncation or replacement
  const startOffset = fromOffset > fileSize || fromOffset < 0 ? 0 : fromOffset
  if (fileSize === startOffset) {
    return { lines: [], nextOffset: startOffset, fileSize, mtimeMs }
  }

  const fd = fs.openSync(filePath, 'r')
  try {
    const windowBuf = Buffer.allocUnsafe(Math.min(STREAM_WINDOW_BYTES, fileSize - startOffset))
    const lines: string[] = []
    let cursor = startOffset
    let lineStartOffset = startOffset
    let carryChunks: Buffer[] = []
    let carryBytes = 0
    let droppingOversizedLine = false

    while (cursor < fileSize) {
      const toRead = Math.min(windowBuf.length, fileSize - cursor)
      const bytesRead = fs.readSync(fd, windowBuf, 0, toRead, cursor)
      if (bytesRead <= 0) break

      let sliceStart = 0
      for (let i = 0; i < bytesRead; i++) {
        if (windowBuf[i] === 0x0a) {
          if (!droppingOversizedLine) {
            const tail = windowBuf.subarray(sliceStart, i)
            const fullLine =
              carryChunks.length === 0
                ? tail.toString('utf8')
                : Buffer.concat([...carryChunks, tail], carryBytes + tail.length).toString('utf8')
            const trimmed = fullLine.trim()
            if (trimmed) lines.push(trimmed)
          }
          carryChunks = []
          carryBytes = 0
          droppingOversizedLine = false
          sliceStart = i + 1
          lineStartOffset = cursor + sliceStart
        }
      }

      if (sliceStart < bytesRead) {
        const rem = windowBuf.subarray(sliceStart, bytesRead)
        if (!droppingOversizedLine) {
          if (carryBytes + rem.length > MAX_SINGLE_LINE_BYTES) {
            carryChunks = []
            carryBytes = 0
            droppingOversizedLine = true
          } else {
            carryChunks.push(Buffer.from(rem))
            carryBytes += rem.length
          }
        }
      }

      cursor += bytesRead
    }

    return {
      lines,
      nextOffset: lineStartOffset,
      fileSize,
      mtimeMs
    }
  } finally {
    fs.closeSync(fd)
  }
}

function parseIsoMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 1e12 ? raw : raw * 1000
  }
  if (typeof raw === 'string' && raw.trim()) {
    const ms = Date.parse(raw)
    if (Number.isFinite(ms) && ms > 0) return ms
  }
  return null
}

const MAX_REALISTIC_TPS = 450

function computeValidDurationAndTps(
  startMs: number | null,
  endMs: number,
  generatedTokens: number,
  minDurationSec = 0.2
): { durationSec: number | null; tps: number | null } {
  if (!startMs || endMs <= startMs || generatedTokens <= 0) {
    return { durationSec: null, tps: null }
  }
  const deltaSec = (endMs - startMs) / 1000
  // Filter sub-threshold metadata/quantization noise and >10min idle gaps
  if (deltaSec < minDurationSec || deltaSec > 600) {
    return { durationSec: null, tps: null }
  }
  const tps = generatedTokens / deltaSec
  if (!Number.isFinite(tps) || tps <= 0 || tps > MAX_REALISTIC_TPS) {
    return { durationSec: null, tps: null }
  }
  return { durationSec: deltaSec, tps }
}

function sanitizePromptPreview(raw: string): string | null {
  let s = raw
  // Unwrap Antigravity <USER_REQUEST>...</USER_REQUEST>
  const match = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i)
  if (match) {
    s = match[1]
  }
  // If this is an Orca handover continuation prompt, surface the original session title
  if (s.includes('Continue work from the prior Orca session')) {
    const sessMatch = s.match(/Session:\s*([^\r\n]+)/)
    if (sessMatch?.[1]?.trim()) {
      s = sessMatch[1].trim()
    }
  }
  // Strip XML-like system tags
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > 88 ? `${s.slice(0, 85)}…` : s
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part)
      } else if (part && typeof part === 'object') {
        const text =
          (part as { text?: unknown; input_text?: unknown }).text ??
          (part as { input_text?: unknown }).input_text
        if (typeof text === 'string') parts.push(text)
      }
    }
    return parts.join(' ')
  }
  return ''
}

function isInternalHelperPromptText(text: string): boolean {
  if (!text) return false
  return (
    text.includes("Name this chat from the user's first request.") ||
    text.includes('You are generating a single git commit message.') ||
    text.includes('Return only the commit message text.')
  )
}

function touchTimestamps(state: SessionTranscriptState, tsMs: number | null): void {
  if (!tsMs) return
  if (state.createdAtMs === 0 || tsMs < state.createdAtMs) {
    state.createdAtMs = tsMs
  }
  if (tsMs > state.updatedAtMs) {
    state.updatedAtMs = tsMs
  }
}

/**
 * Parses lines from a Claude Code `~/.claude/projects/.../*.jsonl` session transcript.
 */
export function applyClaudeLines(state: SessionTranscriptState, lines: string[]): void {
  for (const line of lines) {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    const tsMs = parseIsoMs(obj.timestamp)
    touchTimestamps(state, tsMs)

    if (typeof obj.cwd === 'string' && obj.cwd.trim()) {
      state.cwd = obj.cwd.trim()
    }
    if (typeof obj.customTitle === 'string' && obj.customTitle.trim()) {
      state.titleHint = obj.customTitle.trim()
    }

    const entryType = obj.type
    if (entryType === 'api-request') {
      const params = obj.params as { model?: unknown } | undefined
      if (typeof params?.model === 'string' && params.model !== '<synthetic>') {
        state.latestModel = params.model
      }
      if (tsMs) {
        state.lastInferenceStartMs = tsMs
      }
      state.lastEventState = 'working'
      continue
    }

    if (entryType === 'user') {
      if (tsMs) {
        state.lastInferenceStartMs = tsMs
      }
      const msg = obj.message as { content?: unknown } | undefined
      const rawText = extractMessageText(msg?.content)
      if (state.turnsByKey.size === 0 && isInternalHelperPromptText(rawText)) {
        state.isInternalHelper = true
      }
      if (!state.titleHint && rawText) {
        const preview = sanitizePromptPreview(rawText)
        if (preview) state.titleHint = preview
      }
      state.lastEventState = 'working'
      continue
    }

    if (entryType === 'assistant') {
      const msg = obj.message as {
        id?: unknown
        model?: unknown
        stop_reason?: unknown
        content?: unknown
        usage?: Record<string, unknown>
      } | null
      if (!msg || typeof msg !== 'object') continue

      const model = typeof msg.model === 'string' ? msg.model : null
      if (model === '<synthetic>') continue
      if (model) state.latestModel = model

      const stopReason = typeof msg.stop_reason === 'string' ? msg.stop_reason : null
      if (stopReason === 'end_turn' || stopReason === 'stop_sequence' || stopReason === 'max_tokens') {
        state.lastEventState = 'done'
      } else {
        const blocks = Array.isArray(msg.content) ? msg.content : []
        const hasInteractiveQuestion = blocks.some((b) => {
          if (!b || typeof b !== 'object') return false
          const name = String((b as { name?: unknown }).name || '')
          return name === 'AskUserQuestion' || name === 'ExitPlanMode'
        })
        state.lastEventState = hasInteractiveQuestion ? 'waiting' : 'working'
      }

      const usage = msg.usage
      if (!usage || typeof usage !== 'object') continue

      const input = Math.max(0, Number(usage.input_tokens) || 0)
      const output = Math.max(0, Number(usage.output_tokens) || 0)
      const cacheRead = Math.max(0, Number(usage.cache_read_input_tokens) || 0)
      const cacheWrite = Math.max(0, Number(usage.cache_creation_input_tokens) || 0)
      const total = input + output + cacheRead + cacheWrite
      if (total <= 0) continue

      const endMs = tsMs ?? (state.updatedAtMs || Date.now())
      const turnKey =
        typeof msg.id === 'string' && msg.id
          ? msg.id
          : typeof obj.uuid === 'string' && obj.uuid
            ? obj.uuid
            : `claude-${state.turnsByKey.size}-${endMs}`

      // Persist the original request start timestamp per `turnKey` across multi-poll streaming chunks
      let inferredStartMs = state.turnStartMs.get(turnKey) ?? null
      if (inferredStartMs === null && state.lastInferenceStartMs !== null) {
        inferredStartMs = state.lastInferenceStartMs
        if (state.turnStartMs.size >= 64) {
          const oldestKey = state.turnStartMs.keys().next().value
          if (oldestKey !== undefined) state.turnStartMs.delete(oldestKey)
        }
        state.turnStartMs.set(turnKey, inferredStartMs)
      }

      const { durationSec, tps } = computeValidDurationAndTps(inferredStartMs, endMs, output)
      const explicitCost =
        typeof obj.costUSD === 'number' && obj.costUSD > 0 ? obj.costUSD : null

      state.turnsByKey.set(turnKey, {
        turnKey,
        timestampMs: endMs,
        input,
        output,
        reasoning: 0,
        cacheRead,
        cacheWrite,
        total,
        durationSec,
        tps,
        model: model || state.latestModel,
        explicitCostUsd: explicitCost
      })

      // Next tool loop starts from this completion unless overridden by a user/api-request event
      state.lastInferenceStartMs = endMs
    }
  }
}

/**
 * Parses lines from a Codex `~/.codex/sessions/.../*.jsonl` rollout transcript.
 */
export function applyCodexLines(state: SessionTranscriptState, lines: string[]): void {
  for (const line of lines) {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    const tsMs = parseIsoMs(obj.timestamp)
    touchTimestamps(state, tsMs)

    const topType = obj.type
    const payload = (obj.payload && typeof obj.payload === 'object'
      ? obj.payload
      : {}) as Record<string, unknown>

    if (topType === 'session_meta') {
      if (typeof payload.cwd === 'string' && payload.cwd.trim()) {
        state.cwd = payload.cwd.trim()
      }
      if (typeof payload.id === 'string' && payload.id.trim()) {
        state.sessionId = payload.id.trim()
      } else if (typeof payload.session_id === 'string' && payload.session_id.trim()) {
        state.sessionId = payload.session_id.trim()
      }
      const source = payload.source as { kind?: unknown; subagent?: unknown } | string | undefined
      const sourceKind =
        typeof source === 'string'
          ? source
          : source && typeof source === 'object' && typeof source.kind === 'string'
            ? source.kind
            : ''
      if (sourceKind === 'memory_consolidation' || sourceKind === 'guardian_review') {
        state.isInternalHelper = true
      } else if (
        sourceKind === 'subagent' ||
        (source && typeof source === 'object' && 'subagent' in source && Boolean(source.subagent))
      ) {
        state.isSubagent = true
      }
      continue
    }

    if (topType === 'turn_context') {
      if (typeof payload.cwd === 'string' && payload.cwd.trim()) {
        state.cwd = payload.cwd.trim()
      }
      if (typeof payload.model === 'string' && payload.model.trim()) {
        state.latestModel = payload.model.trim()
      }
      if (tsMs) state.lastInferenceStartMs = tsMs
      continue
    }

    if (topType === 'response_item') {
      if (payload.type === 'message' && payload.role === 'user') {
        const text = extractMessageText(payload.content)
        if (state.turnsByKey.size === 0 && isInternalHelperPromptText(text)) {
          state.isInternalHelper = true
        }
        // Skip system/developer injected instructions
        if (
          !state.titleHint &&
          text &&
          !text.startsWith('# AGENTS.md') &&
          !text.startsWith('<environment_context>')
        ) {
          const preview = sanitizePromptPreview(text)
          if (preview) state.titleHint = preview
        }
        state.lastEventState = 'working'
      } else if (payload.type === 'message' && payload.role === 'assistant') {
        if (payload.phase === 'final_answer') {
          state.lastEventState = 'done'
        }
      } else if (payload.type === 'function_call') {
        const fnName = String(payload.name || '')
        state.lastEventState = fnName === 'request_user_input' ? 'waiting' : 'working'
      } else if (payload.type === 'function_call_output') {
        if (tsMs) state.lastInferenceStartMs = tsMs
        state.lastEventState = 'working'
      }
      continue
    }

    if (topType === 'event_msg') {
      const evType = payload.type
      if (evType === 'task_complete' || evType === 'turn_aborted') {
        state.lastEventState = 'done'
        continue
      }
      if (evType === 'agent_message' && payload.phase === 'final_answer') {
        state.lastEventState = 'done'
        continue
      }
      if (evType === 'task_started' || evType === 'user_message') {
        if (tsMs) state.lastInferenceStartMs = tsMs
        if (evType === 'user_message' && typeof payload.message === 'string') {
          if (state.turnsByKey.size === 0 && isInternalHelperPromptText(payload.message)) {
            state.isInternalHelper = true
          }
          if (!state.titleHint) {
            const preview = sanitizePromptPreview(payload.message)
            if (preview) state.titleHint = preview
          }
        }
        state.lastEventState = 'working'
        continue
      }

      if (evType === 'token_count') {
        const info = payload.info as Record<string, unknown> | null
        if (!info || typeof info !== 'object') continue

        const totalUsage = info.total_token_usage as Record<string, unknown> | undefined
        const cumulativeTotal = Number(totalUsage?.total_tokens)
        if (Number.isFinite(cumulativeTotal) && cumulativeTotal > 0) {
          // Deduplicate consecutive identical token_count heartbeats
          if (state.lastCodexCumulativeTotal === cumulativeTotal) {
            continue
          }
          state.lastCodexCumulativeTotal = cumulativeTotal
        }

        const last = info.last_token_usage as Record<string, unknown> | undefined
        if (!last || typeof last !== 'object') continue

        const rawInput = Math.max(0, Number(last.input_tokens) || 0)
        const cacheRead = Math.max(0, Number(last.cached_input_tokens) || 0)
        const cacheWrite = Math.max(0, Number(last.cache_write_input_tokens) || 0)
        // In OpenAI / Codex `input_tokens` includes `cached_input_tokens`! Subtract so we never double-count tokens or cost!
        const uncachedInput = Math.max(0, rawInput - cacheRead)

        const rawOutput = Math.max(0, Number(last.output_tokens) || 0)
        const reasoning = Math.max(0, Number(last.reasoning_output_tokens) || 0)
        const includesReasoning = info.last_usage_includes_reasoning !== false
        const nonReasoningOutput = includesReasoning ? Math.max(0, rawOutput - reasoning) : rawOutput
        const generatedOut = nonReasoningOutput + reasoning

        const total = uncachedInput + cacheRead + cacheWrite + generatedOut
        if (total <= 0) continue

        const endMs = tsMs ?? (state.updatedAtMs || Date.now())
        const { durationSec, tps } = computeValidDurationAndTps(
          state.lastInferenceStartMs,
          endMs,
          generatedOut
        )

        const turnKey = `codex-${Number.isFinite(cumulativeTotal) ? cumulativeTotal : `${state.turnsByKey.size}-${endMs}`}`
        state.turnsByKey.set(turnKey, {
          turnKey,
          timestampMs: endMs,
          input: uncachedInput,
          output: nonReasoningOutput,
          reasoning,
          cacheRead,
          cacheWrite,
          total,
          durationSec,
          tps,
          model: state.latestModel,
          explicitCostUsd: null
        })

        state.lastInferenceStartMs = endMs
      }
    }
  }
}

function minDurationForAntigravity(startMs: number | null, endMs: number): number {
  if (!startMs) return 0.2
  // Antigravity ISO timestamps are quantized to whole seconds; require >= 2s span when quantized
  // so a 1.05s response crossing a second boundary cannot round to 1.0s and inflate TPS 2x.
  return startMs % 1000 === 0 && endMs % 1000 === 0 ? 2.0 : 0.2
}

/**
 * Parses lines from an Antigravity `.system_generated/logs/transcript.jsonl` file.
 * Note: In Antigravity transcripts, `PLANNER_RESPONSE.created_at` is the step START timestamp
 * (1-second precision) and lines may flush out of `step_index` order (e.g. `step_index + 1` tool
 * call written just before `step_index` `PLANNER_RESPONSE`). We reconcile duration & completion
 * `timestampMs` against the earliest subsequent step (`step_index > k`) or live file flush `mtimeMs`.
 */
export function applyAntigravityLines(state: SessionTranscriptState, lines: string[]): void {
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    const tsMs = parseIsoMs(obj.created_at)
    touchTimestamps(state, tsMs)

    const hasNumericIdx = typeof obj.step_index === 'number' && Number.isFinite(obj.step_index)
    const stepIndex = hasNumericIdx ? (obj.step_index as number) : state.turnsByKey.size
    const stepType = String(obj.type || '')
    const stepStatus = String(obj.status || '')

    if (stepIndex >= state.maxAgStepIndex) {
      state.maxAgStepIndex = stepIndex
      if (stepType === 'USER_INPUT') {
        state.lastEventState = 'working'
      } else if (stepType === 'PLANNER_RESPONSE') {
        const toolCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : []
        const hasAskQuestion = toolCalls.some((tc) => {
          if (!tc || typeof tc !== 'object') return false
          const name = String((tc as { name?: unknown }).name || '')
          return name === 'ask_question' || name.endsWith(':ask_question')
        })
        if (hasAskQuestion) {
          state.lastEventState = 'waiting'
        } else if (
          toolCalls.length === 0 &&
          (stepStatus === 'DONE' || stepStatus === 'ERROR' || stepStatus === 'CANCELED')
        ) {
          state.lastEventState = 'done'
        } else {
          state.lastEventState = 'working'
        }
      } else {
        state.lastEventState = 'working'
      }
    }

    if (hasNumericIdx && tsMs) {
      if (state.agStepCreatedMs.size > 512) {
        const oldestIdx = state.agStepCreatedMs.keys().next().value
        if (oldestIdx !== undefined) state.agStepCreatedMs.delete(oldestIdx)
      }
      state.agStepCreatedMs.set(stepIndex, tsMs)
      // Backfill any preceding PLANNER_RESPONSE turn whose completion timestamp just arrived
      for (let prevIdx = stepIndex - 1; prevIdx >= Math.max(0, stepIndex - 6); prevIdx--) {
        const prevTurn = state.turnsByKey.get(`ag-step-${prevIdx}`)
        const prevStartMs = state.agStepCreatedMs.get(prevIdx) ?? prevTurn?.timestampMs ?? null
        if (prevTurn && prevStartMs !== null && tsMs > prevStartMs) {
          if (prevTurn.tps === null) {
            const genOut = prevTurn.output + prevTurn.reasoning
            const minDur = minDurationForAntigravity(prevStartMs, tsMs)
            const { durationSec, tps } = computeValidDurationAndTps(
              prevStartMs,
              tsMs,
              genOut,
              minDur
            )
            if (durationSec !== null && tps !== null) {
              prevTurn.durationSec = durationSec
              prevTurn.tps = tps
            }
          }
          if (tsMs > prevTurn.timestampMs) {
            prevTurn.timestampMs = tsMs
          }
          break
        }
      }
    }

    if (stepType === 'USER_INPUT') {
      if (tsMs) state.lastInferenceStartMs = tsMs
      const content = typeof obj.content === 'string' ? obj.content : ''
      if (stepIndex === 0 && isInternalHelperPromptText(content)) {
        state.isInternalHelper = true
      }
      if (!state.titleHint && content) {
        const preview = sanitizePromptPreview(content)
        if (preview) state.titleHint = preview
      }
      // Extract workspace hint if present in system metadata or Orca handover header
      if (!state.cwd) {
        const cwdMatch =
          content.match(/Command Working Directory:\s*([^\r\n]+)/) ||
          content.match(/Original working directory:\s*([^\r\n]+)/) ||
          content.match(/Active Workspaces:\s*\r?\n-\s*([^\r\n]+)/)
        if (cwdMatch?.[1]?.trim()) {
          state.cwd = cwdMatch[1].trim()
        }
      }
      continue
    }

    if (stepType === 'PLANNER_RESPONSE') {
      const input = Math.max(0, Number(obj.input_tokens) || 0)
      const cacheRead = Math.max(0, Number(obj.cache_read_tokens) || 0)
      const cacheWrite = Math.max(0, Number(obj.cache_write_tokens) || 0)
      const output = Math.max(0, Number(obj.output_tokens) || 0)
      const reasoning = Math.max(0, Number(obj.thoughts_tokens ?? obj.reasoning_tokens) || 0)
      const total = input + cacheRead + cacheWrite + output + reasoning
      if (total <= 0) continue

      if (typeof obj.model === 'string' && obj.model.trim()) {
        state.latestModel = obj.model.trim()
      }

      const startOrTurnMs = tsMs ?? (state.updatedAtMs || Date.now())
      const generatedOut = output + reasoning

      // 1) Prefer completion timestamp from earliest subsequent step (`step_index > stepIndex`)
      let nextStepMs: number | null = null
      if (hasNumericIdx) {
        for (let nextIdx = stepIndex + 1; nextIdx <= stepIndex + 8; nextIdx++) {
          const cand = state.agStepCreatedMs.get(nextIdx)
          if (cand && cand > startOrTurnMs) {
            nextStepMs = cand
            break
          }
        }
      }

      // 2) If this is the trailing step on disk (`lineIdx === lines.length - 1`) and `lastMtimeMs`
      // reflects the actual file flush time of this completed step, use it as completion timestamp!
      const isTrailingStep = lineIdx === lines.length - 1 && stepIndex >= state.maxAgStepIndex
      const liveFlushEndMs =
        nextStepMs === null &&
        isTrailingStep &&
        state.lastMtimeMs > startOrTurnMs &&
        state.lastMtimeMs - startOrTurnMs <= 180_000
          ? Math.round(state.lastMtimeMs)
          : null

      const effectiveEndMs = nextStepMs ?? liveFlushEndMs
      let durationSec: number | null = null
      let tps: number | null = null
      if (effectiveEndMs !== null) {
        const minDur = minDurationForAntigravity(startOrTurnMs, effectiveEndMs)
        const computed = computeValidDurationAndTps(
          startOrTurnMs,
          effectiveEndMs,
          generatedOut,
          minDur
        )
        durationSec = computed.durationSec
        tps = computed.tps
      } else {
        const minDur = minDurationForAntigravity(state.lastInferenceStartMs, startOrTurnMs)
        const computed = computeValidDurationAndTps(
          state.lastInferenceStartMs,
          startOrTurnMs,
          generatedOut,
          minDur
        )
        durationSec = computed.durationSec
        tps = computed.tps
      }

      const completionTimestampMs = effectiveEndMs ?? startOrTurnMs
      touchTimestamps(state, completionTimestampMs)

      const turnKey = `ag-step-${stepIndex}`
      state.turnsByKey.set(turnKey, {
        turnKey,
        timestampMs: completionTimestampMs,
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        total,
        durationSec,
        tps,
        model: state.latestModel,
        explicitCostUsd: null
      })

      state.lastInferenceStartMs = completionTimestampMs
      continue
    }

    // Tool execution completions mark the start of the next planner inference turn
    if (tsMs) {
      state.lastInferenceStartMs = tsMs
    }
  }
}

function extractGeminiFolderKeyFromPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/')
  const match = normalized.match(/\/tmp\/([^/]+)\/chats\/[^/]+$/)
  return match?.[1] ?? null
}

/**
 * Parses a Gemini CLI `session-*.json` chat document (`~/.gemini/tmp/<hash>/chats/session-*.json`).
 */
export function parseGeminiSessionJson(
  filePath: string,
  rawJson: string,
  projectPathMap?: Map<string, string>
): SessionTranscriptState | null {
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(rawJson) as Record<string, unknown>
  } catch {
    return null
  }

  const sessionId =
    typeof doc.sessionId === 'string' && doc.sessionId.trim()
      ? doc.sessionId.trim()
      : path.basename(filePath, path.extname(filePath))

  const state = createEmptySessionState(sessionId, 'gemini', filePath)

  if (typeof doc.cwd === 'string' && doc.cwd.trim()) {
    state.cwd = doc.cwd.trim()
  } else if (projectPathMap) {
    const hashCandidates = [
      typeof doc.projectHash === 'string' ? doc.projectHash.trim() : null,
      extractGeminiFolderKeyFromPath(filePath)
    ]
    for (const key of hashCandidates) {
      if (key && projectPathMap.has(key)) {
        state.cwd = projectPathMap.get(key) ?? null
        break
      }
    }
  }

  touchTimestamps(state, parseIsoMs(doc.startTime))
  touchTimestamps(state, parseIsoMs(doc.lastUpdated))

  const messages = Array.isArray(doc.messages) ? doc.messages : []
  let lastStartMs: number | null = state.createdAtMs || null

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx] as Record<string, unknown> | null
    if (!msg || typeof msg !== 'object') continue

    const tsMs = parseIsoMs(msg.timestamp)
    touchTimestamps(state, tsMs)

    const role = String(msg.type ?? msg.role ?? '').toLowerCase()
    if (role === 'user') {
      if (tsMs) lastStartMs = tsMs
      const rawText = extractMessageText(msg.content)
      if (state.turnsByKey.size === 0 && isInternalHelperPromptText(rawText)) {
        state.isInternalHelper = true
      }
      if (!state.titleHint && rawText) {
        const preview = sanitizePromptPreview(rawText)
        if (preview) state.titleHint = preview
      }
      state.lastEventState = 'working'
      continue
    }

    if (role === 'gemini' || role === 'model' || role === 'assistant') {
      const model = typeof msg.model === 'string' && msg.model.trim() ? msg.model.trim() : null
      if (model) state.latestModel = model
      state.lastEventState = 'done'

      const tok = (msg.tokens ?? msg.usageMetadata ?? msg.usage) as
        | Record<string, unknown>
        | undefined
      if (!tok || typeof tok !== 'object') continue

      const rawInput = Math.max(
        0,
        Number(tok.input ?? tok.promptTokenCount ?? tok.input_tokens) || 0
      )
      const cacheRead = Math.max(
        0,
        Number(tok.cached ?? tok.cachedContentTokenCount ?? tok.cache_read_input_tokens) || 0
      )
      const uncachedInput = rawInput >= cacheRead ? rawInput - cacheRead : rawInput
      const output = Math.max(
        0,
        Number(tok.output ?? tok.candidatesTokenCount ?? tok.output_tokens) || 0
      )
      const reasoning = Math.max(0, Number(tok.thoughts ?? tok.thoughtsTokenCount ?? 0) || 0)
      const total = uncachedInput + cacheRead + output + reasoning
      if (total <= 0) continue

      const endMs = tsMs ?? (state.updatedAtMs || Date.now())
      const explicitDurationMs = Number(msg.durationMs)
      let durationSec: number | null = null
      let tps: number | null = null
      if (Number.isFinite(explicitDurationMs) && explicitDurationMs >= 200) {
        const candDur = explicitDurationMs / 1000
        const candTps = (output + reasoning) / candDur
        if (candDur <= 600 && candTps > 0 && candTps <= MAX_REALISTIC_TPS) {
          durationSec = candDur
          tps = candTps
        }
      } else {
        const computed = computeValidDurationAndTps(lastStartMs, endMs, output + reasoning)
        durationSec = computed.durationSec
        tps = computed.tps
      }

      const turnKey = typeof msg.id === 'string' && msg.id ? msg.id : `gemini-${idx}`
      state.turnsByKey.set(turnKey, {
        turnKey,
        timestampMs: endMs,
        input: uncachedInput,
        output,
        reasoning,
        cacheRead,
        cacheWrite: 0,
        total,
        durationSec,
        tps,
        model: model || state.latestModel,
        explicitCostUsd: null
      })

      lastStartMs = endMs
    }
  }

  return state
}
