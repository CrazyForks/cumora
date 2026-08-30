/**
 * The fan-out-width half of the wake-economics ledger: turns per human
 * message. The SQL does the grouping; these tests pin the JS contract —
 * bucket mapping, the numeric conversion of pg's decimal strings, the fixed
 * histogram order — and that the metric rides along on the wake-economics
 * response where the panel reads it.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-observability-turns.test.ts
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

// Same pattern as computer-engine-redetect.test.ts: pin the HTTP runtime
// client and mock the pool, so no Redis or Postgres is needed.
process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { getWakeEconomics, getTurnsPerMessage } = await import('../agents/observability.js')
const { pool } = await import('../db/pool.js')

const realQuery = pool.query.bind(pool)

afterEach(() => {
  ;(pool as unknown as { query: typeof realQuery }).query = realQuery
})

type QueryHandler = (sql: string, params?: unknown[]) => { rows: unknown[] }

function mockPool(handler: QueryHandler): void {
  ;(pool as unknown as { query: QueryHandler }).query = (sql: string, params?: unknown[]) => handler(sql, params)
}

const WAKE_SQL_PREFIX = 'WITH run_convo AS'
const TURNS_SQL_PREFIX = 'WITH scope AS'

function mockWakeAndTurns(turnRows: unknown[]): void {
  mockPool((sql) => {
    if (sql.startsWith(WAKE_SQL_PREFIX)) {
      return {
        rows: [{
          conversation_kind: 'group',
          runs: 10,
          silent_runs: 3,
          model: 'gpt-test',
          input_tokens: '1000',
          cached_tokens: '0',
          cache_creation_tokens: '0',
          output_tokens: '200',
        }],
      }
    }
    if (sql.startsWith(TURNS_SQL_PREFIX)) return { rows: turnRows }
    throw new Error('unexpected query: ' + sql.slice(0, 60))
  })
}

test('turns-per-message buckets carry the histogram in fixed order', async () => {
  mockPool((sql) => {
    if (sql.startsWith(TURNS_SQL_PREFIX)) {
      return {
        rows: [{
          conversation_kind: 'group',
          messages: 100,
          turns: 240,
          avg_turns: '2.4000000000000000',
          median_turns: '2',
          w0: 15,
          w1: 30,
          w2: 25,
          w3_5: 20,
          w6: 10,
        }],
      }
    }
    throw new Error('unexpected query: ' + sql.slice(0, 60))
  })
  const [b] = await getTurnsPerMessage({ companyId: 'c1', sinceHours: 24 })
  assert.equal(b.conversationKind, 'group')
  assert.equal(b.messages, 100)
  assert.equal(b.turns, 240)
  assert.equal(b.avgTurns, 2.4)
  assert.equal(b.medianTurns, 2)
  assert.deepEqual(
    b.hist.map((h) => h.turns),
    ['0', '1', '2', '3–5', '6+'],
    'the bar renderer relies on this order: darkest segment is 6+',
  )
  assert.deepEqual(b.hist.map((h) => h.messages), [15, 30, 25, 20, 10])
  assert.equal(b.hist.reduce((s, h) => s + h.messages, 0), b.messages, 'histogram sums to the denominator')
})

test('a window with no human messages yields no buckets, not zeroes', async () => {
  mockPool((sql) => {
    if (sql.startsWith(TURNS_SQL_PREFIX)) return { rows: [] }
    throw new Error('unexpected query: ' + sql.slice(0, 60))
  })
  assert.deepEqual(await getTurnsPerMessage({ companyId: 'c1' }), [])
})

test('the metric rides along on the wake-economics response the panel reads', async () => {
  mockWakeAndTurns([{
    conversation_kind: 'group',
    messages: 4,
    turns: 12,
    avg_turns: '3.0',
    median_turns: '3',
    w0: 0,
    w1: 1,
    w2: 1,
    w3_5: 2,
    w6: 0,
  }])
  const res = await getWakeEconomics({ companyId: 'c1', sinceHours: 24 })
  assert.equal(res.costEstimated, true, 'no prices configured here — the dollars are modelled and must say so')
  assert.equal(res.buckets[0].runs, 10)
  assert.deepEqual(res.turnsPerMessage.map((b) => b.conversationKind), ['group'])
  assert.equal(res.turnsPerMessage[0].avgTurns, 3)
})

test('sinceHours is clamped to the same window the rest of the panel uses', async () => {
  let captured: unknown[] = []
  mockPool((sql, params = []) => {
    if (sql.startsWith(TURNS_SQL_PREFIX)) {
      captured = params as unknown[]
      return { rows: [] }
    }
    throw new Error('unexpected query: ' + sql.slice(0, 60))
  })
  await getTurnsPerMessage({ companyId: 'c1', sinceHours: 99999 })
  // 720h ceiling, expressed as milliseconds — same clamp as getWakeEconomics.
  assert.equal(captured[1], 720 * 3_600_000)
})
