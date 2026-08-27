/**
 * Appearance picker — system / light / dark — plus chat layout
 * (official thread vs left/right bubbles).
 *
 * Shared by desktop Preferences and the mobile You screen so the two
 * shells can't drift apart on which choices exist or how they're worded.
 * Lives next to the language picker: both are per-device, apply
 * immediately, and never round-trip through server preferences.
 */
import { Select } from '@/components/Select'
import { useT, type MessageKey } from '@/lib/i18n'
import { useAppearanceStore, type Appearance } from '@/lib/theme'
import { useChatLayoutStore, type ChatLayout } from '@/lib/chatLayout'

const OPTIONS: Array<{ value: Appearance; label: MessageKey }> = [
  { value: 'system', label: 'common.appearance.system' },
  { value: 'light', label: 'common.appearance.light' },
  { value: 'dark', label: 'common.appearance.dark' },
]

export function AppearancePicker({ className }: { className?: string }) {
  const t = useT()
  const appearance = useAppearanceStore((s) => s.appearance)
  const setAppearance = useAppearanceStore((s) => s.setAppearance)

  return (
    <Select<Appearance>
      className={className}
      value={appearance}
      ariaLabel={t('common.appearance')}
      onValueChange={setAppearance}
      options={OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))}
    />
  )
}

const LAYOUT_OPTIONS: Array<{ value: ChatLayout; label: MessageKey }> = [
  { value: 'thread', label: 'common.chatLayout.thread' },
  { value: 'bubble', label: 'common.chatLayout.bubble' },
]

export function ChatLayoutPicker({ className }: { className?: string }) {
  const t = useT()
  const layout = useChatLayoutStore((s) => s.layout)
  const setLayout = useChatLayoutStore((s) => s.setLayout)

  return (
    <Select<ChatLayout>
      className={className}
      value={layout}
      ariaLabel={t('common.chatLayout')}
      onValueChange={setLayout}
      options={LAYOUT_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))}
    />
  )
}
