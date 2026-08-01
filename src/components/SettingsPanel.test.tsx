import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../types/library'
import { SettingsPanel } from './SettingsPanel'

afterEach(cleanup)

function renderSettings() {
  const onSetCollectorEnabled = vi.fn()
  const onClearLibraryIndex = vi.fn()
  const onRebuildLibraryIndex = vi.fn()
  const onRetryFailedThumbnails = vi.fn()
  const onRevealThumbnailFailure = vi.fn()
  const thumbnailFailures: Asset[] = [
    {
      dimensions: '400 x 300',
      favorite: false,
      folder: '/素材',
      id: 'failed-1',
      kind: 'jpg',
      modifiedAt: '2026-07-28',
      name: '损坏图片.jpg',
      note: '',
      relativePath: '素材/损坏图片.jpg',
      sizeKb: 12,
      sourcePath: '/tmp/素材/损坏图片.jpg',
      swatch: 'blue',
      tags: [],
      thumbnailError: '无法解码图片',
      thumbnailReady: false,
    },
  ]
  render(
    <SettingsPanel
      appSettingsPath="/tmp/Picman/settings.json"
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
      thumbnailFailures={thumbnailFailures}
      updateState={{ message: '已是最新版本', status: 'none' }}
      onCheckForUpdate={vi.fn()}
      onClearLibraryIndex={onClearLibraryIndex}
      onClearThumbnailCache={vi.fn()}
      onClose={vi.fn()}
      onGenerateAllThumbnails={vi.fn()}
      onGenerateFolderThumbnails={vi.fn()}
      onOpenFolder={vi.fn()}
      onRebuildLibraryIndex={onRebuildLibraryIndex}
      onRevealAppSettings={vi.fn()}
      onRetryFailedThumbnails={onRetryFailedThumbnails}
      onRevealThumbnailFailure={onRevealThumbnailFailure}
      onSetCollectorEnabled={onSetCollectorEnabled}
      onSetDeleteShortcut={vi.fn()}
      onSetOcrApiKey={vi.fn()}
      onSetOcrLanguage={vi.fn()}
      onSetSelectionKeyAxis={vi.fn()}
      onSetThemePref={vi.fn()}
    />,
  )
  return {
    onClearLibraryIndex,
    onRetryFailedThumbnails,
    onRevealThumbnailFailure,
    onRebuildLibraryIndex,
    onSetCollectorEnabled,
  }
}

describe('SettingsPanel', () => {
  it('uses fixed thumbnail defaults and wires failure recovery plus collector controls', () => {
    const handlers = renderSettings()
    fireEvent.click(screen.getByLabelText('图片收集助手'))
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }))
    fireEvent.click(screen.getByRole('button', { name: /损坏图片\.jpg/ }))

    expect(handlers.onSetCollectorEnabled).toHaveBeenCalledWith(false)
    expect(handlers.onRetryFailedThumbnails).toHaveBeenCalledOnce()
    expect(handlers.onRevealThumbnailFailure).toHaveBeenCalledWith('failed-1')
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.queryByText('生成品质')).toBeNull()
    expect(screen.queryByRole('button', { name: '压缩已有缓存' })).toBeNull()
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
