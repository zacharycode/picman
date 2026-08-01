import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Color } from '@tauri-apps/api/window'

const DARK_BACKGROUND: Color = [26, 26, 26, 255]
const LIGHT_BACKGROUND: Color = [246, 246, 247, 255]

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function currentBackground(): Color {
  return document.documentElement.dataset.theme === 'light' ? LIGHT_BACKGROUND : DARK_BACKGROUND
}

export async function revealMainWindowWhenReady() {
  if (!isTauriRuntime()) return

  const appWindow = getCurrentWindow()
  const syncBackground = () => {
    void appWindow.setBackgroundColor(currentBackground()).catch(() => undefined)
  }
  const themeObserver = new MutationObserver(syncBackground)
  themeObserver.observe(document.documentElement, { attributeFilter: ['data-theme'] })

  await appWindow.setBackgroundColor(currentBackground()).catch(() => undefined)
  document.documentElement.getBoundingClientRect()
  await appWindow.show()
  await appWindow.setFocus()
}
