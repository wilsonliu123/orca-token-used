import crypto from 'node:crypto'
import fs, { type Dirent, type Stats } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultOrcaAppDataDirs, type JournalIndex, readOrcaJournalIndex } from './journal'
import {
  applyAntigravityLines,
  applyClaudeLines,
  applyCodexLines,
  cleanSubagentLabel,
  createEmptySessionState,
  parseGeminiSessionJson,
  readCompleteJsonlChunk,
  type SessionTranscriptState,
  type SpawnedSubagentMeta
} from './parsers'
import type { AgentKind } from './protocol'

export interface ScannerOptions {
  homeDir?: string
  orcaAppDirs?: string[]
  /** Lookback horizon in days; defaults to 65 days (covers Month + previous-month comparison) */
  lookbackDays?: number
}

export interface DiscoveredFile {
  agent: AgentKind
  filePath: string
  sessionIdHint: string
  mtimeMs: number
  sizeBytes: number
}

export const HISTORICAL_CACHE_STORAGE_KEY = 'historicalSessions.v6'

export interface CachedFileSummary {
  sessionId: string
  agent: AgentKind
  filePath: string
  sizeBytes: number
  mtimeMs: number
  cwd: string | null
  cliCustomTitle?: string | null
  titleHint: string | null
  isInternalHelper: boolean
  isSubagent?: boolean
  parentSessionId?: string | null
  parentMessageUuid?: string | null
  subagentId?: string | null
  subagentName?: string | null
  subagentRole?: string | null
  subagentMetaMtimeMs?: number | null
  subagentMetaSize?: number | null
  spawnedSubagentsByAgentId?: Record<string, SpawnedSubagentMeta>
  messageUuids?: string[]
  reasoningLevels?: string[]
  latestModel: string | null
  createdAtMs: number
  updatedAtMs: number
  lastEventState?: 'working' | 'waiting' | 'done' | null
  turns: Array<{
    k: string
    ts: number
    in: number
    out: number
    rs: number
    cr: number
    cw: number
    tot: number
    dur: number | null
    tps: number | null
    m: string | null
    cost: number | null
  }>
}

function safeReaddir(dirPath: string): Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
}

function safeStat(filePath: string): Stats | null {
  try {
    return fs.statSync(filePath)
  } catch {
    return null
  }
}

function canonicalInodeOrRealpath(targetPath: string, st?: Stats | null): string | null {
  const stat = st ?? safeStat(targetPath)
  if (!stat) return null
  if (stat.dev || stat.ino) {
    return `${stat.dev}:${stat.ino}`
  }
  try {
    return fs.realpathSync.native(targetPath)
  } catch {
    return path.resolve(targetPath)
  }
}

function uniqueExistingDirs(candidates: Iterable<string>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const dir of candidates) {
    const st = safeStat(dir)
    if (!st) continue
    const key = canonicalInodeOrRealpath(dir, st)
    if (!key || seen.has(key)) continue
    seen.add(key)
    try {
      result.push(fs.realpathSync.native(dir))
    } catch {
      result.push(dir)
    }
  }
  return result
}

function walkMatchingFiles(
  rootDir: string,
  maxDepth: number,
  matcher: (fullPath: string, entry: Dirent) => boolean,
  skipDirNames: Set<string>,
  cutoffMs: number,
  out: Array<{ filePath: string; mtimeMs: number; sizeBytes: number; stat: Stats }>
): void {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()!
    const entries = safeReaddir(current.dir)
    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (current.depth < maxDepth && !skipDirNames.has(entry.name)) {
          stack.push({ dir: fullPath, depth: current.depth + 1 })
        }
      } else if (entry.isFile() && matcher(fullPath, entry)) {
        const st = safeStat(fullPath)
        if (!st || st.size <= 0) continue
        if (st.mtimeMs >= cutoffMs) {
          out.push({ filePath: fullPath, mtimeMs: st.mtimeMs, sizeBytes: st.size, stat: st })
        }
      }
    }
  }
}

const MAX_SUBAGENT_META_BYTES = 64 * 1024

interface SubagentMetaStamp {
  mtimeMs: number
  size: number
}

function readClaudeSubagentMeta(
  metaPath: string,
  prevStamp: SubagentMetaStamp | null | undefined
): {
  changedStamp: boolean
  stamp: SubagentMetaStamp | null
  role: string | null
  name: string | null
} {
  let st: Stats
  try {
    st = fs.statSync(metaPath)
  } catch {
    return {
      changedStamp: prevStamp !== null,
      stamp: null,
      role: null,
      name: null
    }
  }
  if (!st.isFile()) {
    return {
      changedStamp: prevStamp !== null,
      stamp: null,
      role: null,
      name: null
    }
  }

  const nextStamp: SubagentMetaStamp = { mtimeMs: st.mtimeMs, size: st.size }
  if (
    prevStamp &&
    prevStamp.mtimeMs === nextStamp.mtimeMs &&
    prevStamp.size === nextStamp.size
  ) {
    return {
      changedStamp: false,
      stamp: prevStamp,
      role: null,
      name: null
    }
  }

  if (st.size <= 0 || st.size > MAX_SUBAGENT_META_BYTES) {
    return {
      changedStamp: true,
      stamp: nextStamp,
      role: null,
      name: null
    }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        changedStamp: true,
        stamp: nextStamp,
        role: null,
        name: null
      }
    }
    const obj = raw as Record<string, unknown>
    return {
      changedStamp: true,
      stamp: nextStamp,
      role: cleanSubagentLabel(obj.agentType ?? obj.subagent_type ?? obj.subagentType),
      name: cleanSubagentLabel(obj.name ?? obj.agentName)
    }
  } catch {
    return {
      changedStamp: true,
      stamp: nextStamp,
      role: null,
      name: null
    }
  }
}

function applyClaudeSubagentFileHints(
  state: SessionTranscriptState,
  subagentMetaByFile?: Map<string, SubagentMetaStamp | null>
): boolean {
  const normalized = state.filePath.replace(/\\/g, '/')
  if (!normalized.includes('/subagents/')) return false

  state.isSubagent = true
  if (state.agent !== 'claude') return false

  const subMatch = normalized.match(/(?:^|\/)(?:([^/]+)\/)?subagents\/(agent-([^/]+))\.jsonl$/)
  if (!subMatch) return false

  const parentDir = subMatch[1]
  const canonicalSessionId = subMatch[2]
  const agentId = subMatch[3]

  if (!state.sessionId && canonicalSessionId) {
    state.sessionId = canonicalSessionId
  }
  if (agentId && !state.subagentId) {
    state.subagentId = agentId
  }
  if (parentDir && parentDir !== 'projects' && !state.parentSessionId) {
    state.parentSessionId = parentDir
  }

  const metaPath = state.filePath.replace(/\.jsonl$/i, '.meta.json')
  const prevStamp = subagentMetaByFile?.get(state.filePath)
  const meta = readClaudeSubagentMeta(metaPath, prevStamp)
  if (!meta.changedStamp) return false

  subagentMetaByFile?.set(state.filePath, meta.stamp)
  const prevRole = state.subagentRole
  const prevName = state.subagentName
  state.subagentRole = meta.role
  state.subagentName = meta.name
  return prevRole !== state.subagentRole || prevName !== state.subagentName
}

function ingestJsonlTranscript(
  statesByFile: Map<string, SessionTranscriptState>,
  disc: DiscoveredFile,
  existing: SessionTranscriptState | undefined,
  subagentMetaByFile?: Map<string, SubagentMetaStamp | null>
): { state: SessionTranscriptState; chunkMtimeMs: number } | null {
  let state = existing
  if (!state || disc.sizeBytes < state.offsetBytes) {
    state = createEmptySessionState(disc.sessionIdHint, disc.agent, disc.filePath)
    subagentMetaByFile?.delete(disc.filePath)
    applyClaudeSubagentFileHints(state, subagentMetaByFile)
    statesByFile.set(disc.filePath, state)
  } else if (state.agent === 'claude' && state.isSubagent) {
    applyClaudeSubagentFileHints(state, subagentMetaByFile)
  }

  try {
    const chunk = readCompleteJsonlChunk(disc.filePath, state.offsetBytes)
    state.lastMtimeMs = chunk.mtimeMs
    if (chunk.lines.length > 0) {
      switch (disc.agent) {
        case 'claude':
          applyClaudeLines(state, chunk.lines)
          break
        case 'codex':
          applyCodexLines(state, chunk.lines)
          break
        case 'antigravity':
        case 'gemini':
          applyAntigravityLines(state, chunk.lines)
          break
      }
    }
    state.offsetBytes = chunk.nextOffset
    state.lastSizeBytes = chunk.fileSize
    if (state.updatedAtMs === 0) state.updatedAtMs = chunk.mtimeMs
    if (state.createdAtMs === 0) state.createdAtMs = chunk.mtimeMs
    return { state, chunkMtimeMs: chunk.mtimeMs }
  } catch {
    // Ignore deleted or transient unreadable file mid-scan
    return null
  }
}

function extractCodexUuidFromFilename(filePath: string): string {
  const base = path.basename(filePath, '.jsonl')
  const uuidMatch = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
  return uuidMatch ? uuidMatch[1] : base
}

function registerPathHashes(map: Map<string, string>, projPath: string): void {
  const trimmed = projPath.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return
  const sha = crypto.createHash('sha256').update(trimmed).digest('hex')
  map.set(sha, trimmed)
  try {
    const real = fs.realpathSync.native(trimmed)
    if (real !== trimmed) {
      const realSha = crypto.createHash('sha256').update(real).digest('hex')
      map.set(realSha, real)
    }
  } catch {
    // Ignore missing path
  }
}

function buildGeminiProjectHashLookup(
  geminiRoot: string,
  knownWorkspacePaths: Iterable<string>
): Map<string, string> {
  const map = new Map<string, string>()

  for (const wp of knownWorkspacePaths) {
    registerPathHashes(map, wp)
  }

  const projJson = path.join(geminiRoot, 'projects.json')
  try {
    if (fs.existsSync(projJson)) {
      const raw = JSON.parse(fs.readFileSync(projJson, 'utf8')) as {
        projects?: Record<string, string>
      }
      if (raw && typeof raw.projects === 'object' && raw.projects) {
        for (const [projPath, nameOrId] of Object.entries(raw.projects)) {
          registerPathHashes(map, projPath)
          if (typeof nameOrId === 'string' && nameOrId.trim()) {
            map.set(nameOrId.trim(), projPath)
          }
        }
      }
    }
  } catch {
    // Ignore malformed projects.json
  }

  // Gemini CLI also writes `.project_root` inside `~/.gemini/tmp/<folder>/`
  const geminiTmp = path.join(geminiRoot, 'tmp')
  for (const ent of safeReaddir(geminiTmp)) {
    if (!ent.isDirectory()) continue
    const markerPath = path.join(geminiTmp, ent.name, '.project_root')
    try {
      if (fs.existsSync(markerPath)) {
        const rootDir = fs.readFileSync(markerPath, 'utf8').trim()
        if (rootDir) {
          map.set(ent.name, rootDir)
          registerPathHashes(map, rootDir)
        }
      }
    } catch {
      // Ignore unreadable marker
    }
  }

  return map
}

export class TranscriptScanner {
  private readonly homeDir: string
  private readonly orcaAppDirs: string[]
  private readonly lookbackDays: number

  private statesByFile = new Map<string, SessionTranscriptState>()
  private subagentMetaByFile = new Map<string, SubagentMetaStamp | null>()
  private journalIndex: JournalIndex = {
    byNativeId: new Map(),
    accountHomes: new Map()
  }
  private knownWorkspacePaths = new Set<string>()
  private lastJournalRefreshMs = 0
  private lastFullDiscoveryMs = 0
  private cachedDiscovered: DiscoveredFile[] = []
  private geminiProjectMap = new Map<string, string>()
  private dirtyHistoricalCache = false
  private disabledAgents = new Set<AgentKind>()

  constructor(options: ScannerOptions = {}) {
    this.homeDir = options.homeDir ?? (process.env.TOKEN_PULSE_HOME_DIR || os.homedir())
    this.orcaAppDirs = options.orcaAppDirs ?? defaultOrcaAppDataDirs(this.homeDir)
    this.lookbackDays = options.lookbackDays ?? 65
  }

  setKnownWorkspacePaths(paths: Iterable<string>): void {
    this.knownWorkspacePaths.clear()
    for (const p of paths) {
      if (p && p.trim()) this.knownWorkspacePaths.add(p.trim())
    }
  }

  hydrateHistoricalCache(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const items = (raw as { files?: Record<string, CachedFileSummary> }).files
    if (!items || typeof items !== 'object') return

    const cutoffMs = Date.now() - this.lookbackDays * 86_400_000
    const seenHydratedInodes = new Set<string>()
    for (const [rawFilePath, item] of Object.entries(items)) {
      if (!item || typeof item !== 'object' || item.updatedAtMs < cutoffMs) continue
      if (this.disabledAgents.has(item.agent)) {
        this.dirtyHistoricalCache = true
        continue
      }
      let filePath = rawFilePath
      const inodeKey = canonicalInodeOrRealpath(rawFilePath)
      if (inodeKey) {
        if (seenHydratedInodes.has(inodeKey)) continue
        seenHydratedInodes.add(inodeKey)
        try {
          filePath = fs.realpathSync.native(rawFilePath)
        } catch {
          // Keep rawFilePath
        }
      }

      // Older caches can carry the parent's ID in a Codex child's summary.
      const sessionId = item.agent === 'codex' && item.isSubagent && item.sessionId === item.parentSessionId
        ? extractCodexUuidFromFilename(filePath)
        : item.sessionId
      const st = createEmptySessionState(sessionId, item.agent, filePath)
      st.offsetBytes = item.sizeBytes
      st.lastSizeBytes = item.sizeBytes
      st.lastMtimeMs = item.mtimeMs
      st.cwd = item.cwd
      st.cliCustomTitle = item.cliCustomTitle ?? null
      st.titleHint = item.titleHint
      st.isInternalHelper = Boolean(item.isInternalHelper)
      st.isSubagent = Boolean(item.isSubagent)
      st.parentSessionId = item.parentSessionId ?? null
      st.parentMessageUuid = item.parentMessageUuid ?? null
      st.subagentId = typeof item.subagentId === 'string' && item.subagentId.trim() ? item.subagentId.trim() : null
      st.subagentName = cleanSubagentLabel(item.subagentName)
      st.subagentRole = cleanSubagentLabel(item.subagentRole)
      if (st.agent === 'claude' && st.isSubagent) {
        if (item.subagentMetaMtimeMs === null) {
          this.subagentMetaByFile.set(filePath, null)
        } else if (typeof item.subagentMetaMtimeMs === 'number') {
          this.subagentMetaByFile.set(filePath, {
            mtimeMs: item.subagentMetaMtimeMs,
            size: typeof item.subagentMetaSize === 'number' ? item.subagentMetaSize : -1
          })
        } else {
          this.subagentMetaByFile.delete(filePath)
        }
      }
      if (item.spawnedSubagentsByAgentId && typeof item.spawnedSubagentsByAgentId === 'object') {
        st.spawnedSubagentsByAgentId = item.spawnedSubagentsByAgentId
      }
      st.messageUuids = Array.isArray(item.messageUuids)
        ? item.messageUuids.filter((uuid): uuid is string => typeof uuid === 'string')
        : []
      st.reasoningLevels = Array.isArray(item.reasoningLevels)
        ? item.reasoningLevels.filter((level): level is string => typeof level === 'string')
        : []
      st.latestModel = item.latestModel
      st.createdAtMs = item.createdAtMs
      st.updatedAtMs = item.updatedAtMs
      st.lastEventState =
        item.lastEventState === 'working' ||
        item.lastEventState === 'waiting' ||
        item.lastEventState === 'done'
          ? item.lastEventState
          : null
      if (Array.isArray(item.turns)) {
        for (const t of item.turns) {
          st.turnsByKey.set(t.k, {
            turnKey: t.k,
            timestampMs: t.ts,
            input: t.in,
            output: t.out,
            reasoning: t.rs,
            cacheRead: t.cr,
            cacheWrite: t.cw,
            total: t.tot,
            durationSec: t.dur,
            tps: t.tps,
            model: t.m,
            explicitCostUsd: t.cost
          })
        }
      }
      this.statesByFile.set(filePath, st)
    }
  }

  hasDirtyHistoricalCache(): boolean {
    return this.dirtyHistoricalCache
  }

  consumeHistoricalCacheSnapshot(
    now = Date.now()
  ): { files: Record<string, CachedFileSummary> } | null {
    if (!this.dirtyHistoricalCache) return null
    this.dirtyHistoricalCache = false

    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)
    const archiveBeforeMs = todayStart.getTime()

    const files: Record<string, CachedFileSummary> = {}
    const candidates = Array.from(this.statesByFile.entries())
      .filter(
        ([, st]) => st.lastMtimeMs < archiveBeforeMs && st.turnsByKey.size > 0 && !st.isInternalHelper
      )
      .sort((a, b) => b[1].updatedAtMs - a[1].updatedAtMs)
      .slice(0, 220)

    for (const [filePath, st] of candidates) {
      let serializedTurns: CachedFileSummary['turns']
      if (st.turnsByKey.size <= 24) {
        serializedTurns = Array.from(st.turnsByKey.values()).map((t) => ({
          k: t.turnKey,
          ts: t.timestampMs,
          in: t.input,
          out: t.output,
          rs: t.reasoning,
          cr: t.cacheRead,
          cw: t.cacheWrite,
          tot: t.total,
          dur: t.durationSec,
          tps: t.tps,
          m: t.model,
          cost: t.explicitCostUsd
        }))
      } else {
        const hourMap = new Map<string, CachedFileSummary['turns'][number]>()
        for (const t of st.turnsByKey.values()) {
          const hourEpoch = Math.floor(t.timestampMs / 3_600_000)
          const bucketKey = `${hourEpoch}:${t.model || ''}`
          const prev = hourMap.get(bucketKey)
          if (!prev) {
            hourMap.set(bucketKey, {
              k: `hr-${bucketKey}`,
              ts: t.timestampMs,
              in: t.input,
              out: t.output,
              rs: t.reasoning,
              cr: t.cacheRead,
              cw: t.cacheWrite,
              tot: t.total,
              dur: t.durationSec,
              tps: t.tps,
              m: t.model,
              cost: t.explicitCostUsd
            })
          } else {
            prev.in += t.input
            prev.out += t.output
            prev.rs += t.reasoning
            prev.cr += t.cacheRead
            prev.cw += t.cacheWrite
            prev.tot += t.total
            if (t.timestampMs > prev.ts) prev.ts = t.timestampMs
            if (t.durationSec !== null && t.tps !== null) {
              const nextDur = (prev.dur ?? 0) + t.durationSec
              prev.dur = nextDur
              prev.tps = nextDur > 0 ? +((prev.out + prev.rs) / nextDur).toFixed(1) : prev.tps
            }
            if (t.explicitCostUsd !== null) {
              prev.cost = (prev.cost ?? 0) + t.explicitCostUsd
            }
          }
        }
        serializedTurns = Array.from(hourMap.values())
      }

      const metaStamp =
        st.agent === 'claude' && st.isSubagent ? this.subagentMetaByFile.get(filePath) : undefined
      files[filePath] = {
        sessionId: st.sessionId,
        agent: st.agent,
        filePath,
        sizeBytes: st.lastSizeBytes,
        mtimeMs: st.lastMtimeMs,
        cwd: st.cwdIsHeuristic ? null : st.cwd,
        cliCustomTitle: st.cliCustomTitle,
        titleHint: st.titleHint,
        isInternalHelper: st.isInternalHelper,
        isSubagent: st.isSubagent,
        parentSessionId: st.parentSessionId,
        parentMessageUuid: st.parentMessageUuid,
        subagentId: st.subagentId,
        subagentName: st.subagentName,
        subagentRole: st.subagentRole,
        ...(metaStamp !== undefined
          ? {
              subagentMetaMtimeMs: metaStamp ? metaStamp.mtimeMs : null,
              subagentMetaSize: metaStamp ? metaStamp.size : null
            }
          : {}),
        ...(st.spawnedSubagentsByAgentId && Object.keys(st.spawnedSubagentsByAgentId).length > 0
          ? { spawnedSubagentsByAgentId: st.spawnedSubagentsByAgentId }
          : {}),
        messageUuids: st.messageUuids,
        reasoningLevels: st.reasoningLevels,
        latestModel: st.latestModel,
        createdAtMs: st.createdAtMs,
        updatedAtMs: st.updatedAtMs,
        lastEventState: st.lastEventState,
        turns: serializedTurns
      }
    }
    return { files }
  }

  getJournalIndex(): JournalIndex {
    return this.journalIndex
  }

  refreshJournal(now = Date.now(), minIntervalMs = 800): JournalIndex {
    if (now - this.lastJournalRefreshMs >= minIntervalMs) {
      this.journalIndex = readOrcaJournalIndex(
        this.orcaAppDirs,
        this.homeDir,
        this.knownWorkspacePaths,
        this.disabledAgents
      )
      this.lastJournalRefreshMs = now
    }
    return this.journalIndex
  }

  private applyJournalSessionHints(now: number): void {
    const claudeMessageOwners = new Map<string, string>()
    for (const state of this.statesByFile.values()) {
      if (state.agent !== 'claude') continue
      for (const uuid of state.messageUuids) claudeMessageOwners.set(uuid, state.sessionId)
    }
    for (const state of this.statesByFile.values()) {
      if (state.agent !== 'claude' || !state.parentMessageUuid || state.parentSessionId) continue
      const parentId = claudeMessageOwners.get(state.parentMessageUuid)
      if (parentId && parentId !== state.sessionId) {
        state.parentSessionId = parentId
        state.isSubagent = true
      }
    }

    const summaries = this.journalIndex.antigravitySummaries
    const histByConv = this.journalIndex.antigravityHistoryByConversationId
    const histEntries = this.journalIndex.antigravityHistoryEntries
    if (!summaries?.size && !histByConv?.size && !histEntries?.length) return

    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)
    const todayStartMs = todayStart.getTime()

    for (const state of this.statesByFile.values()) {
      if (state.agent !== 'antigravity') continue
      let persistedFieldChanged = false

      const summary = summaries?.get(state.sessionId)
      const explicitHistWs = histByConv?.get(state.sessionId) ?? null
      const authoritativeWs = summary?.workspacePath || explicitHistWs || null

      if (authoritativeWs && (!state.cwd || state.cwdIsHeuristic)) {
        if (state.cwd !== authoritativeWs || state.cwdIsHeuristic) {
          state.cwd = authoritativeWs
          state.cwdIsHeuristic = false
          persistedFieldChanged = true
        }
      } else if (!state.cwd && state.createdAtMs > 0 && histEntries && histEntries.length > 0) {
        const candidates = histEntries.filter(
          (e) =>
            (!e.conversationId || e.conversationId === state.sessionId) &&
            Math.abs(e.timestampMs - state.createdAtMs) <= 15_000
        )
        if (candidates.length > 0) {
          const hintPrefix = state.titleHint ? state.titleHint.slice(0, 24) : ''
          candidates.sort((a, b) => {
            const aMatch =
              hintPrefix &&
              a.displayPreview &&
              (state.titleHint!.startsWith(a.displayPreview.slice(0, 24)) ||
                a.displayPreview.startsWith(hintPrefix))
                ? 1
                : 0
            const bMatch =
              hintPrefix &&
              b.displayPreview &&
              (state.titleHint!.startsWith(b.displayPreview.slice(0, 24)) ||
                b.displayPreview.startsWith(hintPrefix))
                ? 1
                : 0
            if (aMatch !== bMatch) return bMatch - aMatch
            return (
              Math.abs(a.timestampMs - state.createdAtMs) -
              Math.abs(b.timestampMs - state.createdAtMs)
            )
          })
          state.cwd = candidates[0].workspacePath
          state.cwdIsHeuristic = true
        }
      }

      if (summary?.isSubagent && !state.isSubagent) {
        state.isSubagent = true
        persistedFieldChanged = true
      }
      if (summary?.parentConversationId && state.parentSessionId !== summary.parentConversationId) {
        state.parentSessionId = summary.parentConversationId
        persistedFieldChanged = true
      }

      if (
        persistedFieldChanged &&
        state.lastMtimeMs > 0 &&
        state.lastMtimeMs < todayStartMs &&
        state.turnsByKey.size > 0 &&
        !state.isInternalHelper
      ) {
        this.dirtyHistoricalCache = true
      }
    }
  }

  getSessions(): SessionTranscriptState[] {
    return Array.from(this.statesByFile.values()).filter(
      (s) => !s.isInternalHelper && !this.disabledAgents.has(s.agent)
    )
  }

  /** Agents switched off in the plugin settings: they are neither discovered nor reported. */
  setDisabledAgents(agents: Iterable<AgentKind>): void {
    const next = new Set(agents)
    const same = next.size === this.disabledAgents.size && [...next].every((a) => this.disabledAgents.has(a))
    if (same) return
    this.disabledAgents = next
    for (const [filePath, st] of this.statesByFile) {
      if (!next.has(st.agent)) continue
      this.statesByFile.delete(filePath)
      this.subagentMetaByFile.delete(filePath)
      this.dirtyHistoricalCache = true
    }
    this.lastJournalRefreshMs = 0
    // Force a fresh discovery so re-enabled agents are picked up immediately.
    this.cachedDiscovered = []
    this.lastFullDiscoveryMs = 0
  }

  private refreshUnchangedSubagentMeta(
    existing: SessionTranscriptState,
    discMtimeMs: number,
    todayStartMs: number
  ): void {
    if (existing.agent !== 'claude' || !existing.isSubagent) return
    const metaChanged = applyClaudeSubagentFileHints(existing, this.subagentMetaByFile)
    if (
      metaChanged &&
      discMtimeMs < todayStartMs &&
      existing.turnsByKey.size > 0 &&
      !existing.isInternalHelper
    ) {
      this.dirtyHistoricalCache = true
    }
  }

  /**
   * Ultra-low-overhead (<1ms) incremental tail for 1-second single-agent live waveform polling:
   * checks files active within the last 6 hours plus the explicitly watched session without walking directories.
   */
  pollHotFiles(now = Date.now(), targetSessionKey?: string): SessionTranscriptState[] {
    if (this.cachedDiscovered.length === 0) {
      return this.scan({ now })
    }
    const hotCutoff = now - 6 * 3600_000
    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)
    const todayStartMs = todayStart.getTime()

    for (const disc of this.cachedDiscovered) {
      const existing = this.statesByFile.get(disc.filePath)
      const isTarget =
        Boolean(targetSessionKey) &&
        (`${disc.agent}:${disc.sessionIdHint}` === targetSessionKey ||
          disc.sessionIdHint === targetSessionKey ||
          (existing !== undefined &&
            (`${existing.agent}:${existing.sessionId}` === targetSessionKey ||
              existing.sessionId === targetSessionKey)))
      if (!isTarget && disc.mtimeMs < hotCutoff) continue
      const st = safeStat(disc.filePath)
      if (!st) continue
      disc.mtimeMs = st.mtimeMs
      disc.sizeBytes = st.size

      if (
        existing &&
        existing.offsetBytes === disc.sizeBytes &&
        Math.abs(existing.lastMtimeMs - disc.mtimeMs) < 1
      ) {
        this.refreshUnchangedSubagentMeta(existing, disc.mtimeMs, todayStartMs)
        continue
      }

      if (disc.agent === 'gemini' && disc.filePath.endsWith('.json')) {
        try {
          const raw = fs.readFileSync(disc.filePath, 'utf8')
          const parsed = parseGeminiSessionJson(disc.filePath, raw, this.geminiProjectMap)
          if (parsed) {
            parsed.offsetBytes = disc.sizeBytes
            parsed.lastSizeBytes = disc.sizeBytes
            parsed.lastMtimeMs = disc.mtimeMs
            this.statesByFile.set(disc.filePath, parsed)
          }
        } catch {
          // Ignore transient write
        }
        continue
      }

      const ingested = ingestJsonlTranscript(
        this.statesByFile,
        disc,
        existing,
        this.subagentMetaByFile
      )
      if (
        ingested &&
        ingested.chunkMtimeMs < todayStartMs &&
        ingested.state.turnsByKey.size > 0 &&
        !ingested.state.isInternalHelper
      ) {
        this.dirtyHistoricalCache = true
      }
    }
    this.applyJournalSessionHints(now)
    return this.getSessions()
  }

  scan(options: { forceFullDiscovery?: boolean; now?: number } = {}): SessionTranscriptState[] {
    const now = options.now ?? Date.now()
    const cutoffMs = now - this.lookbackDays * 86_400_000

    // Refresh agent-owned metadata and CLI model settings at most every 2s (or on forced scan)
    if (options.forceFullDiscovery || now - this.lastJournalRefreshMs >= 2000) {
      this.journalIndex = readOrcaJournalIndex(
        this.orcaAppDirs,
        this.homeDir,
        this.knownWorkspacePaths,
        this.disabledAgents
      )
      this.lastJournalRefreshMs = now
    }

    const doFullWalk =
      options.forceFullDiscovery ||
      this.cachedDiscovered.length === 0 ||
      now - this.lastFullDiscoveryMs >= 12_000

    if (doFullWalk) {
      this.cachedDiscovered = this.discoverAllFiles(cutoffMs)
      this.lastFullDiscoveryMs = now
    } else {
      const hotCutoff = now - 2 * 3600_000
      for (const item of this.cachedDiscovered) {
        if (item.mtimeMs >= hotCutoff) {
          const st = safeStat(item.filePath)
          if (st) {
            item.mtimeMs = st.mtimeMs
            item.sizeBytes = st.size
          }
        }
      }
    }

    const activePaths = new Set<string>()
    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)
    const todayStartMs = todayStart.getTime()

    for (const disc of this.cachedDiscovered) {
      activePaths.add(disc.filePath)
      const existing = this.statesByFile.get(disc.filePath)

      if (
        existing &&
        existing.offsetBytes === disc.sizeBytes &&
        Math.abs(existing.lastMtimeMs - disc.mtimeMs) < 1
      ) {
        this.refreshUnchangedSubagentMeta(existing, disc.mtimeMs, todayStartMs)
        continue
      }

      if (disc.agent === 'gemini' && disc.filePath.endsWith('.json')) {
        try {
          const raw = fs.readFileSync(disc.filePath, 'utf8')
          const parsed = parseGeminiSessionJson(disc.filePath, raw, this.geminiProjectMap)
          if (parsed) {
            parsed.offsetBytes = disc.sizeBytes
            parsed.lastSizeBytes = disc.sizeBytes
            parsed.lastMtimeMs = disc.mtimeMs
            this.statesByFile.set(disc.filePath, parsed)
            if (disc.mtimeMs < todayStartMs) this.dirtyHistoricalCache = true
          }
        } catch {
          // Ignore transient read error while Gemini CLI rewrites session JSON
        }
        continue
      }

      const ingested = ingestJsonlTranscript(
        this.statesByFile,
        disc,
        existing,
        this.subagentMetaByFile
      )
      if (
        ingested &&
        ingested.chunkMtimeMs < todayStartMs &&
        ingested.state.turnsByKey.size > 0
      ) {
        this.dirtyHistoricalCache = true
      }
    }

    if (doFullWalk) {
      for (const [filePath, st] of this.statesByFile) {
        if (!activePaths.has(filePath)) {
          this.statesByFile.delete(filePath)
          this.subagentMetaByFile.delete(filePath)
        }
      }
    }

    this.applyJournalSessionHints(now)
    return this.getSessions()
  }

  private discoverAllFiles(cutoffMs: number): DiscoveredFile[] {
    const discovered: DiscoveredFile[] = []
    const seenInodes = new Set<string>()
    // Do NOT skip `subagents` directories so subagent token spend counts accurately in Day/Week/Month totals
    const skipCommon = new Set(['node_modules', '.git', 'plugins', 'cache', 'backups'])

    const pushUnique = (
      agent: AgentKind,
      filePath: string,
      sessionIdHint: string,
      mtimeMs: number,
      sizeBytes: number,
      stat: Stats
    ) => {
      if (this.disabledAgents.has(agent)) return
      const dedupeKey = canonicalInodeOrRealpath(filePath, stat)
      if (!dedupeKey || seenInodes.has(dedupeKey)) return
      seenInodes.add(dedupeKey)
      let canonicalPath = filePath
      try {
        canonicalPath = fs.realpathSync.native(filePath)
      } catch {
        // Keep filePath
      }
      discovered.push({ agent, filePath: canonicalPath, sessionIdHint, mtimeMs, sizeBytes })
    }

    // 1. Claude Code (`~/.claude/projects` + custom CLAUDE_CONFIG_DIR)
    const rawClaudeHomes = this.disabledAgents.has('claude')
      ? []
      : [path.join(this.homeDir, '.claude'), ...(this.journalIndex.accountHomes.get('claude') ?? [])]
    for (const ch of uniqueExistingDirs(rawClaudeHomes)) {
      const projDir = path.join(ch, 'projects')
      if (!fs.existsSync(projDir)) continue
      const found: Array<{ filePath: string; mtimeMs: number; sizeBytes: number; stat: Stats }> = []
      walkMatchingFiles(
        projDir,
        4,
        (_fp, ent) => ent.name.endsWith('.jsonl'),
        skipCommon,
        cutoffMs,
        found
      )
      for (const f of found) {
        const st = pushUniqueClaudeOrSubagentHint(f.filePath)
        pushUnique('claude', f.filePath, st.sessionId, f.mtimeMs, f.sizeBytes, f.stat)
      }
    }

    // 2. Codex (`~/.codex/sessions`, Orca `codex-runtime-home/home/sessions`, `codex-accounts/*/sessions`, custom CODEX_HOME)
    const codexOn = !this.disabledAgents.has('codex')
    const rawCodexSessionDirs: string[] = codexOn ? [path.join(this.homeDir, '.codex', 'sessions')] : []
    for (const h of codexOn ? (this.journalIndex.accountHomes.get('codex') ?? []) : []) {
      rawCodexSessionDirs.push(path.join(h, 'sessions'))
    }
    for (const orcaDir of codexOn ? this.orcaAppDirs : []) {
      rawCodexSessionDirs.push(path.join(orcaDir, 'codex-runtime-home', 'home', 'sessions'))
      const accsDir = path.join(orcaDir, 'codex-accounts')
      for (const ent of safeReaddir(accsDir)) {
        if (ent.isDirectory()) {
          rawCodexSessionDirs.push(path.join(accsDir, ent.name, 'sessions'))
        }
      }
    }
    for (const sdir of uniqueExistingDirs(rawCodexSessionDirs)) {
      const found: Array<{ filePath: string; mtimeMs: number; sizeBytes: number; stat: Stats }> = []
      walkMatchingFiles(
        sdir,
        5,
        (_fp, ent) => ent.name.endsWith('.jsonl'),
        skipCommon,
        cutoffMs,
        found
      )
      for (const f of found) {
        pushUnique(
          'codex',
          f.filePath,
          extractCodexUuidFromFilename(f.filePath),
          f.mtimeMs,
          f.sizeBytes,
          f.stat
        )
      }
    }

    // 3. Antigravity (`<orca>/antigravity-chat/**/brain/<id>/.system_generated/logs/transcript.jsonl` + `~/.gemini/antigravity*/brain`)
    const agOn = !this.disabledAgents.has('antigravity')
    const rawAgBrainDirs: string[] = agOn
      ? [
          path.join(this.homeDir, '.gemini', 'antigravity', 'brain'),
          path.join(this.homeDir, '.gemini', 'antigravity-cli', 'brain')
        ]
      : []
    for (const orcaDir of agOn ? this.orcaAppDirs : []) {
      rawAgBrainDirs.push(path.join(orcaDir, 'antigravity-chat', 'antigravity-acp', 'brain'))
      rawAgBrainDirs.push(path.join(orcaDir, 'antigravity-chat', 'antigravity-cli', 'brain'))
      const agAccs = path.join(orcaDir, 'antigravity-accounts')
      for (const ent of safeReaddir(agAccs)) {
        if (ent.isDirectory()) {
          rawAgBrainDirs.push(path.join(agAccs, ent.name, 'brain'))
          rawAgBrainDirs.push(path.join(agAccs, ent.name, 'antigravity-acp', 'brain'))
          rawAgBrainDirs.push(path.join(agAccs, ent.name, 'antigravity-cli', 'brain'))
        }
      }
    }
    for (const bdir of uniqueExistingDirs(rawAgBrainDirs)) {
      for (const conv of safeReaddir(bdir)) {
        if (!conv.isDirectory()) continue
        const transcriptPath = path.join(
          bdir,
          conv.name,
          '.system_generated',
          'logs',
          'transcript.jsonl'
        )
        const st = safeStat(transcriptPath)
        if (st && st.size > 0 && st.mtimeMs >= cutoffMs) {
          pushUnique('antigravity', transcriptPath, conv.name, st.mtimeMs, st.size, st)
        }
      }
    }

    // 4. Gemini CLI (`~/.gemini/tmp/<projectHash>/chats/session-*.json`)
    const geminiRoot = path.join(this.homeDir, '.gemini')
    const geminiTmp = path.join(geminiRoot, 'tmp')
    if (!this.disabledAgents.has('gemini') && fs.existsSync(geminiTmp)) {
      this.geminiProjectMap = buildGeminiProjectHashLookup(geminiRoot, this.knownWorkspacePaths)
      const found: Array<{ filePath: string; mtimeMs: number; sizeBytes: number; stat: Stats }> = []
      walkMatchingFiles(
        geminiTmp,
        4,
        (fp, ent) =>
          (ent.name.startsWith('session-') && ent.name.endsWith('.json')) ||
          (fp.includes(`${path.sep}chats${path.sep}`) && ent.name.endsWith('.jsonl')),
        skipCommon,
        cutoffMs,
        found
      )
      for (const f of found) {
        pushUnique(
          'gemini',
          f.filePath,
          path.basename(f.filePath, path.extname(f.filePath)),
          f.mtimeMs,
          f.sizeBytes,
          f.stat
        )
      }
    }

    return discovered
  }
}

function pushUniqueClaudeOrSubagentHint(filePath: string): { sessionId: string } {
  return { sessionId: path.basename(filePath, '.jsonl') }
}
