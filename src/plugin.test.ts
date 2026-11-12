import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import {
  buildDashboardSnapshot,
  compute60sIoSeries,
  isSameOrChildWorktreePath
} from './aggregator'
import {
  cleanConversationTitle,
  extractWorkspacePathFromId,
  type JournalIndex,
  normalizeConfiguredModelSlug,
  readOrcaActiveWorktreeSelection
} from './journal'
import {
  escapeHtml,
  formatProjectWorktreeLabel,
  renderDashboardShellHtml,
  renderIoWaveformSvg
} from './panel/app'
import { formatTokens, formatUsd, getMessages, resolveLocale } from './panel/i18n'
import {
  applyAntigravityLines,
  applyClaudeLines,
  applyCodexLines,
  createEmptySessionState,
  parseGeminiSessionJson,
  readCompleteJsonlChunk
} from './parsers'
import {
  normalizeModelId,
  parseModelsDevPayload,
  parseOpenRouterPayload,
  PricingEngine
} from './pricing'
import { TranscriptScanner } from './scanner'
import * as workerModule from './worker'

function createTestJournalIndex(overrides: Partial<JournalIndex> = {}): JournalIndex {
  return {
    byNativeId: new Map(),
    byOrcaSessionId: new Map(),
    accountHomes: new Map(),
    workspaceActivityMs: new Map(),
    ...overrides
  }
}

describe('readCompleteJsonlChunk incremental streaming & UTF-8 safety', () => {
  test('holds partial trailing line until newline arrives and resets on file truncation', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-chunk-test-'))
    const logPath = path.join(tmpDir, 'stream.jsonl')
    try {
      const line1 = JSON.stringify({ seq: 1, title: '第一筆繁體中文測試' })
      const line2 = JSON.stringify({ seq: 2, title: '第二筆串流中斷測試🚀' })

      const halfIdx = Math.floor(line2.length / 2)
      fs.writeFileSync(logPath, `${line1}\n${line2.slice(0, halfIdx)}`, 'utf8')

      const c1 = readCompleteJsonlChunk(logPath, 0)
      assert.equal(c1.lines.length, 1)
      assert.deepEqual(JSON.parse(c1.lines[0]), { seq: 1, title: '第一筆繁體中文測試' })

      const c2 = readCompleteJsonlChunk(logPath, c1.nextOffset)
      assert.equal(c2.lines.length, 0)
      assert.equal(c2.nextOffset, c1.nextOffset)

      fs.appendFileSync(logPath, `${line2.slice(halfIdx)}\n`, 'utf8')
      const c3 = readCompleteJsonlChunk(logPath, c2.nextOffset)
      assert.equal(c3.lines.length, 1)
      assert.deepEqual(JSON.parse(c3.lines[0]), { seq: 2, title: '第二筆串流中斷測試🚀' })

      const lineRotated = JSON.stringify({ seq: 99 })
      fs.writeFileSync(logPath, `${lineRotated}\n`, 'utf8')
      const c4 = readCompleteJsonlChunk(logPath, c3.nextOffset)
      assert.equal(c4.lines.length, 1)
      assert.deepEqual(JSON.parse(c4.lines[0]), { seq: 99 })
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('4-Agent Transcript Parsers & TPS Accuracy', () => {
  test('Claude Code deduplicates multi-poll streaming message.id chunks, skips <synthetic>, and filters <0.2s noise', () => {
    const st = createEmptySessionState('claude-s1', 'claude', '/tmp/claude-s1.jsonl')
    applyClaudeLines(st, [
      JSON.stringify({
        type: 'user',
        cwd: '/Users/dev/project-alpha',
        timestamp: '2026-11-11T06:00:00.000Z',
        message: { role: 'user', content: 'Build the token pulse dashboard' }
      }),
      JSON.stringify({
        type: 'api-request',
        timestamp: '2026-11-11T06:00:01.000Z',
        params: { model: 'claude-fable-5' }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-11T06:00:01.050Z',
        message: { id: 'msg_syn', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-11T06:00:01.100Z',
        message: {
          id: 'msg_01',
          model: 'claude-fable-5',
          usage: {
            input_tokens: 1200,
            cache_read_input_tokens: 8000,
            cache_creation_input_tokens: 500,
            output_tokens: 15
          }
        }
      })
    ])

    applyClaudeLines(st, [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-11T06:00:05.000Z',
        message: {
          id: 'msg_01',
          model: 'claude-fable-5',
          usage: {
            input_tokens: 1200,
            cache_read_input_tokens: 8000,
            cache_creation_input_tokens: 500,
            output_tokens: 240
          }
        }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-11T06:00:05.050Z',
        message: {
          id: 'msg_02',
          model: 'claude-fable-5',
          usage: { input_tokens: 100, output_tokens: 20 }
        }
      })
    ])

    assert.equal(st.cwd, '/Users/dev/project-alpha')
    assert.equal(st.latestModel, 'claude-fable-5')
    assert.equal(st.titleHint, 'Build the token pulse dashboard')
    assert.equal(st.turnsByKey.size, 2)

    const t1 = st.turnsByKey.get('msg_01')!
    assert.equal(t1.input, 1200)
    assert.equal(t1.cacheRead, 8000)
    assert.equal(t1.cacheWrite, 500)
    assert.equal(t1.output, 240)
    assert.equal(t1.total, 9940)
    assert.equal(t1.tps, 60)

    const t2 = st.turnsByKey.get('msg_02')!
    assert.equal(t2.tps, null)
  })

  test('Codex subtracts cached_input_tokens, deduplicates heartbeats, and tags subagent rollouts', () => {
    const st = createEmptySessionState('codex-raw', 'codex', '/tmp/rollout-1.jsonl')
    applyCodexLines(st, [
      JSON.stringify({
        timestamp: '2026-11-11T06:10:00.000Z',
        type: 'session_meta',
        payload: {
          id: '01a0c6de-1111-2222-3333-444455556666',
          cwd: '/Users/dev/project-alpha',
          source: { subagent: { parent_id: 'root-1' } }
        }
      }),
      JSON.stringify({
        timestamp: '2026-11-11T06:10:01.000Z',
        type: 'turn_context',
        payload: { cwd: '/Users/dev/project-alpha', model: 'gpt-6.1-sol' }
      }),
      JSON.stringify({
        timestamp: '2026-11-11T06:10:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Audit adversarial P0/P1 edge cases' }
      }),
      JSON.stringify({
        timestamp: '2026-11-11T06:10:06.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 10500 },
            last_token_usage: {
              input_tokens: 10000,
              cached_input_tokens: 8500,
              output_tokens: 500,
              reasoning_output_tokens: 200
            }
          }
        }
      }),
      JSON.stringify({
        timestamp: '2026-11-11T06:10:06.500Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 10500 },
            last_token_usage: {
              input_tokens: 10000,
              cached_input_tokens: 8500,
              output_tokens: 500,
              reasoning_output_tokens: 200
            }
          }
        }
      })
    ])

    assert.equal(st.sessionId, '01a0c6de-1111-2222-3333-444455556666')
    assert.equal(st.isSubagent, true)
    assert.equal(st.latestModel, 'gpt-6.1-sol')
    assert.equal(st.turnsByKey.size, 1)

    const turn = Array.from(st.turnsByKey.values())[0]!
    assert.equal(turn.input, 1500)
    assert.equal(turn.cacheRead, 8500)
    assert.equal(turn.output, 300)
    assert.equal(turn.reasoning, 200)
    assert.equal(turn.total, 10500)
    assert.equal(turn.tps, 100)
  })

  test('Antigravity computes TPS for start-timed & out-of-order steps, guards 1s quantization spikes, and filters helpers', () => {
    const st = createEmptySessionState('ag-brain-1', 'antigravity', '/tmp/transcript.jsonl')
    applyAntigravityLines(st, [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-11T07:00:00Z',
        content: 'Command Working Directory: /Users/dev/project-alpha\n<USER_REQUEST>實測並執行對抗性審查</USER_REQUEST>'
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-11T07:00:00Z',
        input_tokens: 4000,
        cache_read_tokens: 20000,
        output_tokens: 500
      }),
      JSON.stringify({
        step_index: 2,
        type: 'AGENCY_TOOL_CALL',
        created_at: '2026-11-11T07:00:10Z'
      }),
      JSON.stringify({
        step_index: 4,
        type: 'AGENCY_TOOL_CALL',
        created_at: '2026-11-11T07:00:22Z'
      }),
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-11T07:00:12Z',
        input_tokens: 2000,
        cache_read_tokens: 24000,
        output_tokens: 400
      }),
      JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-11T07:00:22Z',
        input_tokens: 1000,
        output_tokens: 600
      }),
      JSON.stringify({
        step_index: 6,
        type: 'AGENCY_TOOL_CALL',
        created_at: '2026-11-11T07:00:23Z'
      })
    ])

    assert.equal(st.isInternalHelper, false)
    assert.equal(st.cwd, '/Users/dev/project-alpha')
    assert.equal(st.titleHint, '實測並執行對抗性審查')
    assert.equal(st.turnsByKey.get('ag-step-1')?.tps, 50)
    assert.equal(st.turnsByKey.get('ag-step-3')?.tps, 40)
    assert.equal(st.turnsByKey.get('ag-step-5')?.tps, null)

    const helper = createEmptySessionState('ag-helper', 'antigravity', '/tmp/helper.jsonl')
    applyAntigravityLines(helper, [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-11T07:00:00Z',
        content: "Name this chat from the user's first request."
      })
    ])
    assert.equal(helper.isInternalHelper, true)

    const commitHelper = createEmptySessionState('ag-commit-helper', 'antigravity', '/tmp/commit-helper.jsonl')
    applyAntigravityLines(commitHelper, [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-11T07:01:00Z',
        content: 'You are generating a single git commit message.\nReturn only the commit message text.'
      })
    ])
    assert.equal(commitHelper.isInternalHelper, true)

    const askAndDone = createEmptySessionState('ag-state-1', 'antigravity', '/tmp/state.jsonl')
    applyAntigravityLines(askAndDone, [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-11T07:02:00Z',
        content: '<USER_REQUEST>Build dashboard</USER_REQUEST>'
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-11T07:02:04Z',
        tool_calls: [{ name: 'ask_question', args: {} }],
        input_tokens: 1200,
        output_tokens: 80
      })
    ])
    assert.equal(askAndDone.lastEventState, 'waiting')
    applyAntigravityLines(askAndDone, [
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-11T07:02:15Z',
        tool_calls: [],
        input_tokens: 1500,
        output_tokens: 240
      })
    ])
    assert.equal(askAndDone.lastEventState, 'done')

    const handover = createEmptySessionState('ag-handover', 'antigravity', '/tmp/handover.jsonl')
    applyAntigravityLines(handover, [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-11T07:05:00Z',
        content:
          'Continue work from the prior Orca session.\nSession: QBiBot Release 2.0 Audit\nOriginal working directory: /Users/dev/qbibotlive/release-2.0\n...[truncated]'
      })
    ])
    assert.equal(handover.cwd, '/Users/dev/qbibotlive/release-2.0')
    assert.equal(handover.titleHint, 'QBiBot Release 2.0 Audit')
  })

  test('Gemini CLI parses monolithic session JSON, folder-key project mapping, cached subtraction, and TPS', () => {
    const projMap = new Map([['folder-hash-xyz', '/Users/dev/project-alpha']])
    const raw = JSON.stringify({
      sessionId: 'gem-sess-1',
      startTime: '2026-11-11T06:30:00.000Z',
      lastUpdated: '2026-11-11T06:30:08.000Z',
      messages: [
        { type: 'user', timestamp: '2026-11-11T06:30:00.000Z', content: 'Optimize bundle performance' },
        {
          id: 'g-1',
          type: 'gemini',
          model: 'gemini-3-pro',
          timestamp: '2026-11-11T06:30:08.000Z',
          tokens: { input: 5000, cached: 3000, output: 320, thoughts: 80 }
        }
      ]
    })

    const st = parseGeminiSessionJson(
      '/Users/dev/.gemini/tmp/folder-hash-xyz/chats/session-1.json',
      raw,
      projMap
    )!
    assert.ok(st)
    assert.equal(st.cwd, '/Users/dev/project-alpha')
    assert.equal(st.latestModel, 'gemini-3-pro')
    const turn = st.turnsByKey.get('g-1')!
    assert.equal(turn.input, 2000)
    assert.equal(turn.cacheRead, 3000)
    assert.equal(turn.output, 320)
    assert.equal(turn.reasoning, 80)
    assert.equal(turn.tps, 50)
  })
})

describe('Live Online Model Pricing Engine', () => {
  test('normalizes model IDs, converts OpenRouter per-token rates, rejects negative sentinels, and computes cache-discounted USD', async () => {
    assert.equal(
      normalizeModelId('us.anthropic.claude-sonnet-4.6-20251001[1m]:thinking'),
      'claude-sonnet-4-6'
    )
    assert.equal(normalizeModelId('opus[1m]'), 'opus')

    const orParsed = parseOpenRouterPayload({
      data: [
        {
          id: 'anthropic/claude-sonnet-4.6',
          pricing: {
            prompt: '0.000003',
            completion: '0.000015',
            input_cache_read: '0.0000003',
            input_cache_write: '0.00000375'
          }
        },
        {
          id: 'openai/auto-router',
          pricing: { prompt: '-1', completion: '-1' }
        }
      ]
    })
    assert.deepEqual(orParsed['claude-sonnet-4-6'], {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75
    })
    assert.equal(orParsed['auto-router'], undefined)

    const mdParsed = parseModelsDevPayload({
      openai: {
        models: {
          'gpt-5-mini': { cost: { input: 0.25, output: 2.0, cache_read: 0.025 } },
          'gpt-5': { cost: { input: 1.25, output: 10.0, cache_read: 0.125 } }
        }
      }
    })
    assert.equal(mdParsed['gpt-5-mini'].input, 0.25)

    const mockFetch: typeof fetch = async (url) => {
      const u = String(url)
      if (u.includes('openrouter.ai')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'anthropic/claude-sonnet-4.6',
                pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' }
              }
            ]
          }),
          { status: 200 }
        )
      }
      return new Response(
        JSON.stringify({
          openai: {
            models: {
              'gpt-5': { cost: { input: 1.25, output: 10.0, cache_read: 0.125 } },
              'gpt-5-mini': { cost: { input: 0.25, output: 2.0, cache_read: 0.025 } }
            }
          }
        }),
        { status: 200 }
      )
    }

    const engine = new PricingEngine(mockFetch)
    const status = await engine.syncOnline(2000)
    assert.equal(status.source, 'online')
    assert.equal(engine.resolveRate('codex', 'gpt-5-mini-preview').input, 0.25)

    const cost = engine.computeCostUsd('claude', 'claude-fable-5', {
      input: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000
    })
    assert.equal(+cost.toFixed(2), 18.3)

    const offlineEngine = new PricingEngine(async () => {
      throw new Error('offline')
    })
    offlineEngine.loadFromCache(engine.toStorableCatalog())
    const failStatus = await offlineEngine.syncOnline(200)
    assert.equal(failStatus.source, 'cache')
    assert.ok(failStatus.lastError?.includes('offline'))
  })
})

describe('Aggregator, Left-Sidebar Project/Worktree Focus, Pure-Icon UI & i18n', () => {
  test('scopes conversations strictly to focused Orca Project -> Worktree, sorts newest-to-oldest, excludes subagents from cards, and uses pure SVG icon tabs', () => {
    assert.equal(resolveLocale('zh-TW'), 'zh-TW')
    assert.equal(resolveLocale('zh-Hant-HK'), 'zh-TW')
    assert.equal(resolveLocale('zh-CN'), 'zh-CN')
    assert.equal(resolveLocale('ja-JP'), 'ja')
    assert.equal(resolveLocale('ko-KR'), 'ko')
    assert.equal(resolveLocale('en-US'), 'en')

    assert.equal(
      extractWorkspacePathFromId('d950d0e9::/Users/wilsonliu/orca/orca-token-used@@pty123'),
      '/Users/wilsonliu/orca/orca-token-used'
    )
    assert.equal(formatProjectWorktreeLabel('PulseBoard', 'main', 'main'), 'PulseBoard / main')
    assert.equal(
      isSameOrChildWorktreePath('/Users/dev/wt-a/packages/ui', '/Users/dev/wt-a'),
      true
    )
    assert.equal(
      isSameOrChildWorktreePath('/Users/dev/wt-a-other', '/Users/dev/wt-a'),
      false
    )

    const now = Date.parse('2026-11-11T08:00:00.000Z')

    // Project A (`orca-token-used`), worktree `main`: 2 user sessions + 1 subagent
    const sOlderA = createEmptySessionState('s-older-a', 'claude', '/tmp/older-a.jsonl')
    sOlderA.cwd = '/Users/dev/orca-token-used'
    sOlderA.latestModel = 'claude-fable-5'
    sOlderA.createdAtMs = now - 3600_000
    sOlderA.updatedAtMs = now - 1800_000
    sOlderA.turnsByKey.set('t1', {
      turnKey: 't1',
      timestampMs: now - 1800_000,
      input: 1000,
      output: 500,
      reasoning: 0,
      cacheRead: 2000,
      cacheWrite: 0,
      total: 3500,
      durationSec: 10,
      tps: 50,
      model: 'claude-fable-5',
      explicitCostUsd: null
    })

    const sNewerA = createEmptySessionState('s-newer-a', 'codex', '/tmp/newer-a.jsonl')
    sNewerA.cwd = '/Users/dev/orca-token-used/src'
    sNewerA.latestModel = 'gpt-6.1-sol'
    sNewerA.createdAtMs = now - 600_000
    sNewerA.updatedAtMs = now - 10_000
    sNewerA.titleHint = 'Fix <script>alert("xss")</script> bug'
    sNewerA.turnsByKey.set('t2', {
      turnKey: 't2',
      timestampMs: now - 10_000,
      input: 2000,
      output: 800,
      reasoning: 200,
      cacheRead: 5000,
      cacheWrite: 0,
      total: 8000,
      durationSec: 10,
      tps: 100,
      model: 'gpt-6.1-sol',
      explicitCostUsd: null
    })

    const sSubagentA = createEmptySessionState('s-sub-a', 'codex', '/tmp/sub-a.jsonl')
    sSubagentA.cwd = '/Users/dev/orca-token-used'
    sSubagentA.isSubagent = true
    sSubagentA.updatedAtMs = now - 8_000
    sSubagentA.turnsByKey.set('t-sub', {
      turnKey: 't-sub',
      timestampMs: now - 8_000,
      input: 500,
      output: 500,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1000,
      durationSec: 5,
      tps: 100,
      model: 'gpt-6.1-sol',
      explicitCostUsd: null
    })

    // Project B (`PulseBoard`), ALSO having worktree named `main`
    const sProjectB = createEmptySessionState('s-pulse-b', 'antigravity', '/tmp/pulse-b.jsonl')
    sProjectB.cwd = '/Users/dev/PulseBoard'
    sProjectB.updatedAtMs = now - 5_000
    sProjectB.titleHint = 'PulseBoard UI redesign'
    sProjectB.turnsByKey.set('t3', {
      turnKey: 't3',
      timestampMs: now - 5_000,
      input: 1_000_000,
      output: 100_000,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1_100_000,
      durationSec: 6,
      tps: 50,
      model: null, // Antigravity turn has null model; resolved via journal (`gemini-4-carbon`)
      explicitCostUsd: null
    })

    // Second Antigravity session using cheaper `gemini-4-argon` via journal (verifies perAgentFallbackModel does not clobber `sProjectB` cost)
    const sAgLight = createEmptySessionState('s-ag-light', 'antigravity', '/tmp/ag-light.jsonl')
    sAgLight.cwd = '/Users/dev/PulseBoard'
    sAgLight.updatedAtMs = now - 4_000
    sAgLight.turnsByKey.set('t4', {
      turnKey: 't4',
      timestampMs: now - 4_000,
      input: 100_000,
      output: 10_000,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 110_000,
      durationSec: 5,
      tps: 40,
      model: null,
      explicitCostUsd: null
    })

    const journal = createTestJournalIndex({
      byNativeId: new Map([
        [
          's-older-a',
          {
            orcaSessionId: 'orca-1',
            nativeId: 's-older-a',
            provider: 'claude',
            title: '舊的對話標題',
            workspacePath: '/Users/dev/orca-token-used',
            model: 'claude-fable-5',
            updatedAt: now - 1800_000,
            isLiveLease: false,
            isTurnOpen: false
          }
        ],
        [
          's-newer-a',
          {
            orcaSessionId: 'orca-a2',
            nativeId: 's-newer-a',
            provider: 'codex',
            title: null,
            workspacePath: '/Users/dev/orca-token-used',
            model: 'gpt-6.1-terra',
            updatedAt: now - 10_000,
            isLiveLease: false,
            isTurnOpen: false
          }
        ],
        [
          's-pulse-b',
          {
            orcaSessionId: 'orca-b1',
            nativeId: 's-pulse-b',
            provider: 'antigravity',
            title: 'PulseBoard UI redesign',
            workspacePath: '/Users/dev/PulseBoard',
            model: 'gemini-4-carbon',
            updatedAt: now - 5_000,
            isLiveLease: true,
            isTurnOpen: false
          }
        ],
        [
          's-ag-light',
          {
            orcaSessionId: 'orca-b2',
            nativeId: 's-ag-light',
            provider: 'antigravity',
            title: 'PulseBoard quick fix',
            workspacePath: '/Users/dev/PulseBoard',
            model: 'gemini-4-argon',
            updatedAt: now - 4_000,
            isLiveLease: false,
            isTurnOpen: false
          }
        ]
      ])
    })

    const knownWorkspaces = [
      {
        id: 'repo-a::/Users/dev/orca-token-used',
        project: 'orca-token-used',
        name: 'main',
        path: '/Users/dev/orca-token-used',
        branch: 'refs/heads/main'
      },
      {
        id: 'repo-b::/Users/dev/PulseBoard',
        project: 'PulseBoard',
        name: 'main',
        path: '/Users/dev/PulseBoard',
        branch: 'refs/heads/main'
      }
    ]

    const snapA = buildDashboardSnapshot(
      [sOlderA, sNewerA, sSubagentA, sProjectB, sAgLight],
      journal,
      new PricingEngine(),
      {
        focusedId: 'repo-a::/Users/dev/orca-token-used',
        focusedProject: 'orca-token-used',
        focusedName: 'main',
        focusedBranch: 'refs/heads/main',
        focusedPath: '/Users/dev/orca-token-used',
        knownWorkspaces,
        liveAgents: [
          {
            terminalId: 'stale-done-pty',
            title: 'aggy-finished-2h-ago',
            agent: 'claude',
            state: 'done',
            stateStartedAt: now - 2 * 3600_000
          }
        ]
      },
      now
    )

    assert.equal(snapA.workspace.project, 'orca-token-used')
    assert.equal(snapA.workspace.name, 'main')
    assert.equal(snapA.workspace.branch, 'main')
    assert.equal(snapA.sessions.length, 2)
    assert.equal(snapA.sessions[0].sessionId, 's-newer-a')
    assert.equal(snapA.sessions[0].projectName, 'orca-token-used')
    assert.equal(snapA.sessions[1].sessionId, 's-older-a')
    assert.equal(snapA.sessions[1].title, '舊的對話標題')

    // Stale (>15m) `state: 'done'` terminal must NOT appear in Live view
    assert.ok(!snapA.live.agents.some((la) => la.id === 'stale-done-pty'))

    assert.equal(snapA.periods.worktree.day.tokens.total, 12500)
    assert.equal(snapA.periods.all.day.tokens.total, 1_222_500)

    // Per-agent cost breakdown MUST sum identically to total period cost even across mixed-model null-turn-model sessions
    const byAgentCostSum = snapA.periods.all.day.byAgent.reduce((acc, r) => acc + r.tokens.costUsd, 0)
    assert.ok(
      Math.abs(byAgentCostSum - snapA.periods.all.day.tokens.costUsd) < 1e-4,
      `Expected byAgent sum ${byAgentCostSum} to match period cost ${snapA.periods.all.day.tokens.costUsd}`
    )

    const htmlSessions = renderDashboardShellHtml({
      snap: snapA,
      tab: 'sessions',
      scope: 'worktree',
      locale: 'zh-TW',
      nowMs: now
    })
    assert.ok(htmlSessions.includes(getMessages('zh-TW').appTitle))
    assert.ok(htmlSessions.includes('orca-token-used / main'))
    // Must NOT show PulseBoard pills or manual switcher inside orca-token-used's Sessions view
    assert.ok(!htmlSessions.includes('PulseBoard / main'))
    assert.ok(htmlSessions.includes('OpenAI · gpt-6.1-terra'))
    assert.ok(!htmlSessions.includes('<script>alert("xss")</script>'))
    assert.ok(htmlSessions.includes(escapeHtml('Fix <script>alert("xss")</script> bug')))

    assert.equal(getMessages('en').appTitle, 'Token Pulse')
    assert.equal(getMessages('zh-TW').appTitle, 'Token 算力脈衝')
    assert.ok(htmlSessions.includes('tp-brand-emblem'))

    const navBtnMatches = [
      ...htmlSessions.matchAll(/<button[^>]*class="(tp-nav-btn[^"]*)"[^>]*>([\s\S]*?)<\/button>/g)
    ]
    assert.equal(navBtnMatches.length, 5)
    let activeNavCount = 0
    for (const m of navBtnMatches) {
      const cls = m[1]
      const inner = m[2].trim()
      assert.ok(inner.startsWith('<svg'))
      const strippedSvg = inner.replace(/<svg[\s\S]*?<\/svg>/g, '').trim()
      if (cls.split(/\s+/).includes('active')) {
        activeNavCount++
        assert.equal(strippedSvg, `<span class="tp-nav-label">${getMessages('zh-TW').navShort.sessions}</span>`)
      } else {
        assert.equal(strippedSvg, '')
      }
    }
    assert.equal(activeNavCount, 1)

    // Verify 60s dual I/O series & smooth flowing spline SVG (Output upper half, Input lower half, NaN-free, no protruding dot)
    const ioZero = renderIoWaveformSvg([], 'out')
    assert.ok(!ioZero.html.includes('NaN') && !ioZero.html.includes('Infinity'))
    assert.ok(!ioZero.html.includes('tp-io-live-dot'))
    assert.ok(ioZero.html.includes('clipPath'))
    assert.equal(ioZero.scaleMax, 20)

    const ioSpiky = compute60sIoSeries(sNewerA.turnsByKey.values(), true, now)
    assert.equal(ioSpiky.outSeries.length, 60)
    assert.equal(ioSpiky.inSeries.length, 60)
    assert.equal(ioSpiky.seriesEndSec, Math.floor(now / 1000))
    assert.ok(ioSpiky.outSeries.some((v) => v > 0))
    assert.ok(ioSpiky.inSeries.some((v) => v > 0))

    // Verify zero flat-topped rectangular plateaus (no 4+ identical consecutive peak values)
    const nonZeroOut = ioSpiky.outSeries.filter((v) => v > 1)
    assert.ok(new Set(nonZeroOut).size >= 4, 'Multi-second output span should form a smooth rounded wave, not a flat square-wave plateau')

    // Verify strict world-time invariance: advancing `now` by +1000ms shifts `outSeries` & `inSeries` left by 1 second identically
    const ioNextSec = compute60sIoSeries(sNewerA.turnsByKey.values(), true, now + 1000)
    assert.deepEqual(ioNextSec.outSeries.slice(0, 59), ioSpiky.outSeries.slice(1, 60))
    assert.deepEqual(ioNextSec.inSeries.slice(0, 59), ioSpiky.inSeries.slice(1, 60))

    // Verify `liveOutRate` and `liveInRate` are non-zero and dynamically evolve across 1s ticks while `working`,
    // then settle cleanly to `0` once stopped (`isWorking = false`)
    const ioSec2 = compute60sIoSeries(sNewerA.turnsByKey.values(), true, now + 2000)
    assert.ok(ioSpiky.liveOutRate > 0 && ioNextSec.liveOutRate > 0 && ioSec2.liveOutRate > 0)
    assert.ok(ioSpiky.liveInRate > 0 && ioNextSec.liveInRate > 0 && ioSec2.liveInRate > 0)
    assert.ok(
      new Set([ioSpiky.liveOutRate, ioNextSec.liveOutRate, ioSec2.liveOutRate]).size >= 2,
      'Active working Output tok/s readout should dynamically update across consecutive 1s polls'
    )
    assert.ok(
      new Set([ioSpiky.liveInRate, ioNextSec.liveInRate, ioSec2.liveInRate]).size >= 2,
      'Active working Input tok/s readout should dynamically update across consecutive 1s polls'
    )
    const ioStopped = compute60sIoSeries(sNewerA.turnsByKey.values(), false, now + 5000)
    assert.equal(ioStopped.liveOutRate, 0)
    assert.equal(ioStopped.liveInRate, 0)

    // Stopped Orca Native Chat session with `isLiveLease: true, isTurnOpen: false` (e.g. `# Wilson` / `s-pulse-b`)
    // MUST display `done` (NOT `waiting`)
    const pulseLiveCard = snapA.live.agents.find((a) => a.sessionKey === 'antigravity:s-pulse-b')
    assert.ok(pulseLiveCard)
    assert.equal(pulseLiveCard.state, 'done')

    // Expanding a single agent in Live mode must show explicit model input/output labels.
    const targetAgent = snapA.live.agents.find((a) => a.sessionKey === 'codex:s-newer-a')!
    assert.ok(targetAgent)
    assert.equal(targetAgent.modelLabel, 'gpt-6.1-terra')
    const htmlExpandedLive = renderDashboardShellHtml({
      snap: snapA,
      tab: 'live',
      scope: 'all',
      locale: 'en',
      selectedLiveAgentKey: targetAgent.sessionKey,
      nowMs: now
    })
    assert.ok(htmlExpandedLive.includes('tp-io-monitor'))
    assert.ok(!htmlExpandedLive.includes('tp-io-live-dot'))
    assert.ok(htmlExpandedLive.includes('data-io-path="out-stroke"'))
    assert.ok(htmlExpandedLive.includes('data-io-path="in-stroke"'))
    assert.ok(htmlExpandedLive.includes('OpenAI · gpt-6.1-terra'))
    assert.ok(!htmlExpandedLive.includes('PulseBoard UI redesign'))
    const outIdx = htmlExpandedLive.indexOf('MODEL OUTPUT · REPLY RATE')
    const inIdx = htmlExpandedLive.indexOf('MODEL INPUT · CONTEXT RATE')
    assert.ok(outIdx > 0 && inIdx > outIdx, 'Model output must render above model input')
    assert.ok(!htmlExpandedLive.includes('↑ Output') && !htmlExpandedLive.includes('↓ Input'))

    assert.equal(formatTokens(1_250_000), '1.25M')
    assert.equal(formatUsd(12.345), '$12.35')

    // `#` ("井字號") prefixes in Orca tab titles MUST be preserved verbatim
    assert.equal(cleanConversationTitle('# 优化 skills'), '# 优化 skills')
    assert.equal(cleanConversationTitle('# orca plugins init'), '# orca plugins init')
    assert.equal(cleanConversationTitle('#QA'), '#QA')
    assert.equal(normalizeConfiguredModelSlug('Gemini 4 Carbon (Medium)'), 'gemini-4-carbon')
    assert.equal(normalizeConfiguredModelSlug('openai-codex/gpt-6.1-sol'), 'gpt-6.1-sol')

    // PTY terminal tab with `customTitle: "# 优化 skills"` + CLI `settings.json` model `gemini-4-carbon`
    const sCliAgy = createEmptySessionState(
      '6cf4f801-cli',
      'antigravity',
      '/Users/dev/.gemini/antigravity-cli/brain/6cf4f801-cli/.system_generated/logs/transcript.jsonl'
    )
    sCliAgy.cwd = '/Users/dev/ai-engineering-workflow-skills'
    sCliAgy.titleHint = '确认 team-init 角色账号与 URL 询问流程'
    sCliAgy.createdAtMs = now - 3600_000
    sCliAgy.updatedAtMs = now - 2_000
    sCliAgy.turnsByKey.set('t-cli', {
      turnKey: 't-cli',
      timestampMs: now - 2_000,
      input: 2000,
      output: 1000,
      reasoning: 0,
      cacheRead: 10000,
      cacheWrite: 0,
      total: 13000,
      durationSec: 20,
      tps: 50,
      model: null,
      explicitCostUsd: null
    })

    const snapCli = buildDashboardSnapshot(
      [sCliAgy],
      createTestJournalIndex({
        ptyCustomTitles: new Map([
          ['repo-skills::/Users/dev/ai-engineering-workflow-skills@@72e25391', '# 优化 skills']
        ]),
        terminalTabOverrides: [
          {
            ptyId: 'repo-skills::/Users/dev/ai-engineering-workflow-skills@@72e25391',
            workspacePath: '/Users/dev/ai-engineering-workflow-skills',
            agent: 'antigravity',
            customTitle: '# 优化 skills',
            createdAt: now - 3605_000,
            lastFocusedAt: now - 1_000
          }
        ],
        cliConfiguredModels: { antigravity: 'gemini-4-carbon' }
      }),
      new PricingEngine(),
      {
        focusedId: 'repo-skills::/Users/dev/ai-engineering-workflow-skills',
        focusedProject: 'ai-engineering-workflow-skills',
        focusedName: 'main',
        focusedBranch: 'main',
        focusedPath: '/Users/dev/ai-engineering-workflow-skills',
        knownWorkspaces: [
          {
            id: 'repo-skills::/Users/dev/ai-engineering-workflow-skills',
            project: 'ai-engineering-workflow-skills',
            name: 'main',
            path: '/Users/dev/ai-engineering-workflow-skills',
            branch: 'refs/heads/main'
          }
        ],
        liveAgents: [
          {
            terminalId: 'repo-skills::/Users/dev/ai-engineering-workflow-skills@@72e25391',
            title: 'agy',
            agent: 'antigravity',
            state: 'working',
            stateStartedAt: now - 2_000
          }
        ]
      },
      now
    )

    assert.equal(snapCli.sessions.length, 1)
    assert.equal(snapCli.sessions[0].title, '# 优化 skills')
    assert.equal(snapCli.sessions[0].modelLabel, 'gemini-4-carbon')
    assert.equal(snapCli.live.agents[0].title, '# 优化 skills')
    assert.equal(snapCli.live.agents[0].modelLabel, 'gemini-4-carbon')

    // Regression: a completed CLI session (>45m old, `lastEventState === 'done'`) MUST NOT be hijacked
    // as `working` when Orca's `agents.list` reports a `terminalId: null` Structured Chat agent!
    const sCompletedOldCli = createEmptySessionState(
      '6cf4f801-closed',
      'antigravity',
      '/Users/dev/.gemini/antigravity-cli/brain/6cf4f801-closed/.system_generated/logs/transcript.jsonl'
    )
    sCompletedOldCli.cwd = '/Users/dev/ai-engineering-workflow-skills'
    sCompletedOldCli.titleHint = '确认 team-init 角色账号与 URL 询问流程'
    sCompletedOldCli.createdAtMs = now - 7200_000
    sCompletedOldCli.updatedAtMs = now - 3500_000
    sCompletedOldCli.lastMtimeMs = now - 3500_000
    sCompletedOldCli.lastEventState = 'done'
    sCompletedOldCli.turnsByKey.set('t-old', {
      turnKey: 't-old',
      timestampMs: now - 3500_000,
      input: 4000,
      output: 900,
      reasoning: 0,
      cacheRead: 30000,
      cacheWrite: 0,
      total: 34900,
      durationSec: 18,
      tps: 50,
      model: 'gemini-4-carbon',
      explicitCostUsd: null
    })

    const sActiveNativeChat = createEmptySessionState(
      '808ad2e0-live',
      'antigravity',
      '/Users/dev/Library/Application Support/orca/antigravity-chat/antigravity-acp/brain/808ad2e0-live/.system_generated/logs/transcript.jsonl'
    )
    sActiveNativeChat.cwd = '/Users/dev/ai-engineering-workflow-skills'
    sActiveNativeChat.createdAtMs = now - 600_000
    sActiveNativeChat.updatedAtMs = now - 4_000
    sActiveNativeChat.lastMtimeMs = now - 4_000
    sActiveNativeChat.lastEventState = 'working'
    sActiveNativeChat.turnsByKey.set('t-live', {
      turnKey: 't-live',
      timestampMs: now - 4_000,
      input: 1500,
      output: 420,
      reasoning: 0,
      cacheRead: 12000,
      cacheWrite: 0,
      total: 13920,
      durationSec: 7,
      tps: 60,
      model: 'gemini-4-carbon',
      explicitCostUsd: null
    })

    const snapNoFalseWorking = buildDashboardSnapshot(
      [sCompletedOldCli, sActiveNativeChat],
      createTestJournalIndex({
        byNativeId: new Map([
          [
            '808ad2e0-live',
            {
              orcaSessionId: 'orca-live-chat',
              nativeId: '808ad2e0-live',
              provider: 'antigravity',
              title: '评估并更新 README 和 CHANGELOG',
              workspacePath: '/Users/dev/ai-engineering-workflow-skills',
              model: 'gemini-4-carbon',
              updatedAt: now - 4_000,
              turnUpdatedAt: now - 60_000,
              isLiveLease: true,
              isTurnOpen: true,
              lastTurnState: 'open'
            }
          ]
        ])
      }),
      new PricingEngine(),
      {
        focusedId: 'repo-skills::/Users/dev/ai-engineering-workflow-skills',
        focusedProject: 'ai-engineering-workflow-skills',
        focusedName: 'main',
        focusedBranch: 'main',
        focusedPath: '/Users/dev/ai-engineering-workflow-skills',
        knownWorkspaces: [],
        liveAgents: [
          {
            terminalId: null,
            title: '评估并更新 README 和 CHANGELOG',
            agent: 'antigravity',
            state: 'working',
            stateStartedAt: now - 60_000
          }
        ]
      },
      now
    )

    assert.ok(
      !snapNoFalseWorking.live.agents.some((a) => a.sessionKey === 'antigravity:6cf4f801-closed'),
      'Old completed CLI session must NOT appear in Live Monitor due to terminalId: null Structured Chat entry'
    )
    const closedSessionRow = snapNoFalseWorking.sessions.find((s) => s.sessionId === '6cf4f801-closed')
    assert.ok(closedSessionRow)
    assert.equal(closedSessionRow.active, false)
    assert.equal(snapNoFalseWorking.live.agents.length, 1)
    assert.equal(snapNoFalseWorking.live.agents[0].sessionKey, 'antigravity:808ad2e0-live')
    assert.equal(snapNoFalseWorking.live.agents[0].state, 'working')
  })
})

describe('Trusted Worker Integration, Left-Sidebar Focus Tracking & Host Contract Verification', () => {
  test('automatically switches focused Project -> Worktree when Orca left-sidebar activeWorktreeId changes, even with background agents running in another main worktree', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-worker-home-'))
    try {
      const orcaDir = path.join(tmpHome, 'orca-data')
      const profileDir = path.join(orcaDir, 'profiles', 'local-default')
      const agBrainDir = path.join(
        orcaDir,
        'antigravity-chat',
        'antigravity-acp',
        'brain',
        'conv-1',
        '.system_generated',
        'logs'
      )
      fs.mkdirSync(profileDir, { recursive: true })
      fs.mkdirSync(agBrainDir, { recursive: true })

      fs.writeFileSync(
        path.join(orcaDir, 'orca-profile-index.json'),
        JSON.stringify({ schemaVersion: 1, activeProfileId: 'local-default' }),
        'utf8'
      )

      // Create synthetic Orca `profile-state.db` to simulate left-sidebar Project -> Worktree focus changes
      const req = createRequire(import.meta.url)
      const { DatabaseSync } = req('node:sqlite') as {
        DatabaseSync: new (p: string) => {
          exec(sql: string): void
          prepare(sql: string): { run(...args: unknown[]): void }
          close(): void
        }
      }
      const profileDbPath = path.join(profileDir, 'profile-state.db')
      const setLeftSidebarFocus = (worktreeId: string) => {
        const db = new DatabaseSync(profileDbPath)
        db.exec(
          'CREATE TABLE IF NOT EXISTS profile_state_document_parts (domain TEXT NOT NULL, part_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (domain, part_key))'
        )
        db.prepare(
          'INSERT OR REPLACE INTO profile_state_document_parts (domain, part_key, payload) VALUES (?, ?, ?)'
        ).run('workspaceSession', '["activeWorktreeId"]', JSON.stringify(worktreeId))
        db.close()
      }

      // Initially focused on `PulseBoard / main` in Orca's left sidebar
      setLeftSidebarFocus('repo-pulse::/Users/wilsonliu/ai-proj/PulseBoard')

      const sel = readOrcaActiveWorktreeSelection([orcaDir])
      assert.equal(sel.activeWorktreeId, 'repo-pulse::/Users/wilsonliu/ai-proj/PulseBoard')
      assert.equal(sel.activeWorktreePath, '/Users/wilsonliu/ai-proj/PulseBoard')

      fs.writeFileSync(
        path.join(agBrainDir, 'transcript.jsonl'),
        `${JSON.stringify({
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          created_at: new Date().toISOString(),
          input_tokens: 1000,
          output_tokens: 200
        })}\n`,
        'utf8'
      )

      // Inode deduplication test
      const dupScanner = new TranscriptScanner({
        homeDir: tmpHome,
        orcaAppDirs: [orcaDir, orcaDir]
      })
      assert.equal(dupScanner.scan({ forceFullDiscovery: true }).length, 1)

      process.env.TOKEN_PULSE_HOME_DIR = tmpHome
      process.env.TOKEN_PULSE_ORCA_DATA_DIR = orcaDir

      const host = mockHost({
        settings: { pricingSyncHours: 6, livePollSeconds: 5 },
        results: {
          'workspace.list': () => ({
            workspaces: [
              {
                id: 'repo-orca::/Users/wilsonliu/orca/orca-token-used',
                kind: 'worktree',
                name: 'main',
                project: 'orca-token-used',
                path: '/Users/wilsonliu/orca/orca-token-used',
                branch: 'refs/heads/main',
                hostId: 'local'
              },
              {
                id: 'repo-pulse::/Users/wilsonliu/ai-proj/PulseBoard',
                kind: 'worktree',
                name: 'main',
                project: 'PulseBoard',
                path: '/Users/wilsonliu/ai-proj/PulseBoard',
                branch: 'refs/heads/main',
                hostId: 'local'
              }
            ],
            truncated: false
          }),
          'workspace.readContext': () => ({
            branch: 'refs/heads/main',
            displayName: 'main',
            terminals: []
          }),
          'agents.list': () => ({ agents: [] }),
          'statusBar.update': () => ({ ok: true })
        }
      })

      const worker = await mountWorker(workerModule, { host })
      try {
        assert.deepEqual(worker.refusals, [])

        // 1) Left sidebar is on `PulseBoard / main` -> must resolve to `PulseBoard`
        const snapPulse = await worker.request('dashboard.get', { forceScan: false, locale: 'zh-TW' })
        assert.equal(snapPulse.workspace.project, 'PulseBoard')
        assert.equal(snapPulse.workspace.path, '/Users/wilsonliu/ai-proj/PulseBoard')

        // 2) Even if a background agent emits `agent.status.changed` in `orca-token-used / main`,
        //    left-sidebar focus on `PulseBoard / main` MUST NOT be hijacked!
        await worker.emit('agent.status.changed', {
          workspaceId: 'repo-orca::/Users/wilsonliu/orca/orca-token-used',
          paneKey: 'pane-bg',
          terminalId: 'repo-orca::/Users/wilsonliu/orca/orca-token-used@@pty1',
          state: 'working',
          title: 'Background Agent',
          receivedAt: Date.now()
        })
        const snapStillPulse = await worker.request('dashboard.get', { forceScan: false })
        assert.equal(snapStillPulse.workspace.project, 'PulseBoard')

        // 3) User clicks `orca-token-used -> main` in Orca's left navigation sidebar!
        setLeftSidebarFocus('repo-orca::/Users/wilsonliu/orca/orca-token-used')
        await worker.emit('workspace.changed', {
          context: { branch: 'refs/heads/main', displayName: 'main', terminals: [] }
        })

        const snapOrca = await worker.request('dashboard.get', { forceScan: false })
        assert.equal(snapOrca.workspace.project, 'orca-token-used')
        assert.equal(snapOrca.workspace.path, '/Users/wilsonliu/orca/orca-token-used')

        // 4) 1-second single-agent live poll (`agent.livePoll`) + `view.set` (`liveAgentKey`)
        const pollRes = await worker.request('agent.livePoll', {
          sessionKey: 'antigravity:conv-1'
        })
        assert.ok(pollRes.agent)
        assert.equal(pollRes.agent?.sessionKey, 'antigravity:conv-1')
        assert.equal(pollRes.agent?.outSeries.length, 60)
        assert.equal(pollRes.agent?.inSeries.length, 60)

        const viewState = await worker.request('view.set', {
          tab: 'live',
          liveAgentKey: 'antigravity:conv-1'
        })
        assert.equal(viewState.tab, 'live')
        assert.equal(viewState.liveAgentKey, 'antigravity:conv-1')

        const cmdOut = await worker.command('tokenPulse.refresh')
        assert.match(String(cmdOut), /Token Pulse refreshed/)

        const sbCalls = host.callsOf('statusBar.update')
        assert.ok(sbCalls.length >= 1)
        assert.deepEqual(worker.refusals, [])
      } finally {
        await worker.deactivate()
        delete process.env.TOKEN_PULSE_HOME_DIR
        delete process.env.TOKEN_PULSE_ORCA_DATA_DIR
      }
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})
