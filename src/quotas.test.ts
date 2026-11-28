import { assert, describe, mockHost, mountWorker, test } from 'orca/testing'
import { createEmptySessionState } from './parsers'
import { PricingEngine } from './pricing'
import {
  computeLocalRollingUsage,
  parseOrcaAccountListPayload,
  QuotaEngine,
  QUOTAS_STORAGE_KEY
} from './quotas'
import { TranscriptScanner } from './scanner'
import * as workerModule from './worker'

function sampleAccountListPayload() {
  return {
    ok: true,
    result: {
      antigravity: {
        accounts: [
          {
            id: 'ag-1',
            email: 'victor@example.com',
            authMethod: 'consumer',
            usage: {
              provider: 'antigravity',
              status: 'ok',
              error: null,
              updatedAt: 1794883077445,
              session: {
                usedPercent: 15,
                windowMinutes: 300,
                resetsAt: 1794885620000,
                resetDescription: null
              },
              weekly: {
                usedPercent: 5,
                windowMinutes: 10080,
                resetsAt: 1795472420000,
                resetDescription: null
              },
              buckets: [
                {
                  name: 'Gemini Models · Weekly Limit Remaining',
                  group: 'Gemini Models',
                  windowName: 'Weekly Limit Remaining',
                  usedPercent: 5,
                  windowMinutes: 10080,
                  resetsAt: 1795472420000,
                  resetDescription: null
                },
                {
                  name: 'Gemini Models · Five Hour Limit Remaining',
                  group: 'Gemini Models',
                  windowName: 'Five Hour Limit Remaining',
                  usedPercent: 15,
                  windowMinutes: 300,
                  resetsAt: 1794885620000,
                  resetDescription: null
                },
                {
                  name: 'Claude and GPT models · Weekly Limit Remaining',
                  group: 'Claude and GPT models',
                  windowName: 'Weekly Limit Remaining',
                  usedPercent: 12,
                  windowMinutes: 10080,
                  resetsAt: 1795487876000,
                  resetDescription: null
                },
                {
                  name: 'Claude and GPT models · Five Hour Limit Remaining',
                  group: 'Claude and GPT models',
                  windowName: 'Five Hour Limit Remaining',
                  usedPercent: 30,
                  windowMinutes: 300,
                  resetsAt: 1794901076000,
                  resetDescription: null
                }
              ]
            }
          }
        ],
        activeAccountId: 'ag-1'
      },
      codex: {
        accounts: [],
        activeAccountId: null,
        systemDefault: {
          hasAuth: true,
          authKind: 'oauth',
          email: 'wilson@example.com',
          providerAccountId: 'codex-sys',
          workspaceLabel: null
        }
      },
      claude: {
        accounts: [],
        activeAccountId: null
      },
      rateLimits: {
        claude: {
          provider: 'claude',
          session: null,
          weekly: null,
          updatedAt: 1794883073734,
          error: 'No subscription plan — API key billing',
          status: 'unavailable',
          usageMetadata: {
            credentialSource: 'none',
            authProvenance: 'system',
            failureKind: 'missing-credentials'
          }
        },
        codex: {
          provider: 'codex',
          session: null,
          weekly: {
            usedPercent: 41,
            windowMinutes: 10080,
            resetsAt: 1794988386000,
            resetDescription: 'Wed 3:53 PM'
          },
          rateLimitResetCredits: {
            availableCount: 3,
            totalEarnedCount: 0,
            nextExpiresAt: 1796068433572
          },
          updatedAt: 1794883075178,
          error: null,
          status: 'ok'
        },
        antigravity: {
          provider: 'antigravity',
          session: {
            usedPercent: 15,
            windowMinutes: 300,
            resetsAt: 1794885620000,
            resetDescription: null
          },
          weekly: {
            usedPercent: 5,
            windowMinutes: 10080,
            resetsAt: 1795472420000,
            resetDescription: null
          },
          buckets: [
            {
              name: 'Gemini Models · Weekly Limit Remaining',
              group: 'Gemini Models',
              windowName: 'Weekly Limit Remaining',
              usedPercent: 5,
              windowMinutes: 10080,
              resetsAt: 1795472420000,
              resetDescription: null
            },
            {
              name: 'Gemini Models · Five Hour Limit Remaining',
              group: 'Gemini Models',
              windowName: 'Five Hour Limit Remaining',
              usedPercent: 15,
              windowMinutes: 300,
              resetsAt: 1794885620000,
              resetDescription: null
            },
            {
              name: 'Claude and GPT models · Weekly Limit Remaining',
              group: 'Claude and GPT models',
              windowName: 'Weekly Limit Remaining',
              usedPercent: 12,
              windowMinutes: 10080,
              resetsAt: 1795487876000,
              resetDescription: null
            },
            {
              name: 'Claude and GPT models · Five Hour Limit Remaining',
              group: 'Claude and GPT models',
              windowName: 'Five Hour Limit Remaining',
              usedPercent: 30,
              windowMinutes: 300,
              resetsAt: 1794901076000,
              resetDescription: null
            }
          ],
          updatedAt: 1794883077445,
          error: null,
          status: 'ok',
          usageMetadata: {
            account: {
              id: 'ag-1',
              email: 'victor@example.com'
            }
          }
        },
        antigravityAccounts: [
          {
            accountId: 'ag-1',
            email: 'victor@example.com',
            active: true,
            rateLimits: {
              status: 'ok',
              error: null,
              session: {
                usedPercent: 15,
                windowMinutes: 300,
                resetsAt: 1794885620000,
                resetDescription: null
              },
              weekly: {
                usedPercent: 5,
                windowMinutes: 10080,
                resetsAt: 1795472420000,
                resetDescription: null
              },
              buckets: []
            }
          }
        ],
        inactiveCodexAccounts: [],
        inactiveClaudeAccounts: []
      }
    }
  }
}

describe('Quotas payload parser, local rolling usage, and QuotaEngine', () => {
  test('parses Codex weekly-only plan with reset credits, Antigravity model pools, and unavailable Claude API key billing', () => {
    const providers = parseOrcaAccountListPayload(sampleAccountListPayload())
    assert.equal(providers.length, 3)

    const [codex, antigravity, claude] = providers
    assert.equal(codex.provider, 'codex')
    assert.equal(codex.status, 'ok')
    assert.equal(codex.accountEmail, 'wilson@example.com')
    assert.equal(codex.authKind, 'oauth')
    assert.equal(codex.session, null)
    assert.equal(codex.weekly?.usedPercent, 41)
    assert.equal(codex.weekly?.windowMinutes, 10080)
    assert.equal(codex.weekly?.resetDescription, 'Wed 3:53 PM')
    assert.equal(codex.resetCredits?.availableCount, 3)

    assert.equal(antigravity.provider, 'antigravity')
    assert.equal(antigravity.status, 'ok')
    assert.equal(antigravity.officialQuotaAvailable, true)
    assert.equal(antigravity.accountEmail, 'victor@example.com')
    assert.equal(antigravity.authKind, 'consumer')
    assert.equal(antigravity.pools.length, 2)
    assert.equal(antigravity.pools[0].label, 'Gemini Models')
    assert.equal(antigravity.pools[0].session?.usedPercent, 15)
    assert.equal(antigravity.pools[0].weekly?.usedPercent, 5)
    assert.equal(antigravity.pools[1].label, 'Claude and GPT models')
    assert.equal(antigravity.pools[1].session?.usedPercent, 30)
    assert.equal(antigravity.pools[1].weekly?.usedPercent, 12)
    assert.equal(antigravity.accounts.length, 1)
    assert.equal(antigravity.accounts[0].active, true)

    assert.equal(claude.provider, 'claude')
    assert.equal(claude.status, 'unavailable')
    assert.equal(claude.error, 'No subscription plan — API key billing')
    assert.equal(claude.session, null)
    assert.equal(claude.weekly, null)
  })

  test('marks Orca hosts without Antigravity official quota as local-only while preserving saved accounts', () => {
    const providers = parseOrcaAccountListPayload({
      ok: true,
      result: {
        antigravity: {
          accounts: [
            { id: 'ag-1', email: 'active@example.com', authMethod: 'consumer' },
            { id: 'ag-2', email: 'backup@example.com', authMethod: 'consumer' }
          ],
          activeAccountId: 'ag-1'
        },
        rateLimits: {
          antigravityAccounts: []
        }
      }
    })
    const antigravity = providers.find((provider) => provider.provider === 'antigravity')
    assert.ok(antigravity)
    assert.equal(antigravity.officialQuotaAvailable, false)
    assert.equal(antigravity.status, 'unavailable')
    assert.deepEqual(antigravity.accounts.map((account) => [account.email, account.active]), [
      ['active@example.com', true],
      ['backup@example.com', false]
    ])
  })

  test('normalizes 10-digit epoch seconds to ms for resetsAt and nextExpiresAt while preserving ms', () => {
    const payload = sampleAccountListPayload()
    payload.result.rateLimits.codex.weekly.resetsAt = 1794988386
    payload.result.rateLimits.codex.rateLimitResetCredits.nextExpiresAt = 1796068433
    const providers = parseOrcaAccountListPayload(payload)
    assert.equal(providers[0].weekly?.resetsAt, 1794988386000)
    assert.equal(providers[0].resetCredits?.nextExpiresAt, 1796068433000)
    assert.equal(providers[1].session?.resetsAt, 1794885620000)
  })

  test('clamps percentages to [0, 100] and rejects invalid payloads', () => {
    const payload = sampleAccountListPayload()
    payload.result.rateLimits.codex.weekly.usedPercent = 145
    const providers = parseOrcaAccountListPayload(payload)
    assert.equal(providers[0].weekly?.usedPercent, 100)

    let threw = false
    try {
      parseOrcaAccountListPayload({ ok: false, error: 'CLI failure' })
    } catch {
      threw = true
    }
    assert.equal(threw, true)
  })

  test('computes local rolling 5h and 7d tokens, USD cost, turnCount, and sessionCount per provider', () => {
    const now = 1_800_000_000_000
    const pricing = new PricingEngine()

    const sClaude = createEmptySessionState('c1', 'claude', '/tmp/c1.jsonl')
    sClaude.turnsByKey.set('t-old', {
      turnKey: 't-old',
      timestampMs: now - 8 * 86400_000, // outside 7d
      input: 1000,
      output: 500,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 1500,
      durationSec: 1,
      tps: 500,
      model: 'claude-sonnet-4-6',
      explicitCostUsd: 0.5
    })
    sClaude.turnsByKey.set('t-week', {
      turnKey: 't-week',
      timestampMs: now - 2 * 86400_000, // inside 7d, outside 5h
      input: 2000,
      output: 1000,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 3000,
      durationSec: 2,
      tps: 500,
      model: 'claude-sonnet-4-6',
      explicitCostUsd: 1.25
    })
    sClaude.turnsByKey.set('t-5h', {
      turnKey: 't-5h',
      timestampMs: now - 60_000, // inside 5h and 7d
      input: 400,
      output: 600,
      reasoning: 0,
      cacheRead: 100,
      cacheWrite: 0,
      total: 1100,
      durationSec: 1,
      tps: 600,
      model: 'claude-sonnet-4-6',
      explicitCostUsd: 0.25
    })

    const sHelper = createEmptySessionState('c-helper', 'claude', '/tmp/c-helper.jsonl')
    sHelper.isInternalHelper = true
    sHelper.turnsByKey.set('t-help', {
      turnKey: 't-help',
      timestampMs: now - 10_000,
      input: 9999,
      output: 9999,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 19998,
      durationSec: 1,
      tps: 100,
      model: 'claude-sonnet-4-6',
      explicitCostUsd: 10
    })

    const sCodexDupA = createEmptySessionState('x1', 'codex', '/tmp/a/x1.jsonl')
    sCodexDupA.turnsByKey.set('t1', {
      turnKey: 't1',
      timestampMs: now - 30_000,
      input: 100,
      output: 200,
      reasoning: 50,
      cacheRead: 0,
      cacheWrite: 0,
      total: 350,
      durationSec: 1,
      tps: 250,
      model: 'gpt-6.1-sol',
      explicitCostUsd: 0.01
    })
    const sCodexDupB = createEmptySessionState('x1', 'codex', '/tmp/b/x1.jsonl')
    sCodexDupB.turnsByKey.set('t1', {
      turnKey: 't1',
      timestampMs: now - 30_000,
      input: 100,
      output: 200,
      reasoning: 50,
      cacheRead: 0,
      cacheWrite: 0,
      total: 350,
      durationSec: 1,
      tps: 250,
      model: 'gpt-6.1-sol',
      explicitCostUsd: 0.01
    })

    const local = computeLocalRollingUsage([sClaude, sHelper, sCodexDupA, sCodexDupB], pricing, now)
    assert.equal(local.claude.window5h.totalTokens, 1100)
    assert.equal(local.claude.window5h.turnCount, 1)
    assert.equal(local.claude.window5h.sessionCount, 1)
    assert.equal(local.claude.window5h.costUsd, 0.25)
    assert.equal(local.claude.window5h.rateLimitHits, null)

    assert.equal(local.claude.window7d.totalTokens, 4100)
    assert.equal(local.claude.window7d.turnCount, 2)
    assert.equal(local.claude.window7d.sessionCount, 1)
    assert.equal(local.claude.window7d.costUsd, 1.5)

    assert.equal(local.codex.window5h.totalTokens, 350)
    assert.equal(local.codex.window5h.turnCount, 1)
    assert.equal(local.codex.window5h.sessionCount, 1)
  })

  test('computes activity5h (10x30m including now boundary), daily7d (7 local days), modelMix7d (top-3 + other summing to 100%), and cacheHitRate7d', () => {
    // Anchor at 14:15 local time so all 5h buckets stay cleanly on the same local day
    const anchorDate = new Date(2026, 10, 17, 14, 15, 0, 0)
    const now = anchorDate.getTime()
    const pricing = new PricingEngine()

    const sAg = createEmptySessionState('ag-charts', 'antigravity', '/tmp/ag-charts.jsonl')
    // Bucket 0: [now - 5h, now - 4.5h) -> exactly at now - 5h
    sAg.turnsByKey.set('t-b0', {
      turnKey: 't-b0',
      timestampMs: now - 5 * 3600_000,
      input: 1000,
      output: 200,
      reasoning: 0,
      cacheRead: 3000,
      cacheWrite: 0,
      total: 4200,
      durationSec: 2,
      tps: 100,
      model: 'gemini-3.5-pro',
      explicitCostUsd: 0.42
    })
    // Bucket 9: [now - 30m, now] -> exact `now` boundary MUST land in bucket 9 (not dropped!)
    sAg.turnsByKey.set('t-b9-now', {
      turnKey: 't-b9-now',
      timestampMs: now,
      input: 500,
      output: 300,
      reasoning: 0,
      cacheRead: 1500,
      cacheWrite: 0,
      total: 2300,
      durationSec: 1,
      tps: 300,
      model: 'claude-sonnet-4-6',
      explicitCostUsd: 0.23
    })
    // 2 days ago (local calendar day index 4): 3rd model
    const twoDaysAgo = new Date(2026, 10, 15, 10, 0, 0, 0).getTime()
    sAg.turnsByKey.set('t-d2', {
      turnKey: 't-d2',
      timestampMs: twoDaysAgo,
      input: 1000,
      output: 500,
      reasoning: 0,
      cacheRead: 2500,
      cacheWrite: 500,
      total: 4500,
      durationSec: 3,
      tps: 166,
      model: 'gemini-3.5-flash',
      explicitCostUsd: 0.15
    })
    // 6 days ago (oldest local calendar day index 0): 4th and 5th models -> aggregated into "other"
    const sixDaysAgo = new Date(2026, 10, 11, 16, 0, 0, 0).getTime()
    sAg.turnsByKey.set('t-d6-a', {
      turnKey: 't-d6-a',
      timestampMs: sixDaysAgo,
      input: 400,
      output: 200,
      reasoning: 0,
      cacheRead: 400,
      cacheWrite: 0,
      total: 1000,
      durationSec: 1,
      tps: 200,
      model: 'gpt-5.4-mini',
      explicitCostUsd: 0.05
    })
    sAg.turnsByKey.set('t-d6-b', {
      turnKey: 't-d6-b',
      timestampMs: sixDaysAgo + 60_000,
      input: 200,
      output: 100,
      reasoning: 0,
      cacheRead: 200,
      cacheWrite: 0,
      total: 500,
      durationSec: 1,
      tps: 100,
      model: 'gemini-2.5-flash-lite',
      explicitCostUsd: 0.02
    })
    // 8 days ago: outside both daily7d and window7d
    const eightDaysAgo = new Date(2026, 10, 9, 12, 0, 0, 0).getTime()
    sAg.turnsByKey.set('t-old', {
      turnKey: 't-old',
      timestampMs: eightDaysAgo,
      input: 9000,
      output: 1000,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 10000,
      durationSec: 2,
      tps: 500,
      model: 'legacy-model',
      explicitCostUsd: 1.0
    })

    const local = computeLocalRollingUsage([sAg], pricing, now)
    const ag = local.antigravity

    // 1. activity5h: 10 x 30m buckets oldest -> newest
    assert.equal(ag.activity5h.length, 10)
    assert.equal(ag.activity5h[0].startMs, now - 5 * 3600_000)
    assert.equal(ag.activity5h[9].startMs, now - 30 * 60_000)
    assert.equal(ag.activity5h[0].totalTokens, 4200)
    assert.equal(ag.activity5h[0].costUsd, 0.42)
    assert.equal(ag.activity5h[0].turnCount, 1)
    assert.equal(ag.activity5h[9].totalTokens, 2300)
    assert.equal(ag.activity5h[9].costUsd, 0.23)
    assert.equal(ag.activity5h[9].turnCount, 1)
    assert.equal(
      ag.activity5h.reduce((sum, b) => sum + b.totalTokens, 0),
      ag.window5h.totalTokens
    )

    // 2. daily7d: 7 local calendar days oldest -> today
    assert.equal(ag.daily7d.length, 7)
    assert.equal(ag.daily7d[0].dayKey, '2026-11-11')
    assert.equal(ag.daily7d[0].isToday, false)
    assert.equal(ag.daily7d[0].totalTokens, 1500)
    assert.equal(ag.daily7d[0].turnCount, 2)
    assert.equal(ag.daily7d[0].costUsd, 0.07)
    assert.equal(ag.daily7d[4].dayKey, '2026-11-15')
    assert.equal(ag.daily7d[4].totalTokens, 4500)
    assert.equal(ag.daily7d[6].dayKey, '2026-11-17')
    assert.equal(ag.daily7d[6].isToday, true)
    assert.equal(ag.daily7d[6].totalTokens, 6500)
    assert.equal(ag.daily7d[6].turnCount, 2)
    assert.equal(ag.daily7d[6].costUsd, 0.65)

    // 3. modelMix7d: top 3 + aggregated "other" summing cleanly to 100%
    // Totals: gemini-3.5-flash=4500, gemini-3.5-pro=4200, claude-sonnet-4-6=2300, other=1500 (total=12500)
    assert.equal(ag.modelMix7d.length, 4)
    assert.deepEqual(
      ag.modelMix7d.map((m) => [m.model, m.totalTokens, Boolean(m.isOther)]),
      [
        ['gemini-3.5-flash', 4500, false],
        ['gemini-3.5-pro', 4200, false],
        ['claude-sonnet-4-6', 2300, false],
        ['other', 1500, true]
      ]
    )
    assert.equal(
      ag.modelMix7d.reduce((sum, m) => sum + m.pct, 0),
      100
    )
    for (const entry of ag.modelMix7d) {
      assert.ok(Number.isInteger(entry.pct) && entry.pct >= 0)
    }

    // 4. cacheHitRate7d: exact same formula as Stats view (cacheRead / (input + cacheRead + cacheWrite))
    // input=3100, cacheRead=7600, cacheWrite=500 -> denom=11200 -> round(7600/11200*100) = 68
    assert.equal(ag.cacheHitRate7d, 68)
  })

  test('handles zero-token edge cases and exact 3-way tie for modelMix7d and cacheHitRate7d', () => {
    const now = new Date(2026, 10, 17, 12, 0, 0, 0).getTime()
    const pricing = new PricingEngine()

    // Zero-token turn must produce modelMix7d=[] and cacheHitRate7d=null
    const sZero = createEmptySessionState('ag-zero', 'antigravity', '/tmp/ag-zero.jsonl')
    sZero.turnsByKey.set('t0', {
      turnKey: 't0',
      timestampMs: now - 10_000,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      durationSec: 1,
      tps: 0,
      model: 'gemini-3.5-pro',
      explicitCostUsd: 0
    })

    // Three equal models + one literally named "other" (when <=3 models, isOther must NOT be set)
    const sTie = createEmptySessionState('codex-tie', 'codex', '/tmp/codex-tie.jsonl')
    for (const model of ['model-a', 'model-b', 'other']) {
      sTie.turnsByKey.set(model, {
        turnKey: model,
        timestampMs: now - 5_000,
        input: 100,
        output: 200,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 300,
        durationSec: 1,
        tps: 200,
        model,
        explicitCostUsd: 0.01
      })
    }

    const local = computeLocalRollingUsage([sZero, sTie], pricing, now)
    assert.equal(local.antigravity.activity5h.length, 10)
    assert.equal(local.antigravity.daily7d.length, 7)
    assert.deepEqual(local.antigravity.modelMix7d, [])
    assert.equal(local.antigravity.cacheHitRate7d, null)

    // Codex has 3 equal models (300 each = 900 total): pct sums to 100 (34+33+33), none marked isOther
    assert.equal(local.codex.modelMix7d.length, 3)
    assert.equal(local.codex.modelMix7d.reduce((s, m) => s + m.pct, 0), 100)
    assert.equal(local.codex.modelMix7d.some((m) => m.isOther === true), false)
    // input=300 < 1000 threshold -> cacheHitRate7d=null
    assert.equal(local.codex.cacheHitRate7d, null)

    // Claude with zero sessions -> empty buckets, empty mix, null cache hit
    assert.equal(local.claude.activity5h.length, 10)
    assert.equal(local.claude.daily7d.length, 7)
    assert.deepEqual(local.claude.modelMix7d, [])
    assert.equal(local.claude.cacheHitRate7d, null)
  })

  test('QuotaEngine deduplicates in-flight refreshes, respects 5m TTL, falls back to cache on error, and aborts cleanly', async () => {
    let calls = 0
    let failNext = false
    let observedAbort = false

    const engine = new QuotaEngine({
      ttlMs: 5 * 60_000,
      execCli: async (signal) => {
        calls++
        signal.addEventListener('abort', () => {
          observedAbort = true
        })
        await new Promise((r) => setTimeout(r, 25))
        if (signal.aborted) throw new Error('Aborted')
        if (failNext) throw new Error('CLI timeout')
        return sampleAccountListPayload()
      }
    })

    const pricing = new PricingEngine()
    const t0 = 1_800_000_000_000

    // Before first fetch -> loading state
    const initial = engine.getSnapshot([], pricing, t0)
    assert.equal(initial.source, 'loading')
    assert.equal(initial.providers.length, 3)
    assert.equal(initial.providers[0].status, 'loading')

    // Concurrent calls deduplicated to 1 CLI execution
    const [r1, r2] = await Promise.all([engine.refresh(false, t0), engine.refresh(false, t0)])
    assert.equal(calls, 1)
    assert.equal(r1.source, 'live')
    assert.equal(r2.source, 'live')
    assert.equal(r1.providers[0].weekly?.usedPercent, 41)

    // Within 5m TTL -> cached without invoking CLI
    assert.equal(engine.needsRefresh(t0 + 60_000), false)
    await engine.refresh(false, t0 + 60_000)
    assert.equal(calls, 1)

    // Force refresh within TTL -> invokes CLI, and on error preserves cached data
    failNext = true
    const afterErr = await engine.refresh(true, t0 + 60_000)
    assert.equal(calls, 2)
    assert.equal(afterErr.source, 'cache')
    assert.equal(afterErr.lastError, 'CLI timeout')
    assert.equal(afterErr.providers[0].weekly?.usedPercent, 41)

    // Abort in-flight call
    failNext = false
    const pSlow = engine.refresh(true, t0 + 400_000)
    engine.abortInFlight()
    await pSlow
    assert.equal(observedAbort, true)

    // TTL expiry after 5 minutes triggers fresh CLI call
    assert.equal(engine.needsRefresh(t0 + 5 * 60_000), true)
    const afterTtl = await engine.refresh(false, t0 + 5 * 60_000)
    assert.equal(calls, 4)
    assert.equal(afterTtl.source, 'live')

    // Storage cache round-trip hydrates another QuotaEngine cleanly
    const cached = engine.toStorableCache()
    assert.ok(cached)
    const restored = new QuotaEngine({
      ttlMs: 5 * 60_000,
      execCli: async () => {
        throw new Error('should not run within TTL')
      }
    })
    restored.loadFromCache(cached)
    assert.equal(restored.needsRefresh(t0 + 5 * 60_000 + 30_000), false)
    const restoredSnap = restored.getSnapshot([], pricing, t0 + 5 * 60_000 + 30_000)
    assert.equal(restoredSnap.source, 'cache')
    assert.equal(restoredSnap.providers[0].weekly?.usedPercent, 41)
    assert.equal(restoredSnap.providers[1].pools.length, 2)

    // Cold-start failure with no cache produces 'error' source
    const coldErrEngine = new QuotaEngine({
      execCli: async () => {
        throw new Error('orca binary missing')
      }
    })
    const errSnap = await coldErrEngine.refresh(true, t0)
    assert.equal(errSnap.source, 'error')
    assert.equal(errSnap.lastError, 'orca binary missing')
    assert.equal(errSnap.providers[0].status, 'error')
  })
})

describe('Worker Quotas RPC & non-blocking integration', () => {
  test('exposes quotas in dashboard.get, accepts quotas tab in view.set, and handles quotas.refresh', async () => {
    const host = mockHost({
      handlers: {
        'workspace.list': () => ({ workspaces: [], truncated: false }),
        'workspace.readContext': () => ({ branch: 'main', displayName: 'main', terminals: [] }),
        'agents.list': () => ({ agents: [] }),
        'statusBar.update': () => ({ ok: true })
      }
    })

    const worker = await mountWorker(workerModule, { host })
    try {
      const snap = await worker.request('dashboard.get', { forceScan: false })
      assert.ok(snap.quotas)
      assert.equal(snap.quotas?.providers.length, 3)

      const view = await worker.request('view.set', { tab: 'quotas' })
      assert.equal(view.tab, 'quotas')

      const refreshed = await worker.request('quotas.refresh', {})
      assert.equal(refreshed.providers.length, 3)
      assert.deepEqual(worker.refusals, [])
    } finally {
      await worker.deactivate()
    }
  })
})

describe('Per-agent tracking switches: quota cache, refresh, and historical cache', () => {
  const t0 = 1_800_000_000_000
  const pricing = new PricingEngine()

  test('switching off every cached provider returns to the loading state instead of an empty cache', async () => {
    let failNext = false
    const engine = new QuotaEngine({
      execCli: async () => {
        if (failNext) throw new Error('CLI timeout')
        return sampleAccountListPayload()
      }
    })
    await engine.refresh(true, t0)
    engine.setDisabledProviders(['codex', 'antigravity'])
    assert.deepEqual(engine.toStorableCache()?.providers.map((p) => p.provider), ['claude'])

    engine.setDisabledProviders(['codex', 'claude'])
    assert.equal(engine.toStorableCache(), null)
    assert.equal(engine.needsRefresh(t0 + 1000), true)
    const pending = engine.getSnapshot([], pricing, t0 + 1000)
    assert.equal(pending.source, 'loading')
    assert.equal(pending.syncedAt, null)
    assert.deepEqual(pending.providers.map((p) => [p.provider, p.status]), [['antigravity', 'loading']])

    failNext = true
    const failed = await engine.refresh(false, t0 + 2000)
    assert.equal(failed.source, 'error')
    assert.equal(failed.providers[0].status, 'error')
  })

  test('a provider missing from the cache because it was off is refreshed right away, not after the TTL', async () => {
    let calls = 0
    const writer = new QuotaEngine({ execCli: async () => sampleAccountListPayload() })
    writer.setDisabledProviders(['codex'])
    await writer.refresh(true, t0)
    const cached = writer.toStorableCache()
    assert.deepEqual(cached?.coveredProviders, ['antigravity', 'claude'])

    const reader = new QuotaEngine({
      execCli: async () => {
        calls++
        return sampleAccountListPayload()
      }
    })
    reader.setDisabledProviders([])
    reader.loadFromCache(cached)
    assert.equal(reader.needsRefresh(t0 + 60_000), true)
    const refreshed = await reader.refresh(false, t0 + 60_000)
    assert.equal(calls, 1)
    assert.notEqual(refreshed.providers.find((p) => p.provider === 'codex')?.status, 'unavailable')
    assert.equal(reader.needsRefresh(t0 + 120_000), false)

    const stillOff = new QuotaEngine({ execCli: async () => sampleAccountListPayload() })
    stillOff.setDisabledProviders(['codex'])
    stillOff.loadFromCache(cached)
    assert.equal(stillOff.needsRefresh(t0 + 60_000), false)

    const legacy = new QuotaEngine({ execCli: async () => sampleAccountListPayload() })
    legacy.loadFromCache({ ...reader.toStorableCache(), coveredProviders: undefined })
    assert.equal(legacy.needsRefresh(t0 + 120_000), false)
  })

  test('switching a provider off aborts a running refresh, and the next refresh can start at once', async () => {
    let calls = 0
    let aborted = 0
    const engine = new QuotaEngine({
      execCli: async (signal) => {
        calls++
        signal.addEventListener('abort', () => aborted++)
        await new Promise((r) => setTimeout(r, 25))
        if (signal.aborted) throw new Error('Aborted')
        return sampleAccountListPayload()
      }
    })
    const slow = engine.refresh(true, t0)
    engine.setDisabledProviders(['codex'])
    await slow
    assert.equal(aborted, 1)
    assert.equal(engine.toStorableCache(), null)

    const next = await engine.refresh(false, t0 + 1000)
    assert.equal(calls, 2)
    assert.equal(next.source, 'live')
    assert.deepEqual(engine.toStorableCache()?.providers.map((p) => p.provider), ['antigravity', 'claude'])
  })

  test('sessions of a switched-off agent are dropped from the scanner and from the historical cache', () => {
    const now = Date.now()
    const old = now - 3 * 86_400_000
    const item = (agent: 'claude' | 'codex', sessionId: string) => ({
      sessionId,
      agent,
      filePath: `/nonexistent/${sessionId}.jsonl`,
      sizeBytes: 10,
      mtimeMs: old,
      cwd: null,
      titleHint: null,
      isInternalHelper: false,
      latestModel: null,
      createdAtMs: old,
      updatedAtMs: old,
      turns: [{ k: 't1', ts: old, in: 1, out: 1, rs: 0, cr: 0, cw: 0, tot: 2, dur: null, tps: null, m: null, cost: null }]
    })
    const raw = {
      files: {
        '/nonexistent/c1.jsonl': item('claude', 'c1'),
        '/nonexistent/x1.jsonl': item('codex', 'x1')
      }
    }

    const scanner = new TranscriptScanner({ homeDir: '/nonexistent-home', orcaAppDirs: [] })
    scanner.setDisabledAgents(['codex'])
    scanner.hydrateHistoricalCache(raw)
    assert.equal(scanner.hasDirtyHistoricalCache(), true)
    const first = scanner.consumeHistoricalCacheSnapshot(now)
    assert.deepEqual(Object.values(first?.files ?? {}).map((f) => f.sessionId), ['c1'])

    scanner.setDisabledAgents(['codex', 'claude'])
    assert.equal(scanner.hasDirtyHistoricalCache(), true)
    assert.deepEqual(Object.keys(scanner.consumeHistoricalCacheSnapshot(now)?.files ?? {}), [])
    assert.equal(scanner.getSessions().length, 0)
  })

  test('worker start reads settings before the caches and deletes a quota cache left only with switched-off providers', async () => {
    const writer = new QuotaEngine({ execCli: async () => sampleAccountListPayload() })
    writer.setDisabledProviders(['claude', 'antigravity'])
    await writer.refresh(true, t0)
    const codexOnly = writer.toStorableCache()
    assert.ok(codexOnly)

    const previousBin = process.env.ORCA_BIN
    process.env.ORCA_BIN = '/nonexistent/orca-for-tests'
    const host = mockHost({
      settings: { enableCodex: false },
      storage: {
        [QUOTAS_STORAGE_KEY]: JSON.parse(JSON.stringify({ ...codexOnly, syncedAt: Date.now() }))
      },
      handlers: {
        'workspace.list': () => ({ workspaces: [], truncated: false }),
        'workspace.readContext': () => ({ branch: 'main', displayName: 'main', terminals: [] }),
        'agents.list': () => ({ agents: [] }),
        'statusBar.update': () => ({ ok: true })
      }
    })
    const worker = await mountWorker(workerModule, { host })
    try {
      assert.equal(QUOTAS_STORAGE_KEY in host.data().storage, false)
      const snap = await worker.request('dashboard.get', { forceScan: false })
      assert.deepEqual(snap.quotas?.providers.map((p) => p.provider), ['antigravity', 'claude'])
      assert.equal(snap.quotas?.providers.some((p) => p.status === 'unavailable'), false)
    } finally {
      await worker.deactivate()
      if (previousBin === undefined) delete process.env.ORCA_BIN
      else process.env.ORCA_BIN = previousBin
    }
  })
})
