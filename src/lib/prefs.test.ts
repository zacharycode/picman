import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

function setTauriRuntime(enabled: boolean) {
  const runtimeWindow = window as Window & { __TAURI_INTERNALS__?: unknown }
  if (enabled) runtimeWindow.__TAURI_INTERNALS__ = {}
  else delete runtimeWindow.__TAURI_INTERNALS__
}

describe('应用设置文件', () => {
  beforeEach(() => {
    vi.resetModules()
    invokeMock.mockReset()
    localStorage.clear()
    setTauriRuntime(false)
  })

  it('首次启动把旧 WebView 偏好迁移到原生 JSON', async () => {
    setTauriRuntime(true)
    localStorage.setItem('picman-app-prefs', JSON.stringify({ cacheLimitGb: 7, themePref: 'dark' }))
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'read_app_settings') {
        return { path: '/Application Support/Picman/settings.json', settings: { sidebarWidth: 248 } }
      }
      return undefined
    })
    const prefs = await import('./prefs')

    const loaded = await prefs.loadAppPrefs()

    expect(loaded).toMatchObject({ cacheLimitGb: 7, sidebarWidth: 248, themePref: 'dark', version: 1 })
    expect(prefs.getAppSettingsPath()).toBe('/Application Support/Picman/settings.json')
    expect(invokeMock).toHaveBeenCalledWith('write_app_settings', { settings: loaded })
    expect(localStorage.getItem('picman-app-prefs')).toBeNull()
  })

  it('浏览器预览仍使用本地回退，原生运行时串行写入设置文件', async () => {
    const browserPrefs = await import('./prefs')
    browserPrefs.writeAppPrefs({ thumbSize: 180 })
    expect(JSON.parse(localStorage.getItem('picman-app-prefs') ?? '{}')).toMatchObject({ thumbSize: 180, version: 1 })

    vi.resetModules()
    setTauriRuntime(true)
    invokeMock.mockResolvedValue(undefined)
    const nativePrefs = await import('./prefs')
    nativePrefs.writeAppPrefs({ cacheLimitGb: 3 })

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('write_app_settings', {
        settings: { cacheLimitGb: 3, version: 1 },
      })
    })
  })
})
