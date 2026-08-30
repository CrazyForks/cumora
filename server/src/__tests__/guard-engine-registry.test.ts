import { test } from 'node:test'
import assert from 'node:assert/strict'
// The guard is plain ESM tooling; tsx lets this .ts test import the .mjs.
import { scanRepo, engineIds, extract } from '../../../scripts/guard-engine-registry.mjs'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Making an engine runnable means adding its id to about ten hand-kept lists.
// Missing one does not error — BYOA_SOURCES in particular is read through
// normalizeByoaSource(), which maps anything unknown to 'byoa-claude', so a
// half-wired engine silently bills its runs to Claude. This test is the CI
// enforcement. See scripts/guard-engine-registry.mjs.

const ROOT = join(import.meta.dirname, '..', '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

test('every engine is wired into all of its lists', () => {
  const problems = scanRepo()
  assert.deepEqual(
    problems, [],
    '\n🚨 engine registry is half-wired:\n' +
      problems.map((p) => `  ${p.where}\n    ${p.why}`).join('\n') +
      '\nAn engine must be in every list or none.',
  )
})

test('the guard is looking at a real, non-empty engine list', () => {
  // If ENGINE_IDS ever stopped parsing, scanRepo() would have nothing to check
  // and would pass vacuously. Pin that it found the engines that exist.
  const ids = engineIds(read('server/src/agents/computer/engine.ts'))
  assert.ok(ids && ids.length >= 6, `expected the real engine list, got ${JSON.stringify(ids)}`)
  assert.ok(ids.includes('claude'))
})

// --- the checks actually catch a half-wired engine (so the guard isn't a no-op) ---

test('a missing BYOA_SOURCES entry is caught', () => {
  // The one that fails silently in production, so the one most worth pinning.
  const body = extract(
    read('server/src/agents/runtime/byoa-source.ts'),
    /export const BYOA_SOURCES = \[([\s\S]*?)\] as const/,
  )
  assert.ok(body, 'anchor not found: BYOA_SOURCES')
  const ids = engineIds(read('server/src/agents/computer/engine.ts')) ?? []
  for (const id of ids) {
    assert.ok(body.includes(`'byoa-${id}'`), `'byoa-${id}' missing from BYOA_SOURCES`)
  }
  // The needle carries its quotes, so the match is exact rather than a prefix:
  // a hypothetical 'byoa-gemini-cli' entry would NOT satisfy 'byoa-gemini'.
  assert.ok(!body.includes("'byoa-gemini-cl'"))
  assert.ok(!body.includes("'byoa-notanengine'"))
})

test('an anchor that stops matching fails loudly rather than passing', () => {
  // A guard that silently stops checking is worse than no guard. `extract`
  // returns null when a declaration moves or is renamed, and scanRepo turns
  // that into a reported problem.
  assert.equal(extract('nothing to see here', /export const ENGINE_IDS: EngineId\[\] = \[([^\]]*)\]/), null)
  assert.equal(engineIds('const ENGINE_IDS = "moved elsewhere"'), null)
})

test('the spawn guard covers every engine BINARY, not every engine id', () => {
  // cursor's binary is `cursor-agent`, so checking ids against R4 would pass
  // while the real binary went unguarded.
  const bigBrain = read('scripts/guard-big-brain.mjs')
  const at = bigBrain.indexOf('R4 —')
  assert.ok(at >= 0, 'anchor not found: R4')
  const alt = extract(bigBrain.slice(at, at + 400), /\(([a-z0-9|-]{10,})\)/)
  assert.ok(alt, 'anchor not found: the R4 engine-binary alternation')
  assert.ok(alt.split('|').includes('cursor-agent'))
})

// --- the script actually RUNS when launched as a CLI ---

test('the CLI entry point reaches scanRepo, not just exits 0', () => {
  // Every test above calls scanRepo() directly, so none of them can tell a
  // working guard from one whose main-module check never fires. That is not
  // hypothetical: the first version compared `import.meta.url` against a
  // hand-built `file://${process.argv[1]}`, which never matches on Windows —
  // `npm run guard:engine-registry` exited 0 having checked nothing.
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'guard-engine-registry.mjs')], {
    cwd: ROOT, encoding: 'utf8',
  })
  assert.match(out, /engine registry guard/, `the script printed nothing:\n${out}`)
})

test('the CLI exits non-zero when a list is half-wired', () => {
  // The other half of the same property: a guard that always exits 0 is
  // indistinguishable from a passing one until something is actually broken.
  const script = readFileSync(join(ROOT, 'scripts', 'guard-engine-registry.mjs'), 'utf8')
  // Point the BYOA_SOURCES check at a declaration that cannot contain any
  // engine, so the run must fail. Written to a sibling file so the real script
  // is never modified.
  const sabotaged = script.replace(
    "/export const BYOA_SOURCES = \\[([\\s\\S]*?)\\] as const/",
    "/export const BYOA_SOURCE_SET = new Set<string>\\((BYOA_SOURCES)\\)/",
  )
  assert.notEqual(sabotaged, script, 'the BYOA_SOURCES anchor moved — update this test with it')
  const tmp = join(ROOT, 'scripts', '.guard-entry-probe.mjs')
  writeFileSync(tmp, sabotaged, 'utf8')
  try {
    let code = 0
    let stdout = ''
    try {
      stdout = execFileSync(process.execPath, [tmp], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    } catch (e) {
      code = (e as { status?: number }).status ?? 0
      stdout = String((e as { stdout?: string }).stdout ?? '')
    }
    assert.equal(code, 1, `expected a failing exit, got ${code}; stdout was:\n${stdout}`)
  } finally {
    rmSync(tmp, { force: true })
  }
})
