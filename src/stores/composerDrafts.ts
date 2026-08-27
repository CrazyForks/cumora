/**
 * Composer draft persistence — the storage half of `useApp().composerDrafts`.
 *
 * A half-typed message is the user's work, and it used to evaporate twice
 * over: the desktop composer kept drafts in component state, so switching to
 * Boards and back unmounted the pane and took them with it, and nothing
 * survived a reload on either shell. Drafts now live in the store (one mount
 * boundary can't destroy them) and mirror to localStorage (a restart can't
 * either).
 *
 * Kept in its own module so the policy — what a draft is, how many we keep,
 * how big the mirror may get — is testable without a store or a DOM.
 */
import type { ApiAttachment } from '@/api/client'

export interface ComposerDraft {
  text: string
  /** An upload the user already paid for. Dropping it on navigation loses a
   *  file that is sitting in storage, so it rides along with the text. */
  attachment: ApiAttachment | null
}

/** Keyed by composer SCOPE, not conversation: the desktop thread drawer is a
 *  separate composer over the same conversation (`<id>::thread::<rootId>`) and
 *  must not share text with the main one. Mobile has one composer per
 *  conversation, so its scope is just the conversation id. */
export type ComposerDrafts = Record<string, ComposerDraft>

export const STORAGE_KEY = 'cumora.composerDrafts'

/** Enough that nobody realistically hits it, small enough that a pathological
 *  client can't turn localStorage into a landfill. Eviction is least-recently-
 *  updated (see `touch`). */
export const MAX_DRAFTS = 50
/** Hard ceiling on the serialized mirror. localStorage is a shared ~5MB budget
 *  for the whole origin; drafts are a guest in it, not the tenant. */
export const MAX_SERIALIZED_BYTES = 256 * 1024

export const EMPTY_DRAFT: ComposerDraft = { text: '', attachment: null }

export function emptyComposerDraft(): ComposerDraft {
  return EMPTY_DRAFT
}

export function isEmptyDraft(d: ComposerDraft): boolean {
  return d.text === '' && d.attachment === null
}

/** Re-insert a key so it lands at the end of the object's iteration order.
 *  That ordering IS the LRU record — it means a draft needs no timestamp
 *  field, and eviction can just take from the front. */
function touch(drafts: ComposerDrafts, scope: string, next: ComposerDraft): ComposerDrafts {
  const copy = { ...drafts }
  delete copy[scope]
  copy[scope] = next
  return copy
}

/**
 * Apply an update to one scope, returning the SAME object when nothing
 * changed so React and the store can both skip the render.
 *
 * An emptied draft is deleted rather than stored as `{ text: '' }` — otherwise
 * every conversation the user ever opened would accumulate a tombstone and
 * consume one of the MAX_DRAFTS slots.
 */
export function applyDraftUpdate(
  drafts: ComposerDrafts,
  scope: string,
  updater: (current: ComposerDraft) => ComposerDraft,
): ComposerDrafts {
  const current = drafts[scope] ?? EMPTY_DRAFT
  const next = updater(current)
  if (next.text === current.text && next.attachment === current.attachment) return drafts
  if (isEmptyDraft(next)) {
    if (!(scope in drafts)) return drafts
    const copy = { ...drafts }
    delete copy[scope]
    return copy
  }
  return evict(touch(drafts, scope, next))
}

/** Trim to MAX_DRAFTS, oldest-touched first. */
export function evict(drafts: ComposerDrafts): ComposerDrafts {
  const keys = Object.keys(drafts)
  if (keys.length <= MAX_DRAFTS) return drafts
  const copy = { ...drafts }
  for (const k of keys.slice(0, keys.length - MAX_DRAFTS)) delete copy[k]
  return copy
}

/** Coerce whatever is in storage into the current shape. Anything unrecognized
 *  is dropped rather than trusted: this data is replayed into a composer, and
 *  a bad `attachment` would be handed to the send path. */
export function parseStoredDrafts(raw: string | null): ComposerDrafts {
  if (!raw) return {}
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return {} }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: ComposerDrafts = {}
  for (const [scope, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!scope || typeof value !== 'object' || value === null) continue
    const v = value as { text?: unknown; attachment?: unknown }
    const text = typeof v.text === 'string' ? v.text : ''
    const attachment = parseAttachment(v.attachment)
    const draft: ComposerDraft = { text, attachment }
    if (!isEmptyDraft(draft)) out[scope] = draft
  }
  return evict(out)
}

function parseAttachment(value: unknown): ApiAttachment | null {
  if (!value || typeof value !== 'object') return null
  const a = value as Record<string, unknown>
  if (typeof a.url !== 'string' || typeof a.name !== 'string') return null
  const kind = a.kind
  if (kind !== 'img' && kind !== 'pdf' && kind !== 'file' && kind !== 'fig') return null
  return {
    url: a.url,
    name: a.name,
    kind,
    ...(typeof a.mime === 'string' ? { mime: a.mime } : {}),
    ...(typeof a.size === 'number' ? { size: a.size } : {}),
    ...(typeof a.key === 'string' ? { key: a.key } : {}),
  }
}

/** Serialize within the byte ceiling, dropping oldest-touched drafts until it
 *  fits. Returns null when even one draft is too big to keep. */
export function serializeDrafts(drafts: ComposerDrafts): string | null {
  let working = evict(drafts)
  for (;;) {
    const json = JSON.stringify(working)
    if (json.length <= MAX_SERIALIZED_BYTES) return json
    const keys = Object.keys(working)
    if (keys.length <= 1) return null
    const copy = { ...working }
    delete copy[keys[0]]
    working = copy
  }
}

export function loadComposerDrafts(): ComposerDrafts {
  if (typeof localStorage === 'undefined') return {}
  try {
    return parseStoredDrafts(localStorage.getItem(STORAGE_KEY))
  } catch {
    return {}
  }
}

let flushTimer: ReturnType<typeof setTimeout> | null = null
let pending: ComposerDrafts | null = null

function writeNow(): void {
  if (pending === null) return
  const drafts = pending
  pending = null
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  try {
    if (Object.keys(drafts).length === 0) { localStorage.removeItem(STORAGE_KEY); return }
    const json = serializeDrafts(drafts)
    if (json === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, json)
  } catch {
    /* private mode, quota, disabled storage — a lost mirror must never break typing */
  }
}

/**
 * Mirror drafts to localStorage on a trailing debounce: typing fires this on
 * every keystroke, and a synchronous localStorage write per keystroke is a
 * jank source on long drafts. The `pagehide` flush below is what makes the
 * debounce safe — otherwise closing the window inside the window would lose
 * the very keystrokes this exists to protect.
 */
export function saveComposerDrafts(drafts: ComposerDrafts): void {
  if (typeof localStorage === 'undefined') return
  pending = drafts
  if (flushTimer) return
  flushTimer = setTimeout(() => { flushTimer = null; writeNow() }, 400)
}

/** Write immediately — used by the unload hooks and by tests. */
export function flushComposerDrafts(): void {
  writeNow()
}

if (typeof window !== 'undefined') {
  // `pagehide` fires on tab close, navigation and (unlike `beforeunload`)
  // the iOS back/forward cache path. `visibilitychange` covers backgrounding
  // the app without closing it, which is the common mobile case.
  window.addEventListener('pagehide', flushComposerDrafts)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushComposerDrafts()
  })
}
