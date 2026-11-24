import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { assert, describe, test } from 'orca/testing'
import { cleanAgentName, readOrcaJournalIndex } from './journal'
import { TranscriptScanner } from './scanner'

type TestSqliteHandle = {
  exec(sql: string): void
  prepare(sql: string): { run(...args: unknown[]): void }
  close(): void
}

function openWritableTestSqlite(dbPath: string): TestSqliteHandle {
  const req = createRequire(import.meta.url)
  const sqliteMod = req('node:sqlite') as {
    Database?: new (p: string) => TestSqliteHandle
    DatabaseSync?: new (p: string) => TestSqliteHandle
  }
  const Ctor = sqliteMod.Database ?? sqliteMod.DatabaseSync
  if (!Ctor) throw new Error('node:sqlite constructor unavailable')
  return new Ctor(dbPath)
}

function writeSummaryDb(
  dbPath: string,
  options: { includeAgentNameCol: boolean },
  rows: Array<{
    conversation_id: string
    title: string
    agent_name?: string | null
    workspace_uris?: string
    last_modified_time: string
    parent_conversation_id?: string
    nesting_depth?: number
  }>
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = openWritableTestSqlite(dbPath)
  try {
    if (options.includeAgentNameCol) {
      db.exec(
        'CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, agent_name TEXT, workspace_uris TEXT, last_modified_time TEXT, parent_conversation_id TEXT, nesting_depth INTEGER)'
      )
      const stmt = db.prepare(
        'INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, agent_name, workspace_uris, last_modified_time, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      for (const r of rows) {
        stmt.run(
          r.conversation_id,
          r.title,
          r.agent_name ?? null,
          r.workspace_uris ?? '[]',
          r.last_modified_time,
          r.parent_conversation_id ?? '',
          r.nesting_depth ?? 0
        )
      }
    } else {
      db.exec(
        'CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time TEXT, parent_conversation_id TEXT, nesting_depth INTEGER)'
      )
      const stmt = db.prepare(
        'INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, workspace_uris, last_modified_time, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (const r of rows) {
        stmt.run(
          r.conversation_id,
          r.title,
          r.workspace_uris ?? '[]',
          r.last_modified_time,
          r.parent_conversation_id ?? '',
          r.nesting_depth ?? 0
        )
      }
    }
  } finally {
    db.close()
  }
}

describe('Antigravity conversation_summaries agent_name extraction', () => {
  test('cleanAgentName trims valid names and discards empty or raw UUID-like values', () => {
    assert.equal(cleanAgentName('backend'), 'backend')
    assert.equal(cleanAgentName('  frontend  '), 'frontend')
    assert.equal(cleanAgentName('s1-ingress-api'), 's1-ingress-api')
    assert.equal(cleanAgentName('DeepCoderWorkerL0'), 'DeepCoderWorkerL0')
    assert.equal(cleanAgentName('  monitor   2 '), 'monitor 2')

    assert.equal(cleanAgentName(''), null)
    assert.equal(cleanAgentName('   \t\n '), null)
    assert.equal(cleanAgentName(null), null)
    assert.equal(cleanAgentName(undefined), null)
    assert.equal(cleanAgentName(42), null)
    assert.equal(cleanAgentName('540fc4ed-df2b-46ce-bc83-14fc6caf8761'), null)
    assert.equal(cleanAgentName('{540FC4ED-DF2B-46CE-BC83-14FC6CAF8761}'), null)
    assert.equal(cleanAgentName('540fc4eddf2b46cebc8314fc6caf8761'), null)
  })

  test('readOrcaJournalIndex extracts agentName when present, ignores missing column, and merges non-destructively across DBs', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-journal-agent-name-'))
    try {
      const homeDir = path.join(tmpRoot, 'home')
      const orcaDir = path.join(tmpRoot, 'orca')
      const now = Date.UTC(2026, 10, 17, 3, 0, 0)

      writeSummaryDb(
        path.join(homeDir, '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
        { includeAgentNameCol: true },
        [
          {
            conversation_id: 'sub-backend',
            title: '',
            agent_name: '  backend ',
            last_modified_time: new Date(now - 30_000).toISOString(),
            parent_conversation_id: 'parent-1',
            nesting_depth: 1
          },
          {
            conversation_id: 'sub-uuid-name',
            title: '',
            agent_name: '625a7059-16d1-4831-8dea-f737067c0827',
            last_modified_time: new Date(now - 25_000).toISOString(),
            parent_conversation_id: 'parent-1',
            nesting_depth: 1
          },
          {
            conversation_id: 'sub-upgraded',
            title: '',
            agent_name: 'old-name',
            last_modified_time: new Date(now - 40_000).toISOString(),
            parent_conversation_id: 'parent-1',
            nesting_depth: 1
          },
          {
            conversation_id: 'sub-older-fill',
            title: '',
            agent_name: '',
            last_modified_time: new Date(now - 10_000).toISOString(),
            parent_conversation_id: 'parent-1',
            nesting_depth: 1
          }
        ]
      )

      writeSummaryDb(
        path.join(homeDir, '.gemini', 'antigravity', 'conversation_summaries.db'),
        { includeAgentNameCol: true },
        [
          {
            conversation_id: 'sub-backend',
            title: '',
            agent_name: '',
            last_modified_time: new Date(now - 5_000).toISOString(),
            parent_conversation_id: 'parent-1',
            nesting_depth: 1
          },
          {
            conversation_id: 'sub-upgraded',
            title: '',
            agent_name: 'verifier',
            last_modified_time: new Date(now - 5_000).toISOString(),
            parent_conversation_id: 'parent-1',
            nesting_depth: 1
          },
          {
            conversation_id: 'sub-older-fill',
            title: '',
            agent_name: 'polish',
            last_modified_time: new Date(now - 50_000).toISOString(),
            parent_conversation_id: 'parent-1',
            nesting_depth: 1
          }
        ]
      )

      const idx = readOrcaJournalIndex([orcaDir], homeDir)
      const summaries = idx.antigravitySummaries
      assert.ok(summaries)

      assert.equal(summaries.get('sub-backend')?.agentName, 'backend')
      assert.equal(summaries.get('sub-backend')?.title, null)
      assert.equal(summaries.get('sub-backend')?.isSubagent, true)

      assert.equal(summaries.get('sub-uuid-name')?.agentName, null)
      assert.equal(summaries.get('sub-upgraded')?.agentName, 'verifier')
      assert.equal(summaries.get('sub-older-fill')?.agentName, 'polish')

      // Legacy DB schema without agent_name column must still work cleanly
      const legacyHome = path.join(tmpRoot, 'legacy-home')
      writeSummaryDb(
        path.join(legacyHome, '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
        { includeAgentNameCol: false },
        [
          {
            conversation_id: 'legacy-sub',
            title: 'Legacy Subagent',
            last_modified_time: new Date(now).toISOString(),
            parent_conversation_id: 'parent-legacy',
            nesting_depth: 1
          }
        ]
      )
      const legacyIdx = readOrcaJournalIndex([orcaDir], legacyHome)
      const legacyRow = legacyIdx.antigravitySummaries?.get('legacy-sub')
      assert.ok(legacyRow)
      assert.equal(legacyRow.title, 'Legacy Subagent')
      assert.equal(legacyRow.agentName, null)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

test('ignores both Orca private session stores', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-session-store-'))
  try {
    for (const store of ['journal', 'domain']) {
      const db = openWritableTestSqlite(path.join(dir, `agent-session-${store}.db`))
      try {
        db.exec('CREATE TABLE agent_session_records (session_id TEXT PRIMARY KEY, record_json TEXT)')
        for (const provider of ['antigravity', 'codex', 'claude', 'gemini']) {
          db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run(provider, JSON.stringify({
            provider,
            conversationName: store,
            providerHandleChain: [{ handle: { nativeId: provider } }]
          }))
        }
      } finally {
        db.close()
      }
    }
    const index = readOrcaJournalIndex([dir], dir)
    assert.equal(index.byNativeId.size, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('scans custom provider homes and managed agent transcripts without Orca state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-provider-homes-'))
  const claudeHome = path.join(dir, 'custom-claude')
  const codexHome = path.join(dir, 'custom-codex')
  const orcaDir = path.join(dir, 'orca')
  const priorClaudeHome = process.env.CLAUDE_CONFIG_DIR
  const priorCodexHome = process.env.CODEX_HOME
  function writeTranscript(relativePath: string, event: object): void {
    const filePath = path.join(dir, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(event) + '\n')
  }
  try {
    process.env.CLAUDE_CONFIG_DIR = claudeHome
    process.env.CODEX_HOME = codexHome
    const timestamp = new Date().toISOString()
    writeTranscript('custom-claude/projects/project/claude.jsonl', { type: 'user', timestamp })
    writeTranscript('custom-codex/sessions/custom.jsonl', { type: 'session_meta', timestamp, payload: { id: 'custom' } })
    writeTranscript('orca/codex-accounts/account/sessions/managed.jsonl', { type: 'session_meta', timestamp, payload: { id: 'managed' } })
    writeTranscript('orca/antigravity-accounts/account/antigravity-cli/brain/agy/.system_generated/logs/transcript.jsonl', { type: 'USER_INPUT', created_at: timestamp })
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{"model":"claude-opus"}')
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-codex"')

    const scanner = new TranscriptScanner({ homeDir: dir, orcaAppDirs: [orcaDir] })
    const sessions = scanner.scan({ forceFullDiscovery: true })
    assert.deepEqual(sessions.map((session) => session.agent).sort(), ['antigravity', 'claude', 'codex', 'codex'])
    assert.equal(scanner.getJournalIndex().cliConfiguredModels?.claude, 'claude-opus')
    assert.equal(scanner.getJournalIndex().cliConfiguredModels?.codex, 'gpt-codex')
  } finally {
    if (priorClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorClaudeHome
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = priorCodexHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('does not read settings, account homes or Antigravity metadata of switched-off agents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-disabled-agents-'))
  const claudeHome = path.join(dir, 'custom-claude')
  const codexHome = path.join(dir, 'custom-codex')
  const priorClaudeHome = process.env.CLAUDE_CONFIG_DIR
  const priorCodexHome = process.env.CODEX_HOME
  try {
    process.env.CLAUDE_CONFIG_DIR = claudeHome
    process.env.CODEX_HOME = codexHome
    fs.mkdirSync(claudeHome, { recursive: true })
    fs.mkdirSync(codexHome, { recursive: true })
    fs.mkdirSync(path.join(dir, '.gemini', 'antigravity-cli'), { recursive: true })
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{"model":"claude-opus"}')
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-codex"')
    fs.writeFileSync(path.join(dir, '.gemini', 'settings.json'), '{"model":{"name":"gemini-pro"}}')
    fs.writeFileSync(path.join(dir, '.gemini', 'antigravity-cli', 'settings.json'), '{"model":"ag-model"}')

    const everything = readOrcaJournalIndex([path.join(dir, 'orca')], dir)
    assert.equal(everything.cliConfiguredModels?.claude, 'claude-opus')
    assert.equal(everything.cliConfiguredModels?.codex, 'gpt-codex')
    assert.equal(everything.cliConfiguredModels?.antigravity, 'ag-model')
    assert.equal(everything.accountHomes.has('claude'), true)
    assert.equal(everything.accountHomes.has('codex'), true)

    const onlyGemini = readOrcaJournalIndex(
      [path.join(dir, 'orca')],
      dir,
      undefined,
      new Set(['claude', 'codex', 'antigravity'] as const)
    )
    assert.equal(onlyGemini.cliConfiguredModels?.claude, undefined)
    assert.equal(onlyGemini.cliConfiguredModels?.codex, undefined)
    assert.equal(onlyGemini.cliConfiguredModels?.antigravity, undefined)
    assert.equal(onlyGemini.accountHomes.has('claude'), false)
    assert.equal(onlyGemini.accountHomes.has('codex'), false)
    assert.equal(onlyGemini.antigravitySummaries.size, 0)

    const noneEnabled = readOrcaJournalIndex(
      [path.join(dir, 'orca')],
      dir,
      undefined,
      new Set(['claude', 'codex', 'antigravity', 'gemini'] as const)
    )
    assert.deepEqual(noneEnabled.cliConfiguredModels, {})
  } finally {
    if (priorClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorClaudeHome
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = priorCodexHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('scanner skips transcripts and CLI settings of a switched-off agent and picks them up again when re-enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-scanner-toggle-'))
  const claudeHome = path.join(dir, '.claude')
  const priorClaudeHome = process.env.CLAUDE_CONFIG_DIR
  try {
    delete process.env.CLAUDE_CONFIG_DIR
    const filePath = path.join(claudeHome, 'projects', 'project', 'claude.jsonl')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({ type: 'user', timestamp: new Date().toISOString() }) + '\n')
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{"model":"claude-opus"}')

    const scanner = new TranscriptScanner({ homeDir: dir, orcaAppDirs: [path.join(dir, 'orca')] })
    scanner.setDisabledAgents(['claude'])
    assert.equal(scanner.scan({ forceFullDiscovery: true }).length, 0)
    assert.equal(scanner.getJournalIndex().cliConfiguredModels?.claude, undefined)

    scanner.setDisabledAgents([])
    assert.deepEqual(scanner.scan({ forceFullDiscovery: true }).map((s) => s.agent), ['claude'])
    assert.equal(scanner.getJournalIndex().cliConfiguredModels?.claude, 'claude-opus')

    scanner.setDisabledAgents(['claude'])
    assert.equal(scanner.getSessions().length, 0)
    assert.equal(scanner.scan({ forceFullDiscovery: true }).length, 0)
  } finally {
    if (priorClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorClaudeHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
