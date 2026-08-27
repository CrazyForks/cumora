/**
 * Chat bubble layout — per-device, like appearance and locale.
 *
 * Default is `thread` (official: every message on the left). `bubble`
 * puts your messages on the right. Not synced through server
 * preferences: two devices can disagree.
 */
import { create } from 'zustand'

export type ChatLayout = 'thread' | 'bubble'

const STORAGE_KEY = 'cumora.chatLayout'

function isChatLayout(v: string | null): v is ChatLayout {
  return v === 'thread' || v === 'bubble'
}

function readInitial(): ChatLayout {
  if (typeof window === 'undefined') return 'thread'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (isChatLayout(raw)) return raw
  } catch {
    /* private mode */
  }
  return 'thread'
}

interface ChatLayoutState {
  layout: ChatLayout
  setLayout(next: ChatLayout): void
}

export const useChatLayoutStore = create<ChatLayoutState>((set) => ({
  layout: readInitial(),
  setLayout(next) {
    set({ layout: next })
    try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* ignore */ }
  },
}))
