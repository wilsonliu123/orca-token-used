import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, describe, hostError, mockHost, mountWorker, test } from 'orca/testing'
import {
  buildDashboardSnapshot,
  compute60sIoSeries,
  isSameOrChildWorktreePath,
  pollSingleLiveAgent,
  resolveSessionRunState,
  withoutDisabledLiveAgents
} from './aggregator'
import {
  cleanConversationTitle,
  type JournalIndex,
  normalizeConfiguredModelSlug
} from './journal'
import {
  computeCacheHitPercent,
  escapeHtml,
  formatProjectWorktreeLabel,
  renderDashboardShellHtml,
  renderIoWaveformSvg,
  renderLiveAgentDetailHtml,
  updateBgElapsedNodes
} from './panel/app'
import { assignSessionMascots, buildActiveRaceSquads } from './panel/race'
import {
  formatElapsedDuration,
  formatTokens,
  formatUsd,
  getMessages,
  resolveLocale
} from './panel/i18n'
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
import type { DashboardSnapshot, LocalQuotaUsageWindow, QuotaProviderSnapshot, QuotasSnapshot } from './protocol'
import { TranscriptScanner } from './scanner'
import * as workerModule from './worker'

function createTestJournalIndex(overrides: Partial<JournalIndex> = {}): JournalIndex {
  return {
    byNativeId: new Map(),
    accountHomes: new Map(),
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
        timestamp: '2026-11-11T06:10:01.100Z',
        type: 'event_msg',
        payload: { type: 'thread_settings_applied', thread_settings: { reasoning_effort: 'xhigh' } }
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
    assert.equal(st.parentSessionId, 'root-1')
    assert.deepEqual(st.reasoningLevels, ['XHigh'])
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

  test('Claude sidechain transcripts preserve parent message linkage', () => {
    const st = createEmptySessionState('claude-sidechain', 'claude', '/tmp/claude-sidechain.jsonl')
    applyClaudeLines(st, [
      JSON.stringify({
        uuid: 'child-message-1',
        parentUuid: 'parent-message-1',
        isSidechain: true,
        timestamp: '2026-11-11T06:20:00.000Z',
        cwd: '/Users/dev/project-alpha',
        type: 'user',
        message: { content: 'Inspect the child task' }
      })
    ])
    assert.equal(st.isSubagent, true)
    assert.equal(st.parentMessageUuid, 'parent-message-1')
    assert.deepEqual(st.messageUuids, ['child-message-1'])
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
    assert.equal(resolveLocale('cs'), 'cs')
    assert.equal(resolveLocale('cs-CZ'), 'cs')
    assert.equal(getMessages('cs-CZ').tabs.day, 'Dnes')
    assert.equal(resolveLocale('en-US'), 'en')

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
    sNewerA.reasoningLevels = ['XHigh']
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
    sSubagentA.parentSessionId = 's-newer-a'
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
            provider: 'claude',
            title: '舊的對話標題',
            workspacePath: '/Users/dev/orca-token-used',
            model: 'claude-fable-5',
            updatedAt: now - 1800_000
          }
        ],
        [
          's-newer-a',
          {
            provider: 'codex',
            title: null,
            workspacePath: '/Users/dev/orca-token-used',
            model: 'gpt-6.1-terra',
            updatedAt: now - 10_000
          }
        ],
        [
          's-pulse-b',
          {
            provider: 'antigravity',
            title: 'PulseBoard UI redesign',
            workspacePath: '/Users/dev/PulseBoard',
            model: 'gemini-4-carbon',
            updatedAt: now - 5_000
          }
        ],
        [
          's-ag-light',
          {
            provider: 'antigravity',
            title: 'PulseBoard quick fix',
            workspacePath: '/Users/dev/PulseBoard',
            model: 'gemini-4-argon',
            updatedAt: now - 4_000
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
    assert.equal(navBtnMatches.length, 4)
    const navTabs = navBtnMatches.map((m) => m[0].match(/data-tab="([^"]+)"/)?.[1])
    assert.deepEqual(navTabs, ['live', 'sessions', 'day', 'quotas'])
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

    // Only recent reported usage contributes to live rates, even if the terminal stays working.
    assert.equal(ioSpiky.liveOutRate, 0)
    assert.equal(ioSpiky.liveInRate, 0)
    const sampleTime = sNewerA.updatedAtMs
    const ioActive = compute60sIoSeries(sNewerA.turnsByKey.values(), true, sampleTime)
    assert.equal(ioActive.liveOutRate, 100)
    assert.equal(ioActive.liveInRate, 700)
    const ioBetweenReports = compute60sIoSeries(sNewerA.turnsByKey.values(), true, sampleTime + 4000)
    assert.equal(ioBetweenReports.liveOutRate, 50)
    assert.equal(ioBetweenReports.liveInRate, 350)
    const ioStopped = compute60sIoSeries(sNewerA.turnsByKey.values(), false, sampleTime)
    assert.equal(ioStopped.liveOutRate, 0)
    assert.equal(ioStopped.liveInRate, 0)

    // A completed transcript stays done when public history still contains the session.
    // MUST display `done` (NOT `waiting`)
    const pulseLiveCard = snapA.live.agents.find((a) => a.sessionKey === 'antigravity:s-pulse-b')
    assert.ok(pulseLiveCard)
    assert.equal(pulseLiveCard.state, 'done')
    assert.equal(pulseLiveCard.tps.liveTps, 0)
    assert.equal(snapA.live.tps.liveTps, snapA.live.agents.reduce((sum, a) => sum + a.liveOutRate, 0))

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
    assert.ok(htmlExpandedLive.includes('data-io-text="out-rate">0 tok/s'))
    assert.ok(htmlExpandedLive.includes('Avg <span data-io-text="avg">100 tok/s'))
    assert.ok(htmlExpandedLive.includes('tp-io-monitor'))
    assert.ok(!htmlExpandedLive.includes('tp-io-live-dot'))
    assert.ok(htmlExpandedLive.includes('data-io-path="out-stroke"'))
    assert.ok(htmlExpandedLive.includes('data-io-path="in-stroke"'))
    assert.ok(htmlExpandedLive.includes('OpenAI · gpt-6.1-terra'))
    const htmlLiveOverview = renderDashboardShellHtml({
      snap: snapA,
      tab: 'live',
      scope: 'worktree',
      locale: 'en',
      nowMs: now
    })
    assert.ok(htmlLiveOverview.includes('class="tp-session-avg">Avg 100 tok/s'))
    assert.ok(htmlLiveOverview.includes('0 tok/s<span class="tp-expand-chevron"'))
    assert.ok(htmlLiveOverview.includes(getMessages('en').liveCostLabel))
    assert.ok(htmlLiveOverview.includes(getMessages('en').todayCostLabel))
    assert.ok(htmlLiveOverview.includes('tp-subagent-children'))
    assert.ok(!htmlLiveOverview.includes('live:subagents'))
    assert.ok(htmlLiveOverview.includes('tp-reasoning-chip'))
    assert.ok(htmlLiveOverview.includes('XHigh'))
    assert.ok(htmlLiveOverview.includes(formatUsd(snapA.periods.all.day.tokens.costUsd)))
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
            terminalId: 'term-skills',
            sessionId: '6cf4f801-cli',
            workspacePath: '/Users/dev/ai-engineering-workflow-skills',
            title: '# 优化 skills',
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
      createTestJournalIndex(),
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
            sessionId: '808ad2e0-live',
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
  test('uses the public focused workspace ID across same-named branches and background agent events', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-worker-home-'))
    try {
      const orcaDir = path.join(tmpHome, 'orca-data')
      const agBrainDir = path.join(
        orcaDir,
        'antigravity-chat',
        'antigravity-acp',
        'brain',
        'conv-1',
        '.system_generated',
        'logs'
      )
      fs.mkdirSync(agBrainDir, { recursive: true })
      let workspaceId = 'workspace-pulse'
      const readContext = () => ({
        workspaceId,
        branch: 'refs/heads/main',
        displayName: 'main',
        terminals: []
      })

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
                id: 'workspace-orca',
                kind: 'worktree',
                name: 'main',
                project: 'orca-token-used',
                path: '/Users/wilsonliu/orca/orca-token-used',
                branch: 'refs/heads/main',
                hostId: 'local',
                status: { state: 'working', unread: false, terminalCount: 0, lastActivityAt: Date.now() }
              },
              {
                id: 'workspace-pulse',
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
          'workspace.readContext': readContext,
          'agents.list': ({ workspaceId }: { workspaceId?: string }) => ({
            agents: workspaceId === 'workspace-orca' ? [{
              terminalId: null,
              sessionId: 'conv-1',
              agent: 'antigravity',
              title: 'Background native chat',
              state: 'working',
              stateStartedAt: Date.now()
            }] : []
          }),
          'agent.listSessions': () => ({ sessions: [], truncated: false }),
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
        const nativeChat = snapPulse.live.agents.find((card) => card.sessionKey === 'antigravity:conv-1')
        assert.equal(nativeChat?.title, 'Background native chat')
        assert.equal(nativeChat?.workspacePath, '/Users/wilsonliu/orca/orca-token-used')
        assert.equal(nativeChat?.terminalId, null)
        assert.equal(nativeChat?.tokens.total, 1200)

        // 2) Even if a background agent emits `agent.status.changed` in `orca-token-used / main`,
        //    left-sidebar focus on `PulseBoard / main` MUST NOT be hijacked!
        await worker.emit('agent.status.changed', {
          workspaceId: 'workspace-orca',
          paneKey: 'pane-bg',
          terminalId: 'term-bg',
          state: 'working',
          title: 'Background Agent',
          receivedAt: Date.now()
        })
        const snapStillPulse = await worker.request('dashboard.get', { forceScan: false })
        assert.equal(snapStillPulse.workspace.project, 'PulseBoard')

        // 3) User clicks `orca-token-used -> main` in Orca's left navigation sidebar!
        workspaceId = 'workspace-orca'
        await worker.emit('workspace.changed', { context: readContext() })

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

function writeTestAntigravitySummariesDb(
  dbPath: string,
  rows: Array<{
    conversation_id: string
    title: string
    workspace_uris: string
    last_modified_time: string
    parent_conversation_id?: string
    nesting_depth?: number
  }>,
  parentLinks: Array<{ conversation_id: string; parent_conversation_id: string }> = []
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = openWritableTestSqlite(dbPath)
  try {
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
        r.workspace_uris,
        r.last_modified_time,
        r.parent_conversation_id ?? '',
        r.nesting_depth ?? 0
      )
    }
    if (parentLinks.length > 0) {
      db.exec(
        'CREATE TABLE IF NOT EXISTS conversation_parents (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT NOT NULL)'
      )
      const pStmt = db.prepare(
        'INSERT OR REPLACE INTO conversation_parents (conversation_id, parent_conversation_id) VALUES (?, ?)'
      )
      for (const link of parentLinks) {
        pStmt.run(link.conversation_id, link.parent_conversation_id)
      }
    }
  } finally {
    db.close()
  }
}

describe('Terminal Tab & Handoff Title Synchronization Regressions', () => {
  test('resolves Antigravity CLI cwd from conversation_summaries.db and history.jsonl, merging #54 terminal tab into a single worktree card and filtering subagents', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-ag-term-54-'))
    try {
      const homeDir = path.join(tmpRoot, 'home')
      const orcaDir = path.join(tmpRoot, 'orca')
      const wtPath = path.join(tmpRoot, 'workspaces', 'qbibotlive', 'release-1.0')
      const otherRoot = path.join(tmpRoot, 'workspaces', 'unrelated-root')
      fs.mkdirSync(wtPath, { recursive: true })
      fs.mkdirSync(otherRoot, { recursive: true })

      const wtId = 'workspace-release'
      const ptyId = 'term-54'
      const now = Date.UTC(2026, 10, 13, 1, 30, 0)

      // Authoritative summary in antigravity-cli + newer blank title in antigravity (must merge non-destructively)
      const wtUri = `file://${wtPath}`
      const otherUri = `file://${otherRoot}`
      writeTestAntigravitySummariesDb(
        path.join(homeDir, '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
        [
          {
            conversation_id: '228134bd-main',
            title: 'Issue #54 需求與問題釐清',
            workspace_uris: JSON.stringify([otherUri, wtUri]),
            last_modified_time: new Date(now - 30_000).toISOString(),
            parent_conversation_id: '',
            nesting_depth: 0
          },
          {
            conversation_id: 'sub-brain-99',
            title: 'Codebase Subagent Audit',
            workspace_uris: JSON.stringify([wtUri]),
            last_modified_time: new Date(now - 20_000).toISOString(),
            parent_conversation_id: '228134bd-main',
            nesting_depth: 1
          }
        ]
      )
      writeTestAntigravitySummariesDb(
        path.join(homeDir, '.gemini', 'antigravity', 'conversation_summaries.db'),
        [
          {
            conversation_id: '228134bd-main',
            title: '',
            workspace_uris: '[]',
            last_modified_time: new Date(now - 5_000).toISOString(),
            parent_conversation_id: '',
            nesting_depth: 0
          }
        ]
      )

      // History tail entry for a brand-new turn-1 conversation before conversation_summaries.db flushes
      const agCliDir = path.join(homeDir, '.gemini', 'antigravity-cli')
      fs.writeFileSync(
        path.join(agCliDir, 'history.jsonl'),
        `${JSON.stringify({
          timestamp: now - 8_000,
          workspace: wtPath,
          display: '請幫我檢查 release-1.0 設定'
        })}\n`,
        'utf8'
      )

      const writeAgTranscript = (
        convId: string,
        prompt: string,
        createdMs: number,
        inTok: number,
        outTok: number
      ) => {
        const logDir = path.join(agCliDir, 'brain', convId, '.system_generated', 'logs')
        fs.mkdirSync(logDir, { recursive: true })
        const p = path.join(logDir, 'transcript.jsonl')
        fs.writeFileSync(
          p,
          [
            JSON.stringify({
              step_index: 0,
              type: 'USER_INPUT',
              created_at: new Date(createdMs).toISOString(),
              content: `<USER_REQUEST>${prompt}</USER_REQUEST>`
            }),
            JSON.stringify({
              step_index: 1,
              type: 'PLANNER_RESPONSE',
              status: 'IN_PROGRESS',
              created_at: new Date(createdMs + 3_000).toISOString(),
              model: 'gemini-4-carbon',
              input_tokens: inTok,
              output_tokens: outTok,
              cache_read_tokens: 1000
            })
          ].join('\n') + '\n',
          'utf8'
        )
        const mtimeSec = (createdMs + 4_000) / 1000
        fs.utimesSync(p, mtimeSec, mtimeSec)
      }

      writeAgTranscript(
        '228134bd-main',
        '请你看一下issue #54 我沒有看懂他講的是什麼意思。需求是什麼？',
        now - 60_000,
        4000,
        500
      )
      writeAgTranscript('sub-brain-99', 'Audit child task', now - 40_000, 2000, 300)
      writeAgTranscript('turn1-history-only', '請幫我檢查 release-1.0 設定', now - 7_500, 1000, 100)

      const scanner = new TranscriptScanner({ homeDir, orcaAppDirs: [orcaDir] })
      scanner.setKnownWorkspacePaths([wtPath])
      const sessions = scanner.scan({ forceFullDiscovery: true, now })
      const journal = scanner.getJournalIndex()

      const snap = buildDashboardSnapshot(
        sessions,
        journal,
        new PricingEngine(),
        {
          focusedId: wtId,
          focusedProject: 'qbibotlive',
          focusedName: 'release-1.0',
          focusedBranch: 'release-1.0',
          focusedPath: wtPath,
          knownWorkspaces: [
            {
              id: wtId,
              project: 'qbibotlive',
              name: 'release-1.0',
              path: wtPath,
              branch: 'refs/heads/release-1.0'
            }
          ],
          liveAgents: [
            {
              terminalId: ptyId,
              sessionId: '228134bd-main',
              workspacePath: wtPath,
              title: '#54',
              agent: 'antigravity',
              state: 'working',
              stateStartedAt: now - 10_000
            }
          ]
        },
        now
      )

      // Must NOT split into an unbound `Terminal 1` (0 tok) card + `local` card!
      assert.ok(
        !snap.live.agents.some((a) => a.title === 'Terminal 1' && a.tokens.total === 0),
        'Active terminal PTY must bind to #54 Antigravity CLI transcript without leaving a 0-tok phantom card'
      )
      const card54 = snap.live.agents.find((a) => a.sessionKey === 'antigravity:228134bd-main')
      assert.ok(card54, 'Expected #54 session card in Live Monitor')
      assert.equal(card54.title, '#54')
      assert.equal(card54.projectName, 'qbibotlive')
      assert.equal(card54.workspaceName, 'release-1.0')
      assert.equal(card54.tokens.total, 5500)

      // Subagent stays out of the primary session list but renders under its parent and counts in worktree totals
      assert.ok(!snap.sessions.some((s) => s.sessionId === 'sub-brain-99'))
      assert.ok(!snap.live.agents.some((a) => a.sessionKey.includes('sub-brain-99')))
      const subagentCard = snap.live.subagents.find((a) => a.sessionKey.includes('sub-brain-99'))
      assert.ok(subagentCard, 'Expected subagent in the Live snapshot')
      assert.equal(subagentCard.parentSessionKey, 'antigravity:228134bd-main')
      assert.equal(subagentCard.tokens.total, 3300)
      assert.equal(snap.periods.worktree.day.tokens.total, 5500 + 3300 + 2100)

      // Turn-1 session without summary DB row resolves worktree via history.jsonl
      const turn1Row = snap.sessions.find((s) => s.sessionId === 'turn1-history-only')
      assert.ok(turn1Row, 'Expected turn-1 history-matched session in focused worktree sessions')
      assert.equal(turn1Row.workspaceName, 'release-1.0')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('synchronizes Chat UI -> Terminal handoff generatedTitle, filters boilerplate handoff generatedTitle, and updates on customTitle rename', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-handoff-title-'))
    try {
      const wtA = path.join(tmpRoot, 'ws', 'proj-a')
      const wtB = path.join(tmpRoot, 'ws', 'proj-b')
      const ptyA = 'term-handoff-a'
      const ptyB = 'term-handoff-b'
      const now = Date.UTC(2026, 10, 13, 1, 35, 0)

      const sHandoffA = createEmptySessionState('handoff-a', 'antigravity', '/tmp/handoff-a.jsonl')
      sHandoffA.cwd = wtA
      applyAntigravityLines(sHandoffA, [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: new Date(now - 85_000).toISOString(),
          content:
            'Continue work from the prior Orca session.\nSession: #debug 2\n\nNew instructions: redesign chart'
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'IN_PROGRESS',
          created_at: new Date(now - 10_000).toISOString(),
          model: 'gemini-4-carbon',
          input_tokens: 1200,
          output_tokens: 300
        })
      ])

      const sHandoffB = createEmptySessionState('handoff-b', 'claude', '/tmp/handoff-b.jsonl')
      sHandoffB.cwd = wtB
      applyClaudeLines(sHandoffB, [
        JSON.stringify({
          type: 'user',
          timestamp: new Date(now - 80_000).toISOString(),
          cwd: wtB,
          message: {
            content:
              'Continue work from the prior Orca session.\nSession: 真實交接摘要標題\n\nPlease finish tests.'
          }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(now - 8_000).toISOString(),
          message: {
            id: 'msg-b1',
            model: 'claude-sonnet-4-6',
            stop_reason: 'tool_use',
            usage: { input_tokens: 800, output_tokens: 200 }
          }
        })
      ])

      const journal1 = createTestJournalIndex()
      const snap1 = buildDashboardSnapshot(
        [sHandoffA, sHandoffB],
        journal1,
        new PricingEngine(),
        {
          focusedName: null,
          focusedBranch: null,
          focusedPath: null,
          liveAgents: [
            {
              terminalId: ptyA,
              sessionId: 'handoff-a',
              workspacePath: wtA,
              title: 'Token 流速圖表 UI/UX 重新設計',
              agent: 'antigravity',
              state: 'working',
              stateStartedAt: now - 10_000
            },
            {
              terminalId: ptyB,
              sessionId: 'handoff-b',
              workspacePath: wtB,
              title: 'Continue work from the prior Orca',
              agent: 'claude',
              state: 'working',
              stateStartedAt: now - 8_000
            }
          ]
        },
        now
      )

      const cardA1 = snap1.live.agents.find((a) => a.sessionKey === 'antigravity:handoff-a')
      const cardB1 = snap1.live.agents.find((a) => a.sessionKey === 'claude:handoff-b')
      assert.equal(cardA1?.title, 'Token 流速圖表 UI/UX 重新設計')
      assert.equal(
        cardB1?.title,
        '真實交接摘要標題',
        'Boilerplate "Continue work from the prior Orca" generatedTitle must fall through to real session summary'
      )

      // User renames Tab A to `# handoff-fix` -> customTitle supersedes generatedTitle
      const journal2 = createTestJournalIndex()
      const snap2 = buildDashboardSnapshot(
        [sHandoffA, sHandoffB],
        journal2,
        new PricingEngine(),
        {
          focusedName: null,
          focusedBranch: null,
          focusedPath: null,
          liveAgents: [
            {
              terminalId: ptyA,
              sessionId: 'handoff-a',
              workspacePath: wtA,
              title: '# handoff-fix',
              agent: 'antigravity',
              state: 'working',
              stateStartedAt: now - 10_000
            }
          ]
        },
        now
      )
      const cardA2 = snap2.live.agents.find((a) => a.sessionKey === 'antigravity:handoff-a')
      assert.equal(cardA2?.title, '# handoff-fix')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('keeps the public terminal label before usage, then resolves terminal-key polls to the exact session', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-plain-term-'))
    try {
      const wtPath = path.join(tmpRoot, 'ws', 'plain-repo')
      const wtId = 'plain-workspace'
      const ptyId = 'term-plain'
      const now = Date.UTC(2026, 10, 13, 1, 40, 0)
      const journal = createTestJournalIndex()
      const runtime = {
        focusedId: wtId,
        focusedProject: 'plain-repo',
        focusedName: 'main',
        focusedBranch: 'main',
        focusedPath: wtPath,
        liveAgents: [
          {
            terminalId: ptyId,
            workspacePath: wtPath,
            title: 'Terminal 1',
            agent: 'antigravity',
            state: 'working' as const,
            stateStartedAt: now - 5_000
          }
        ]
      }

      // 0-tok state before any conversation turn exists
      const snap0 = buildDashboardSnapshot([], journal, new PricingEngine(), runtime, now)
      assert.equal(snap0.live.agents.length, 1)
      assert.equal(snap0.live.agents[0].title, 'Terminal 1')
      assert.equal(snap0.live.agents[0].sessionKey, `terminal:${ptyId}`)

      // First turn arrives -> transitions from "Terminal 1" to conversation summary, and terminal:<ptyId> livePoll still resolves it
      const sTurn1 = createEmptySessionState('plain-conv-1', 'antigravity', '/tmp/plain-conv-1.jsonl')
      sTurn1.cwd = wtPath
      sTurn1.titleHint = '修正 Terminal 標題同步問題'
      sTurn1.createdAtMs = now - 25_000
      sTurn1.updatedAtMs = now - 2_000
      sTurn1.lastMtimeMs = now - 2_000
      sTurn1.lastEventState = 'working'
      sTurn1.turnsByKey.set('t1', {
        turnKey: 't1',
        timestampMs: now - 2_000,
        input: 900,
        output: 180,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 1080,
        durationSec: 3,
        tps: 60,
        model: 'gemini-4-carbon',
        explicitCostUsd: null
      })

      const linkedRuntime = {
        ...runtime,
        liveAgents: [{ ...runtime.liveAgents[0], sessionId: 'plain-conv-1' }]
      }
      const snap1 = buildDashboardSnapshot([sTurn1], journal, new PricingEngine(), linkedRuntime, now)
      assert.equal(snap1.live.agents.length, 1)
      assert.equal(snap1.live.agents[0].title, '修正 Terminal 標題同步問題')

      const polledViaTerminalKey = pollSingleLiveAgent(
        `terminal:${ptyId}`,
        [sTurn1],
        journal,
        new PricingEngine(),
        linkedRuntime,
        now
      )
      assert.ok(polledViaTerminalKey, 'pollSingleLiveAgent must seamlessly transition terminal:<ptyId> key')
      assert.equal(polledViaTerminalKey.sessionKey, 'antigravity:plain-conv-1')
      assert.equal(polledViaTerminalKey.title, '修正 Terminal 標題同步問題')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('rebinds a reused terminal to its newly reported session ID', () => {
    const now = Date.now()
    const workspacePath = '/tmp/reused-terminal'
    const makeSession = (id: string, timestampMs: number, state: 'done' | 'working') => {
      const session = createEmptySessionState(id, 'antigravity', `/tmp/${id}.jsonl`)
      session.cwd = workspacePath
      session.titleHint = `Prompt for ${id}`
      session.updatedAtMs = timestampMs
      session.lastEventState = state
      session.turnsByKey.set('usage', {
        turnKey: 'usage', timestampMs, input: 50, output: 20, reasoning: 0, cacheRead: 0,
        cacheWrite: 0, total: 70, durationSec: 2, tps: 10,
        model: 'gemini-4-carbon', explicitCostUsd: null
      })
      return session
    }
    const oldSession = makeSession('old-session', now - 10_000, 'done')
    const nextSession = makeSession('next-session', now - 5_000, 'working')
    const snap = buildDashboardSnapshot(
      [oldSession, nextSession],
      createTestJournalIndex(),
      new PricingEngine(),
      {
        focusedPath: workspacePath, focusedBranch: 'main', focusedName: 'main',
        liveAgents: [{
          terminalId: 'term-reused', sessionId: 'next-session', workspacePath, title: '# My tab',
          agent: 'antigravity', state: 'working', stateStartedAt: now - 5_000
        }]
      },
      now
    )
    const oldCard = snap.live.agents.find((card) => card.sessionKey === 'antigravity:old-session')
    const nextCard = snap.live.agents.find((card) => card.sessionKey === 'antigravity:next-session')
    assert.equal(oldCard?.title, 'Prompt for old-session')
    assert.equal(oldCard?.terminalId, null)
    assert.equal(nextCard?.title, '# My tab')
    assert.equal(nextCard?.terminalId, 'term-reused')
  })

  test('hydrates late conversation_summaries.db flush on unchanged transcript during pollHotFiles and distinguishes Claude /rename cliCustomTitle', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-late-flush-'))
    try {
      const homeDir = path.join(tmpRoot, 'home')
      const orcaDir = path.join(tmpRoot, 'orca')
      const wtPath = path.join(tmpRoot, 'ws', 'late-repo')
      fs.mkdirSync(wtPath, { recursive: true })
      const now = Date.UTC(2026, 10, 13, 1, 50, 0)

      const logDir = path.join(
        homeDir,
        '.gemini',
        'antigravity-cli',
        'brain',
        'late-conv',
        '.system_generated',
        'logs'
      )
      fs.mkdirSync(logDir, { recursive: true })
      const transcriptPath = path.join(logDir, 'transcript.jsonl')
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            step_index: 0,
            type: 'USER_INPUT',
            created_at: new Date(now - 10_000).toISOString(),
            content: '<USER_REQUEST>Initial prompt before DB flush</USER_REQUEST>'
          }),
          JSON.stringify({
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            status: 'IN_PROGRESS',
            created_at: new Date(now - 5_000).toISOString(),
            model: 'gemini-4-carbon',
            input_tokens: 600,
            output_tokens: 120
          })
        ].join('\n') + '\n',
        'utf8'
      )

      const scanner = new TranscriptScanner({ homeDir, orcaAppDirs: [orcaDir] })
      const initial = scanner.scan({ forceFullDiscovery: true, now })
      assert.equal(initial.length, 1)
      assert.equal(initial[0].cwd, null)

      // Now conversation_summaries.db flushes WITHOUT any new bytes written to transcript.jsonl!
      writeTestAntigravitySummariesDb(
        path.join(homeDir, '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
        [
          {
            conversation_id: 'late-conv',
            title: 'Late Flushed Summary',
            workspace_uris: JSON.stringify([`file://${wtPath}`]),
            last_modified_time: new Date(now - 1_000).toISOString()
          }
        ]
      )

      scanner.refreshJournal(now + 1_000, 0)
      const afterHotPoll = scanner.pollHotFiles(now + 1_000, 'antigravity:late-conv')
      assert.equal(afterHotPoll[0].cwd, wtPath)

      // Verify Claude /rename cliCustomTitle beats stale journal title when no terminal tab override exists
      const sClaude = createEmptySessionState('claude-renamed', 'claude', '/tmp/claude-renamed.jsonl')
      applyClaudeLines(sClaude, [
        JSON.stringify({
          type: 'user',
          timestamp: new Date(now - 20_000).toISOString(),
          cwd: wtPath,
          customTitle: '/rename 後的新名稱',
          message: { content: 'Old prompt text' }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(now - 15_000).toISOString(),
          message: {
            id: 'm1',
            model: 'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            usage: { input_tokens: 500, output_tokens: 100 }
          }
        })
      ])

      const snapClaude = buildDashboardSnapshot(
        [sClaude],
        createTestJournalIndex({
          byNativeId: new Map([
            [
              'claude-renamed',
              {
                provider: 'claude',
                title: '舊的 Journal 標題',
                workspacePath: wtPath,
                model: 'claude-sonnet-4-6',
                updatedAt: now - 20_000
              }
            ]
          ])
        }),
        new PricingEngine(),
        { focusedName: 'late-repo', focusedBranch: 'main', focusedPath: wtPath, liveAgents: [] },
        now
      )
      assert.equal(snapClaude.sessions[0]?.title, '/rename 後的新名稱')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('refreshes terminal tab rename from the public workspace.changed event and preserves live agent workspacePath across short terminalIds', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-worker-rename-'))
    try {
      const orcaDir = path.join(tmpHome, 'orca-data')
      const wtPath = path.join(tmpHome, 'workspaces', 'token-pulse-repo')
      const otherWtPath = path.join(tmpHome, 'workspaces', 'other-repo')
      fs.mkdirSync(wtPath, { recursive: true })
      fs.mkdirSync(otherWtPath, { recursive: true })
      const wtId = 'worktree-rename'
      const shortTabId = 'term-renamed'
      const now = Date.now()
      let title = '# initial-tab'
      const readContext = () => ({
        workspaceId: wtId,
        branch: 'refs/heads/main',
        displayName: 'main',
        terminals: [{ id: shortTabId, title }]
      })

      writeTestAntigravitySummariesDb(
        path.join(tmpHome, '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
        [
          {
            conversation_id: 'live-rename-conv',
            title: 'Summary Fallback',
            workspace_uris: JSON.stringify([`file://${wtPath}`]),
            last_modified_time: new Date(now - 5_000).toISOString()
          },
          {
            conversation_id: 'other-newer-conv',
            title: 'Other Repo Task',
            workspace_uris: JSON.stringify([`file://${otherWtPath}`]),
            last_modified_time: new Date(now - 1_000).toISOString()
          }
        ]
      )
      const writeConv = (id: string, createdOffsetMs: number) => {
        const logDir = path.join(
          tmpHome,
          '.gemini',
          'antigravity-cli',
          'brain',
          id,
          '.system_generated',
          'logs'
        )
        fs.mkdirSync(logDir, { recursive: true })
        fs.writeFileSync(
          path.join(logDir, 'transcript.jsonl'),
          [
            JSON.stringify({
              step_index: 0,
              type: 'USER_INPUT',
              created_at: new Date(now - 20_000).toISOString(),
              content: `<USER_REQUEST>Task ${id}</USER_REQUEST>`
            }),
            JSON.stringify({
              step_index: 1,
              type: 'PLANNER_RESPONSE',
              status: 'IN_PROGRESS',
              created_at: new Date(now - createdOffsetMs).toISOString(),
              model: 'gemini-4-carbon',
              input_tokens: 1000,
              output_tokens: 250
            })
          ].join('\n') + '\n',
          'utf8'
        )
      }
      writeConv('live-rename-conv', 4_000)
      writeConv('other-newer-conv', 1_000)

      process.env.TOKEN_PULSE_HOME_DIR = tmpHome
      process.env.TOKEN_PULSE_ORCA_DATA_DIR = orcaDir

      const host = mockHost({
        settings: { pricingSyncHours: 6, livePollSeconds: 10 },
        results: {
          'workspace.list': () => ({
            workspaces: [
              {
                id: wtId,
                kind: 'worktree',
                name: 'main',
                project: 'token-pulse-repo',
                path: wtPath,
                branch: 'refs/heads/main',
                hostId: 'local'
              }
            ],
            truncated: false
          }),
          'workspace.readContext': readContext,
          'agents.list': () => ({
            agents: [
              {
                terminalId: shortTabId,
                sessionId: 'live-rename-conv',
                title: 'agy',
                agent: 'antigravity',
                state: 'working',
                stateStartedAt: now - 3_000
              }
            ]
          }),
          'agent.listSessions': () => ({ sessions: [], truncated: false }),
          'statusBar.update': () => ({ ok: true })
        }
      })

      const worker = await mountWorker(workerModule, { host })
      try {
        await worker.emit('agent.status.changed', {
          workspaceId: wtId,
          paneKey: 'pane-1',
          terminalId: shortTabId,
          sessionId: 'live-rename-conv',
          state: 'working',
          title: 'agy',
          receivedAt: Date.now()
        })

        const snapBefore = await worker.request('dashboard.get', { forceScan: true })
        const cardBefore = snapBefore.live.agents.find(
          (a) => a.sessionKey === 'antigravity:live-rename-conv'
        )
        assert.equal(cardBefore?.title, '# initial-tab')
        assert.equal(cardBefore?.workspaceName, 'main')

        const postsBefore = worker.posts.length
        title = '# renamed-live'
        await worker.emit('workspace.changed', { context: readContext() })

        // Must have pushed a `dashboard.updated` event automatically without requiring a panel RPC
        const pushedSnapshots = worker.posts
          .slice(postsBefore)
          .filter((p) => p.event === 'dashboard.updated')
          .map((p) => p.payload as import('./protocol').DashboardSnapshot)
        const latestPushedCard = pushedSnapshots[pushedSnapshots.length - 1]?.live.agents.find(
          (a) => a.sessionKey === 'antigravity:live-rename-conv'
        )
        assert.equal(latestPushedCard?.title, '# renamed-live')

        const pollAfter = await worker.request('agent.livePoll', {
          sessionKey: 'antigravity:live-rename-conv'
        })
        assert.equal(pollAfter.agent?.title, '# renamed-live')
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

  test('publish-plugin.sh dirty-worktree allowlist accepts *-plan.md without staging plan files into release commits', () => {
    const scriptPath = path.resolve(import.meta.dirname, '..', 'scripts', 'publish-plugin.sh')
    const scriptText = fs.readFileSync(scriptPath, 'utf8')
    const caseBlockMatch = scriptText.match(
      /while IFS= read -r line; do[\s\S]*?done < <\(git status --porcelain\)/
    )
    assert.ok(caseBlockMatch, 'Expected git status --porcelain guard loop in publish-plugin.sh')
    const loopBody = caseBlockMatch[0].replace(
      'done < <(git status --porcelain)',
      'done <<< "$MOCK_PORCELAIN"'
    )

    // Positive check: *-plan.md and src/* pass cleanly
    execFileSync('bash', ['-euo', 'pipefail', '-c', loopBody], {
      env: {
        ...process.env,
        MOCK_PORCELAIN: '?? terminal-tab-title-sync-plan.md\n M src/journal.ts'
      }
    })

    // Negative control: unexpected file fails closed with exit code 1
    assert.throws(() => {
      execFileSync('bash', ['-euo', 'pipefail', '-c', loopBody], {
        env: { ...process.env, MOCK_PORCELAIN: '?? unexpected-scratch.tmp' },
        stdio: 'pipe'
      })
    })

    // Ensure release staging `git add` never stages arbitrary *-plan.md files
    const gitAddLine = scriptText
      .split('\n')
      .find((line) => line.trim().startsWith('git add -A --'))
    assert.ok(gitAddLine, 'Expected git add release line in publish-plugin.sh')
    assert.ok(!gitAddLine.includes('*-plan.md'))
  })

  test('binds and focuses parallel terminals using public session IDs', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-term-crossbind-'))
    try {
      const homeDir = path.join(tmpRoot, 'home')
      const orcaDir = path.join(tmpRoot, 'orca')
      const wtPath = path.join(tmpRoot, 'ws', 'test-app')
      fs.mkdirSync(wtPath, { recursive: true })
      const wtId = 'workspace-parallel'
      const now = Date.now()
      const termHandleUi = 'term-ui'
      const termHandleVoice = 'term-voice'
      writeTestAntigravitySummariesDb(
        path.join(homeDir, '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
        [
          {
            conversation_id: 'sess-ui',
            title: 'Optimize UI rendering',
            workspace_uris: JSON.stringify([`file://${wtPath}`]),
            last_modified_time: new Date(now - 8_000).toISOString()
          },
          {
            conversation_id: 'sess-voice',
            title: 'Implement voice names',
            workspace_uris: JSON.stringify([`file://${wtPath}`]),
            last_modified_time: new Date(now - 4_000).toISOString()
          }
        ]
      )

      const writeConv = (id: string, startOffsetMs: number, updatedOffsetMs: number) => {
        const logDir = path.join(
          homeDir,
          '.gemini',
          'antigravity-cli',
          'brain',
          id,
          '.system_generated',
          'logs'
        )
        fs.mkdirSync(logDir, { recursive: true })
        fs.writeFileSync(
          path.join(logDir, 'transcript.jsonl'),
          [
            JSON.stringify({
              step_index: 0,
              type: 'USER_INPUT',
              created_at: new Date(now - startOffsetMs).toISOString(),
              content: `<USER_REQUEST>Task ${id}</USER_REQUEST>`
            }),
            JSON.stringify({
              step_index: 1,
              type: 'PLANNER_RESPONSE',
              status: 'IN_PROGRESS',
              created_at: new Date(now - updatedOffsetMs).toISOString(),
              model: 'gemini-3-pro',
              input_tokens: 1000,
              output_tokens: 250
            })
          ].join('\n') + '\n',
          'utf8'
        )
      }
      writeConv('sess-ui', 110_000, 8_000)
      writeConv('sess-voice', 55_000, 4_000)

      process.env.TOKEN_PULSE_HOME_DIR = homeDir
      process.env.TOKEN_PULSE_ORCA_DATA_DIR = orcaDir

      const workerModule = await import('./worker')
      const host = mockHost({
        settings: { pricingSyncHours: 6, livePollSeconds: 10 },
        results: {
          'workspace.list': () => ({
            workspaces: [
              {
                id: wtId,
                kind: 'worktree',
                name: 'main',
                project: 'test-app',
                path: wtPath,
                branch: 'refs/heads/main',
                hostId: 'local'
              }
            ],
            truncated: false
          }),
          'workspace.readContext': () => ({
            workspaceId: wtId,
            branch: 'refs/heads/main',
            displayName: 'main',
            terminals: [
              { id: termHandleUi, title: '# ui opt' },
              { id: termHandleVoice, title: '#voice name' }
            ]
          }),
          'agents.list': () => ({
            agents: [
              {
                terminalId: termHandleUi,
                sessionId: 'sess-ui',
                title: 'agy',
                agent: 'antigravity',
                state: 'working',
                stateStartedAt: now - 8_000
              },
              {
                terminalId: termHandleVoice,
                sessionId: 'sess-voice',
                title: 'agy',
                agent: 'antigravity',
                state: 'working',
                stateStartedAt: now - 4_000
              }
            ]
          }),
          'terminal.focus': () => ({ focused: true }),
          'agent.listSessions': () => ({ sessions: [], truncated: false }),
          'statusBar.update': () => ({ ok: true })
        }
      })

      const worker = await mountWorker(workerModule, { host })
      try {
        const snapWorker = await worker.request('dashboard.get', { forceScan: true })
        assert.ok(snapWorker.live.agents.length >= 2)
        const wCardUi = snapWorker.live.agents.find((c) => c.title === '# ui opt')
        const wCardVoice = snapWorker.live.agents.find((c) => c.title === '#voice name')

        assert.ok(wCardUi, 'Worker dashboard must have # ui opt card')
        assert.ok(wCardVoice, 'Worker dashboard must have #voice name card')
        assert.equal(wCardUi?.terminalId, termHandleUi, 'Worker card # ui opt must have termHandleUi')
        assert.equal(wCardUi?.sessionKey, 'antigravity:sess-ui', 'Worker card # ui opt must have sessionKey sess-ui')
        assert.equal(wCardVoice?.terminalId, termHandleVoice, 'Worker card #voice name must have termHandleVoice')
        assert.equal(wCardVoice?.sessionKey, 'antigravity:sess-voice', 'Worker card #voice name must have sessionKey sess-voice')
        assert.deepEqual(await worker.request('session.focus', { terminalId: termHandleVoice }), { focused: true })
        assert.deepEqual(await worker.request('session.focus', { terminalId: 'unknown-terminal' }), { focused: false })
        assert.equal(host.callsOf('terminal.focus').length, 1)
        host.respond('terminal.focus', { focused: false })
        assert.deepEqual(await worker.request('session.focus', { terminalId: termHandleVoice }), { focused: false })
      } finally {
        await worker.deactivate()
      }
    } finally {
      delete process.env.TOKEN_PULSE_HOME_DIR
      delete process.env.TOKEN_PULSE_ORCA_DATA_DIR
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('elevates parent session state to waiting when any child subagent is working or waiting, reverting to done when subagents finish', () => {
    const now = Date.now()
    const wtPath = '/tmp/test-subagent-elevate'
    const parentId = 'parent-agent-sess'
    const childId = 'child-subagent-sess'

    // Parent session whose own transcript has ended on done
    const sParent = createEmptySessionState(parentId, 'codex', `/tmp/${parentId}.jsonl`)
    sParent.cwd = wtPath
    sParent.titleHint = 'Parent task'
    sParent.createdAtMs = now - 60_000
    sParent.updatedAtMs = now - 10_000
    sParent.lastMtimeMs = now - 10_000
    sParent.lastEventState = 'done'
    sParent.isSubagent = false
    sParent.turnsByKey.set('t1', {
      turnKey: 't1',
      timestampMs: now - 10_000,
      input: 500,
      output: 100,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 600,
      durationSec: 3,
      tps: 33,
      model: 'gpt-6.1-sol',
      explicitCostUsd: null
    })

    // Child subagent session linked to parentId that is currently working
    const sChild = createEmptySessionState(childId, 'codex', `/tmp/${childId}.jsonl`)
    sChild.cwd = wtPath
    sChild.titleHint = 'Child research'
    sChild.createdAtMs = now - 30_000
    sChild.updatedAtMs = now - 2_000
    sChild.lastMtimeMs = now - 2_000
    sChild.lastEventState = 'working'
    sChild.isSubagent = true
    sChild.parentSessionId = parentId
    sChild.turnsByKey.set('t1', {
      turnKey: 't1',
      timestampMs: now - 2_000,
      input: 200,
      output: 50,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 250,
      durationSec: 1,
      tps: 50,
      model: 'gpt-6.1-sol',
      explicitCostUsd: null
    })

    const emptyJournal = createTestJournalIndex()
    const pricing = new PricingEngine()
    const runtime = {
      focusedName: 'main',
      focusedBranch: 'main',
      focusedPath: wtPath,
      liveAgents: []
    }

    // Snap 1: Child is working -> parent card must be 'waiting', session item must have active = true
    const snap1 = buildDashboardSnapshot([sParent, sChild], emptyJournal, pricing, runtime, now)
    const pCard1 = snap1.live.agents.find((c) => c.sessionKey === `codex:${parentId}`)
    const pSess1 = snap1.sessions.find((s) => s.sessionId === parentId)

    assert.equal(snap1.live.tps.liveTps, 6.3) // 50 child tokens over the 8-second window
    assert.equal(pCard1?.liveOutRate, 0)
    assert.ok(pCard1, 'Parent card must be present in snap.live.agents')
    assert.equal(pCard1?.state, 'waiting', 'Parent card state must be elevated to waiting when child is working')
    assert.equal(pSess1?.active, true, 'Parent session item in sessions list must be active when child is working')

    // Snap 2: Child is waiting -> parent card must also be 'waiting'
    sChild.lastEventState = 'waiting'
    const snap2 = buildDashboardSnapshot([sParent, sChild], emptyJournal, pricing, runtime, now)
    const pCard2 = snap2.live.agents.find((c) => c.sessionKey === `codex:${parentId}`)
    assert.equal(pCard2?.state, 'waiting', 'Parent card state must remain waiting when child is waiting')

    // Snap 3: Child is done -> parent card reverts to 'done'
    sChild.lastEventState = 'done'
    const snap3 = buildDashboardSnapshot([sParent, sChild], emptyJournal, pricing, runtime, now)
    const pCard3 = snap3.live.agents.find((c) => c.sessionKey === `codex:${parentId}`)
    assert.equal(snap3.live.tps.liveTps, 0)
    assert.equal(pCard3?.state, 'done', 'Parent card state must revert to done when child finishes')
  })

  test('binds active terminal PTY to parent session whose turn finished >60s ago when child subagent is active, avoiding duplicate split cards', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-pty-subagent-split-'))
    try {
      const wtPath = path.join(tmpRoot, 'repo')
      fs.mkdirSync(wtPath, { recursive: true })

      const now = Date.now()
      const ptyId = 'term-parent'
      const parentId = 'parent-agent-sess'
      const childId = 'child-subagent-sess'

      // Parent session whose turn finished >60s ago (st.lastEventState === 'done', st.updatedAtMs = now - 90_000)
      const sParent = createEmptySessionState(parentId, 'antigravity', path.join(tmpRoot, `${parentId}.jsonl`))
      sParent.cwd = wtPath
      sParent.titleHint = 'Parent prompt task'
      sParent.createdAtMs = now - 120_000
      sParent.updatedAtMs = now - 90_000
      sParent.lastMtimeMs = now - 90_000
      sParent.lastEventState = 'done'
      sParent.isSubagent = false
      sParent.turnsByKey.set('t1', {
        turnKey: 't1',
        timestampMs: now - 90_000,
        input: 5000,
        output: 500,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 5500,
        durationSec: 4,
        tps: 125,
        model: 'gemini-3.8-flash-high',
        explicitCostUsd: null
      })

      // Active child subagent session (sChild.lastEventState === 'working')
      const sChild = createEmptySessionState(childId, 'antigravity', path.join(tmpRoot, `${childId}.jsonl`))
      sChild.cwd = wtPath
      sChild.titleHint = 'Child subagent worker'
      sChild.createdAtMs = now - 30_000
      sChild.updatedAtMs = now - 5_000
      sChild.lastMtimeMs = now - 5_000
      sChild.lastEventState = 'working'
      sChild.isSubagent = true
      sChild.parentSessionId = parentId
      sChild.turnsByKey.set('t1', {
        turnKey: 't1',
        timestampMs: now - 5_000,
        input: 1200,
        output: 300,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 1500,
        durationSec: 2,
        tps: 150,
        model: 'gemini-3.8-flash-high',
        explicitCostUsd: null
      })

      const emptyJournal = createTestJournalIndex()
      const pricing = new PricingEngine()
      const runtime = {
        focusedName: 'repo',
        focusedBranch: 'main',
        focusedPath: wtPath,
        liveAgents: [
          {
            terminalId: ptyId,
            sessionId: parentId,
            title: 'agy',
            agent: 'antigravity',
            state: 'working' as const,
            stateStartedAt: now - 20_000,
            workspacePath: wtPath
          }
        ]
      }

      const snap = buildDashboardSnapshot([sParent, sChild], emptyJournal, pricing, runtime, now)

      // Verify:
      // Exactly ONE card exists for the parent session (c.state === 'waiting').
      const parentCards = snap.live.agents.filter((c) => c.sessionKey === `antigravity:${parentId}`)
      assert.equal(parentCards.length, 1, 'Exactly ONE card exists for the parent session')
      assert.equal(parentCards[0].state, 'waiting', 'Parent card state must be waiting while child is working')

      // No duplicate or phantom zero-token PTY fallback card exists with c.state === 'working' and tokens.total === 0.
      const phantomCards = snap.live.agents.filter(
        (c) => c.state === 'working' && c.tokens.total === 0
      )
      assert.equal(phantomCards.length, 0, 'No duplicate or phantom zero-token PTY fallback card exists')

      // Exactly ONE card exists in live.agents overall
      assert.equal(snap.live.agents.length, 1, 'Exactly ONE card in snap.live.agents overall')

      // The card has c.terminalId === la.terminalId and correct model and token count.
      const card = snap.live.agents[0]
      assert.equal(card.terminalId, ptyId, 'Card must have c.terminalId === la.terminalId')
      assert.equal(card.modelLabel, 'gemini-3.8-flash-high', 'Card must have correct model label')
      assert.equal(card.tokens.total, 5500, 'Card must have correct token count')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('prefers fresh transcript activity over an older public done state, then stops on a fresh done event', () => {
    const now = Date.now()
    const st = createEmptySessionState('agy-resumed-1', 'antigravity', '/tmp/qbibotlive/optimization/transcript.jsonl')
    st.cwd = '/tmp/qbibotlive/optimization'
    st.lastEventState = 'working'
    st.updatedAtMs = now - 3_000
    st.lastMtimeMs = now - 3_000

    assert.equal(resolveSessionRunState(st, 'done', now, now - 10_000), 'working')
    assert.equal(resolveSessionRunState(st, 'done', now, now - 1_000), 'done')
  })
})

function emptyLocalWindow(overrides: Partial<LocalQuotaUsageWindow> = {}): LocalQuotaUsageWindow {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    turnCount: 0,
    sessionCount: 0,
    rateLimitHits: null,
    ...overrides
  }
}

function emptyPeriodSummary() {
  return {
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      costUsd: 0
    },
    tps: { liveTps: 0, avgTps: 0, peakTps: 0 },
    previousTotalTokens: null,
    deltaPercent: null,
    buckets: [],
    byAgent: []
  }
}

function createQuotaTestSnapshot(quotas: QuotasSnapshot | undefined, nowMs: number): DashboardSnapshot {
  return {
    generatedAt: nowMs,
    workspace: {
      id: 'repo::/Users/dev/orca-token-used',
      project: 'orca-token-used',
      name: 'main',
      branch: 'main',
      path: '/Users/dev/orca-token-used'
    },
    pricing: {
      source: 'builtin',
      syncedAt: nowMs,
      modelCount: 10,
      lastError: null
    },
    quotas,
    live: {
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        costUsd: 0
      },
      tps: { liveTps: 0, avgTps: 0, peakTps: 0 },
      agents: [],
      subagents: []
    },
    sessions: [],
    periods: {
      all: { day: emptyPeriodSummary(), week: emptyPeriodSummary(), month: emptyPeriodSummary() },
      worktree: { day: emptyPeriodSummary(), week: emptyPeriodSummary(), month: emptyPeriodSummary() }
    }
  }
}

function createProviderSnapshot(
  provider: QuotaProviderSnapshot['provider'],
  overrides: Partial<QuotaProviderSnapshot> = {}
): QuotaProviderSnapshot {
  const defaultLabels = {
    codex: 'Codex',
    antigravity: 'Antigravity',
    claude: 'Claude'
  } as const
  return {
    provider,
    label: defaultLabels[provider],
    status: 'ok',
    error: null,
    accountEmail: null,
    authKind: null,
    session: null,
    weekly: null,
    pools: [],
    resetCredits: null,
    accounts: [],
    updatedAt: null,
    local: {
      window5h: emptyLocalWindow(),
      window7d: emptyLocalWindow()
    },
    ...overrides
  }
}

describe('Quotas & Limits Tab UI Rendering (renderDashboardShellHtml)', () => {
  test('renders Codex weekly-only plan with Weekly 240° gauge + 5h N/A reset-credits tile without a fake 5h gauge', () => {
    const now = Date.UTC(2026, 10, 17, 12, 0, 0)
    const snap = createQuotaTestSnapshot(
      {
        source: 'live',
        syncedAt: now - 30_000,
        refreshing: false,
        lastError: null,
        providers: [
          createProviderSnapshot('codex', {
            accountEmail: 'wilson@example.com',
            authKind: 'oauth',
            session: null,
            weekly: {
              usedPercent: 41,
              windowMinutes: 10080,
              resetsAt: now + 2 * 86_400_000,
              resetDescription: 'Wed 3:53 PM'
            },
            resetCredits: {
              availableCount: 3,
              totalEarnedCount: 3,
              nextExpiresAt: now + 10 * 86_400_000
            },
            local: {
              window5h: emptyLocalWindow({ totalTokens: 15_000, costUsd: 0.42, turnCount: 4 }),
              window7d: emptyLocalWindow({ totalTokens: 120_000, costUsd: 2.1, turnCount: 25 })
            }
          })
        ]
      },
      now
    )

    const html = renderDashboardShellHtml({
      snap,
      tab: 'quotas',
      scope: 'all',
      locale: 'en',
      nowMs: now
    })

    // Active tab is 'quotas' with localized short label
    const activeTabMatch = html.match(/<button[^>]*class="tp-nav-btn active"[^>]*>([\s\S]*?)<\/button>/)
    assert.ok(activeTabMatch)
    assert.ok(activeTabMatch[0].includes('data-tab="quotas"'))
    assert.ok(activeTabMatch[1].includes(`<span class="tp-nav-label">${getMessages('en').navShort.quotas}</span>`))

    // Exactly ONE 240-degree SVG gauge for Codex (Weekly 41%), NOT a fake 5h gauge
    const gaugeSvgs = html.match(/<svg class="tp-quota-gauge-svg"[\s\S]*?<\/svg>/g) ?? []
    assert.equal(gaugeSvgs.length, 1)
    assert.ok(gaugeSvgs[0].includes('M 17.09 71.00 A 38 38 0 1 1 82.91 71.00'))
    assert.ok(gaugeSvgs[0].includes('41%'))
    assert.ok(gaugeSvgs[0].includes('tp-quota-arc-normal'))

    // 5h Window N/A tile + weekly-only hint + reset credits pill
    assert.ok(html.includes('tp-quota-na-tile'))
    assert.ok(html.includes('5h Window'))
    assert.ok(html.includes('N/A'))
    assert.ok(html.includes('Weekly-only plan · No 5h limit'))
    assert.ok(html.includes('tp-quota-credits-pill'))
    assert.ok(html.includes('3 reset credits'))
    assert.ok(html.includes('Resets in 2d'))
    assert.ok(html.includes('Wed 3:53 PM'))
  })

  test('renders Antigravity separate pool sections (Gemini Models, Claude and GPT models) with 5h + Weekly gauges and multi-account collapse group', () => {
    const now = Date.UTC(2026, 10, 17, 12, 0, 0)
    const snap = createQuotaTestSnapshot(
      {
        source: 'live',
        syncedAt: now,
        refreshing: false,
        lastError: null,
        providers: [
          createProviderSnapshot('antigravity', {
            accountEmail: 'victor@example.com',
            authKind: 'consumer',
            pools: [
              {
                id: 'gemini-models',
                label: 'Gemini Models',
                session: { usedPercent: 15, windowMinutes: 300, resetsAt: now + 3_600_000, resetDescription: null },
                weekly: { usedPercent: 5, windowMinutes: 10080, resetsAt: now + 5 * 86_400_000, resetDescription: null }
              },
              {
                id: 'claude-and-gpt-models',
                label: 'Claude and GPT models',
                session: { usedPercent: 80, windowMinutes: 300, resetsAt: now + 7_200_000, resetDescription: null },
                weekly: { usedPercent: 95, windowMinutes: 10080, resetsAt: now + 6 * 86_400_000, resetDescription: null }
              }
            ],
            accounts: [
              {
                id: 'ag-1',
                email: 'victor@example.com',
                label: null,
                authKind: 'consumer',
                active: true,
                status: 'ok',
                session: null,
                weekly: null,
                pools: [
                  {
                    id: 'gemini-models',
                    label: 'Gemini Models',
                    session: { usedPercent: 15, windowMinutes: 300, resetsAt: null, resetDescription: null },
                    weekly: { usedPercent: 5, windowMinutes: 10080, resetsAt: null, resetDescription: null }
                  }
                ],
                error: null
              },
              {
                id: 'ag-2',
                email: 'backup@example.com',
                label: null,
                authKind: 'consumer',
                active: false,
                status: 'ok',
                session: null,
                weekly: null,
                pools: [
                  {
                    id: 'gemini-models',
                    label: 'Gemini Models',
                    session: { usedPercent: 42, windowMinutes: 300, resetsAt: null, resetDescription: null },
                    weekly: { usedPercent: 20, windowMinutes: 10080, resetsAt: null, resetDescription: null }
                  }
                ],
                error: null
              }
            ]
          })
        ]
      },
      now
    )

    const html = renderDashboardShellHtml({
      snap,
      tab: 'quotas',
      scope: 'all',
      locale: 'en',
      collapsedGroups: { 'quotas:accounts:antigravity': false },
      nowMs: now
    })

    const poolBlocks = html.match(/class="tp-quota-pool-block"/g) ?? []
    assert.equal(poolBlocks.length, 2)
    assert.ok(html.includes('Gemini Models'))
    assert.ok(html.includes('Claude and GPT models'))

    // 2 pools * 2 windows (5h + Weekly) = 4 SVG gauges
    const gaugeSvgs = html.match(/<svg class="tp-quota-gauge-svg"[\s\S]*?<\/svg>/g) ?? []
    assert.equal(gaugeSvgs.length, 4)
    assert.ok(gaugeSvgs[0].includes('15%'))
    assert.ok(gaugeSvgs[1].includes('5%'))
    assert.ok(gaugeSvgs[2].includes('80%'))
    assert.ok(gaugeSvgs[3].includes('95%'))

    // Multi-account list renders both accounts and active badge
    assert.ok(html.includes('data-collapse-key="quotas:accounts:antigravity"'))
    assert.ok(html.includes('victor@example.com'))
    assert.ok(html.includes('backup@example.com'))
    assert.ok(html.includes('Gemini Models: 42%/20%'))
    assert.ok(html.includes(getMessages('en').quotaActiveAccountBadge))
  })

  test('renders Claude unavailable and error states with reason banner and local rolling 5h & 7d token/cost tiles', () => {
    const now = Date.UTC(2026, 10, 17, 12, 0, 0)
    const snap = createQuotaTestSnapshot(
      {
        source: 'cache',
        syncedAt: now - 120_000,
        refreshing: false,
        lastError: null,
        providers: [
          createProviderSnapshot('claude', {
            status: 'unavailable',
            error: 'No subscription plan — API key billing',
            authKind: 'api-key',
            local: {
              window5h: emptyLocalWindow({
                totalTokens: 45_200,
                costUsd: 1.25,
                turnCount: 12,
                sessionCount: 2,
                rateLimitHits: 2
              }),
              window7d: emptyLocalWindow({
                totalTokens: 320_000,
                costUsd: 8.5,
                turnCount: 64,
                sessionCount: 9,
                rateLimitHits: 0
              })
            }
          }),
          createProviderSnapshot('codex', {
            status: 'error',
            error: 'orca account list exited with code 1'
          })
        ]
      },
      now
    )

    const html = renderDashboardShellHtml({
      snap,
      tab: 'quotas',
      scope: 'all',
      locale: 'en',
      nowMs: now
    })

    // No fake gauges when unavailable/error
    assert.equal((html.match(/<svg class="tp-quota-gauge-svg"/g) ?? []).length, 0)

    // Unavailable reason banner (non-error style) + local 5h & 7d tiles
    assert.ok(html.includes('<div class="tp-quota-reason-banner">No subscription plan — API key billing</div>'))
    assert.ok(html.includes('tp-quota-local-grid'))
    assert.ok(html.includes('Local 5h'))
    assert.ok(html.includes('45.2K tok'))
    assert.ok(html.includes('$1.25'))
    assert.ok(html.includes('12 turns'))
    assert.ok(html.includes('2 × 429'))
    assert.ok(html.includes('Local 7d'))
    assert.ok(html.includes('320.0K tok'))
    assert.ok(html.includes('$8.50'))
    assert.ok(html.includes('64 turns'))

    // Error state renders error status pill + error reason banner
    assert.ok(html.includes('tp-quota-status-error'))
    assert.ok(html.includes('<div class="tp-quota-reason-banner tp-quota-reason-error">orca account list exited with code 1</div>'))
  })

  test('applies severity color classes at >=75% warn and >=90% crit and clamps edge values (0%, 100%, -25%, 150%, NaN, Infinity)', () => {
    const now = Date.UTC(2026, 10, 17, 12, 0, 0)
    const makeWindow = (usedPercent: number) => ({
      usedPercent,
      windowMinutes: 300,
      resetsAt: now + 3_600_000,
      resetDescription: null
    })
    const snap = createQuotaTestSnapshot(
      {
        source: 'live',
        syncedAt: now,
        refreshing: false,
        lastError: null,
        providers: [
          createProviderSnapshot('antigravity', {
            pools: [
              { id: 'p-norm', label: 'Below Warn', session: makeWindow(74.9), weekly: makeWindow(0) },
              { id: 'p-warn', label: 'Warn Range', session: makeWindow(75), weekly: makeWindow(89.9) },
              { id: 'p-crit', label: 'Crit Range', session: makeWindow(90), weekly: makeWindow(100) },
              { id: 'p-clamp', label: 'Out Of Range', session: makeWindow(-25), weekly: makeWindow(150) },
              { id: 'p-nan', label: 'Non Finite', session: makeWindow(Number.NaN), weekly: makeWindow(Number.POSITIVE_INFINITY) }
            ]
          })
        ]
      },
      now
    )

    const html = renderDashboardShellHtml({
      snap,
      tab: 'quotas',
      scope: 'all',
      locale: 'en',
      nowMs: now
    })

    assert.ok(!html.includes('NaN'))
    assert.ok(!html.includes('Infinity'))

    const gaugeSvgs = html.match(/<svg class="tp-quota-gauge-svg"[\s\S]*?<\/svg>/g) ?? []
    assert.equal(gaugeSvgs.length, 10)

    // 74.9% -> normal
    assert.ok(gaugeSvgs[0].includes('tp-quota-arc-normal'))
    assert.ok(gaugeSvgs[0].includes('tp-quota-pct-normal'))
    assert.ok(gaugeSvgs[0].includes('75%')) // rounded display while severity stays normal (< 75)

    // 0% -> normal, no fill path
    assert.ok(gaugeSvgs[1].includes('0%'))
    assert.ok(gaugeSvgs[1].includes('tp-quota-pct-normal'))
    assert.ok(!gaugeSvgs[1].includes('tp-quota-arc-fill'))

    // 75% and 89.9% -> warn
    assert.ok(gaugeSvgs[2].includes('tp-quota-arc-warn'))
    assert.ok(gaugeSvgs[2].includes('tp-quota-pct-warn'))
    assert.ok(gaugeSvgs[3].includes('tp-quota-arc-warn'))
    assert.ok(gaugeSvgs[3].includes('tp-quota-pct-warn'))

    // 90% and 100% -> crit
    assert.ok(gaugeSvgs[4].includes('tp-quota-arc-crit'))
    assert.ok(gaugeSvgs[4].includes('tp-quota-pct-crit'))
    assert.ok(gaugeSvgs[5].includes('100%'))
    assert.ok(gaugeSvgs[5].includes('tp-quota-arc-crit'))
    assert.ok(gaugeSvgs[5].includes('stroke-dashoffset="0.00"'))

    // -25% -> clamped to 0%, no fill path
    assert.ok(gaugeSvgs[6].includes('0%'))
    assert.ok(gaugeSvgs[6].includes('tp-quota-pct-normal'))
    assert.ok(!gaugeSvgs[6].includes('tp-quota-arc-fill'))

    // 150% -> clamped to 100%, crit, dashoffset 0.00
    assert.ok(gaugeSvgs[7].includes('100%'))
    assert.ok(gaugeSvgs[7].includes('tp-quota-arc-crit'))
    assert.ok(gaugeSvgs[7].includes('stroke-dashoffset="0.00"'))

    // NaN and Infinity -> clamped safely to 0% normal, no fill path
    assert.ok(gaugeSvgs[8].includes('0%'))
    assert.ok(gaugeSvgs[8].includes('tp-quota-pct-normal'))
    assert.ok(!gaugeSvgs[8].includes('tp-quota-arc-fill'))
    assert.ok(gaugeSvgs[9].includes('0%'))
    assert.ok(gaugeSvgs[9].includes('tp-quota-pct-normal'))
    assert.ok(!gaugeSvgs[9].includes('tp-quota-arc-fill'))
  })

  test('escapes XSS payloads in accountEmail, error, pool.label, and resetDescription', () => {
    const now = Date.UTC(2026, 10, 17, 12, 0, 0)
    const xssEmail = 'evil@x.com"><script>alert("email")</script>'
    const xssError = '<img src=x onerror="alert(1)"><script>alert("err")</script>'
    const xssPool = 'Pool <script>alert("pool")</script> "attr"'
    const xssReset = 'Fri 10:00 AM" onmouseover="alert(2)<script>alert("reset")</script>'

    const snap = createQuotaTestSnapshot(
      {
        source: 'error',
        syncedAt: now,
        refreshing: false,
        lastError: xssError,
        providers: [
          createProviderSnapshot('antigravity', {
            accountEmail: xssEmail,
            pools: [
              {
                id: 'xss-pool',
                label: xssPool,
                session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: xssReset },
                weekly: null
              }
            ]
          }),
          createProviderSnapshot('claude', {
            status: 'error',
            accountEmail: xssEmail,
            error: xssError
          })
        ]
      },
      now
    )

    const html = renderDashboardShellHtml({
      snap,
      tab: 'quotas',
      scope: 'all',
      locale: 'en',
      quotasError: xssError,
      nowMs: now
    })

    assert.ok(!html.includes('<script>'))
    assert.ok(!html.includes('<img src=x'))
    assert.ok(!html.includes('" onmouseover="alert(2)'))
    assert.ok(html.includes(escapeHtml(xssEmail)))
    assert.ok(html.includes(escapeHtml(xssError)))
    assert.ok(html.includes(escapeHtml(xssPool)))
    assert.ok(html.includes(escapeHtml(xssReset)))
  })

  test('renders localized Quotas UI strings for en, zh-TW, and zh-CN', () => {
    const now = Date.UTC(2026, 10, 17, 12, 0, 0)
    const snap = createQuotaTestSnapshot(
      {
        source: 'live',
        syncedAt: now,
        refreshing: false,
        lastError: null,
        providers: [
          createProviderSnapshot('codex', {
            status: 'ok',
            session: null,
            weekly: { usedPercent: 25, windowMinutes: 10080, resetsAt: now + 86_400_000, resetDescription: null },
            local: {
              window5h: emptyLocalWindow({ totalTokens: 500, costUsd: 0.01, turnCount: 1 }),
              window7d: emptyLocalWindow({ totalTokens: 2000, costUsd: 0.05, turnCount: 3 })
            }
          })
        ]
      },
      now
    )

    for (const locale of ['en', 'zh-TW', 'zh-CN'] as const) {
      const msg = getMessages(locale)
      const html = renderDashboardShellHtml({
        snap,
        tab: 'quotas',
        scope: 'all',
        locale,
        nowMs: now
      })

      assert.ok(html.includes(escapeHtml(msg.tabs.quotas)), `${locale}: missing tabs.quotas`)
      assert.ok(html.includes(escapeHtml(msg.navShort.quotas)), `${locale}: missing navShort.quotas`)
      assert.ok(html.includes(escapeHtml(msg.quotaSourceLive)), `${locale}: missing quotaSourceLive`)
      assert.ok(html.includes(escapeHtml(msg.quotaRefreshAction)), `${locale}: missing quotaRefreshAction`)
      assert.ok(html.includes(escapeHtml(msg.quota5hLabel)), `${locale}: missing quota5hLabel`)
      assert.ok(html.includes(escapeHtml(msg.quotaWeeklyLabel)), `${locale}: missing quotaWeeklyLabel`)
      assert.ok(html.includes(escapeHtml(msg.quotaNotApplicable)), `${locale}: missing quotaNotApplicable`)
      assert.ok(html.includes(escapeHtml(msg.quotaWeeklyOnlyHint)), `${locale}: missing quotaWeeklyOnlyHint`)
      assert.ok(html.includes(escapeHtml(msg.quotaLocalUsage5h)), `${locale}: missing quotaLocalUsage5h`)
      assert.ok(html.includes(escapeHtml(msg.quotaLocalUsage7d)), `${locale}: missing quotaLocalUsage7d`)
    }
  })

  test('formats future resetCredits.nextExpiresAt as future expiry countdown, never Just now', () => {
    const now = Date.UTC(2026, 10, 17, 12, 0, 0)
    const snap = createQuotaTestSnapshot(
      {
        source: 'live',
        syncedAt: now,
        refreshing: false,
        lastError: null,
        providers: [
          createProviderSnapshot('codex', {
            status: 'ok',
            session: null,
            weekly: {
              usedPercent: 41,
              windowMinutes: 10080,
              resetsAt: now + 2 * 86_400_000,
              resetDescription: null
            },
            resetCredits: {
              availableCount: 3,
              totalEarnedCount: 3,
              nextExpiresAt: now + 14 * 86_400_000
            }
          })
        ]
      },
      now
    )

    const html = renderDashboardShellHtml({
      snap,
      tab: 'quotas',
      scope: 'all',
      locale: 'en',
      nowMs: now
    })

    const creditsMatch = html.match(/<div class="tp-quota-credits-pill">([\s\S]*?)<\/div>/)
    assert.ok(creditsMatch, 'missing tp-quota-credits-pill')
    assert.ok(!creditsMatch[1].includes(getMessages('en').justNow), `unexpected Just now: ${creditsMatch[1]}`)
    assert.ok(creditsMatch[1].includes('14d'), `expected 14d in credits pill, got: ${creditsMatch[1]}`)
  })
})

describe('Readable Subagent Titles & Metadata Wiring', () => {
  test('Antigravity subagent names survive generic history titles while the parent title stays intact', () => {
    const now = Date.parse('2026-11-17T10:00:00.000Z')
    const wtPath = '/Users/dev/orca-subagent-ag'

    const parent = createEmptySessionState(
      '11111111-parent-ag',
      'antigravity',
      '/Users/dev/.gemini/antigravity-cli/brain/11111111-parent-ag/.system_generated/logs/transcript.jsonl'
    )
    parent.cwd = wtPath
    parent.titleHint = 'Coordinate swarm work'
    parent.updatedAtMs = now - 5_000
    parent.turnsByKey.set('t-parent', {
      turnKey: 't-parent',
      timestampMs: now - 5_000,
      input: 1000,
      output: 200,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1200,
      durationSec: 2,
      tps: 100,
      model: 'gemini-4-carbon',
      explicitCostUsd: null
    })

    const subVerifier = createEmptySessionState(
      '7a8b9c0d-1111-2222-3333-444455556666',
      'antigravity',
      '/Users/dev/.gemini/antigravity-cli/brain/7a8b9c0d-1111-2222-3333-444455556666/.system_generated/logs/transcript.jsonl'
    )
    subVerifier.cwd = wtPath
    subVerifier.isSubagent = true
    subVerifier.parentSessionId = '11111111-parent-ag'
    subVerifier.titleHint = 'You are verifier, one agent in a swarm...'
    subVerifier.updatedAtMs = now - 3_000
    subVerifier.turnsByKey.set('t-ver', {
      turnKey: 't-ver',
      timestampMs: now - 3_000,
      input: 800,
      output: 150,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 950,
      durationSec: 1.5,
      tps: 100,
      model: 'gemini-4-carbon',
      explicitCostUsd: null
    })

    const subBackend = createEmptySessionState(
      '9e8d7c6b-1111-2222-3333-444455556666',
      'antigravity',
      '/Users/dev/.gemini/antigravity-cli/brain/9e8d7c6b-1111-2222-3333-444455556666/.system_generated/logs/transcript.jsonl'
    )
    subBackend.cwd = wtPath
    subBackend.isSubagent = true
    subBackend.parentSessionId = '11111111-parent-ag'
    subBackend.updatedAtMs = now - 2_000
    subBackend.turnsByKey.set('t-be', {
      turnKey: 't-be',
      timestampMs: now - 2_000,
      input: 600,
      output: 120,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 720,
      durationSec: 1.2,
      tps: 100,
      model: 'gemini-4-carbon',
      explicitCostUsd: null
    })

    const journal = createTestJournalIndex({
      byNativeId: new Map([
        [`antigravity:${subBackend.sessionId}`, {
          provider: 'antigravity',
          title: `Antigravity ${subBackend.sessionId.slice(0, 8)}`,
          workspacePath: wtPath,
          model: null,
          updatedAt: now
        }]
      ]),
      antigravitySummaries: new Map([
        [
          '11111111-parent-ag',
          {
            conversationId: '11111111-parent-ag',
            parentConversationId: null,
            title: 'Swarm Coordinator Session',
            agentName: 'coordinator',
            workspacePath: wtPath,
            workspacePaths: [wtPath],
            isSubagent: false,
            updatedAtMs: now - 5_000
          }
        ],
        [
          '7a8b9c0d-1111-2222-3333-444455556666',
          {
            conversationId: '7a8b9c0d-1111-2222-3333-444455556666',
            parentConversationId: '11111111-parent-ag',
            title: null,
            agentName: 'verifier',
            workspacePath: wtPath,
            workspacePaths: [wtPath],
            isSubagent: true,
            updatedAtMs: now - 3_000
          }
        ],
        [
          '9e8d7c6b-1111-2222-3333-444455556666',
          {
            conversationId: '9e8d7c6b-1111-2222-3333-444455556666',
            parentConversationId: '11111111-parent-ag',
            title: null,
            agentName: 'cp-dev',
            workspacePath: wtPath,
            workspacePaths: [wtPath],
            isSubagent: true,
            updatedAtMs: now - 2_000
          }
        ]
      ])
    })

    const snap = buildDashboardSnapshot(
      [parent, subVerifier, subBackend],
      journal,
      new PricingEngine(),
      {
        focusedName: 'main',
        focusedBranch: 'main',
        focusedPath: wtPath,
        liveAgents: []
      },
      now
    )

    const parentCard = snap.live.agents.find((c) => c.sessionKey === 'antigravity:11111111-parent-ag')
    assert.equal(parentCard?.title, 'Swarm Coordinator Session')
    assert.equal(snap.sessions[0]?.title, 'Swarm Coordinator Session')

    const verifierCard = snap.live.subagents.find(
      (c) => c.sessionKey === 'antigravity:7a8b9c0d-1111-2222-3333-444455556666'
    )
    const backendCard = snap.live.subagents.find(
      (c) => c.sessionKey === 'antigravity:9e8d7c6b-1111-2222-3333-444455556666'
    )
    assert.equal(verifierCard?.title, 'verifier')
    assert.equal(backendCard?.title, 'cp-dev')
  })

  test('Codex thread_spawn subagent displays agent_path/agent_role + agent_nickname (e.g. premortem_merge · Linnaeus) while parent stays untouched', () => {
    const now = Date.parse('2026-11-17T10:05:00.000Z')
    const wtPath = '/Users/dev/orca-subagent-codex'

    const parent = createEmptySessionState('codex-parent-1', 'codex', '/tmp/codex-parent.jsonl')
    parent.cwd = wtPath
    parent.titleHint = 'Run premortem merge check'
    parent.updatedAtMs = now - 6_000
    parent.turnsByKey.set('t-p', {
      turnKey: 't-p',
      timestampMs: now - 6_000,
      input: 1200,
      output: 300,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1500,
      durationSec: 2,
      tps: 150,
      model: 'gpt-6.1-sol',
      explicitCostUsd: null
    })

    const child = createEmptySessionState('codex-sub-raw', 'codex', '/tmp/codex-sub.jsonl')
    applyCodexLines(child, [
      JSON.stringify({
        timestamp: new Date(now - 10_000).toISOString(),
        type: 'session_meta',
        payload: {
          id: '019a0c6d-1111-2222-3333-444455556666',
          cwd: wtPath,
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'codex-parent-1',
                agent_path: '/root/premortem_merge',
                agent_role: 'default',
                agent_nickname: 'Linnaeus'
              }
            }
          }
        }
      }),
      JSON.stringify({
        timestamp: new Date(now - 11_000).toISOString(),
        type: 'session_meta',
        payload: { id: 'codex-parent-1', cwd: wtPath, source: 'vscode' }
      }),
      JSON.stringify({
        timestamp: new Date(now - 9_000).toISOString(),
        type: 'turn_context',
        payload: { cwd: wtPath, model: 'gpt-6.1-sol' }
      }),
      JSON.stringify({
        timestamp: new Date(now - 9_000).toISOString(),
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Merge premortem findings into checklist' }
      }),
      JSON.stringify({
        timestamp: new Date(now - 4_000).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 900 },
            last_token_usage: { input_tokens: 700, cached_input_tokens: 0, output_tokens: 200 }
          }
        }
      })
    ])

    const snap = buildDashboardSnapshot(
      [parent, child],
      createTestJournalIndex(),
      new PricingEngine(),
      {
        focusedName: 'main',
        focusedBranch: 'main',
        focusedPath: wtPath,
        liveAgents: []
      },
      now
    )

    const parentCard = snap.live.agents.find((c) => c.sessionKey === 'codex:codex-parent-1')
    assert.equal(parentCard?.title, 'Run premortem merge check')
    assert.equal(snap.sessions.find((s) => s.sessionId === 'codex-parent-1')?.title, 'Run premortem merge check')

    const subCard = snap.live.subagents.find(
      (c) => c.sessionKey === 'codex:019a0c6d-1111-2222-3333-444455556666'
    )
    assert.equal(subCard?.title, 'premortem_merge · Linnaeus')
    assert.equal(subCard?.parentSessionKey, parentCard?.sessionKey)
  })

  test('Claude subagent displays parent Task/Agent description + subagent_type, works when parent is outside hotRaw, and falls back to .meta.json agentType when parent is absent', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-claude-subagent-titles-'))
    try {
      const now = Date.parse('2026-11-17T10:10:00.000Z')
      const wtPath = path.join(tmpRoot, 'repo')
      const claudeProjDir = path.join(tmpRoot, '.claude', 'projects', 'repo-slug')
      const oldParentId = 'parent-claude-old'
      const subDirWithParent = path.join(claudeProjDir, oldParentId, 'subagents')
      const subDirOrphan = path.join(claudeProjDir, 'missing-parent-id', 'subagents')
      fs.mkdirSync(wtPath, { recursive: true })
      fs.mkdirSync(subDirWithParent, { recursive: true })
      fs.mkdirSync(subDirOrphan, { recursive: true })

      // Old parent (>6h old so pollSingleLiveAgent excludes it from hotRaw) that spawned two subagents via Task/Agent
      const oldParentTs = new Date(now - 8 * 3600_000).toISOString()
      const parentFile = path.join(claudeProjDir, `${oldParentId}.jsonl`)
      fs.writeFileSync(
        parentFile,
        [
          JSON.stringify({
            type: 'user',
            sessionId: oldParentId,
            cwd: wtPath,
            timestamp: oldParentTs,
            message: { role: 'user', content: 'Audit codebase architecture' }
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'asst-spawn-1',
            sessionId: oldParentId,
            cwd: wtPath,
            timestamp: new Date(now - 8 * 3600_000 + 2_000).toISOString(),
            message: {
              id: 'msg-spawn-1',
              model: 'claude-sonnet-4-6',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_task_1',
                  name: 'Task',
                  input: {
                    subagent_type: 'Explore',
                    description: 'Audit aggregator wiring'
                  }
                },
                {
                  type: 'tool_use',
                  id: 'toolu_agent_2',
                  name: 'Agent',
                  input: {
                    subagent_type: 'Explore',
                    description: 'Explore parser edge cases'
                  }
                }
              ],
              usage: { input_tokens: 1000, output_tokens: 150 }
            }
          }),
          JSON.stringify({
            type: 'user',
            sessionId: oldParentId,
            cwd: wtPath,
            timestamp: new Date(now - 8 * 3600_000 + 4_000).toISOString(),
            toolUseResult: { agentId: 'a101' },
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'toolu_task_1', content: 'done' }]
            }
          }),
          JSON.stringify({
            type: 'user',
            sessionId: oldParentId,
            cwd: wtPath,
            timestamp: new Date(now - 8 * 3600_000 + 5_000).toISOString(),
            toolUseResult: { agentId: 'a202' },
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'toolu_agent_2', content: 'done' }]
            }
          })
        ].join('\n') + '\n',
        'utf8'
      )
      const oldMtimeSec = (now - 8 * 3600_000 + 5_000) / 1000
      fs.utimesSync(parentFile, oldMtimeSec, oldMtimeSec)

      // Child 1 (`agent-a101.jsonl` + `.meta.json`): linked to parent Task -> `Explore: Audit aggregator wiring`
      const child1File = path.join(subDirWithParent, 'agent-a101.jsonl')
      fs.writeFileSync(
        child1File,
        [
          JSON.stringify({
            type: 'user',
            isSidechain: true,
            agentId: 'a101',
            sessionId: oldParentId,
            cwd: wtPath,
            timestamp: new Date(now - 8_000).toISOString(),
            message: { role: 'user', content: 'Check src/aggregator.ts carefully' }
          }),
          JSON.stringify({
            type: 'assistant',
            isSidechain: true,
            agentId: 'a101',
            sessionId: oldParentId,
            cwd: wtPath,
            timestamp: new Date(now - 4_000).toISOString(),
            message: {
              id: 'msg-a101',
              model: 'claude-sonnet-4-6',
              usage: { input_tokens: 500, output_tokens: 100 }
            }
          })
        ].join('\n') + '\n',
        'utf8'
      )
      fs.writeFileSync(
        path.join(subDirWithParent, 'agent-a101.meta.json'),
        JSON.stringify({ agentType: 'Explore' }),
        'utf8'
      )

      // Child 2 (`agent-a202.jsonl`): description already starts with role -> `Explore parser edge cases` (no double prefix)
      const child2File = path.join(subDirWithParent, 'agent-a202.jsonl')
      fs.writeFileSync(
        child2File,
        [
          JSON.stringify({
            type: 'user',
            isSidechain: true,
            agentId: 'a202',
            sessionId: oldParentId,
            cwd: wtPath,
            timestamp: new Date(now - 7_000).toISOString(),
            message: { role: 'user', content: 'Inspect parsers.ts' }
          }),
          JSON.stringify({
            type: 'assistant',
            isSidechain: true,
            agentId: 'a202',
            sessionId: oldParentId,
            cwd: wtPath,
            timestamp: new Date(now - 3_000).toISOString(),
            message: {
              id: 'msg-a202',
              model: 'claude-sonnet-4-6',
              usage: { input_tokens: 400, output_tokens: 80 }
            }
          })
        ].join('\n') + '\n',
        'utf8'
      )

      // Child 3 (`agent-orphan99.jsonl` + `.meta.json`): parent transcript absent -> falls back to `.meta.json` `agentType` (`Plan`)
      const orphanFile = path.join(subDirOrphan, 'agent-orphan99.jsonl')
      fs.writeFileSync(
        orphanFile,
        [
          JSON.stringify({
            type: 'user',
            isSidechain: true,
            agentId: 'orphan99',
            sessionId: 'missing-parent-id',
            cwd: wtPath,
            timestamp: new Date(now - 6_000).toISOString(),
            message: { role: 'user', content: 'Boilerplate prompt that should lose to meta agentType' }
          }),
          JSON.stringify({
            type: 'assistant',
            isSidechain: true,
            agentId: 'orphan99',
            sessionId: 'missing-parent-id',
            cwd: wtPath,
            timestamp: new Date(now - 2_000).toISOString(),
            message: {
              id: 'msg-orphan99',
              model: 'claude-sonnet-4-6',
              usage: { input_tokens: 300, output_tokens: 60 }
            }
          })
        ].join('\n') + '\n',
        'utf8'
      )
      fs.writeFileSync(
        path.join(subDirOrphan, 'agent-orphan99.meta.json'),
        JSON.stringify({ agentType: 'Plan' }),
        'utf8'
      )

      const scanner = new TranscriptScanner({ homeDir: tmpRoot, orcaAppDirs: [] })
      const sessions = scanner.scan({ forceFullDiscovery: true, now })
      const journal = scanner.getJournalIndex()
      const pricing = new PricingEngine()
      const runtime = {
        focusedName: 'main',
        focusedBranch: 'main',
        focusedPath: wtPath,
        liveAgents: []
      }

      const snap = buildDashboardSnapshot(sessions, journal, pricing, runtime, now)
      assert.equal(
        snap.sessions.find((s) => s.sessionId === oldParentId)?.title,
        'Audit codebase architecture'
      )

      const c1 = snap.live.subagents.find((c) => c.sessionKey === 'claude:agent-a101')
      const c2 = snap.live.subagents.find((c) => c.sessionKey === 'claude:agent-a202')
      const c3 = snap.live.subagents.find((c) => c.sessionKey === 'claude:agent-orphan99')
      assert.equal(c1?.title, 'Explore: Audit aggregator wiring')
      assert.equal(c2?.title, 'Explore parser edge cases')
      assert.equal(c3?.title, 'Plan')

      // pollSingleLiveAgent must still resolve child's parent spawn description even when parent's updatedAtMs < recentCutoff
      const polledChild1 = pollSingleLiveAgent('claude:agent-a101', sessions, journal, pricing, runtime, now)
      assert.equal(polledChild1?.title, 'Explore: Audit aggregator wiring')

      // Fallback lookup by agentId when child has parentSessionId === null
      const noParentChild = createEmptySessionState('agent-a101', 'claude', '/tmp/agent-a101-noparent.jsonl')
      noParentChild.cwd = wtPath
      noParentChild.isSubagent = true
      noParentChild.parentSessionId = null
      noParentChild.subagentId = 'a101'
      noParentChild.updatedAtMs = now - 1_000
      noParentChild.turnsByKey.set('t-np', {
        turnKey: 't-np',
        timestampMs: now - 1_000,
        input: 100,
        output: 20,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 120,
        durationSec: 1,
        tps: 20,
        model: 'claude-sonnet-4-6',
        explicitCostUsd: null
      })
      const parentOnly = sessions.find((s) => s.sessionId === oldParentId)!
      const snapNoParent = buildDashboardSnapshot([parentOnly, noParentChild], journal, pricing, runtime, now)
      assert.equal(
        snapNoParent.live.subagents.find((c) => c.sessionKey === 'claude:agent-a101')?.title,
        'Explore: Audit aggregator wiring'
      )
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('scanner bounds oversized .meta.json, refreshes stale cache on .meta.json update/delete, and rejects raw UUID subagent labels', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-subagent-meta-edge-'))
    try {
      const now = Date.now()
      const yesterdayMs = now - 2 * 86_400_000
      const wtPath = path.join(tmpRoot, 'repo')
      const subDir = path.join(tmpRoot, '.claude', 'projects', 'repo-slug', 'parent-hist', 'subagents')
      fs.mkdirSync(wtPath, { recursive: true })
      fs.mkdirSync(subDir, { recursive: true })

      // 1. Oversized .meta.json (> 64 KiB) must be skipped safely
      const oversizedJsonl = path.join(subDir, 'agent-oversized.jsonl')
      fs.writeFileSync(
        oversizedJsonl,
        `${JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          agentId: 'oversized',
          sessionId: 'parent-hist',
          cwd: wtPath,
          timestamp: new Date(now - 5_000).toISOString(),
          message: { id: 'm-ov', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 20 } }
        })}\n`,
        'utf8'
      )
      fs.writeFileSync(
        path.join(subDir, 'agent-oversized.meta.json'),
        JSON.stringify({ agentType: 'Explore', pad: 'x'.repeat(65 * 1024) }),
        'utf8'
      )

      // 2. Raw UUIDs in .meta.json must be rejected
      const uuidMetaJsonl = path.join(subDir, 'agent-uuidmeta.jsonl')
      fs.writeFileSync(
        uuidMetaJsonl,
        `${JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          agentId: 'uuidmeta',
          sessionId: 'parent-hist',
          cwd: wtPath,
          timestamp: new Date(now - 4_000).toISOString(),
          message: { id: 'm-um', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 20 } }
        })}\n`,
        'utf8'
      )
      fs.writeFileSync(
        path.join(subDir, 'agent-uuidmeta.meta.json'),
        JSON.stringify({
          agentType: '12345678-1234-1234-1234-123456789abc',
          name: 'abcdef1234567890abcdef1234567890'
        }),
        'utf8'
      )

      // 3. Pre-today subagent whose .meta.json changes & is later deleted while .jsonl stays unchanged
      const histJsonl = path.join(subDir, 'agent-hist1.jsonl')
      const histMeta = path.join(subDir, 'agent-hist1.meta.json')
      fs.writeFileSync(
        histJsonl,
        `${JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          agentId: 'hist1',
          sessionId: 'parent-hist',
          cwd: wtPath,
          timestamp: new Date(yesterdayMs).toISOString(),
          message: { id: 'm-h1', model: 'claude-sonnet-4-6', usage: { input_tokens: 200, output_tokens: 40 } }
        })}\n`,
        'utf8'
      )
      const yesterdaySec = yesterdayMs / 1000
      fs.utimesSync(histJsonl, yesterdaySec, yesterdaySec)
      fs.writeFileSync(histMeta, JSON.stringify({ agentType: 'Explore' }), 'utf8')
      fs.utimesSync(histMeta, yesterdaySec, yesterdaySec)

      // 4. Hot subagent to verify pollHotFiles picks up .meta.json update + deletion when .jsonl is unchanged
      const hotJsonl = path.join(subDir, 'agent-hot1.jsonl')
      const hotMeta = path.join(subDir, 'agent-hot1.meta.json')
      fs.writeFileSync(
        hotJsonl,
        `${JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          agentId: 'hot1',
          sessionId: 'parent-hist',
          cwd: wtPath,
          timestamp: new Date(now - 10_000).toISOString(),
          message: { id: 'm-hot1', model: 'claude-sonnet-4-6', usage: { input_tokens: 150, output_tokens: 30 } }
        })}\n`,
        'utf8'
      )
      fs.writeFileSync(hotMeta, JSON.stringify({ agentType: 'Explore' }), 'utf8')

      const scanner = new TranscriptScanner({ homeDir: tmpRoot, orcaAppDirs: [] })
      let sessions = scanner.scan({ forceFullDiscovery: true, now })

      const ov1 = sessions.find((s) => s.sessionId === 'agent-oversized')
      assert.equal(ov1?.subagentRole, null)
      assert.equal(ov1?.subagentName, null)

      const um1 = sessions.find((s) => s.sessionId === 'agent-uuidmeta')
      assert.equal(um1?.subagentRole, null)
      assert.equal(um1?.subagentName, null)

      const h1 = sessions.find((s) => s.sessionId === 'agent-hist1')
      assert.equal(h1?.subagentRole, 'Explore')
      assert.equal(h1?.subagentName, null)

      const cacheSnap1 = scanner.consumeHistoricalCacheSnapshot(now)
      assert.ok(cacheSnap1, 'Expected initial historical cache snapshot for pre-today session')
      assert.equal(scanner.hasDirtyHistoricalCache(), false)

      // Edit pre-today .meta.json without touching .jsonl
      fs.writeFileSync(histMeta, JSON.stringify({ agentType: 'Plan', name: 'Arch' }), 'utf8')
      fs.utimesSync(histMeta, (now - 1_000) / 1000, (now - 1_000) / 1000)

      // Hydrate a fresh scanner from cacheSnap1 and scan with unchanged .jsonl
      const hydratedScanner = new TranscriptScanner({ homeDir: tmpRoot, orcaAppDirs: [] })
      hydratedScanner.hydrateHistoricalCache(cacheSnap1)
      const hydratedSessions = hydratedScanner.scan({ forceFullDiscovery: true, now })
      const h2 = hydratedSessions.find((s) => s.sessionId === 'agent-hist1')
      assert.equal(h2?.subagentRole, 'Plan')
      assert.equal(h2?.subagentName, 'Arch')
      assert.equal(
        hydratedScanner.hasDirtyHistoricalCache(),
        true,
        'Updating pre-today .meta.json must mark historical cache dirty'
      )

      // Also verify pollHotFiles picks up .meta.json update and deletion while hot .jsonl is unchanged
      fs.writeFileSync(hotMeta, JSON.stringify({ agentType: 'CodeReviewer', name: 'Ada' }), 'utf8')
      fs.utimesSync(hotMeta, (now - 500) / 1000, (now - 500) / 1000)
      sessions = scanner.pollHotFiles(now, 'claude:agent-hot1')
      const hotUpdated = sessions.find((s) => s.sessionId === 'agent-hot1')
      assert.equal(hotUpdated?.subagentRole, 'CodeReviewer')
      assert.equal(hotUpdated?.subagentName, 'Ada')

      fs.rmSync(hotMeta)
      sessions = scanner.pollHotFiles(now, 'claude:agent-hot1')
      const hotDeleted = sessions.find((s) => s.sessionId === 'agent-hot1')
      assert.equal(hotDeleted?.subagentRole, null)
      assert.equal(hotDeleted?.subagentName, null)

      // Delete pre-today .meta.json and verify hydratedScanner clears stale fields and marks cache dirty
      hydratedScanner.consumeHistoricalCacheSnapshot(now)
      assert.equal(hydratedScanner.hasDirtyHistoricalCache(), false)
      fs.rmSync(histMeta)
      const afterDelete = hydratedScanner.scan({ forceFullDiscovery: true, now })
      const h3 = afterDelete.find((s) => s.sessionId === 'agent-hist1')
      assert.equal(h3?.subagentRole, null)
      assert.equal(h3?.subagentName, null)
      assert.equal(
        hydratedScanner.hasDirtyHistoricalCache(),
        true,
        'Deleting pre-today .meta.json must clear stale fields and mark historical cache dirty'
      )

      // 5. Raw UUIDs in Codex subagent metadata and Claude Task calls must never leak into titles
      const codexUuidSub = createEmptySessionState('codex-uuid-sub', 'codex', '/tmp/codex-uuid.jsonl')
      applyCodexLines(codexUuidSub, [
        JSON.stringify({
          timestamp: new Date(now - 3_000).toISOString(),
          type: 'session_meta',
          payload: {
            id: 'codex-uuid-sub-id',
            cwd: wtPath,
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: 'parent-codex',
                  agent_path: '/root/12345678-1234-1234-1234-123456789abc',
                  agent_role: 'default',
                  agent_nickname: '12345678-1234-1234-1234-123456789abc'
                }
              }
            }
          }
        }),
        JSON.stringify({
          timestamp: new Date(now - 2_000).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { total_tokens: 100 },
              last_token_usage: { input_tokens: 80, cached_input_tokens: 0, output_tokens: 20 }
            }
          }
        })
      ])
      assert.equal(codexUuidSub.subagentRole, null)
      assert.equal(codexUuidSub.subagentName, null)

      const snapUuid = buildDashboardSnapshot(
        [codexUuidSub],
        createTestJournalIndex(),
        new PricingEngine(),
        { focusedName: 'main', focusedBranch: 'main', focusedPath: wtPath, liveAgents: [] },
        now
      )
      const uuidSubCard = snapUuid.live.subagents.find(
        (c) => c.sessionKey === 'codex:codex-uuid-sub-id'
      )
      assert.equal(uuidSubCard?.title, 'OpenAI · codex-uu')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('displays latest active model and reasoning effort after mid-session /model switch even when earlier model has more cumulative tokens', () => {
    const now = Date.now()
    const st = createEmptySessionState(
      'agy-model-switch',
      'antigravity',
      '/tmp/agy-cli/brain/agy-model-switch/.system_generated/logs/transcript.jsonl'
    )
    st.cwd = '/tmp/qbibotlive/optimization'
    st.lastMtimeMs = now - 1_000
    applyAntigravityLines(st, [
      JSON.stringify({
        step_index: 1,
        type: 'USER_INPUT',
        created_at: new Date(now - 600_000).toISOString(),
        content: 'Initial analysis'
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: new Date(now - 590_000).toISOString(),
        model: 'gemini-4-hydrogen-high',
        input_tokens: 1_000_000,
        cache_read_tokens: 75_000_000,
        output_tokens: 50_000
      }),
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: new Date(now - 2_000).toISOString(),
        model: 'gemini-4-carbon-medium',
        input_tokens: 100_000,
        cache_read_tokens: 4_000_000,
        output_tokens: 10_000
      })
    ])

    const snap = buildDashboardSnapshot(
      [st],
      createTestJournalIndex(),
      new PricingEngine(),
      { focusedName: 'optimization', focusedBranch: 'optimization', focusedPath: st.cwd, liveAgents: [] },
      now
    )
    assert.equal(snap.sessions[0]?.modelLabel, 'gemini-4-carbon-medium')
    assert.deepEqual(snap.sessions[0]?.reasoningLevels, ['High', 'Medium'])
    assert.equal(snap.live.agents[0]?.modelLabel, 'gemini-4-carbon-medium')
    assert.deepEqual(snap.live.agents[0]?.reasoningLevels, ['High', 'Medium'])
  })
})

test('closes an Antigravity turn on a terminal error and resumes on new input', () => {
  const st = createEmptySessionState('tour', 'antigravity', '/tmp/tour.jsonl')
  const event = (step_index: number, type: string) =>
    JSON.stringify({ step_index, type, status: 'DONE', created_at: new Date(step_index * 1000).toISOString() })
  applyAntigravityLines(st, [event(1, 'USER_INPUT'), event(2, 'ERROR_MESSAGE')])
  assert.equal(st.lastEventState, 'done')
  assert.equal(resolveSessionRunState(st, 'working', 3_000, 2_900), 'working')
  applyAntigravityLines(st, [event(3, 'USER_INPUT')])
  assert.equal(st.lastEventState, 'working')
})

test('forgets a background working terminal once its workspace no longer lists it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-background-pty-'))
  process.env.TOKEN_PULSE_HOME_DIR = dir
  process.env.TOKEN_PULSE_ORCA_DATA_DIR = dir
  let open = true
  const host = mockHost({
    results: {
      'workspace.list': () => ({
        workspaces: [{ id: 'background', path: dir, name: 'main', project: 'test', kind: 'worktree', hostId: 'local', branch: 'main' }],
        truncated: false
      }),
      'workspace.readContext': () => ({ workspaceId: 'focused', branch: 'main', displayName: 'other', terminals: [] }),
      'agents.list': ({ workspaceId }: { workspaceId?: string }) => ({
        agents: workspaceId === 'background' && open
          ? [{ terminalId: 'term_background', title: 'agy', agent: 'antigravity', state: 'working', stateStartedAt: Date.now() }]
          : []
      }),
      'terminal.list': () => ({ terminals: open ? [{ id: 'term_background' }] : [], truncated: false }),
      'agent.listSessions': () => ({ sessions: [], truncated: false }),
      'statusBar.update': () => ({ ok: true })
    }
  })
  try {
    const worker = await mountWorker(await import('./worker'), { host })
    try {
      await worker.emit('agent.status.changed', {
        workspaceId: 'background', terminalId: 'term_background', title: 'agy',
        paneKey: 'bg:leaf', state: 'working', receivedAt: Date.now()
      })
      const snapshot = () => worker.request('dashboard.get', { forceScan: true })
      assert.ok((await snapshot()).live.agents.some((a) => a.terminalId === 'term_background'))
      open = false
      assert.ok(!(await snapshot()).live.agents.some((a) => a.terminalId === 'term_background'))
    } finally {
      await worker.deactivate()
    }
  } finally {
    delete process.env.TOKEN_PULSE_HOME_DIR
    delete process.env.TOKEN_PULSE_ORCA_DATA_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Live TPS lists every producer and its available ancestors across workspaces and card limits', () => {
  const now = Date.now()
  const session = (id: string, cwd: string, parentId?: string) => {
    const st = createEmptySessionState(id, 'antigravity', `/tmp/${id}.jsonl`)
    st.cwd = cwd
    st.updatedAtMs = now
    st.lastEventState = 'working'
    st.isSubagent = Boolean(parentId)
    st.parentSessionId = parentId ?? null
    st.turnsByKey.set('turn', {
      turnKey: 'turn', timestampMs: now, output: 80, reasoning: 0, input: 100,
      cacheRead: 0, cacheWrite: 0, total: 180, durationSec: 8, tps: 10,
      model: null, explicitCostUsd: null
    })
    return st
  }
  const parent = session('parent', '/focused')
  parent.lastEventState = 'waiting'
  const children = Array.from({ length: 13 }, (_, i) => session(`child-${i}`, '/focused', 'parent'))
  const background = session('nested', '/other', 'child-0')
  const done = session('finished', '/other', 'parent')
  done.lastEventState = 'done'
  const roots = Array.from({ length: 13 }, (_, i) => session(`root-${i}`, '/other'))
  const snap = buildDashboardSnapshot(
    [parent, ...children, background, { ...background, filePath: '/archive/nested.jsonl' }, done, ...roots],
    createTestJournalIndex(), new PricingEngine(), {
      focusedId: null, focusedName: 'focused', focusedPath: '/focused',
      focusedProject: null, focusedBranch: null,
      liveAgents: [{
        terminalId: null, sessionId: 'nested', workspacePath: '/other',
        title: 'Nested worker', agent: 'antigravity', state: 'working', stateStartedAt: now
      }]
    }, now
  )
  const cards = [...snap.live.agents, ...snap.live.subagents]
  assert.equal(cards.reduce((sum, card) => sum + card.liveOutRate, 0), snap.live.tps.liveTps)
  assert.equal(new Set(cards.map((card) => card.sessionKey)).size, cards.length)
  assert.ok(snap.live.agents.some((card) => card.sessionKey === 'antigravity:parent'))
  assert.ok(!snap.live.agents.some((card) => card.sessionKey === 'antigravity:nested'))
  assert.ok(snap.live.subagents.some((card) => card.sessionKey === 'antigravity:nested' && card.liveOutRate === 10))
  assert.ok(!snap.live.subagents.some((card) => card.sessionKey === 'antigravity:finished'))
  // The waiting root contributes zero. All 13 children (including the producing
  // parent of the nested worker), the nested worker, and 13 independent roots contribute.
  assert.equal(snap.live.tps.liveTps, 270)

  const remoteFocus = buildDashboardSnapshot(
    [parent], createTestJournalIndex(), new PricingEngine(), {
      focusedId: 'remote-workspace', focusedName: 'remote', focusedPath: null,
      focusedProject: null, focusedBranch: null, liveAgents: []
    }, now
  )
  assert.equal(remoteFocus.sessions.length, 0)
  assert.equal(remoteFocus.periods.worktree.day.tokens.total, 0)
  assert.equal(remoteFocus.periods.all.day.tokens.total, 180)
})

test('Live renders nested, orphaned and cyclic subagent cards once each', () => {
  const snap = createQuotaTestSnapshot(undefined, Date.now())
  const card = (key: string, parentSessionKey?: string): DashboardSnapshot['live']['agents'][number] => ({
    id: key, sessionKey: key, parentSessionKey, title: key, agent: 'codex', state: 'working',
    terminalId: null, providerLabel: 'OpenAI', modelLabel: 'Codex', projectName: null,
    workspaceName: 'main', workspacePath: null, updatedAt: snap.generatedAt,
    tokens: snap.live.tokens, tps: snap.live.tps, sparkline: [], outSeries: [], inSeries: [],
    liveOutRate: 10, liveInRate: 0
  })
  snap.live.agents = [card('main')]
  snap.live.subagents = [
    card('grandchild', 'child'), card('child', 'main'),
    card('orphan-leaf', 'orphan'), card('orphan', 'missing'),
    card('cycle-a', 'cycle-b'), card('cycle-b', 'cycle-a')
  ]
  const html = renderDashboardShellHtml({ snap, tab: 'live', scope: 'all', locale: 'en' })
  const keys = [...html.matchAll(/data-live-agent-key="([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual([...keys].sort(), ['main', ...snap.live.subagents.map((item) => item.sessionKey)].sort())
  assert.ok(keys.indexOf('child') < keys.indexOf('grandchild'))
  assert.ok(keys.indexOf('orphan') < keys.indexOf('orphan-leaf'))
})

test('enriches local usage with scoped public history without counting remote or reported totals', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-public-history-'))
  const orcaDir = path.join(home, 'orca')
  const workspacePath = path.join(home, 'repo')
  const sessionsPath = path.join(home, '.codex', 'sessions')
  const sessionId = '01a0c6de-1111-2222-3333-444455556666'
  const now = Date.now()
  try {
    fs.mkdirSync(sessionsPath, { recursive: true })
    fs.mkdirSync(orcaDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessionsPath, `rollout-2026-11-11T06-10-00-${sessionId}.jsonl`),
      [
        {
          timestamp: new Date(now - 10_000).toISOString(),
          type: 'session_meta',
          payload: { id: sessionId, cwd: workspacePath }
        },
        {
          timestamp: new Date(now - 5_000).toISOString(),
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Local transcript title' }
        },
        {
          timestamp: new Date(now - 2_000).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { total_tokens: 120 },
              last_token_usage: { input_tokens: 100, output_tokens: 20 }
            }
          }
        },
        {
          timestamp: new Date(now - 1_000).toISOString(),
          type: 'event_msg',
          payload: { type: 'task_complete' }
        }
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    )

    process.env.TOKEN_PULSE_HOME_DIR = home
    process.env.TOKEN_PULSE_ORCA_DATA_DIR = orcaDir
    const historyItem = {
      sessionId, agent: 'codex', title: 'Public history title', workspaceId: 'workspace-history',
      hostId: 'local', branch: 'main', createdAt: now - 10_000, updatedAt: now - 2_000,
      messageCount: 3, totalTokens: 9_000, running: true
    }
    let denyHistory = false
    const host = mockHost({
      results: {
        'workspace.list': () => ({
          workspaces: [{
            id: 'workspace-history', kind: 'worktree', hostId: 'local',
            name: 'main', project: 'repo', path: workspacePath, branch: 'main'
          }],
          truncated: false
        }),
        'workspace.readContext': () => ({
          workspaceId: 'workspace-history', displayName: 'main', branch: 'main', terminals: []
        }),
        'agents.list': () => ({
          agents: [{ terminalId: 'term-history', sessionId, agent: 'codex', title: 'codex', state: 'done', stateStartedAt: now }]
        }),
        'agent.listSessions': ({ workspaceId }: { workspaceId?: string }) => {
          if (denyHistory) throw hostError('capability_denied', 'History access was denied')
          return workspaceId === 'workspace-history'
            ? { sessions: [historyItem], truncated: false }
            : {
                sessions: [
                  { ...historyItem, hostId: 'ssh:other', title: 'Remote session with colliding ID' },
                  { ...historyItem, agent: 'claude', title: 'Different provider with colliding ID' }
                ],
                truncated: true
              }
        },
        'statusBar.update': () => ({ ok: true })
      }
    })
    const worker = await mountWorker(workerModule, { host })
    try {
      const snapshot = () => worker.request('dashboard.get', { forceScan: true })
      let snap = await snapshot()
      for (let i = 0; i < 10 && snap.sessions[0]?.title !== historyItem.title; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        snap = await snapshot()
      }
      assert.ok(host.callsOf('agent.listSessions').some((params) =>
        (params as { workspaceId?: string } | undefined)?.workspaceId === 'workspace-history'
      ))
      assert.equal(snap.sessions.length, 1)
      assert.equal(snap.sessions[0].title, historyItem.title)
      assert.equal(snap.live.agents[0].title, historyItem.title)
      assert.equal(snap.live.agents[0].state, 'done')
      assert.equal(snap.live.tps.liveTps, 0)
      assert.equal(snap.periods.all.day.tokens.total, 120)
      assert.equal(snap.periods.worktree.day.tokens.total, 120)

      denyHistory = true
      let denied = await snapshot()
      for (let i = 0; i < 10 && denied.sessions[0]?.title !== 'Local transcript title'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        denied = await snapshot()
      }
      assert.equal(denied.sessions[0].title, 'Local transcript title')
      assert.equal(denied.periods.all.day.tokens.total, 120)

      const rosterCalls = host.callsOf('agents.list').length
      await worker.emit('workspace.changed', { context: {
        workspaceId: 'unknown-workspace', displayName: 'Unknown', branch: 'main', terminals: []
      } })
      const unverifiedScope = await snapshot()
      assert.equal(host.callsOf('agents.list').length, rosterCalls)
      assert.equal(unverifiedScope.sessions.length, 0)
      assert.equal(unverifiedScope.periods.all.day.tokens.total, 120)
    } finally {
      await worker.deactivate()
    }
  } finally {
    delete process.env.TOKEN_PULSE_HOME_DIR
    delete process.env.TOKEN_PULSE_ORCA_DATA_DIR
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('renderDashboardShellHtml merges orphan subagents into the same status group without duplicate DONE headers', () => {
  const now = Date.now()
  const snap = createQuotaTestSnapshot(undefined, now)
  const makeAgent = (
    key: string,
    state: DashboardSnapshot['live']['agents'][number]['state'],
    title: string,
    parentSessionKey?: string
  ): DashboardSnapshot['live']['agents'][number] => ({
    id: key,
    sessionKey: key,
    parentSessionKey,
    title,
    agent: 'antigravity',
    state,
    terminalId: null,
    providerLabel: 'Google',
    modelLabel: 'gemini-4-flash',
    projectName: 'proj',
    workspaceName: 'main',
    workspacePath: '/tmp/proj',
    updatedAt: now,
    liveOutRate: 0,
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, costUsd: 0.01 },
    tps: { avgTps: 10, peakTps: 20, liveTps: 0 },
    sparkline: [0, 0, 0],
    io: { outSeries: [0], inSeries: [0], liveOutRate: 0, liveInRate: 0, peakOutRate: 0, peakInRate: 0 }
  })

  snap.live.agents = [
    makeAgent('antigravity:working-1', 'working', 'Active Root'),
    makeAgent('antigravity:done-1', 'done', 'Done Root 1'),
    makeAgent('antigravity:done-2', 'done', 'Done Root 2')
  ]
  snap.live.subagents = [
    makeAgent('antigravity:orphan-1', 'done', 'Orphan Subagent 1', 'antigravity:expired-parent'),
    makeAgent('antigravity:orphan-2', 'done', 'Orphan Subagent 2', 'antigravity:expired-parent')
  ]

  const html = renderDashboardShellHtml({
    snap,
    tab: 'live',
    scope: 'all',
    locale: 'en',
    nowMs: now
  })

  assert.ok(html.includes('class="tp-nav-sticky"'))
  assert.ok(html.includes('class="tp-live-kpi-sticky"'))
  assert.ok(html.includes('ACTIVE &amp; RECENT AGENTS (5)'))
  assert.equal((html.match(/data-collapse-key="live:done"/g) ?? []).length, 1)
  assert.ok(!html.includes('subagents:orphan:'))
  assert.ok(html.includes('<span>done (4)</span>'))
  assert.ok(html.includes('tp-subagent-orphans'))
  assert.ok(html.includes('Orphan Subagent 1'))
  assert.ok(html.includes('Done Root 1'))
})

test('assignSessionMascots guarantees unique species (<=8), species+palette (<=64), and full signatures (<=384) deterministically', () => {
  const keys8 = Array.from({ length: 8 }, (_, i) => `antigravity:session-${i}`)
  const map8 = assignSessionMascots(keys8)
  const map8Reversed = assignSessionMascots([...keys8].reverse())
  assert.equal(new Set([...map8.values()].map((m) => m.species)).size, 8)
  for (const key of keys8) {
    assert.equal(map8.get(key)?.signature, map8Reversed.get(key)?.signature)
  }

  const keys24 = Array.from({ length: 24 }, (_, i) => `antigravity:concurrent-${i}`)
  const map24 = assignSessionMascots(keys24)
  assert.equal(new Set([...map24.values()].map((m) => `${m.species}:${m.palette.id}`)).size, 24)

  const keys80 = Array.from({ length: 80 }, (_, i) => `antigravity:swarm-${i}`)
  const map80 = assignSessionMascots(keys80)
  assert.equal(new Set([...map80.values()].map((m) => m.signature)).size, 80)
})

test('renderDashboardShellHtml renders shared session race track only for active sessions and escapes titles', () => {
  const now = Date.now()
  const snap = createQuotaTestSnapshot(undefined, now)
  const makeAgent = (
    key: string,
    state: DashboardSnapshot['live']['agents'][number]['state'],
    title: string,
    liveOutRate: number
  ): DashboardSnapshot['live']['agents'][number] => ({
    id: key,
    sessionKey: key,
    title,
    agent: 'antigravity',
    state,
    terminalId: null,
    providerLabel: 'Google',
    modelLabel: 'gemini-4-neon',
    projectName: 'proj',
    workspaceName: 'main',
    workspacePath: '/tmp/proj',
    updatedAt: now,
    liveOutRate,
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, costUsd: 0.01 },
    tps: { avgTps: 10, peakTps: 20, liveTps: liveOutRate },
    sparkline: [0, liveOutRate],
    io: { outSeries: [0], inSeries: [0], liveOutRate, liveInRate: 0, peakOutRate: liveOutRate, peakInRate: 0 }
  })

  snap.live.agents = [
    makeAgent('antigravity:s1', 'working', 'Fast <script>alert(1)</script>', 140),
    makeAgent('antigravity:s2', 'waiting', 'Waiting session', 0),
    makeAgent('antigravity:s3', 'done', 'Finished session', 0)
  ]
  snap.live.subagents = []

  const html = renderDashboardShellHtml({ snap, tab: 'live', scope: 'all', locale: 'en', nowMs: now })
  assert.ok(html.includes('class="tp-race-card"'))
  assert.equal((html.match(/data-race-agent-key="/g) ?? []).length, 2)
  assert.ok(html.includes('data-race-agent-key="antigravity:s1"'))
  assert.ok(html.includes('data-race-agent-key="antigravity:s2"'))
  assert.ok(!html.includes('data-race-agent-key="antigravity:s3"'))
  assert.ok(html.includes('class="tp-racer-avatar"'))
  assert.ok(!html.includes('<script>alert(1)</script>'))

  // When working agents are all at 0 tok/s (thinking), do not crown a 0 tok/s leader
  snap.live.agents = [makeAgent('antigravity:s1', 'working', 'Thinking session', 0)]
  const thinkingHtml = renderDashboardShellHtml({ snap, tab: 'live', scope: 'all', locale: 'en', nowMs: now })
  assert.ok(thinkingHtml.includes('💭 1 thinking'))
  assert.ok(!thinkingHtml.includes('tp-race-crown'))
  assert.ok(!thinkingHtml.includes('tp-view-sub'))
  assert.ok(!thinkingHtml.includes('tp-section-hint'))
  assert.equal((thinkingHtml.match(/ACTIVE TOKENS/g) ?? []).length, 1)

  // When all sessions are done, race track should not render
  snap.live.agents = [makeAgent('antigravity:s3', 'done', 'Finished session', 0)]
  const idleHtml = renderDashboardShellHtml({ snap, tab: 'live', scope: 'all', locale: 'en', nowMs: now })
  assert.ok(!idleHtml.includes('class="tp-race-card"'))
})

test('Stats view consolidates Day/Week/Month into 4 primary tabs and renders Agent/Model/Project breakdowns', () => {
  const now = Date.now()
  const snap = createQuotaTestSnapshot(undefined, now)
  snap.periods.all.day = {
    tokens: { input: 1000, output: 500, reasoning: 0, cacheRead: 200, cacheWrite: 0, total: 1700, costUsd: 1.25 },
    tps: { liveTps: 40, avgTps: 35, peakTps: 60 },
    previousTotalTokens: 1000,
    deltaPercent: 70,
    buckets: [],
    byAgent: [
      {
        agent: 'antigravity',
        providerLabel: 'Google',
        sharePercent: 100,
        tokens: { input: 1000, output: 500, reasoning: 0, cacheRead: 200, cacheWrite: 0, total: 1700, costUsd: 1.25 },
        tps: { liveTps: 40, avgTps: 35, peakTps: 60 },
        topModel: 'gemini-4-neon'
      }
    ],
    byModel: [
      {
        modelLabel: 'gemini-4-neon',
        providerLabel: 'Google',
        agent: 'antigravity',
        sharePercent: 100,
        tokens: { input: 1000, output: 500, reasoning: 0, cacheRead: 200, cacheWrite: 0, total: 1700, costUsd: 1.25 },
        tps: { liveTps: 40, avgTps: 35, peakTps: 60 }
      }
    ],
    byProject: [
      {
        projectKey: 'orca-token-used / main',
        label: 'orca-token-used / main',
        sharePercent: 100,
        tokens: { input: 1000, output: 500, reasoning: 0, cacheRead: 200, cacheWrite: 0, total: 1700, costUsd: 1.25 },
        sessionCount: 3
      }
    ]
  }

  const modelHtml = renderDashboardShellHtml({
    snap,
    tab: 'day',
    scope: 'all',
    locale: 'en',
    statsBreakdown: 'model',
    nowMs: now
  })
  assert.ok(modelHtml.includes('data-tab="day"'))
  assert.ok(modelHtml.includes('data-tab="week"'))
  assert.ok(modelHtml.includes('data-tab="month"'))
  assert.ok(modelHtml.includes('<span class="tp-nav-label">Stats</span>'))
  assert.ok(modelHtml.includes('data-breakdown="model"'))
  assert.ok(modelHtml.includes('gemini-4-neon'))

  const projectHtml = renderDashboardShellHtml({
    snap,
    tab: 'day',
    scope: 'all',
    locale: 'en',
    statsBreakdown: 'project',
    nowMs: now
  })
  assert.ok(projectHtml.includes('orca-token-used / main'))
  assert.ok(projectHtml.includes(`3 ${getMessages('en').sessionsCountSuffix}`))
})

test('decluttered views remove subheaders & hero rate duplication, flatten Sessions, move pricing sync to footer, and display cache hit rate', () => {
  assert.equal(
    computeCacheHitPercent({ input: 200, output: 100, reasoning: 0, cacheRead: 1800, cacheWrite: 0, total: 2100, costUsd: 0.1 }),
    90
  )
  assert.equal(
    computeCacheHitPercent({ input: 2000, output: 100, reasoning: 0, cacheRead: 500, cacheWrite: 0, total: 2600, costUsd: 0.1 }),
    20
  )
  assert.equal(
    computeCacheHitPercent({ input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 150, costUsd: 0 }),
    null
  )

  const now = Date.now()
  const snap = createQuotaTestSnapshot(undefined, now)
  snap.live.agents = [
    {
      id: 'antigravity:low-cache',
      sessionKey: 'antigravity:low-cache',
      title: 'Low cache session',
      agent: 'antigravity',
      state: 'working',
      terminalId: null,
      providerLabel: 'Google',
      modelLabel: 'gemini-4-neon',
      projectName: 'proj',
      workspaceName: 'main',
      workspacePath: '/tmp/proj',
      updatedAt: now,
      liveOutRate: 42,
      liveInRate: 12,
      tokens: { input: 6000, output: 500, reasoning: 0, cacheRead: 1000, cacheWrite: 0, total: 7500, costUsd: 0.45 },
      tps: { avgTps: 30, peakTps: 50, liveTps: 42 },
      sparkline: [0, 42],
      outSeries: [0, 42],
      inSeries: [0, 12]
    }
  ]

  const liveHtml = renderDashboardShellHtml({ snap, tab: 'live', scope: 'all', locale: 'en', nowMs: now })
  assert.ok(!liveHtml.includes('tp-subheader'))
  assert.ok(liveHtml.includes('class="tp-footer-sync-btn'))
  assert.ok(liveHtml.includes('tp-cache-hit-low'))
  assert.ok(liveHtml.includes('Cache 14%'))

  const detailHtml = renderDashboardShellHtml({
    snap,
    tab: 'live',
    scope: 'all',
    locale: 'en',
    selectedLiveAgentKey: 'antigravity:low-cache',
    nowMs: now
  })
  assert.ok(!detailHtml.includes('tp-io-hero-rates'))
  assert.ok(detailHtml.includes('data-live-back="1"'))
  assert.ok(detailHtml.includes('data-io-text="cache-hit"'))

  snap.sessions = [
    {
      sessionId: 'sess-1',
      agent: 'antigravity',
      providerLabel: 'Google',
      modelLabel: 'gemini-4-neon',
      title: 'Flat session item',
      projectName: 'proj',
      workspaceName: 'main',
      workspacePath: '/tmp/proj',
      updatedAt: now,
      createdAt: now - 1000,
      active: false,
      tps: { avgTps: 20, peakTps: 30, liveTps: 0 },
      tokens: { input: 2000, output: 500, reasoning: 0, cacheRead: 8000, cacheWrite: 0, total: 10500, costUsd: 0.05 }
    }
  ]
  const sessionsHtml = renderDashboardShellHtml({ snap, tab: 'sessions', scope: 'all', locale: 'en', nowMs: now })
  assert.ok(!sessionsHtml.includes('sessions:recent'))
  assert.ok(!sessionsHtml.includes('sessions:active'))
  assert.ok(sessionsHtml.includes('Flat session item'))
  assert.ok(sessionsHtml.includes('Cache 80%'))

  snap.periods.all.day.tokens = {
    input: 6000,
    output: 500,
    reasoning: 0,
    cacheRead: 2000,
    cacheWrite: 0,
    total: 8500,
    costUsd: 0.42
  }
  const statsHtml = renderDashboardShellHtml({ snap, tab: 'day', scope: 'all', locale: 'en', nowMs: now })
  assert.ok(statsHtml.includes('tp-cache-hit-low'))
  assert.ok(statsHtml.includes('>25%</span>'))
})

test('Live Race groups parent + active subagents into family duckling squad trains with overflow badge and preserves active orphans', () => {
  const now = Date.now()
  const snap = createQuotaTestSnapshot(undefined, now)
  const makeCard = (
    key: string,
    state: DashboardSnapshot['live']['agents'][number]['state'],
    title: string,
    liveOutRate: number,
    parentSessionKey?: string
  ): DashboardSnapshot['live']['agents'][number] => ({
    id: key,
    sessionKey: key,
    parentSessionKey,
    title,
    agent: 'antigravity',
    state,
    terminalId: null,
    providerLabel: 'Google',
    modelLabel: 'gemini-pro-orchestrator-neon',
    projectName: 'proj',
    workspaceName: 'main',
    workspacePath: '/tmp/proj',
    updatedAt: now,
    liveOutRate,
    liveInRate: 0,
    tokens: { input: 1000, output: 500, reasoning: 0, cacheRead: 2000, cacheWrite: 0, total: 3500, costUsd: 0.2 },
    tps: { avgTps: 20, peakTps: 50, liveTps: liveOutRate },
    sparkline: [0, liveOutRate],
    outSeries: [0, liveOutRate],
    inSeries: [0, 0]
  })

  const parent = makeCard('agy:parent-1', 'waiting', '# console改造', 0)
  const sub1 = makeCard('agy:sub-1', 'working', 'infra', 40, 'agy:parent-1')
  const sub2 = makeCard('agy:sub-2', 'working', 'icons', 25, 'agy:parent-1')
  const sub3 = makeCard('agy:sub-3', 'working', 'tests', 15, 'agy:parent-1')
  const sub4 = makeCard('agy:sub-4', 'working', 'docs', 10, 'agy:parent-1')
  const orphan = makeCard('agy:orphan-1', 'working', 'solo-worker', 30, 'agy:missing-parent')

  const { squads, mascotByKey, totalActiveCount } = buildActiveRaceSquads(
    [parent],
    [sub1, sub2, sub3, sub4, orphan]
  )
  assert.equal(totalActiveCount, 6)
  assert.equal(squads.length, 2)

  const mainSquad = squads.find((sq) => sq.lead.sessionKey === 'agy:parent-1')!
  assert.equal(mainSquad.subagents.length, 4)
  assert.equal(mainSquad.totalRate, 90)

  // Family inheritance: children share parent's species + palette, with distinct accessory
  const parentMascot = mascotByKey.get('agy:parent-1')!
  for (const subKey of ['agy:sub-1', 'agy:sub-2', 'agy:sub-3', 'agy:sub-4']) {
    const childMascot = mascotByKey.get(subKey)!
    assert.equal(childMascot.species, parentMascot.species)
    assert.equal(childMascot.palette.id, parentMascot.palette.id)
    assert.notEqual(childMascot.accessory, parentMascot.accessory)
  }

  snap.live.agents = [parent]
  snap.live.subagents = [sub1, sub2, sub3, sub4, orphan]
  const html = renderDashboardShellHtml({ snap, tab: 'live', scope: 'all', locale: 'en', nowMs: now })
  assert.ok(html.includes('🏁 LIVE RACE · 2 (6)'))
  assert.equal((html.match(/data-race-agent-key="/g) ?? []).length, 2)
  assert.equal((html.match(/class="tp-race-duckling"/g) ?? []).length, 3)
  assert.ok(html.includes('class="tp-race-more"'))
  assert.ok(html.includes('+1</span>'))
  assert.ok(html.includes('tp-racer-avatar-sub'))
  assert.ok(html.includes('(+4)'))
})

test('all 6 locales (including cs) have complete i18n keys, localized Live Race labels, and wrapped quota account rows', () => {
  const locales = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'cs'] as const
  const enKeys = Object.keys(getMessages('en')).sort()
  for (const loc of locales) {
    const msg = getMessages(loc)
    assert.deepEqual(Object.keys(msg).sort(), enKeys, `locale ${loc} key mismatch`)
    assert.ok(msg.liveRaceLabel.length > 0, `locale ${loc} missing liveRaceLabel`)
    assert.ok(msg.navShort.stats.length > 0, `locale ${loc} missing navShort.stats`)
    assert.ok(msg.breakdownModes.model.length > 0, `locale ${loc} missing breakdownModes.model`)
    assert.ok(msg.breakdownModes.project.length > 0, `locale ${loc} missing breakdownModes.project`)
    assert.ok(msg.raceThinking(2).includes('2'), `locale ${loc} raceThinking`)
    assert.ok(msg.raceWaiting(3).includes('3'), `locale ${loc} raceWaiting`)
    assert.ok(msg.raceSubagentsShort(2).includes('2'), `locale ${loc} raceSubagentsShort`)
  }

  const now = Date.now()
  const snap = createQuotaTestSnapshot(
    {
      source: 'live',
      syncedAt: now,
      refreshing: false,
      lastError: null,
      providers: [
        createProviderSnapshot('antigravity', {
          label: 'Antigravity',
          accounts: [
            {
              id: 'acc-1',
              email: 'alice@example.com',
              label: null,
              authKind: 'oauth',
              active: true,
              status: 'ok',
              error: null,
              session: null,
              weekly: null,
              pools: [
                {
                  id: 'gemini',
                  label: 'Gemini Models',
                  session: { usedPercent: 38, windowMinutes: 300, resetsAt: null, resetDescription: null },
                  weekly: { usedPercent: 17, windowMinutes: 10080, resetsAt: null, resetDescription: null }
                },
                {
                  id: 'claude-gpt',
                  label: 'Claude and GPT models',
                  session: null,
                  weekly: { usedPercent: 100, windowMinutes: 10080, resetsAt: null, resetDescription: null }
                }
              ]
            },
            {
              id: 'acc-2',
              email: 'bob@example.com',
              label: null,
              authKind: 'oauth',
              active: false,
              status: 'ok',
              error: null,
              session: null,
              weekly: null,
              pools: []
            }
          ]
        })
      ]
    },
    now
  )

  const csHtml = renderDashboardShellHtml({
    snap,
    tab: 'quotas',
    scope: 'all',
    locale: 'cs',
    collapsedGroups: { 'quotas:accounts:antigravity': false },
    nowMs: now
  })
  assert.ok(csHtml.includes('class="tp-quota-account-hdr"'))
  assert.ok(csHtml.includes('class="tp-quota-account-summary"'))
  assert.ok(csHtml.includes('alice@example.com'))
  assert.ok(csHtml.includes('Neuplatňuje se'))
  assert.ok(!csHtml.includes('flex-shrink:0" title="Gemini Models'))

  snap.live.agents = [
    {
      id: 'agy:cs-1',
      sessionKey: 'agy:cs-1',
      title: 'Czech test',
      agent: 'antigravity',
      state: 'working',
      terminalId: null,
      providerLabel: 'Google',
      modelLabel: 'gemini-4-neon',
      projectName: 'proj',
      workspaceName: 'main',
      workspacePath: '/tmp/proj',
      updatedAt: now,
      liveOutRate: 0,
      liveInRate: 0,
      tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 150, costUsd: 0 },
      tps: { avgTps: 0, peakTps: 0, liveTps: 0 },
      sparkline: [0],
      outSeries: [0],
      inSeries: [0]
    }
  ]
  const csLiveHtml = renderDashboardShellHtml({ snap, tab: 'live', scope: 'all', locale: 'cs', nowMs: now })
  assert.ok(csLiveHtml.includes('ŽIVÝ ZÁVOD'))
  assert.ok(csLiveHtml.includes('1 přemýšlí'))
})

describe('Background task tracking, working-state preservation, and compact UI strip', () => {
  test('Antigravity background task followed by PLANNER_RESPONSE(DONE) + ptyState=working (>45s) stays working and exposes backgroundTasks', () => {
    const startMs = Date.parse('2026-11-24T06:00:00Z')
    const now = startMs + 90_000 // 90s elapsed (>45s inactivity threshold)
    const st = createEmptySessionState('ag-bg-1', 'antigravity', '/tmp/ag-bg-1.jsonl')
    st.cwd = '/Users/dev/project-alpha'
    applyAntigravityLines(st, [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-24T05:59:50Z',
        content: '<USER_REQUEST>Run full test suite in background</USER_REQUEST>'
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T05:59:55Z',
        model: 'gemini-4-neon-high',
        input_tokens: 4000,
        output_tokens: 180,
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'pnpm test --watch=false' } }]
      }),
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:00:00Z',
        content:
          'Created At: 2026-11-24T14:00:00+08:00\n' +
          'Tool is running as a background task with task id: ag-bg-1/task-2\n' +
          'Task Description: pnpm test --watch=false\n' +
          'Task logs are available at: file:///Users/dev/.gemini/antigravity-cli/brain/ag-bg-1/.system_generated/tasks/task-2.log\n'
      }),
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:04Z',
        model: 'gemini-4-neon-high',
        input_tokens: 4200,
        output_tokens: 90,
        tool_calls: []
      })
    ])

    assert.equal(st.lastEventState, 'done')
    assert.equal(resolveSessionRunState(st, 'working', now, startMs - 5_000), 'working')
    assert.equal(resolveSessionRunState(st, null, now, 0), 'working')
    // Stale historical transcript (>30m old) with no live PTY must NOT stay working forever
    assert.equal(resolveSessionRunState(st, null, startMs + 2 * 3600_000, 0), 'done')

    const pricing = new PricingEngine()
    const journal = createTestJournalIndex()
    const runtime = {
      focusedPath: '/Users/dev/project-alpha',
      focusedName: 'project-alpha',
      focusedBranch: 'main',
      liveAgents: [
        {
          terminalId: 'term-bg-1',
          sessionId: 'ag-bg-1',
          title: 'Background runner',
          agent: 'antigravity',
          state: 'working' as const,
          stateStartedAt: startMs - 5_000,
          workspacePath: '/Users/dev/project-alpha'
        }
      ]
    }
    const snap = buildDashboardSnapshot([st], journal, pricing, runtime, now)
    assert.equal(snap.live.agents.length, 1)
    assert.equal(snap.live.agents[0].state, 'working')
    assert.deepEqual(snap.live.agents[0].backgroundTasks, [
      { id: 'ag-bg-1/task-2', label: 'pnpm test --watch=false', startedAt: startMs }
    ])

    const polled = pollSingleLiveAgent('antigravity:ag-bg-1', [st], journal, pricing, runtime, now)
    assert.ok(polled)
    assert.equal(polled.state, 'working')
    assert.deepEqual(polled.backgroundTasks, [
      { id: 'ag-bg-1/task-2', label: 'pnpm test --watch=false', startedAt: startMs }
    ])
  })

  test('Background task clears on SYSTEM_MESSAGE completion/cancel/restart, step status transition, and authoritative ptyState=done', () => {
    const startMs = Date.parse('2026-11-24T06:00:00Z')
    const now = startMs + 120_000

    // 1) SYSTEM_MESSAGE finished with result + still-running notification does NOT clear
    const st1 = createEmptySessionState('ag-bg-done', 'antigravity', '/tmp/ag-bg-done.jsonl')
    applyAntigravityLines(st1, [
      JSON.stringify({
        step_index: 1,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:00:00Z',
        content:
          'Tool is running as a background task with task id: ag-bg-done/task-1\n' +
          'Task Description: cargo test --workspace'
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:03Z',
        input_tokens: 1000,
        output_tokens: 50,
        tool_calls: []
      }),
      JSON.stringify({
        step_index: 3,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:30Z',
        content:
          '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-24T06:00:30Z sender=ag-bg-done/task-1 priority=MESSAGE_PRIORITY_HIGH content=Task id "ag-bg-done/task-1" is still running.\n</SYSTEM_MESSAGE>'
      })
    ])
    assert.equal(resolveSessionRunState(st1, 'working', now, startMs - 1_000), 'working')

    applyAntigravityLines(st1, [
      JSON.stringify({
        step_index: 4,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:45Z',
        content:
          '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-24T06:00:45Z sender=ag-bg-done/task-1 priority=MESSAGE_PRIORITY_HIGH content=Task id "ag-bg-done/task-1" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>'
      }),
      JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:50Z',
        input_tokens: 1200,
        output_tokens: 80,
        tool_calls: []
      })
    ])
    assert.equal(resolveSessionRunState(st1, 'working', now, startMs - 1_000), 'done')

    // 2) SYSTEM_MESSAGE canceled
    const st2 = createEmptySessionState('ag-bg-cancel', 'antigravity', '/tmp/ag-bg-cancel.jsonl')
    applyAntigravityLines(st2, [
      JSON.stringify({
        step_index: 1,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:00:00Z',
        content:
          'Tool is running as a background task with task id: ag-bg-cancel/task-1\n' +
          'Task Description: sleep 600'
      }),
      JSON.stringify({
        step_index: 2,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:20Z',
        content:
          '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-24T06:00:20Z sender=ag-bg-cancel/task-1 priority=MESSAGE_PRIORITY_HIGH content=Task id "ag-bg-cancel/task-1" was canceled with result:\n</SYSTEM_MESSAGE>'
      }),
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:22Z',
        input_tokens: 1000,
        output_tokens: 40,
        tool_calls: []
      })
    ])
    assert.equal(resolveSessionRunState(st2, 'working', now, startMs - 1_000), 'done')

    // 3) Same step_index status transition RUNNING -> DONE
    const st3 = createEmptySessionState('ag-bg-step', 'antigravity', '/tmp/ag-bg-step.jsonl')
    applyAntigravityLines(st3, [
      JSON.stringify({
        step_index: 5,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:00:00Z',
        content:
          'Tool is running as a background task with task id: ag-bg-step/task-5\n' +
          'Task Description: npm run build'
      }),
      JSON.stringify({
        step_index: 5,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-24T06:00:15Z',
        content: 'Command exited with code 0.'
      }),
      JSON.stringify({
        step_index: 6,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:18Z',
        input_tokens: 1000,
        output_tokens: 40,
        tool_calls: []
      })
    ])
    assert.equal(resolveSessionRunState(st3, 'working', now, startMs - 1_000), 'done')

    // 4) Server restart clears ALL tasks
    const st4 = createEmptySessionState('ag-bg-restart', 'antigravity', '/tmp/ag-bg-restart.jsonl')
    applyAntigravityLines(st4, [
      JSON.stringify({
        step_index: 1,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:00:00Z',
        content: 'Tool is running as a background task with task id: ag-bg-restart/task-1\nTask Description: cmd1'
      }),
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:00:02Z',
        content: 'Tool is running as a background task with task id: ag-bg-restart/task-2\nTask Description: cmd2'
      }),
      JSON.stringify({
        step_index: 3,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:10Z',
        content:
          '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-24T06:00:10Z sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents and background tasks have been stopped due to server restart.\n</SYSTEM_MESSAGE>'
      }),
      JSON.stringify({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:12Z',
        input_tokens: 1000,
        output_tokens: 40,
        tool_calls: []
      })
    ])
    assert.equal(resolveSessionRunState(st4, 'working', now, startMs - 1_000), 'done')

    // 5) Authoritative Orca ptyState === 'done' with ptyStateStartedAt >= latestTaskStartedAt
    const st5 = createEmptySessionState('ag-bg-ptydone', 'antigravity', '/tmp/ag-bg-ptydone.jsonl')
    applyAntigravityLines(st5, [
      JSON.stringify({
        step_index: 1,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:00:00Z',
        content: 'Tool is running as a background task with task id: ag-bg-ptydone/task-1\nTask Description: vite build'
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:04Z',
        input_tokens: 1000,
        output_tokens: 40,
        tool_calls: []
      })
    ])
    assert.equal(resolveSessionRunState(st5, 'done', now, startMs + 10_000), 'done')
    const snapDone = buildDashboardSnapshot(
      [st5],
      createTestJournalIndex(),
      new PricingEngine(),
      {
        focusedPath: null,
        focusedName: null,
        focusedBranch: null,
        liveAgents: [
          {
            terminalId: 'term-done',
            sessionId: 'ag-bg-ptydone',
            title: 'Done runner',
            agent: 'antigravity',
            state: 'done',
            stateStartedAt: startMs + 10_000,
            workspacePath: '/Users/dev/project-alpha'
          }
        ]
      },
      now
    )
    assert.equal(snapDone.live.agents[0].state, 'done')
    assert.equal(snapDone.live.agents[0].backgroundTasks, undefined)
  })

  test('Multiple concurrent background tasks render compact card strip with +2 badge, elapsed timer, and I/O detail list', () => {
    const t1 = Date.parse('2026-11-24T06:00:00Z')
    const t2 = Date.parse('2026-11-24T06:01:10Z')
    const t3 = Date.parse('2026-11-24T06:02:20Z')
    const now = t1 + (7 * 60 + 48) * 1000 // 7m 48s after t1

    const st = createEmptySessionState('ag-multi-bg', 'antigravity', '/tmp/ag-multi-bg.jsonl')
    st.cwd = '/Users/dev/proj'
    applyAntigravityLines(st, [
      JSON.stringify({
        step_index: 1,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:00:00Z',
        content: 'Tool is running as a background task with task id: ag-multi-bg/task-1\nTask Description: pnpm run typecheck'
      }),
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:01:10Z',
        content: 'Tool is running as a background task with task id: ag-multi-bg/task-2\nTask Description: pytest tests/e2e'
      }),
      JSON.stringify({
        step_index: 3,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:02:20Z',
        content: 'Tool is running as a background task with task id: ag-multi-bg/task-3\nTask Description: docker compose build'
      }),
      JSON.stringify({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T06:02:25Z',
        input_tokens: 2000,
        output_tokens: 100,
        tool_calls: []
      })
    ])

    const snap = buildDashboardSnapshot(
      [st],
      createTestJournalIndex(),
      new PricingEngine(),
      {
        focusedPath: '/Users/dev/proj',
        focusedName: 'proj',
        focusedBranch: 'main',
        liveAgents: [
          {
            terminalId: 'term-multi',
            sessionId: 'ag-multi-bg',
            title: 'Multi BG',
            agent: 'antigravity',
            state: 'working',
            stateStartedAt: t1 - 5_000,
            workspacePath: '/Users/dev/proj'
          }
        ]
      },
      now
    )
    const card = snap.live.agents[0]
    assert.equal(card.state, 'working')
    assert.equal(card.backgroundTasks?.length, 3)
    assert.deepEqual(
      card.backgroundTasks?.map((b) => b.startedAt),
      [t1, t2, t3]
    )

    const liveHtml = renderDashboardShellHtml({
      snap,
      tab: 'live',
      scope: 'all',
      locale: 'en',
      nowMs: now
    })
    assert.ok(liveHtml.includes('class="tp-bg-strip"'))
    assert.ok(liveHtml.includes('&gt;_'))
    assert.ok(liveHtml.includes('pnpm run typecheck'))
    assert.ok(liveHtml.includes('class="tp-bg-more">+2</span>'))
    assert.ok(liveHtml.includes(`data-bg-started-at="${t1}"`))
    assert.ok(liveHtml.includes('7m 48s'))
    assert.ok(liveHtml.includes('pytest tests/e2e'))
    assert.ok(liveHtml.includes('docker compose build'))
    // Top-right TPS slot keeps normal tok/s (no "bg" badge)
    assert.ok(liveHtml.includes('0 tok/s<span class="tp-expand-chevron">›</span>'))
    assert.ok(!liveHtml.includes('3 bg'))

    const detailHtml = renderLiveAgentDetailHtml(card, getMessages('en'), now)
    assert.ok(detailHtml.includes('BACKGROUND TASKS (3)'))
    assert.ok(detailHtml.includes('pnpm run typecheck'))
    assert.ok(detailHtml.includes('pytest tests/e2e'))
    assert.ok(detailHtml.includes('docker compose build'))
    assert.equal((detailHtml.match(/data-bg-started-at="/g) ?? []).length, 3)
  })

  test('XSS payloads in Task Description are escaped in both card strip and detail view, and normal completed turn still resolves to done', () => {
    const startMs = Date.parse('2026-11-24T06:00:00Z')
    const now = startMs + 60_000
    const xssDesc = `<script>alert("xss")</script> & 'danger'`

    const stXss = createEmptySessionState('ag-bg-xss', 'antigravity', '/tmp/ag-bg-xss.jsonl')
    applyAntigravityLines(stXss, [
      JSON.stringify({
        step_index: 1,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:00:00Z',
        content: `Tool is running as a background task with task id: ag-bg-xss/task-1\nTask Description: ${xssDesc}`
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:04Z',
        input_tokens: 1500,
        output_tokens: 80,
        tool_calls: []
      })
    ])

    const snap = buildDashboardSnapshot(
      [stXss],
      createTestJournalIndex(),
      new PricingEngine(),
      {
        focusedPath: null,
        focusedName: null,
        focusedBranch: null,
        liveAgents: [
          {
            terminalId: 'term-xss',
            sessionId: 'ag-bg-xss',
            title: 'XSS test',
            agent: 'antigravity',
            state: 'working',
            stateStartedAt: startMs - 2_000,
            workspacePath: '/Users/dev/proj'
          }
        ]
      },
      now
    )

    const liveHtml = renderDashboardShellHtml({ snap, tab: 'live', scope: 'all', locale: 'en', nowMs: now })
    const detailHtml = renderLiveAgentDetailHtml(snap.live.agents[0], getMessages('en'), now)
    assert.ok(!liveHtml.includes('<script>'))
    assert.ok(!detailHtml.includes('<script>'))
    assert.ok(liveHtml.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'))
    assert.ok(detailHtml.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'))

    // Regression: normal completed Antigravity turn with NO background tasks still resolves to 'done'
    const stNormal = createEmptySessionState('ag-normal-done', 'antigravity', '/tmp/ag-normal-done.jsonl')
    applyAntigravityLines(stNormal, [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-24T06:00:00Z',
        content: '<USER_REQUEST>Say hello</USER_REQUEST>'
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:05Z',
        input_tokens: 500,
        output_tokens: 30,
        tool_calls: []
      })
    ])
    assert.equal(resolveSessionRunState(stNormal, 'working', startMs + 60_000, startMs - 1_000), 'done')
    const normalCardHtml = renderLiveAgentDetailHtml(
      {
        ...snap.live.agents[0],
        state: 'done',
        backgroundTasks: undefined
      },
      getMessages('en'),
      now
    )
    assert.ok(!normalCardHtml.includes('tp-io-bg-section'))
    assert.ok(!normalCardHtml.includes('BACKGROUND TASKS'))
  })

  test('Caps active background tasks at 32, sanitizes labels, skips Cron daemons, clears Timer & manage_task, and formats/updates elapsed timers', () => {
    // 1) Cap at 32 entries per session
    const stCap = createEmptySessionState('ag-cap', 'antigravity', '/tmp/ag-cap.jsonl')
    const launchLines: string[] = []
    for (let i = 1; i <= 40; i++) {
      launchLines.push(
        JSON.stringify({
          step_index: i,
          type: 'GENERIC',
          status: 'RUNNING',
          created_at: new Date(Date.parse('2026-11-24T06:00:00Z') + i * 1000).toISOString(),
          content: `Tool is running as a background task with task id: ag-cap/task-${i}\nTask Description: cmd-${i}`
        })
      )
    }
    applyAntigravityLines(stCap, launchLines)
    assert.equal(stCap.activeBackgroundTasks?.size, 32)
    assert.equal(stCap.activeBackgroundTasks?.has('ag-cap/task-1'), false)
    assert.equal(stCap.activeBackgroundTasks?.has('ag-cap/task-9'), true)
    assert.equal(stCap.activeBackgroundTasks?.has('ag-cap/task-40'), true)

    // 2) Scratch path shortening, length cap (<= 160), run_command fallback, Cron ignored, Timer & manage_task cleanup
    const stLabel = createEmptySessionState('ag-lbl', 'antigravity', '/tmp/ag-lbl.jsonl')
    const longArg = 'x'.repeat(220)
    applyAntigravityLines(stLabel, [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:00Z',
        input_tokens: 1000,
        output_tokens: 50,
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"pnpm lint"' } }]
      }),
      // No Task Description -> falls back to run_command CommandLine
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:00:02Z',
        content: 'Tool is running as a background task with task id: ag-lbl/task-2\nTask logs are available at: file:///tmp/task-2.log'
      }),
      // Scratch path shortened & bounded to <= 160 chars
      JSON.stringify({
        step_index: 3,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:00:04Z',
        content:
          'Tool is running as a background task with task id: ag-lbl/task-3\n' +
          `Task Description: python3 /Users/alice/.gemini/antigravity-cli/brain/11111111-2222-3333-4444-555555555555/scratch/verify.py ${longArg}`
      }),
      // Recurring Cron daemon ignored
      JSON.stringify({
        step_index: 4,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:00:05Z',
        content:
          'Tool is running as a background task with task id: ag-lbl/task-4\n' +
          'Task Description: Cron: */3 * * * *, Prompt: [monitor] tick'
      }),
      // One-shot Timer tracked, then cleared when its SYSTEM_MESSAGE fires
      JSON.stringify({
        step_index: 5,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-24T06:00:06Z',
        content:
          'Tool is running as a background task with task id: ag-lbl/task-5\n' +
          'Task Description: Timer: 5s, Prompt: Re-check build'
      })
    ])
    assert.equal(stLabel.activeBackgroundTasks?.get('ag-lbl/task-2')?.label, 'pnpm lint')
    const shortLabel = stLabel.activeBackgroundTasks?.get('ag-lbl/task-3')?.label ?? ''
    assert.ok(shortLabel.startsWith('python3 scratch/verify.py '))
    assert.ok(shortLabel.length <= 160)
    assert.equal(stLabel.activeBackgroundTasks?.has('ag-lbl/task-4'), false)
    assert.equal(stLabel.activeBackgroundTasks?.has('ag-lbl/task-5'), true)

    applyAntigravityLines(stLabel, [
      JSON.stringify({
        step_index: 6,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-24T06:00:11Z',
        content:
          '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-24T06:00:11Z sender=ag-lbl/task-5 priority=MESSAGE_PRIORITY_HIGH content=Re-check build\n</SYSTEM_MESSAGE>'
      }),
      JSON.stringify({
        step_index: 7,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-24T06:00:12Z',
        content: 'Task: ag-lbl/task-2\nStatus: DONE\nLog: ok'
      }),
      JSON.stringify({
        step_index: 8,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-24T06:00:13Z',
        content: 'Killed task ag-lbl/task-3'
      })
    ])
    assert.equal(stLabel.activeBackgroundTasks?.size, 0)

    // 3) formatElapsedDuration + lightweight DOM updater + all 6 locales have backgroundTasksHeader
    assert.equal(formatElapsedDuration(-500), '0s')
    assert.equal(formatElapsedDuration(NaN), '0s')
    assert.equal(formatElapsedDuration(0), '0s')
    assert.equal(formatElapsedDuration(42_900), '42s')
    assert.equal(formatElapsedDuration((7 * 60 + 48) * 1000), '7m 48s')
    assert.equal(formatElapsedDuration((3600 + 2 * 60 + 5) * 1000), '1h 2m 5s')

    const baseMs = 1_700_000_000_000
    const fakeNodes = [
      { dataset: { bgStartedAt: String(baseMs) }, textContent: '0s', getAttribute: () => String(baseMs) },
      { dataset: { bgStartedAt: String(baseMs - 65_000) }, textContent: '1m 5s', getAttribute: () => String(baseMs - 65_000) }
    ]
    const fakeRoot = {
      querySelectorAll: () => fakeNodes
    } as unknown as ParentNode
    assert.equal(updateBgElapsedNodes(fakeRoot, baseMs + 12_000), 2)
    assert.equal(fakeNodes[0].textContent, '12s')
    assert.equal(fakeNodes[1].textContent, '1m 17s')
    const emptyRoot = { querySelectorAll: () => [] } as unknown as ParentNode
    assert.equal(updateBgElapsedNodes(emptyRoot, baseMs + 12_000), 0)

    for (const loc of ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'cs'] as const) {
      assert.ok(getMessages(loc).backgroundTasksHeader.length > 0, `locale ${loc} missing backgroundTasksHeader`)
    }
  })
})

describe('Per-agent tracking switches: aggregator', () => {
  const now = Date.now()
  const workspace = {
    focusedId: null,
    focusedProject: null,
    focusedName: null,
    focusedBranch: null,
    focusedPath: null
  }

  function sessionWithTurn(id: string, agent: 'claude' | 'codex') {
    const st = createEmptySessionState(id, agent, `/tmp/${id}.jsonl`)
    st.updatedAtMs = now - 5_000
    st.lastMtimeMs = now - 5_000
    st.turnsByKey.set('t1', {
      turnKey: 't1',
      timestampMs: now - 5_000,
      input: 1000,
      output: 500,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1500,
      durationSec: 5,
      tps: 100,
      model: agent === 'claude' ? 'claude-fable-5' : 'gpt-6.1-terra',
      explicitCostUsd: null
    })
    return st
  }

  const liveAgents = [
    { terminalId: 'pty-claude', title: 'claude work', agent: 'claude', state: 'working' as const, stateStartedAt: now - 10_000 },
    { terminalId: 'pty-codex', title: 'codex work', agent: 'codex', state: 'working' as const, stateStartedAt: now - 10_000 }
  ]

  test('leaves switched-off agents out of the per-agent breakdown and the live roster', () => {
    const sessions = [sessionWithTurn('s-claude', 'claude'), sessionWithTurn('s-codex', 'codex')]
    const journal = createTestJournalIndex()

    const all = buildDashboardSnapshot(sessions, journal, new PricingEngine(), { ...workspace, liveAgents }, now)
    assert.ok(all.periods.all.day.byAgent.some((row) => row.agent === 'codex'))
    assert.ok(all.live.agents.some((card) => card.title === 'codex work'))

    const filtered = buildDashboardSnapshot(
      sessions,
      journal,
      new PricingEngine(),
      { ...workspace, liveAgents, disabledAgents: new Set(['codex'] as const) },
      now
    )
    assert.deepEqual(
      filtered.periods.all.day.byAgent.map((row) => row.agent).sort(),
      ['antigravity', 'claude', 'gemini']
    )
    assert.equal(filtered.live.agents.some((card) => card.title === 'codex work'), false)
    assert.equal(filtered.live.agents.some((card) => card.title === 'claude work'), true)
  })

  test('withoutDisabledLiveAgents keeps the runtime untouched when nothing is switched off', () => {
    const runtime = { ...workspace, liveAgents }
    assert.equal(withoutDisabledLiveAgents(runtime), runtime)
    assert.equal(withoutDisabledLiveAgents({ ...runtime, disabledAgents: new Set() }).liveAgents.length, 2)
    const filtered = withoutDisabledLiveAgents({ ...runtime, disabledAgents: new Set(['claude'] as const) })
    assert.deepEqual(filtered.liveAgents.map((a) => a.terminalId), ['pty-codex'])
  })
})

describe('Stale ptyState=working 5-minute silence timeout guard', () => {
  const FIVE_MIN_MS = 5 * 60_000
  const now = 1_800_000_000_000

  function makeWorkingSession(id: string, touchMs: number, lastEventState: 'working' | 'waiting' | 'done' | null = 'working') {
    const st = createEmptySessionState(id, 'codex', `/tmp/${id}.jsonl`)
    st.updatedAtMs = touchMs
    st.lastMtimeMs = touchMs
    st.lastEventState = lastEventState
    return st
  }

  test('downgrades stuck ptyState=working to done after >5m silence (with stale or unset ptyStateStartedAt)', () => {
    const st = makeWorkingSession('codex-interrupted', now - FIVE_MIN_MS - 1, 'working')
    assert.equal(resolveSessionRunState(st, 'working', now, now - FIVE_MIN_MS - 1), 'done')
    assert.equal(resolveSessionRunState(st, 'working', now, 0), 'done')
  })

  test('keeps working within 5m of last transcript touch (including exact 5m boundary) even if ptyStateStartedAt > 5m', () => {
    const stExact = makeWorkingSession('codex-boundary', now - FIVE_MIN_MS, 'working')
    assert.equal(resolveSessionRunState(stExact, 'working', now, now - 10 * 60_000), 'working')

    const stRecent = makeWorkingSession('codex-active-long-turn', now - 2 * 60_000, 'working')
    assert.equal(resolveSessionRunState(stRecent, 'working', now, now - 10 * 60_000), 'working')
  })

  test('keeps working when lastTouchMs > 5m old but ptyStateStartedAt is within 5m (newly started turn before flush)', () => {
    const st = makeWorkingSession('codex-new-turn', now - 10 * 60_000, 'working')
    assert.equal(resolveSessionRunState(st, 'working', now, now - 30_000), 'working')
    assert.equal(resolveSessionRunState(st, 'working', now, now - FIVE_MIN_MS), 'working')
  })

  test('keeps working past 5m silence when active background tasks are present', () => {
    const st = makeWorkingSession('codex-bg', now - 10 * 60_000, 'working')
    st.activeBackgroundTasks = new Map([
      ['bg-1', { id: 'bg-1', label: 'pnpm test', startedAt: now - 10 * 60_000 }]
    ])
    assert.equal(resolveSessionRunState(st, 'working', now, now - 10 * 60_000), 'working')
  })

  test('keeps working when lastTouchMs === 0 (no transcript timestamps yet)', () => {
    const st = makeWorkingSession('codex-no-transcript', 0, null)
    assert.equal(resolveSessionRunState(st, 'working', now, now - 10 * 60_000), 'working')
    assert.equal(resolveSessionRunState(st, 'working', now, 0), 'working')
  })

  test('preserves waiting state, 45s done fast-close, and active child subagent elevation', () => {
    // 1) Interactive question waiting (>5m) stays waiting rather than closing as done
    const stWaiting = makeWorkingSession('codex-waiting', now - 10 * 60_000, 'waiting')
    assert.equal(resolveSessionRunState(stWaiting, 'working', now, now - 10 * 60_000), 'waiting')

    // 2) Existing 45s fast-close for explicit lastEventState === 'done' still triggers at 46s
    const stDone = makeWorkingSession('codex-done-46s', now - 46_000, 'done')
    assert.equal(resolveSessionRunState(stDone, 'working', now, now - 60_000), 'done')

    // 3) Parent silent >5m with stuck ptyState=working still elevates to waiting when a child subagent is active
    const wtPath = '/tmp/test-stale-parent-subagent'
    const parent = makeWorkingSession('parent-stale', now - 10 * 60_000, 'working')
    parent.cwd = wtPath
    parent.createdAtMs = now - 15 * 60_000
    parent.turnsByKey.set('t1', {
      turnKey: 't1',
      timestampMs: now - 10 * 60_000,
      input: 400,
      output: 100,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 500,
      durationSec: 2,
      tps: 50,
      model: 'gpt-6.1-sol',
      explicitCostUsd: null
    })

    const child = makeWorkingSession('child-active', now - 2_000, 'working')
    child.cwd = wtPath
    child.createdAtMs = now - 30_000
    child.isSubagent = true
    child.parentSessionId = 'parent-stale'
    child.turnsByKey.set('t1', {
      turnKey: 't1',
      timestampMs: now - 2_000,
      input: 200,
      output: 50,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 250,
      durationSec: 1,
      tps: 50,
      model: 'gpt-6.1-sol',
      explicitCostUsd: null
    })

    const runtime = {
      focusedName: 'main',
      focusedBranch: 'main',
      focusedPath: wtPath,
      liveAgents: [
        {
          terminalId: 'term-parent-stale',
          sessionId: 'parent-stale',
          title: 'codex',
          agent: 'codex',
          state: 'working' as const,
          stateStartedAt: now - 10 * 60_000,
          workspacePath: wtPath
        }
      ]
    }
    const journal = createTestJournalIndex()
    const pricing = new PricingEngine()

    const snap = buildDashboardSnapshot([parent, child], journal, pricing, runtime, now)
    const parentCard = snap.live.agents.find((c) => c.sessionKey === 'codex:parent-stale')
    assert.equal(parentCard?.state, 'waiting')

    const polled = pollSingleLiveAgent('codex:parent-stale', [parent, child], journal, pricing, runtime, now)
    assert.equal(polled?.state, 'waiting')
  })
})
