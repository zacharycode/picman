const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift'])

const DISPLAY_MAP: Record<string, string> = {
  Meta: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Backspace: '⌫',
  Delete: '⌦',
  Enter: '↩',
  Space: '␣',
  Escape: '⎋',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
}

/** Normalize a keyboard event into a stable "Meta+Backspace" style string.
 * Returns null for a bare modifier press so capture can keep waiting. */
export function eventToShortcut(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null

  const parts: string[] = []
  if (event.metaKey) parts.push('Meta')
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  let key = event.key
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  parts.push(key)

  return parts.join('+')
}

export function formatShortcut(shortcut: string): string {
  if (!shortcut) return '未设置'
  return shortcut
    .split('+')
    .map((part) => DISPLAY_MAP[part] ?? part)
    .join(' ')
}
