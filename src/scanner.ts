import crypto from 'node:crypto'
import fs, { type Dirent, type Stats } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultOrcaAppDataDirs, type JournalIndex, readOrcaJournalIndex } from './journal'
import {
  applyAntigravityLines,
  applyClaudeLines,
  applyCodexLines,
  createEmptySessionState,
  parseGeminiSessionJson,
  readCompleteJsonlChunk,
  type SessionTranscriptState
} from './parsers'
import type { AgentKind } from './protocol'

export interface ScannerOptions {
  homeDir?: string
  orcaAppDirs?: string[]
  /** Lookback horizon in days; defaults to 35 days (covers Month + comparison delta) */
  lookbackDays?: number
}

export interface DiscoveredFile {
  agent: AgentKind
  filePath: string
  sessionIdHint: string
  mtimeMs: number
  sizeBytes: number
}

export const HISTORICAL_CACHE_STORAGE_KEY = 'historicalSessions.v3'

export interface CachedFileSummary {
  sessionId: string
  agent: AgentKind
  filePath: string
  sizeBytes: number
  mtimeMs: number
  cwd: string | null
  titleHint: string | null
  isInternalHelper: boolean
  isSubagent?: boolean
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
  private journalIndex: JournalIndex = {
    byNativeId: new Map(),
    byOrcaSessionId: new Map(),
    accountHomes: new Map(),
    workspaceActivityMs: new Map()
  }
  private knownWorkspacePaths = new Set<string>()
  private lastJournalRefreshMs = 0
  private lastFullDiscoveryMs = 0
  private cachedDiscovered: DiscoveredFile[] = []
  private geminiProjectMap = new Map<string, string>()
  private dirtyHistoricalCache = false

  constructor(options: ScannerOptions = {}) {
    this.homeDir = options.homeDir ?? (process.env.TOKEN_PULSE_HOME_DIR || os.homedir())
    this.orcaAppDirs = options.orcaAppDirs ?? defaultOrcaAppDataDirs(this.homeDir)
    this.lookbackDays = options.lookbackDays ?? 35
  }

  getOrcaAppDirs(): string[] {
    return this.orcaAppDirs
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

      const st = createEmptySessionState(item.sessionId, item.agent, filePath)
      st.offsetBytes = item.sizeBytes
      st.lastSizeBytes = item.sizeBytes
      st.lastMtimeMs = item.mtimeMs
      st.cwd = item.cwd
      st.titleHint = item.titleHint
      st.isInternalHelper = Boolean(item.isInternalHelper)
      st.isSubagent = Boolean(item.isSubagent)
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

      files[filePath] = {
        sessionId: st.sessionId,
        agent: st.agent,
        filePath,
        sizeBytes: st.lastSizeBytes,
        mtimeMs: st.lastMtimeMs,
        cwd: st.cwd,
        titleHint: st.titleHint,
        isInternalHelper: st.isInternalHelper,
        isSubagent: st.isSubagent,
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
      this.journalIndex = readOrcaJournalIndex(this.orcaAppDirs, this.homeDir)
      this.lastJournalRefreshMs = now
    }
    return this.journalIndex
  }

  getSessions(): SessionTranscriptState[] {
    return Array.from(this.statesByFile.values()).filter((s) => !s.isInternalHelper)
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

      let state = existing
      if (!state || disc.sizeBytes < state.offsetBytes) {
        state = createEmptySessionState(disc.sessionIdHint, disc.agent, disc.filePath)
        if (disc.filePath.includes(`${path.sep}subagents${path.sep}`)) {
          state.isSubagent = true
        }
        this.statesByFile.set(disc.filePath, state)
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
      } catch {
        // Ignore transient read error
      }
    }
    return this.getSessions()
  }

  scan(options: { forceFullDiscovery?: boolean; now?: number } = {}): SessionTranscriptState[] {
    const now = options.now ?? Date.now()
    const cutoffMs = now - this.lookbackDays * 86_400_000

    // Refresh Orca journal DB + profile tab headers + CLI model settings at most every 2s (or on forced scan)
    if (options.forceFullDiscovery || now - this.lastJournalRefreshMs >= 2000) {
      this.journalIndex = readOrcaJournalIndex(this.orcaAppDirs, this.homeDir)
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

      let state = existing
      if (!state || disc.sizeBytes < state.offsetBytes) {
        state = createEmptySessionState(disc.sessionIdHint, disc.agent, disc.filePath)
        if (disc.filePath.includes(`${path.sep}subagents${path.sep}`)) {
          state.isSubagent = true
        }
        this.statesByFile.set(disc.filePath, state)
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
              applyAntigravityLines(state, chunk.lines)
              break
            case 'gemini':
              applyAntigravityLines(state, chunk.lines)
              break
          }
        }
        state.offsetBytes = chunk.nextOffset
        state.lastSizeBytes = chunk.fileSize
        if (state.updatedAtMs === 0) state.updatedAtMs = chunk.mtimeMs
        if (state.createdAtMs === 0) state.createdAtMs = chunk.mtimeMs
        if (chunk.mtimeMs < todayStartMs && state.turnsByKey.size > 0) {
          this.dirtyHistoricalCache = true
        }
      } catch {
        // Ignore deleted or unreadable file mid-scan
      }
    }

    if (doFullWalk) {
      for (const filePath of this.statesByFile.keys()) {
        if (!activePaths.has(filePath)) {
          this.statesByFile.delete(filePath)
        }
      }
    }

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

    // 1. Claude Code (`~/.claude/projects` + custom CLAUDE_CONFIG_DIR from Orca journal)
    const rawClaudeHomes = [
      path.join(this.homeDir, '.claude'),
      ...(this.journalIndex.accountHomes.get('claude') ?? [])
    ]
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
    const rawCodexSessionDirs: string[] = [path.join(this.homeDir, '.codex', 'sessions')]
    for (const h of this.journalIndex.accountHomes.get('codex') ?? []) {
      rawCodexSessionDirs.push(path.join(h, 'sessions'))
    }
    for (const orcaDir of this.orcaAppDirs) {
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
    const rawAgBrainDirs: string[] = [
      path.join(this.homeDir, '.gemini', 'antigravity', 'brain'),
      path.join(this.homeDir, '.gemini', 'antigravity-cli', 'brain')
    ]
    for (const orcaDir of this.orcaAppDirs) {
      rawAgBrainDirs.push(path.join(orcaDir, 'antigravity-chat', 'antigravity-acp', 'brain'))
      rawAgBrainDirs.push(path.join(orcaDir, 'antigravity-chat', 'antigravity-cli', 'brain'))
      const agAccs = path.join(orcaDir, 'antigravity-accounts')
      for (const ent of safeReaddir(agAccs)) {
        if (ent.isDirectory()) {
          rawAgBrainDirs.push(path.join(agAccs, ent.name, 'brain'))
          rawAgBrainDirs.push(path.join(agAccs, ent.name, 'antigravity-acp', 'brain'))
        }
      }
    }
    for (const h of this.journalIndex.accountHomes.get('antigravity') ?? []) {
      rawAgBrainDirs.push(path.join(h, 'brain'))
      rawAgBrainDirs.push(path.join(h, 'antigravity-acp', 'brain'))
      rawAgBrainDirs.push(path.join(h, 'antigravity-cli', 'brain'))
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
    if (fs.existsSync(geminiTmp)) {
      const allKnownPaths = new Set<string>(this.knownWorkspacePaths)
      for (const jMeta of this.journalIndex.byNativeId.values()) {
        if (jMeta.workspacePath) allKnownPaths.add(jMeta.workspacePath)
      }
      this.geminiProjectMap = buildGeminiProjectHashLookup(geminiRoot, allKnownPaths)
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
