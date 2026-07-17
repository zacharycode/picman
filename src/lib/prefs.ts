const APP_PREFS_KEY = 'picman-app-prefs'

export type PicmanAppPrefs = {
  activeFolder?: string
  activeTag?: string
  folderPaneHeight?: number
  inspectorVisible?: boolean
  lastLibraryRootPath?: string
  scrollPositions?: Record<string, number>
  sidebarWidth?: number
  sortDir?: string
  sortField?: string
  thumbSize?: number
  viewMode?: string
}

export function readAppPrefs(): PicmanAppPrefs {
  try {
    const raw = localStorage.getItem(APP_PREFS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeAppPrefs(prefs: PicmanAppPrefs) {
  try {
    localStorage.setItem(APP_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Local persistence is best-effort; the source files remain untouched.
  }
}

export function updateAppPrefs(update: (prefs: PicmanAppPrefs) => PicmanAppPrefs) {
  writeAppPrefs(update(readAppPrefs()))
}
