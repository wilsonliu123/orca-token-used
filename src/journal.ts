import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentKind } from './protocol'

interface SqliteStatement {
  all(): Array<Record<string, unknown>>
}

interface SqliteReadOnlyDb {
  prepare(sql: string): SqliteStatement
  close(): void
}

type SqliteDbConstructor = new (
  dbPath: string,
  options?: { readOnly?: boolean; timeout?: number }
) => SqliteReadOnlyDb

export interface JournalSessionMeta {
  provider: AgentKind
  title: string | null
  workspacePath: string | null
  model: string | null
  updatedAt: number
}

export interface AntigravityConversationSummaryMeta {
  conversationId: string
  parentConversationId: string | null
  title: string | null
  agentName: string | null
  workspacePath: string | null
  workspacePaths: string[]
  isSubagent: boolean
  updatedAtMs: number
}

export interface AntigravityHistoryEntry {
  timestampMs: number
  workspacePath: string
  conversationId: string | null
  displayPreview: string | null
}

export interface JournalIndex {
  byNativeId: Map<string, JournalSessionMeta>
  accountHomes: Map<AgentKind, Set<string>>
  /** Authoritative Antigravity workspace paths, titles, and subagent flags from conversation_summaries.db */
  antigravitySummaries?: Map<string, AntigravityConversationSummaryMeta>
  /** Explicit conversationId -> workspacePath mappings from history.jsonl */
  antigravityHistoryByConversationId?: Map<string, string>
  /** Recent Antigravity CLI prompt history entries for zero-latency turn-1 cwd matching */
  antigravityHistoryEntries?: AntigravityHistoryEntry[]
  /** Configured default model slugs read from local CLI settings (`agy`, `codex`, `claude`, `gemini`) */
  cliConfiguredModels?: Partial<Record<AgentKind, string>>
}

function loadSqliteConstructor(): SqliteDbConstructor | null {
  try {
    const req = createRequire(import.meta.url)
    const sqliteMod = req('node:sqlite') as {
      Database?: SqliteDbConstructor
      DatabaseSync?: SqliteDbConstructor
    }
    return sqliteMod.Database ?? sqliteMod.DatabaseSync ?? null
  } catch {
    return null
  }
}

function canonicalDirKey(dirPath: string): string | null {
  try {
    const st = fs.statSync(dirPath)
    if (st.dev || st.ino) {
      return `${st.dev}:${st.ino}`
    }
    return fs.realpathSync.native(dirPath)
  } catch {
    return null
  }
}

export function defaultOrcaAppDataDirs(homeDir = os.homedir()): string[] {
  const envOverride = process.env.TOKEN_PULSE_ORCA_DATA_DIR || process.env.ORCA_USER_DATA_PATH
  const rawCandidates: string[] = []
  if (envOverride && envOverride.trim()) {
    rawCandidates.push(envOverride.trim())
  } else if (process.platform === 'darwin') {
    rawCandidates.push(path.join(homeDir, 'Library', 'Application Support', 'orca'))
    rawCandidates.push(path.join(homeDir, 'Library', 'Application Support', 'Orca'))
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming')
    rawCandidates.push(path.join(appData, 'orca'))
    rawCandidates.push(path.join(appData, 'Orca'))
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config')
    rawCandidates.push(path.join(xdg, 'orca'))
    rawCandidates.push(path.join(xdg, 'Orca'))
  }

  // Deduplicate by (dev, ino) + native realpath so case-insensitive APFS/NTFS never scans `orca` and `Orca` twice
  const seenKeys = new Set<string>()
  const uniqueDirs: string[] = []
  for (const candidate of rawCandidates) {
    const key = canonicalDirKey(candidate)
    if (!key || seenKeys.has(key)) continue
    seenKeys.add(key)
    try {
      uniqueDirs.push(fs.realpathSync.native(candidate))
    } catch {
      uniqueDirs.push(candidate)
    }
  }
  return uniqueDirs
}

export function inferAgentFromTerminalTitle(rawTitle: unknown): AgentKind | null {
  if (typeof rawTitle !== 'string') return null
  const t = rawTitle.trim().toLowerCase()
  if (t === 'agy' || t.startsWith('agy ') || t === 'antigravity') return 'antigravity'
  if (t === 'claude' || t.startsWith('claude ')) return 'claude'
  if (t === 'codex' || t.startsWith('codex ')) return 'codex'
  if (t === 'gemini' || t.startsWith('gemini ')) return 'gemini'
  return null
}

/**
 * Normalizes a conversation/tab title while strictly preserving user-written `#` prefixes
 * (e.g. `# 优化 skills`, `# orca plugins init`, `#QA`, `# Wilson`).
 */
export function cleanConversationTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : null
}

const RAW_UUID_PATTERN =
  /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$|^[0-9a-f]{32}$/i

/**
 * Normalizes an Antigravity subagent `agent_name`, discarding empty strings or raw UUID-like values.
 */
export function cleanAgentName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/\s+/g, ' ').trim()
  if (!cleaned || RAW_UUID_PATTERN.test(cleaned)) return null
  return cleaned.slice(0, 120)
}

/**
 * Returns true if `raw` is a generic terminal/shell/process placeholder or boilerplate header
 * rather than a meaningful conversation or user-assigned tab title.
 */
export function isGenericTerminalTabLabel(raw: unknown, defaultTitle?: unknown): boolean {
  const s = cleanConversationTitle(raw)
  if (!s) return true
  const def = cleanConversationTitle(defaultTitle)
  if (def && s.toLowerCase() === def.toLowerCase()) return true

  if (/^terminal(?:\s+\d+)?$/i.test(s)) return true
  if (
    /^(agy|antigravity|claude|claude code|codex|openai codex|gemini|gemini cli|zsh|bash|fish|sh|dash|ksh|csh|tcsh|tmux|screen|pwsh|powershell|cmd|cmd\.exe|node|python|python3)$/i.test(
      s
    )
  ) {
    return true
  }
  if (/^(codex|claude|claude code|antigravity|gemini|agent|new)\s+(chat|session|terminal)$/i.test(s)) {
    return true
  }
  if (
    s === '~' ||
    s.startsWith('~/') ||
    s.startsWith('~\\') ||
    s.startsWith('/') ||
    s.startsWith('..') ||
    /^[A-Za-z]:[\\/]/.test(s)
  ) {
    return true
  }
  if (/^continue work from the prior orca\b/i.test(s)) return true
  if (s.includes("Name this chat from the user's first request.") || s.includes('<USER_REQUEST>')) {
    return true
  }
  return false
}

/**
 * Normalizes human-readable CLI setting model names (e.g. `"Gemini 4 Carbon (Medium)"` or
 * `"openai-codex/gpt-6.1-sol"`) into clean canonical display slugs (`"gemini-4-carbon"`, `"gpt-6.1-sol"`).
 */
export function normalizeConfiguredModelSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (!s) return null
  const slashIdx = s.lastIndexOf('/')
  if (slashIdx >= 0) {
    s = s.slice(slashIdx + 1).trim()
  }
  // Strip trailing reasoning/tier parentheses such as " (Medium)", " (High)", " (Thinking)"
  s = s.replace(/\s*\([^)]+\)\s*$/, '').trim()
  if (!s) return null
  if (/\s/.test(s)) {
    s = s.toLowerCase().replace(/\s+/g, '-')
  }
  return s
}

export function normalizeReasoningLevel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase().replace(/[_-]+/g, ' ')
  if (!value) return null
  const aliases: Record<string, string> = {
    xhigh: 'XHigh',
    'extra high': 'XHigh',
    high: 'High',
    medium: 'Medium',
    med: 'Medium',
    low: 'Low',
    minimal: 'Minimal',
    none: 'None',
    adaptive: 'Adaptive',
    max: 'Max'
  }
  return aliases[value] ?? value.replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function readLocalCliConfiguredModels(
  homeDir: string,
  orcaDirs: string[],
  accountHomes: Map<AgentKind, Set<string>>,
  disabled: ReadonlySet<AgentKind> = new Set()
): Partial<Record<AgentKind, string>> {
  const out: Partial<Record<AgentKind, string>> = {}

  // 1) Antigravity CLI (`~/.gemini/antigravity-cli/settings.json`)
  if (!disabled.has('antigravity')) try {
    const agSettingsPath = path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json')
    if (fs.existsSync(agSettingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(agSettingsPath, 'utf8')) as { model?: unknown }
      const m = normalizeConfiguredModelSlug(parsed?.model)
      if (m) out.antigravity = m
    }
  } catch {
    // Ignore
  }

  // 2) Codex CLI (`~/.codex/config.toml` or Orca `codex-runtime-home/home/config.toml`)
  const codexConfigs = [
    ...Array.from(accountHomes.get('codex') ?? [], (home) => path.join(home, 'config.toml')),
    path.join(homeDir, '.codex', 'config.toml'),
    ...orcaDirs.map((d) => path.join(d, 'codex-runtime-home', 'home', 'config.toml'))
  ]
  for (const cfgPath of disabled.has('codex') ? [] : codexConfigs) {
    try {
      if (!fs.existsSync(cfgPath)) continue
      const text = fs.readFileSync(cfgPath, 'utf8')
      const match = text.match(/^\s*model\s*=\s*["']([^"'\r\n]+)["']/m)
      const m = normalizeConfiguredModelSlug(match?.[1])
      if (m) {
        out.codex = m
        break
      }
    } catch {
      // Ignore
    }
  }

  // 3) Claude Code
  const claudeHomes = [...(accountHomes.get('claude') ?? []), path.join(homeDir, '.claude')]
  for (const claudeHome of disabled.has('claude') ? [] : claudeHomes) {
    try {
      const claudeSettingsPath = path.join(claudeHome, 'settings.json')
      if (!fs.existsSync(claudeSettingsPath)) continue
      const parsed = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8')) as { model?: unknown }
      const model = normalizeConfiguredModelSlug(parsed?.model)
      if (model) {
        out.claude = model
        break
      }
    } catch {
      // Try the default settings file.
    }
  }

  // 4) Gemini CLI (`~/.gemini/settings.json`)
  if (!disabled.has('gemini')) try {
    const gemSettingsPath = path.join(homeDir, '.gemini', 'settings.json')
    if (fs.existsSync(gemSettingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(gemSettingsPath, 'utf8')) as {
        model?: string | { name?: unknown }
      }
      const rawModel =
        typeof parsed?.model === 'string'
          ? parsed.model
          : parsed?.model && typeof parsed.model === 'object'
            ? parsed.model.name
            : null
      const m = normalizeConfiguredModelSlug(rawModel)
      if (m) out.gemini = m
    }
  } catch {
    // Ignore
  }

  return out
}

function parseJournalTimestampMs(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 1e12 ? raw : raw * 1000
  }
  if (typeof raw === 'string' && raw.trim()) {
    const num = Number(raw)
    if (Number.isFinite(num) && num > 0) {
      return num > 1e12 ? num : num * 1000
    }
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

function decodeFileUriOrPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  let decoded = s
  if (s.startsWith('file://')) {
    try {
      decoded = fileURLToPath(s)
    } catch {
      try {
        decoded = decodeURIComponent(s.replace(/^file:\/\/(?:localhost)?/i, ''))
      } catch {
        decoded = s.replace(/^file:\/\/(?:localhost)?/i, '')
      }
    }
  }
  const cleaned = decoded.trim().replace(/[\\/]+$/, '')
  return cleaned.length > 0 ? cleaned : null
}

function normalizePathForMatch(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  try {
    return fs.realpathSync.native(trimmed)
  } catch {
    return path.resolve(trimmed)
  }
}

function decodeWorkspaceUris(
  rawUris: unknown,
  preferredNormPaths: Set<string>
): { primary: string | null; all: string[] } {
  const candidates: string[] = []
  if (Array.isArray(rawUris)) {
    for (const item of rawUris) {
      const dec = decodeFileUriOrPath(item)
      if (dec && !candidates.includes(dec)) candidates.push(dec)
    }
  } else if (typeof rawUris === 'string' && rawUris.trim()) {
    const trimmed = rawUris.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const dec = decodeFileUriOrPath(item)
            if (dec && !candidates.includes(dec)) candidates.push(dec)
          }
        }
      } catch {
        // Fall through to regex extraction
      }
    }
    if (candidates.length === 0) {
      const matches = trimmed.match(/file:\/\/[^\s"',\]]+/g)
      if (matches) {
        for (const m of matches) {
          const dec = decodeFileUriOrPath(m)
          if (dec && !candidates.includes(dec)) candidates.push(dec)
        }
      } else {
        const single = decodeFileUriOrPath(trimmed)
        if (single) candidates.push(single)
      }
    }
  }

  if (candidates.length === 0) return { primary: null, all: [] }
  if (preferredNormPaths.size > 0 && candidates.length > 1) {
    for (const c of candidates) {
      const cNorm = normalizePathForMatch(c)
      for (const pref of preferredNormPaths) {
        if (cNorm === pref || cNorm.startsWith(pref + path.sep)) {
          return { primary: c, all: candidates }
        }
      }
    }
  }
  return { primary: candidates[0], all: candidates }
}

function collectAntigravityDataDirs(
  homeDir: string,
  orcaDirs: string[]
): string[] {
  const rawDirs: string[] = [
    path.join(homeDir, '.gemini', 'antigravity-cli'),
    path.join(homeDir, '.gemini', 'antigravity')
  ]
  for (const orcaDir of orcaDirs) {
    rawDirs.push(path.join(orcaDir, 'antigravity-chat', 'antigravity-cli'))
    rawDirs.push(path.join(orcaDir, 'antigravity-chat', 'antigravity-acp'))
    const agAccs = path.join(orcaDir, 'antigravity-accounts')
    try {
      if (fs.existsSync(agAccs)) {
        for (const ent of fs.readdirSync(agAccs, { withFileTypes: true })) {
          if (ent.isDirectory()) {
            rawDirs.push(path.join(agAccs, ent.name))
            rawDirs.push(path.join(agAccs, ent.name, 'antigravity-cli'))
            rawDirs.push(path.join(agAccs, ent.name, 'antigravity-acp'))
          }
        }
      }
    } catch {
      // Ignore unreadable account dir
    }
  }
  const seenKeys = new Set<string>()
  const out: string[] = []
  for (const d of rawDirs) {
    const key = canonicalDirKey(d)
    if (!key || seenKeys.has(key)) continue
    seenKeys.add(key)
    try {
      out.push(fs.realpathSync.native(d))
    } catch {
      out.push(d)
    }
  }
  return out
}

function readAntigravityMetadata(
  agDirs: string[],
  DatabaseCtor: SqliteDbConstructor | null,
  preferredNormPaths: Set<string>
): {
  summaries: Map<string, AntigravityConversationSummaryMeta>
  historyByConvId: Map<string, string>
  historyEntries: AntigravityHistoryEntry[]
} {
  const summaries = new Map<string, AntigravityConversationSummaryMeta>()
  const historyByConvId = new Map<string, string>()
  const historyEntries: AntigravityHistoryEntry[] = []

  if (DatabaseCtor) {
    for (const agDir of agDirs) {
      const dbPath = path.join(agDir, 'conversation_summaries.db')
      if (!fs.existsSync(dbPath)) continue
      let db: SqliteReadOnlyDb | null = null
      try {
        db = new DatabaseCtor(dbPath, { readOnly: true, timeout: 300 })

        const parentByChildId = new Map<string, string>()
        try {
          const pRows = db.prepare('SELECT * FROM conversation_parents').all()
          for (const pr of pRows) {
            const childId = pr.conversation_id ?? pr.child_conversation_id ?? pr.child_id
            const parentId = pr.parent_conversation_id ?? pr.parent_id
            if (
              typeof childId === 'string' &&
              childId.trim() &&
              typeof parentId === 'string' &&
              parentId.trim()
            ) {
              parentByChildId.set(childId.trim(), parentId.trim())
            }
          }
        } catch {
          // Optional table
        }

        const colRows = db.prepare('PRAGMA table_info(conversation_summaries)').all()
        const availableCols = new Set(
          colRows
            .map((c) => (typeof c.name === 'string' ? c.name : ''))
            .filter((n) => n.length > 0)
        )
        if (!availableCols.has('conversation_id')) continue

        const wantedCols = [
          'conversation_id',
          'title',
          'agent_name',
          'workspace_uris',
          'last_modified_time',
          'updated_at',
          'parent_conversation_id',
          'nesting_depth'
        ].filter((c) => availableCols.has(c))

        const sRows = db
          .prepare(`SELECT ${wantedCols.join(', ')} FROM conversation_summaries`)
          .all()

        for (const r of sRows) {
          const convId = typeof r.conversation_id === 'string' ? r.conversation_id.trim() : ''
          if (!convId) continue

          const cleanTitle = cleanConversationTitle(r.title)
          const cleanedAgentName = cleanAgentName(r.agent_name)
          const decoded = decodeWorkspaceUris(r.workspace_uris, preferredNormPaths)
          const rowUpdatedMs = parseJournalTimestampMs(r.last_modified_time ?? r.updated_at)
          const parentCol =
            typeof r.parent_conversation_id === 'string' ? r.parent_conversation_id.trim() : ''
          const parentConversationId = parentCol || parentByChildId.get(convId) || null
          const depthNum = Number(r.nesting_depth) || 0
          const rowIsSubagent = Boolean(parentConversationId || depthNum > 0)

          const existing = summaries.get(convId)
          if (!existing) {
            summaries.set(convId, {
              conversationId: convId,
              parentConversationId,
              title: cleanTitle,
              agentName: cleanedAgentName,
              workspacePath: decoded.primary,
              workspacePaths: decoded.all,
              isSubagent: rowIsSubagent,
              updatedAtMs: rowUpdatedMs
            })
          } else {
            const isNewer = rowUpdatedMs >= existing.updatedAtMs
            const mergedPaths = Array.from(
              new Set(
                isNewer
                  ? [...decoded.all, ...existing.workspacePaths]
                  : [...existing.workspacePaths, ...decoded.all]
              )
            )
            // Pick preferred path from mergedPaths if neither DB had a preferred primary yet
            let mergedPrimary = isNewer
              ? decoded.primary || existing.workspacePath
              : existing.workspacePath || decoded.primary
            if (preferredNormPaths.size > 0 && mergedPaths.length > 1) {
              for (const mp of mergedPaths) {
                const mpNorm = normalizePathForMatch(mp)
                if (
                  Array.from(preferredNormPaths).some(
                    (pref) => mpNorm === pref || mpNorm.startsWith(pref + path.sep)
                  )
                ) {
                  mergedPrimary = mp
                  break
                }
              }
            }
            summaries.set(convId, {
              conversationId: convId,
              parentConversationId: isNewer
                ? parentConversationId || existing.parentConversationId
                : existing.parentConversationId || parentConversationId,
              title: isNewer ? cleanTitle || existing.title : existing.title || cleanTitle,
              agentName: isNewer
                ? cleanedAgentName || existing.agentName
                : existing.agentName || cleanedAgentName,
              workspacePath: mergedPrimary,
              workspacePaths: mergedPaths,
              isSubagent: Boolean(existing.isSubagent || rowIsSubagent),
              updatedAtMs: Math.max(existing.updatedAtMs, rowUpdatedMs)
            })
          }
        }
      } catch {
        // Ignore locked/uninitialized conversation_summaries.db
      } finally {
        try {
          db?.close()
        } catch {
          // Ignore close error
        }
      }
    }
  }

  // Read trailing 64 KiB of history.jsonl for zero-latency turn-1 workspace resolution
  const HISTORY_TAIL_BYTES = 64 * 1024
  for (const agDir of agDirs) {
    const histPath = path.join(agDir, 'history.jsonl')
    if (!fs.existsSync(histPath)) continue
    let fd: number | null = null
    try {
      const stat = fs.statSync(histPath)
      if (stat.size <= 0) continue
      const startOffset = Math.max(0, stat.size - HISTORY_TAIL_BYTES)
      const toRead = stat.size - startOffset
      const buf = Buffer.allocUnsafe(toRead)
      fd = fs.openSync(histPath, 'r')
      const bytesRead = fs.readSync(fd, buf, 0, toRead, startOffset)
      if (bytesRead <= 0) continue

      let sliceStart = 0
      if (startOffset > 0) {
        const firstNl = buf.subarray(0, bytesRead).indexOf(0x0a)
        if (firstNl < 0) continue
        sliceStart = firstNl + 1
      }
      const text = buf.subarray(sliceStart, bytesRead).toString('utf8')
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim()
        if (!line) continue
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const wsPath = decodeFileUriOrPath(obj.workspace ?? obj.cwd ?? obj.project)
        if (!wsPath) continue

        const rawConvId = obj.conversationId ?? obj.conversation_id ?? obj.sessionId
        const convId =
          typeof rawConvId === 'string' && rawConvId.trim() ? rawConvId.trim() : null
        if (convId) {
          historyByConvId.set(convId, wsPath)
        }
        const tsMs = parseJournalTimestampMs(
          obj.timestamp ?? obj.createdAt ?? obj.created_at ?? obj.time
        )
        const rawDisplay =
          typeof obj.display === 'string'
            ? obj.display
            : typeof obj.prompt === 'string'
              ? obj.prompt
              : null
        const displayPreview = rawDisplay
          ? cleanConversationTitle(rawDisplay.replace(/<[^>]+>/g, ' '))
          : null
        if (tsMs > 0) {
          historyEntries.push({
            timestampMs: tsMs,
            workspacePath: wsPath,
            conversationId: convId,
            displayPreview
          })
        }
      }
    } catch {
      // Ignore unreadable history.jsonl
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {
          // Ignore
        }
      }
    }
  }

  historyEntries.sort((a, b) => b.timestampMs - a.timestampMs)
  if (historyEntries.length > 200) {
    historyEntries.length = 200
  }

  return { summaries, historyByConvId, historyEntries }
}

/** Reads agent-owned settings, summaries, and transcript metadata. */
export function readOrcaJournalIndex(
  orcaDirs = defaultOrcaAppDataDirs(),
  homeDir = os.homedir(),
  extraKnownPaths?: Iterable<string>,
  disabledAgents: ReadonlySet<AgentKind> = new Set()
): JournalIndex {
  const accountHomes = new Map<AgentKind, Set<string>>()
  for (const [agent, value] of [
    ['claude', process.env.CLAUDE_CONFIG_DIR],
    ['codex', process.env.CODEX_HOME]
  ] as const) {
    const home = value?.trim()
    if (!home || disabledAgents.has(agent)) continue
    // An explicit scan home scopes discovery to that root, including configured provider homes.
    if (path.resolve(homeDir) !== path.resolve(os.homedir())) {
      const relative = path.relative(homeDir, home)
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue
    }
    accountHomes.set(agent, new Set([home]))
  }

  const preferredNormPaths = new Set<string>()
  for (const kp of extraKnownPaths ?? []) {
    if (kp) preferredNormPaths.add(normalizePathForMatch(kp))
  }
  preferredNormPaths.delete('')

  const agMeta = disabledAgents.has('antigravity')
    ? {
        summaries: new Map<string, AntigravityConversationSummaryMeta>(),
        historyByConvId: new Map<string, string>(),
        historyEntries: [] as AntigravityHistoryEntry[]
      }
    : readAntigravityMetadata(
        collectAntigravityDataDirs(homeDir, orcaDirs),
        loadSqliteConstructor(),
        preferredNormPaths
      )
  return {
    byNativeId: new Map(),
    accountHomes,
    antigravitySummaries: agMeta.summaries,
    antigravityHistoryByConversationId: agMeta.historyByConvId,
    antigravityHistoryEntries: agMeta.historyEntries,
    cliConfiguredModels: readLocalCliConfiguredModels(homeDir, orcaDirs, accountHomes, disabledAgents)
  }
}
