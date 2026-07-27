import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from './SettingsPanel'

afterEach(cleanup)

function renderSettings() {
  const onSetCacheLimit = vi.fn()
  const onSetCollectorEnabled = vi.fn()
  const onCompressThumbnailCache = vi.fn()
  const onClearLibraryIndex = vi.fn()
  const onRebuildLibraryIndex = vi.fn()
  render(
    <SettingsPanel
      appSettingsPath="/tmp/Picman/settings.json"
      cacheLimit={5}
      cacheSize={1024}
      collectorEnabled
      deleteShortcut="Meta+Backspace"
      folders={[]}
      generatedCount={3}
      hasNativeLibrary
      indexAssetCount={25000}
      indexBusy={false}
      indexExists
      indexSizeBytes={14 * 1024 * 1024}
      indexValid
      libraryName="素材库"
      ocrApiKey=""
      ocrLanguage="chs"
      pendingCount={7}
      selectionKeyAxis="horizontal"
      sourceSize={2048}
      themePref="system"
      thumbnailGeneration={{ completed: 0, quality: 'standard', scopeLabel: '', status: 'idle', total: 0 }}
      thumbnailQuality="standard"
      updateState={{ message: '已是最新版本', status: 'none' }}
      onCheckForUpdate={vi.fn()}
      onClearLibraryIndex={onClearLibraryIndex}
      onClearThumbnailCache={vi.fn()}
      onClose={vi.fn()}
      onCompressThumbnailCache={onCompressThumbnailCache}
      onGenerateAllThumbnails={vi.fn()}
      onGenerateFolderThumbnails={vi.fn()}
      onOpenFolder={vi.fn()}
      onRebuildLibraryIndex={onRebuildLibraryIndex}
      onRevealAppSettings={vi.fn()}
      onSetCacheLimit={onSetCacheLimit}
      onSetCollectorEnabled={onSetCollectorEnabled}
      onSetDeleteShortcut={vi.fn()}
      onSetOcrApiKey={vi.fn()}
      onSetOcrLanguage={vi.fn()}
      onSetSelectionKeyAxis={vi.fn()}
      onSetThemePref={vi.fn()}
      onSetThumbnailQuality={vi.fn()}
    />,
  )
  return {
    onClearLibraryIndex,
    onCompressThumbnailCache,
    onRebuildLibraryIndex,
    onSetCacheLimit,
    onSetCollectorEnabled,
  }
}

describe('SettingsPanel', () => {
  it('wires the real cache limit, compression, and collector controls', () => {
    const handlers = renderSettings()
    fireEvent.change(screen.getByRole('slider'), { target: { value: '8' } })
    fireEvent.click(screen.getByLabelText('图片收集助手'))
    fireEvent.click(screen.getByRole('button', { name: '压缩已有缓存' }))

    expect(handlers.onSetCacheLimit).toHaveBeenCalledWith(8)
    expect(handlers.onSetCollectorEnabled).toHaveBeenCalledWith(false)
    expect(handlers.onCompressThumbnailCache).toHaveBeenCalledOnce()
  })

  it('shows the actual file-first layout and application settings path', () => {
    const handlers = renderSettings()
    expect(screen.getByText('/tmp/Picman/settings.json')).toBeTruthy()
    expect(screen.getByText(/\.picman\.folder\.json/)).toBeTruthy()
    expect(screen.getByText('25000')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重建索引' }))
    fireEvent.click(screen.getByRole('button', { name: '清理索引' }))
    expect(handlers.onRebuildLibraryIndex).toHaveBeenCalledOnce()
    expect(handlers.onClearLibraryIndex).toHaveBeenCalledOnce()
  })
})
