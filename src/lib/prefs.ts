import { invoke } from '@tauri-apps/api/core'

const APP_PREFS_KEY = 'picman-app-prefs'
const APP_PREFS_VERSION = 1
const NATIVE_WRITE_DEBOUNCE_MS = 180

export type PicmanAppPrefs = {
  version?: number
  activeFolder?: string
  activeTag?: string
  cacheLimitGb?: number
  collectorEnabled?: boolean
  deleteShortcut?: string
  folderPaneHeight?: number
  inspectorVisible?: boolean
  lastCollectFolder?: string
  lastLibraryRootPath?: string
  ocrApiKey?: string
  ocrLanguage?: string
  scrollPositions?: Record<string, number>
  selectionKeyAxis?: string
  sidebarWidth?: number
  sortDir?: string
  sortField?: string
  themePref?: string
  thumbSize?: number
  thumbnailQuality?: string
  viewMode?: string
}

type NativeAppSettingsResponse = {
  path: string
  settings: PicmanAppPrefs
}

let currentPrefs: PicmanAppPrefs | null = null
let currentSettingsPath = ''
let nativeWriteQueue = Promise.resolve()
let nativeWriteTimer: number | undefined
let pendingNativePrefs: PicmanAppPrefs | null = null

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function readLegacyAppPrefs(): PicmanAppPrefs {
  let prefs: PicmanAppPrefs = {}
  try {
    const raw = localStorage.getItem(APP_PREFS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') prefs = parsed
    }

    prefs.themePref ??= localStorage.getItem('picman-theme') ?? undefined
    prefs.ocrApiKey ??= localStorage.getItem('picman-ocr-apikey') ?? undefined
    prefs.ocrLanguage ??= localStorage.getItem('picman-ocr-language') ?? undefined
    prefs.deleteShortcut ??= localStorage.getItem('picman-delete-shortcut') ?? undefined
  } catch {
    return prefs
  }
  return prefs
}

function removeLegacyAppPrefs() {
  try {
    localStorage.removeItem(APP_PREFS_KEY)
    localStorage.removeItem('picman-ocr-apikey')
    localStorage.removeItem('picman-ocr-language')
    localStorage.removeItem('picman-delete-shortcut')
  } catch {
    // The native JSON remains the source of truth even if WebView cleanup fails.
  }
}

function normalizePrefs(prefs: PicmanAppPrefs): PicmanAppPrefs {
  return {
    ...prefs,
    scrollPositions: prefs.scrollPositions ? { ...prefs.scrollPositions } : undefined,
    version: APP_PREFS_VERSION,
  }
}

function enqueueNativeWrite(snapshot: PicmanAppPrefs) {
  nativeWriteQueue = nativeWriteQueue
    .catch(() => undefined)
    .then(async () => {
      await invoke('write_app_settings', { settings: snapshot })
      removeLegacyAppPrefs()
    })
    .catch(() => undefined)
  return nativeWriteQueue
}

function drainPendingNativeWrite() {
  if (!pendingNativePrefs) return nativeWriteQueue
  const snapshot = pendingNativePrefs
  pendingNativePrefs = null
  return enqueueNativeWrite(snapshot)
}

export async function loadAppPrefs(): Promise<PicmanAppPrefs> {
  const legacy = readLegacyAppPrefs()
  if (!isTauriRuntime()) {
    currentPrefs = normalizePrefs(legacy)
    return currentPrefs
  }

  try {
    const response = await invoke<NativeAppSettingsResponse>('read_app_settings')
    currentSettingsPath = response.path
    const nativeSettings = response.settings && typeof response.settings === 'object' ? response.settings : {}
    currentPrefs = normalizePrefs({ ...legacy, ...nativeSettings })

    if (JSON.stringify(currentPrefs) !== JSON.stringify(nativeSettings)) {
      await invoke('write_app_settings', { settings: currentPrefs })
    }
    removeLegacyAppPrefs()
    return currentPrefs
  } catch {
    currentPrefs = normalizePrefs(legacy)
    return currentPrefs
  }
}

export function readAppPrefs(): PicmanAppPrefs {
  return currentPrefs ?? normalizePrefs(readLegacyAppPrefs())
}

export function getAppSettingsPath() {
  return currentSettingsPath
}

export function writeAppPrefs(prefs: PicmanAppPrefs) {
  currentPrefs = normalizePrefs(prefs)

  try {
    if (currentPrefs.themePref) localStorage.setItem('picman-theme', currentPrefs.themePref)
  } catch {
    // The theme mirror is only used before first paint.
  }

  if (!isTauriRuntime()) {
    try {
      localStorage.setItem(APP_PREFS_KEY, JSON.stringify(currentPrefs))
    } catch {
      // Browser persistence is best-effort.
    }
    return
  }

  pendingNativePrefs = currentPrefs
  if (nativeWriteTimer !== undefined) window.clearTimeout(nativeWriteTimer)
  nativeWriteTimer = window.setTimeout(() => {
    nativeWriteTimer = undefined
    void drainPendingNativeWrite()
  }, NATIVE_WRITE_DEBOUNCE_MS)
}

export function updateAppPrefs(update: (prefs: PicmanAppPrefs) => PicmanAppPrefs) {
  writeAppPrefs(update(readAppPrefs()))
}

export async function flushAppPrefs() {
  if (!isTauriRuntime()) return
  if (nativeWriteTimer !== undefined) {
    window.clearTimeout(nativeWriteTimer)
    nativeWriteTimer = undefined
  }
  await drainPendingNativeWrite()
}

export async function revealAppSettingsFile() {
  if (!isTauriRuntime()) return
  await flushAppPrefs()
  await invoke('reveal_app_settings_file')
}
