/**
 * The browser half of composer-draft persistence: mirror the store's drafts
 * into localStorage so a reload or an app restart doesn't lose a half-typed
 * message.
 *
 * Split from ./composerDrafts on purpose. That module holds the policy — what
 * a draft is, how many we keep, what a stored blob is allowed to decode to —
 * and stays free of the DOM and of the `@/` alias so the server test runner
 * can exercise it directly. Everything that needs a `window` lives here.
 */
import type { ApiAttachment } from '@/api/client'
import {
  STORAGE_KEY, parseStoredDrafts, serializeDrafts,
  type ComposerDrafts, type DraftAttachment,
} from './composerDrafts'

/** The policy module re-declares the attachment shape rather than importing
 *  it. These two assignments are the drift alarm: if `ApiAttachment` gains a
 *  required field, or the two shapes stop lining up, the client build fails
 *  here instead of silently dropping data on the way to or from storage. */
const _draftAttachmentIsApiAttachment: DraftAttachment = null as unknown as ApiAttachment
const _apiAttachmentIsDraftAttachment: ApiAttachment = null as unknown as DraftAttachment
void _draftAttachmentIsApiAttachment
void _apiAttachmentIsDraftAttachment

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
 * Mirror drafts on a trailing debounce: typing calls this on every keystroke,
 * and a synchronous localStorage write per keystroke is a jank source on a
 * long draft. The unload flush below is what makes the debounce safe —
 * otherwise closing the window inside the window would lose exactly the
 * keystrokes this exists to protect.
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
  // `pagehide` covers tab close and navigation, including the back/forward
  // cache path where `beforeunload` doesn't fire. `visibilitychange` covers
  // backgrounding the app without closing it, which is the common case on
  // mobile and when the desktop window is hidden rather than quit.
  window.addEventListener('pagehide', flushComposerDrafts)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushComposerDrafts()
  })
}
