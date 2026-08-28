/**
 * GitLab sign-in profile normalization.
 *
 * `NormalizedProfile.email` feeds `findOrCreateUserByProfile`'s cross-provider
 * auto-link, which attaches a new identity to an EXISTING account purely by
 * matching the address. So the address has to be one the provider attests to,
 * not merely one it reports — otherwise sign-in becomes an account-takeover
 * primitive. Google gates on `email_verified`, GitHub on the address being
 * `verified`; GitLab's equivalent is `confirmed_at`.
 *
 * These pin every refusal path, because the failure direction that matters is
 * "refuse the login", never "link to someone else's account".
 *
 * Run: node --import tsx --test server/src/__tests__/oauth-gitlab-profile.test.ts
 */
import { test, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { fetchProfile } from '../oauth.js'
import { pool } from '../db/pool.js'

const SAVED_FETCH = globalThis.fetch

interface GitLabUser {
  id: number
  username: string
  name?: string | null
  email?: string | null
  state?: string | null
  confirmed_at?: string | null
  avatar_url?: string | null
}

function mockGitLab(user: GitLabUser, base = 'https://gitlab.com') {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    if (href === `${base}/api/v4/user`) return new Response(JSON.stringify(user), { status: 200 })
    throw new Error(`unexpected fetch: ${href}`)
  }) as typeof fetch
}

afterEach(() => { globalThis.fetch = SAVED_FETCH })

after(async () => {
  // oauth.ts opens a pool + redis at module load; close them so the runner exits.
  try { await pool.end() } catch { /* ignore */ }
  try {
    const { redis, sub } = await import('../redis.js')
    redis.disconnect()
    sub.disconnect()
  } catch { /* ignore */ }
})

const CONFIRMED: GitLabUser = {
  id: 42,
  username: 'yuluo',
  name: 'Yu Luo',
  email: 'yuluo@example.com',
  state: 'active',
  confirmed_at: '2026-05-23T09:05:22Z',
  avatar_url: 'https://gitlab.com/uploads/-/system/user/avatar/42/avatar.png',
}

test('a confirmed, active account normalizes', async () => {
  mockGitLab(CONFIRMED)
  const p = await fetchProfile('gitlab', 'tok')
  assert.equal(p.providerId, '42')
  assert.equal(p.email, 'yuluo@example.com')
  assert.equal(p.displayName, 'Yu Luo')
  assert.equal(p.avatarUrl, CONFIRMED.avatar_url)
})

test('the email is lowercased, like the other providers', async () => {
  mockGitLab({ ...CONFIRMED, email: 'YuLuo@Example.COM' })
  const p = await fetchProfile('gitlab', 'tok')
  assert.equal(p.email, 'yuluo@example.com')
})

test('an unconfirmed email is refused', async () => {
  // A self-managed instance can disable user confirmation entirely, which
  // leaves confirmed_at null on an otherwise ordinary account. Trusting that
  // address would let anyone who can create an account there claim any
  // existing Cumora account by email.
  mockGitLab({ ...CONFIRMED, confirmed_at: null })
  await assert.rejects(() => fetchProfile('gitlab', 'tok'), /no confirmed email/)
})

test('a non-active account is refused even when confirmed', async () => {
  // Blocked / deactivated users can still be holding a live token.
  mockGitLab({ ...CONFIRMED, state: 'blocked' })
  await assert.rejects(() => fetchProfile('gitlab', 'tok'), /not active/)
})

test('an account that exposes no email is refused', async () => {
  mockGitLab({ ...CONFIRMED, email: null })
  await assert.rejects(() => fetchProfile('gitlab', 'tok'), /no email/)
})

test('the username stands in when the display name is empty', async () => {
  mockGitLab({ ...CONFIRMED, name: '   ' })
  const p = await fetchProfile('gitlab', 'tok')
  assert.equal(p.displayName, 'yuluo')
})

test('a self-managed instance is read from GITLAB_BASE_URL', async () => {
  // The whole point of the issue: sign in against your own GitLab.
  const { env } = await import('../env.js')
  const saved = env.GITLAB_BASE_URL
  ;(env as { GITLAB_BASE_URL: string }).GITLAB_BASE_URL = 'https://gitlab.example.com'
  try {
    mockGitLab(CONFIRMED, 'https://gitlab.example.com')
    const p = await fetchProfile('gitlab', 'tok')
    assert.equal(p.email, 'yuluo@example.com')
  } finally {
    ;(env as { GITLAB_BASE_URL: string }).GITLAB_BASE_URL = saved
  }
})
