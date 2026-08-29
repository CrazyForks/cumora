/**
 * Which column a claim advances a card into (#69).
 *
 * Claiming is the moment work starts, so the board should say Doing instead of
 * relying on the agent to remember a second command — that gap is why a board
 * could read Todo 2 / Doing 1 / Done 0 while the work was finished and
 * delivered in chat.
 *
 * The rule that carries the risk is "only ever forward". Moving someone's card
 * backwards, or out of a column whose meaning we never understood, is silent
 * damage on a surface humans are watching — so most of these cases are about
 * NOT moving.
 *
 * Run: node --import tsx --test server/src/__tests__/board-columns.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimTargetColumn, isColumnKind, isDoneColumn } from '../agents/board-columns.js'

const TODO = { id: 'c-todo', position: 1000, kind: 'todo' }
const DOING = { id: 'c-doing', position: 2000, kind: 'doing' }
const DONE = { id: 'c-done', position: 3000, kind: 'done' }
const BOARD = [TODO, DOING, DONE]

test('claiming from Todo advances to Doing', () => {
  assert.equal(claimTargetColumn({ columns: BOARD, currentColumnId: TODO.id }), DOING.id)
})

test('claiming a card already in Doing moves nothing', () => {
  // No churn, and no card.moved event for a move that did not happen.
  assert.equal(claimTargetColumn({ columns: BOARD, currentColumnId: DOING.id }), null)
})

test('claiming a finished card never drags it back', () => {
  // Re-claiming something in Done must not rewrite what the humans on the
  // board already saw.
  assert.equal(claimTargetColumn({ columns: BOARD, currentColumnId: DONE.id }), null)
})

test('a board with no Doing column moves nothing', () => {
  // Custom workflow, all columns unclassified — guessing which one meant Doing
  // is exactly what this feature exists to avoid.
  const custom = [
    { id: 'c-1', position: 1000, kind: null },
    { id: 'c-2', position: 2000, kind: null },
  ]
  assert.equal(claimTargetColumn({ columns: custom, currentColumnId: 'c-1' }), null)
})

test('a card in an unclassified column stays put even when Doing exists', () => {
  // Half-classified board: we understand where Doing is, but not where the card
  // currently sits, so moving it out could skip a step the board cares about.
  const half = [{ id: 'c-review', position: 500, kind: null }, DOING]
  assert.equal(claimTargetColumn({ columns: half, currentColumnId: 'c-review' }), null)
})

test('an unknown current column moves nothing', () => {
  assert.equal(claimTargetColumn({ columns: BOARD, currentColumnId: 'c-missing' }), null)
})

test('with several Doing columns the leftmost wins', () => {
  // Deterministic rather than dependent on row order.
  const twoDoing = [
    TODO,
    { id: 'c-doing-b', position: 2500, kind: 'doing' },
    { id: 'c-doing-a', position: 2000, kind: 'doing' },
  ]
  assert.equal(claimTargetColumn({ columns: twoDoing, currentColumnId: TODO.id }), 'c-doing-a')
})

test('an empty board moves nothing', () => {
  assert.equal(claimTargetColumn({ columns: [], currentColumnId: 'c-todo' }), null)
})

test('isColumnKind accepts only the three meanings', () => {
  for (const k of ['todo', 'doing', 'done']) assert.equal(isColumnKind(k), true)
  for (const k of ['Todo', 'in-progress', '', null, undefined, 3]) assert.equal(isColumnKind(k), false)
})

test('isDoneColumn is true only for done', () => {
  assert.equal(isDoneColumn(DONE), true)
  assert.equal(isDoneColumn(DOING), false)
  assert.equal(isDoneColumn({ kind: null }), false)
})
