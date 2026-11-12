import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentKind } from './protocol'

interface SqliteStatement {
  all(): Array<Record<string, unknown>>
  get(): Record<string, unknown> | undefined
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
  orcaSessionId: string
  nativeId: string
  provider: AgentKind
  title: string | null
  workspacePath: string | null
  model: string | null
  updatedAt: number
  turnUpdatedAt?: number
  isLiveLease: boolean
  isTurnOpen: boolean
  lastTurnState?: 'open' | 'settled' | null
}

export interface TerminalTabTitleOverride {
  ptyId: string
  workspacePath: string
  agent: AgentKind | null
  customTitle: string
  createdAt: number
  lastFocusedAt: number
}

export interface JournalIndex {
  byNativeId: Map<string, JournalSessionMeta>
  byOrcaSessionId: Map<string, JournalSessionMeta>
  accountHomes: Map<AgentKind, Set<string>>
  /** Latest observed live/recent activity timestamp per workspacePath */
  workspaceActivityMs: Map<string, number>
  /** Custom user-renamed PTY tab titles keyed by ptyId (`<worktreeId>@@<pty>`) */
  ptyCustomTitles?: Map<string, string>
  /** Active PTY terminal tabs with user-defined customTitle for matching CLI sessions */
  terminalTabOverrides?: TerminalTabTitleOverride[]
  /** Configured default model slugs read from local CLI settings (`agy`, `codex`, `claude`, `gemini`) */
  cliConfiguredModels?: Partial<Record<AgentKind, string>>
}

export interface OrcaActiveWorktreeSelection {
  activeRepoId: string | null
  activeWorktreeId: string | null
  activeWorktreePath: string | null
}

function loadSqliteConstructor(): SqliteDbConstructor | null {
  try {
    const req = createRequire(import.meta.url)
    const sqliteMod = req('node:sqlite') as { DatabaseSync?: SqliteDbConstructor }
    return sqliteMod.DatabaseSync ?? null
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

export function extractWorkspacePathFromId(workspaceId: unknown): string | null {
  if (typeof workspaceId !== 'string' || !workspaceId) return null
  const withoutPtySuffix = workspaceId.includes('@@')
    ? workspaceId.slice(0, workspaceId.indexOf('@@'))
    : workspaceId
  const sepIdx = withoutPtySuffix.indexOf('::')
  const candidate = sepIdx >= 0 ? withoutPtySuffix.slice(sepIdx + 2) : withoutPtySuffix
  return candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate) ? candidate : null
}

function listCandidateProfileStateDbs(orcaDir: string): string[] {
  let profileId = 'local-default'
  const indexPath = path.join(orcaDir, 'orca-profile-index.json')
  try {
    if (fs.existsSync(indexPath)) {
      const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
        activeProfileId?: unknown
      }
      if (typeof idx?.activeProfileId === 'string' && idx.activeProfileId.trim()) {
        profileId = idx.activeProfileId.trim()
      }
    }
  } catch {
    // Fallback to local-default
  }

  const candidateDbs: string[] = [path.join(orcaDir, 'profiles', profileId, 'profile-state.db')]
  const profilesRoot = path.join(orcaDir, 'profiles')
  try {
    if (fs.existsSync(profilesRoot)) {
      for (const ent of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
        if (ent.isDirectory() && ent.name !== profileId) {
          candidateDbs.push(path.join(profilesRoot, ent.name, 'profile-state.db'))
        }
      }
    }
  } catch {
    // Ignore
  }
  return candidateDbs
}

/**
 * Reads Orca's left-sidebar focused worktree (`workspaceSession.activeWorktreeId`) from the active
 * profile's `profile-state.db` strictly in `readOnly: true` mode (~0.5ms).
 * This resolves same-named worktrees across different Orca projects (`Project -> main`) with 100% accuracy.
 */
export function readOrcaActiveWorktreeSelection(
  orcaDirs = defaultOrcaAppDataDirs()
): OrcaActiveWorktreeSelection {
  const empty: OrcaActiveWorktreeSelection = {
    activeRepoId: null,
    activeWorktreeId: null,
    activeWorktreePath: null
  }

  const DatabaseSyncCtor = loadSqliteConstructor()
  if (!DatabaseSyncCtor) return empty

  for (const orcaDir of orcaDirs) {
    for (const dbPath of listCandidateProfileStateDbs(orcaDir)) {
      if (!fs.existsSync(dbPath)) continue
      let db: SqliteReadOnlyDb | null = null
      try {
        db = new DatabaseSyncCtor(dbPath, { readOnly: true, timeout: 300 })
        const wtRow = db
          .prepare(
            "SELECT payload FROM profile_state_document_parts WHERE domain = 'workspaceSession' AND part_key = '[\"activeWorktreeId\"]' LIMIT 1"
          )
          .get()
        const repoRow = db
          .prepare(
            "SELECT payload FROM profile_state_document_parts WHERE domain = 'workspaceSession' AND part_key = '[\"activeRepoId\"]' LIMIT 1"
          )
          .get()

        const parsedWt =
          typeof wtRow?.payload === 'string' ? (JSON.parse(wtRow.payload) as unknown) : null
        const parsedRepo =
          typeof repoRow?.payload === 'string' ? (JSON.parse(repoRow.payload) as unknown) : null

        const activeWorktreeId =
          typeof parsedWt === 'string' && parsedWt.trim() ? parsedWt.trim() : null
        const activeRepoId =
          typeof parsedRepo === 'string' && parsedRepo.trim() ? parsedRepo.trim() : null

        if (activeWorktreeId || activeRepoId) {
          return {
            activeRepoId,
            activeWorktreeId,
            activeWorktreePath: extractWorkspacePathFromId(activeWorktreeId)
          }
        }
      } catch {
        // Ignore locked or uninitialized profile-state.db
      } finally {
        try {
          db?.close()
        } catch {
          // Ignore close error
        }
      }
    }
  }

  return empty
}

function mapProviderToAgent(provider: unknown): AgentKind | null {
  const p = String(provider || '').toLowerCase().trim()
  if (p === 'claude' || p === 'claude-code') return 'claude'
  if (p === 'codex' || p === 'openai-codex') return 'codex'
  if (p === 'antigravity' || p === 'agy') return 'antigravity'
  if (p === 'gemini' || p === 'gemini-cli') return 'gemini'
  return null
}

function inferAgentFromTerminalTitle(rawTitle: unknown): AgentKind | null {
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

function isGenericChatTabLabel(label: string | null): boolean {
  if (!label) return true
  return /^(codex|claude|claude code|antigravity|gemini|agent|new)\s+chat$/i.test(label.trim())
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

function readLocalCliConfiguredModels(
  homeDir: string,
  orcaDirs: string[]
): Partial<Record<AgentKind, string>> {
  const out: Partial<Record<AgentKind, string>> = {}

  // 1) Antigravity CLI (`~/.gemini/antigravity-cli/settings.json`)
  try {
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
    path.join(homeDir, '.codex', 'config.toml'),
    ...orcaDirs.map((d) => path.join(d, 'codex-runtime-home', 'home', 'config.toml'))
  ]
  for (const cfgPath of codexConfigs) {
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

  // 3) Claude Code (`~/.claude/settings.json`)
  try {
    const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json')
    if (fs.existsSync(claudeSettingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8')) as { model?: unknown }
      const m = normalizeConfiguredModelSlug(parsed?.model)
      if (m) out.claude = m
    }
  } catch {
    // Ignore
  }

  // 4) Gemini CLI (`~/.gemini/settings.json`)
  try {
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

/**
 * Reads Orca's `agent-session-journal.db` and `profile-state.db` tab headers strictly in
 * `readOnly: true` mode and closes handles immediately so it never interferes with Orca's WAL writer.
 */
export function readOrcaJournalIndex(
  orcaDirs = defaultOrcaAppDataDirs(),
  homeDir = os.homedir()
): JournalIndex {
  const byNativeId = new Map<string, JournalSessionMeta>()
  const byOrcaSessionId = new Map<string, JournalSessionMeta>()
  const workspaceActivityMs = new Map<string, number>()
  const ptyCustomTitles = new Map<string, string>()
  const terminalTabOverrides: TerminalTabTitleOverride[] = []
  const cliConfiguredModels = readLocalCliConfiguredModels(homeDir, orcaDirs)
  const accountHomes = new Map<AgentKind, Set<string>>([
    ['claude', new Set()],
    ['codex', new Set()],
    ['antigravity', new Set()],
    ['gemini', new Set()]
  ])

  const DatabaseSyncCtor = loadSqliteConstructor()
  if (!DatabaseSyncCtor) {
    return {
      byNativeId,
      byOrcaSessionId,
      accountHomes,
      workspaceActivityMs,
      ptyCustomTitles,
      terminalTabOverrides,
      cliConfiguredModels
    }
  }

  for (const orcaDir of orcaDirs) {
    const dbPath = path.join(orcaDir, 'agent-session-journal.db')
    if (fs.existsSync(dbPath)) {
      let db: SqliteReadOnlyDb | null = null
      try {
        db = new DatabaseSyncCtor(dbPath, { readOnly: true, timeout: 500 })
        const rows = db
          .prepare('SELECT session_id, record_json FROM agent_session_records')
          .all() as Array<{ session_id?: string; record_json?: string }>

        for (const row of rows) {
          if (!row?.record_json || !row.session_id) continue
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(row.record_json) as Record<string, unknown>
          } catch {
            continue
          }

          const agent = mapProviderToAgent(parsed.provider)
          if (!agent) continue

          const accHome = parsed.accountHome as { path?: unknown } | undefined
          if (accHome && typeof accHome.path === 'string' && accHome.path.trim()) {
            accountHomes.get(agent)?.add(accHome.path.trim())
          }

          const loc = parsed.location as { workspaceId?: unknown } | undefined
          const launchDir =
            typeof parsed.launchDirectory === 'string' ? parsed.launchDirectory.trim() : null
          const workspacePath = extractWorkspacePathFromId(loc?.workspaceId) || launchDir || null
          const opts = parsed.options as { model?: unknown } | undefined
          const model = normalizeConfiguredModelSlug(opts?.model)
          const title = cleanConversationTitle(parsed.conversationName)
          const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0

          const lease = parsed.lease as
            | { claimStatus?: unknown; lastRenewedAt?: unknown }
            | null
            | undefined
          const isLiveLease = lease?.claimStatus === 'live'
          const renewedAt = typeof lease?.lastRenewedAt === 'number' ? lease.lastRenewedAt : 0

          const lastTurn = parsed.lastTurn as { state?: unknown; at?: unknown } | null | undefined
          const rawTurnState =
            typeof lastTurn?.state === 'string' ? lastTurn.state.toLowerCase().trim() : ''
          const lastTurnState: 'open' | 'settled' | null =
            rawTurnState === 'open' ? 'open' : rawTurnState === 'settled' ? 'settled' : null
          const isTurnOpen = lastTurnState === 'open'
          const turnAt = typeof lastTurn?.at === 'number' ? lastTurn.at : 0
          const turnUpdatedAt = turnAt > 0 ? turnAt : isTurnOpen ? updatedAt : 0

          const effectiveActivity = Math.max(updatedAt, renewedAt, turnAt)
          if (workspacePath && effectiveActivity > 0) {
            const score =
              effectiveActivity + (isTurnOpen ? 10_000_000 : isLiveLease ? 1_000_000 : 0)
            const prevScore = workspaceActivityMs.get(workspacePath) ?? 0
            if (score > prevScore) {
              workspaceActivityMs.set(workspacePath, score)
            }
          }

          const chain = Array.isArray(parsed.providerHandleChain) ? parsed.providerHandleChain : []
          const nativeIds = new Set<string>()
          for (const item of chain) {
            if (!item || typeof item !== 'object') continue
            const handle = (item as { handle?: Record<string, unknown> }).handle
            if (!handle || typeof handle !== 'object') continue
            for (const key of ['sessionId', 'threadId', 'nativeId', 'id']) {
              const val = handle[key]
              if (typeof val === 'string' && val.trim()) {
                nativeIds.add(val.trim())
              }
            }
          }

          const baseMeta: JournalSessionMeta = {
            orcaSessionId: row.session_id,
            nativeId: Array.from(nativeIds)[0] ?? row.session_id,
            provider: agent,
            title,
            workspacePath,
            model,
            updatedAt: Math.max(updatedAt, renewedAt),
            turnUpdatedAt,
            isLiveLease,
            isTurnOpen,
            lastTurnState
          }
          byOrcaSessionId.set(row.session_id, baseMeta)

          for (const nativeId of nativeIds) {
            const existing = byNativeId.get(nativeId)
            if (!existing || baseMeta.updatedAt >= existing.updatedAt) {
              byNativeId.set(nativeId, {
                ...baseMeta,
                nativeId,
                title: title || existing?.title || null,
                workspacePath: workspacePath || existing?.workspacePath || null,
                model: model || existing?.model || null
              })
            }
          }
        }
      } catch {
        // Ignore locked/corrupt DB and continue
      } finally {
        try {
          db?.close()
        } catch {
          // Ignore close errors
        }
      }
    }

    // Read user-visible tab headers (`tabsByWorktree` + `unifiedTabs`) from `profile-state.db`
    for (const profileDbPath of listCandidateProfileStateDbs(orcaDir)) {
      if (!fs.existsSync(profileDbPath)) continue
      let pDb: SqliteReadOnlyDb | null = null
      try {
        pDb = new DatabaseSyncCtor(profileDbPath, { readOnly: true, timeout: 300 })
        const tabRows = pDb
          .prepare(
            "SELECT part_key, payload FROM profile_state_document_parts WHERE domain = 'workspaceSession' AND (part_key LIKE '[\"tabsByWorktree\",%' OR part_key LIKE '[\"unifiedTabs\",%')"
          )
          .all() as Array<{ part_key?: string; payload?: string }>

        const unifiedTerminalMeta = new Map<
          string,
          { customLabel: string | null; lastFocusedAt: number }
        >()
        const rawWorktreeTerminalTabs: Array<Record<string, unknown>> = []

        for (const r of tabRows) {
          if (!r?.part_key || !r.payload) continue
          let arr: unknown
          try {
            arr = JSON.parse(r.payload)
          } catch {
            continue
          }
          if (!Array.isArray(arr)) continue

          if (r.part_key.startsWith('["unifiedTabs",')) {
            for (const item of arr) {
              if (!item || typeof item !== 'object') continue
              const u = item as Record<string, unknown>
              const id = typeof u.id === 'string' ? u.id : ''
              const customLabel = cleanConversationTitle(u.customLabel)
              const label = cleanConversationTitle(u.label)
              const lastFocusedAt = typeof u.lastFocusedAt === 'number' ? u.lastFocusedAt : 0

              if (id.startsWith('structured-agent-session-')) {
                const orcaSessId = id.slice('structured-agent-session-'.length)
                const jEntry = byOrcaSessionId.get(orcaSessId)
                const effectiveTitle =
                  customLabel || (!isGenericChatTabLabel(label) ? label : null)
                if (jEntry && effectiveTitle) {
                  if (customLabel || !jEntry.title) {
                    jEntry.title = effectiveTitle
                    const natEntry = byNativeId.get(jEntry.nativeId)
                    if (natEntry && natEntry.orcaSessionId === orcaSessId) {
                      natEntry.title = effectiveTitle
                    }
                  }
                }
              } else if (id) {
                unifiedTerminalMeta.set(id, { customLabel, lastFocusedAt })
              }
            }
          } else if (r.part_key.startsWith('["tabsByWorktree",')) {
            for (const item of arr) {
              if (item && typeof item === 'object') {
                rawWorktreeTerminalTabs.push(item as Record<string, unknown>)
              }
            }
          }
        }

        for (const t of rawWorktreeTerminalTabs) {
          const tabId = typeof t.id === 'string' ? t.id : ''
          const ptyId = typeof t.ptyId === 'string' ? t.ptyId : ''
          const uMeta = tabId ? unifiedTerminalMeta.get(tabId) : undefined
          const customTitle =
            cleanConversationTitle(t.customTitle) || uMeta?.customLabel || null
          if (!customTitle || !ptyId) continue

          ptyCustomTitles.set(ptyId, customTitle)

          const wsPath =
            extractWorkspacePathFromId(t.worktreeId) ||
            (typeof t.startupCwd === 'string' && t.startupCwd.trim()
              ? t.startupCwd.trim()
              : null) ||
            extractWorkspacePathFromId(ptyId)
          if (!wsPath) continue

          const agent =
            mapProviderToAgent(t.launchAgent) ?? inferAgentFromTerminalTitle(t.title)
          const createdAt = typeof t.createdAt === 'number' ? t.createdAt : 0
          const lastFocusedAt = uMeta?.lastFocusedAt ?? createdAt

          terminalTabOverrides.push({
            ptyId,
            workspacePath: wsPath,
            agent,
            customTitle,
            createdAt,
            lastFocusedAt
          })
        }
        break
      } catch {
        // Ignore locked profile-state.db
      } finally {
        try {
          pDb?.close()
        } catch {
          // Ignore close error
        }
      }
    }
  }

  return {
    byNativeId,
    byOrcaSessionId,
    accountHomes,
    workspaceActivityMs,
    ptyCustomTitles,
    terminalTabOverrides,
    cliConfiguredModels
  }
}
