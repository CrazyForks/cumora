/**
 * `getWakeEconomics` against a real Postgres.
 *
 * The query is the whole point of this file. It anti-joins agent_runs to
 * messages over a time window and aggregates in SQL, and this repo has a
 * documented history of a single mis-shaped query starving the pool — so it
 * gets executed for real rather than reasoned about.
 *
 * The metric: a run is SILENT when the agent posted nothing into the
 * conversation that woke it, within ten minutes of the run starting. Same
 * definition @yetone used to publish the 26.3% group figure in #70, so the two
 * numbers are comparable.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { getWakeEconomics } from '../agents/observability.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll() })

async function seedConvo(companyId: string, kind: 'group' | 'direct', members: string[]): Promise<string> {
  const id = `conv-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, tag, company_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [id, kind, `wake-econ ${kind}`, JSON.stringify(members), kind === 'direct' ? 'human' : 'group', companyId],
  )
  return id
}

/** A completed run that spent tokens, triggered by `convoId`. */
async function seedRun(args: {
  companyId: string; agentId: string; convoId: string; minutesAgo?: number; tokens?: number
}): Promise<string> {
  const id = `run-${randomUUID().slice(0, 8)}`
  const tokens = args.tokens ?? 1000
  await pool.query(
    `INSERT INTO agent_runs
       (id, agent_id, company_id, trigger, status, model,
        input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens, started_at)
     VALUES ($1, $2, $3, $4::jsonb, 'completed', 'gpt-5.5',
             $5, 0, 0, 100, NOW() - ($6::double precision * INTERVAL '1 minute'))`,
    [id, args.agentId, args.companyId,
     JSON.stringify({ source: 'message.new', conversationIds: [args.convoId] }),
     tokens, args.minutesAgo ?? 5],
  )
  return id
}

/** A reply from `authorId`, offset from the run's start. */
async function seedReply(args: {
  companyId: string; convoId: string; authorId: string; minutesAgo: number
}): Promise<void> {
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id, created_at)
       VALUES ($1, $2, $3, 'text', 'on it', 1, $4, NOW() - ($5::double precision * INTERVAL '1 minute'))`,
    [`m-${randomUUID().slice(0, 8)}`, args.convoId, args.authorId, args.companyId, args.minutesAgo],
  )
}

const bucket = (e: Awaited<ReturnType<typeof getWakeEconomics>>, kind: string) =>
  e.buckets.find((b) => b.conversationKind === kind)

test('a run that produced no reply counts as silent', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const convo = await seedConvo(companyId, 'group', [agentId])
  await seedRun({ companyId, agentId, convoId: convo, minutesAgo: 5 })

  const g = bucket(await getWakeEconomics({ companyId }), 'group')
  assert.equal(g?.runs, 1)
  assert.equal(g?.silentRuns, 1)
  assert.equal(g?.silentRate, 1)
  assert.ok((g?.silentSpendUsd ?? 0) > 0, 'a silent run still cost tokens')
})

test('a run whose agent replied inside the window is not silent', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const convo = await seedConvo(companyId, 'group', [agentId])
  await seedRun({ companyId, agentId, convoId: convo, minutesAgo: 5 })
  await seedReply({ companyId, convoId: convo, authorId: agentId, minutesAgo: 4 })

  const g = bucket(await getWakeEconomics({ companyId }), 'group')
  assert.equal(g?.runs, 1)
  assert.equal(g?.silentRuns, 0)
  assert.equal(g?.silentSpendUsd, 0, 'an answered run contributes no silent spend')
})

test('a reply after the ten-minute window still counts as silent', async () => {
  // The window is what makes the metric mean "this wake answered", rather than
  // "the agent eventually said something in that room".
  const { companyId, agentId } = await seedCompanyWithAgent()
  const convo = await seedConvo(companyId, 'group', [agentId])
  await seedRun({ companyId, agentId, convoId: convo, minutesAgo: 30 })
  await seedReply({ companyId, convoId: convo, authorId: agentId, minutesAgo: 5 })

  const g = bucket(await getWakeEconomics({ companyId }), 'group')
  assert.equal(g?.silentRuns, 1)
})

test("another agent's reply does not rescue this run", async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const { agentId: peer } = await seedCompanyWithAgent({ companyId })
  const convo = await seedConvo(companyId, 'group', [agentId, peer])
  await seedRun({ companyId, agentId, convoId: convo, minutesAgo: 5 })
  await seedReply({ companyId, convoId: convo, authorId: peer, minutesAgo: 4 })

  const g = bucket(await getWakeEconomics({ companyId }), 'group')
  assert.equal(g?.silentRuns, 1, 'silence is per-agent — the peer answering is exactly the waste being counted')
})

test('group and direct are reported separately', async () => {
  // A DM legitimately answers far more often; averaging the two would hide the
  // group number this exists to track.
  const { companyId, agentId } = await seedCompanyWithAgent()
  const group = await seedConvo(companyId, 'group', [agentId])
  const dm = await seedConvo(companyId, 'direct', [agentId])
  await seedRun({ companyId, agentId, convoId: group, minutesAgo: 5 })
  await seedRun({ companyId, agentId, convoId: dm, minutesAgo: 5 })
  await seedReply({ companyId, convoId: dm, authorId: agentId, minutesAgo: 4 })

  const e = await getWakeEconomics({ companyId })
  assert.equal(bucket(e, 'group')?.silentRate, 1)
  assert.equal(bucket(e, 'direct')?.silentRate, 0)
})

test('a run that never reached the model is not counted at all', async () => {
  // An orphaned 0-token row never spent a big brain; calling it a silent wake
  // would inflate the very number this tracks.
  const { companyId, agentId } = await seedCompanyWithAgent()
  const convo = await seedConvo(companyId, 'group', [agentId])
  await seedRun({ companyId, agentId, convoId: convo, minutesAgo: 5, tokens: 0 })

  const e = await getWakeEconomics({ companyId })
  assert.equal(bucket(e, 'group'), undefined)
})

test('another company never leaks in', async () => {
  const mine = await seedCompanyWithAgent()
  const theirs = await seedCompanyWithAgent()
  const convo = await seedConvo(theirs.companyId, 'group', [theirs.agentId])
  await seedRun({ companyId: theirs.companyId, agentId: theirs.agentId, convoId: convo, minutesAgo: 5 })

  const e = await getWakeEconomics({ companyId: mine.companyId })
  assert.deepEqual(e.buckets, [])
})

test('the window filters out older runs', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const convo = await seedConvo(companyId, 'group', [agentId])
  await seedRun({ companyId, agentId, convoId: convo, minutesAgo: 60 * 5 })

  assert.deepEqual((await getWakeEconomics({ companyId, sinceHours: 1 })).buckets, [])
  assert.equal(bucket(await getWakeEconomics({ companyId, sinceHours: 24 }), 'group')?.runs, 1)
})

test('agentId narrows to one agent', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const { agentId: peer } = await seedCompanyWithAgent({ companyId })
  const convo = await seedConvo(companyId, 'group', [agentId, peer])
  await seedRun({ companyId, agentId, convoId: convo, minutesAgo: 5 })
  await seedRun({ companyId, agentId: peer, convoId: convo, minutesAgo: 5 })

  assert.equal(bucket(await getWakeEconomics({ companyId }), 'group')?.runs, 2)
  assert.equal(bucket(await getWakeEconomics({ companyId, agentId }), 'group')?.runs, 1)
})
