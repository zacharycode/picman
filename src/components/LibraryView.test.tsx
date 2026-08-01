import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../types/library'
import { LibraryView } from './LibraryView'

let nextFrameId = 0
let animationFrames = new Map<number, FrameRequestCallback>()
let originalClientHeight: PropertyDescriptor | undefined
let originalClientWidth: PropertyDescriptor | undefined
let assetScrollHeight = 300
let assetScrollWidth = 600

function flushAnimationFrames() {
  let remainingPasses = 20
  while (animationFrames.size > 0 && remainingPasses > 0) {
    remainingPasses -= 1
    const currentFrames = Array.from(animationFrames.values())
    animationFrames.clear()
    act(() => {
      for (const callback of currentFrames) callback(window.performance.now())
    })
  }
}

beforeEach(() => {
  assetScrollHeight = 300
  assetScrollWidth = 600
  nextFrameId = 0
  animationFrames = new Map()
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserverMock {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextFrameId += 1
    animationFrames.set(nextFrameId, callback)
    return nextFrameId
  })
  vi.stubGlobal('cancelAnimationFrame', (frameId: number) => {
    animationFrames.delete(frameId)
  })

  originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return this.classList.contains('assets-scroll') ? assetScrollHeight : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList.contains('assets-scroll') ? assetScrollWidth : 0
    },
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
  else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
  if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
})

function createAsset(index: number): Asset {
  return {
    dimensions: '800 x 600',
    favorite: false,
    folder: '/',
    height: 600,
    id: `asset-${index}`,
    kind: 'jpg',
    modifiedAt: '2026-07-28',
    name: `asset-${index}.jpg`,
    note: '',
    relativePath: `asset-${index}.jpg`,
    sizeKb: 120,
    swatch: 'blue',
    tags: [],
    thumbnailHeight: 180,
    thumbnailQuality: 'standard',
    thumbnailReady: true,
    thumbnailUrl: `https://example.test/asset-${index}.webp`,
    thumbnailWidth: 240,
    width: 800,
  }
}

function createProps(onViewportAssetIdsChange: (assetIds: string[]) => void) {
  const assets = Array.from({ length: 20 }, (_, index) => createAsset(index))
  const assetById = new Map(assets.map((asset) => [asset.id, asset]))
  const visibleAssetIds = assets.map((asset) => asset.id)
  const noop = vi.fn()

  return {
    activeFilterCount: 0,
    activeTag: 'all',
    allTags: [],
    assetById,
    assetLayoutVersion: 0,
    breadcrumb: 'Library',
    filtersOpen: false,
    getAssetIndex: (assetId: string) => visibleAssetIds.indexOf(assetId),
    inspectorVisible: false,
    keyboardScrollTargetId: null,
    keyboardScrollVersion: 0,
    onAddAssetTag: noop,
    onAssetClick: noop,
    onAssetContextMenu: noop,
    onAssetDoubleClick: noop,
    onAssetDragStart: noop,
    onDeleteSelected: noop,
    onOcr: noop,
    onOpenBatch: noop,
    onOpenFolder: noop,
    onRefresh: noop,
    onRemoveAssetTag: noop,
    onRotate: noop,
    onRotateSelected: noop,
    onShare: noop,
    onShareSelected: noop,
    onScrollPositionChange: noop,
    onSetActiveTag: noop,
    onSetAssetFavorite: noop,
    onSetFiltersOpen: noop,
    onSetQuery: noop,
    onSetSortDir: noop,
    onSetSortField: noop,
    onSetSortOpen: noop,
    onSetThumbnailState: noop,
    onSetThumbSize: noop,
    onSetTypeFilter: noop,
    onSetViewMode: noop,
    onUpdateAssetNote: noop,
    onViewportAssetIdsChange,
    primaryAsset: undefined,
    query: '',
    scrollJump: null,
    scrollRestoreKey: 'library',
    scrollTop: 0,
    selectedIds: new Set<string>(),
    sortDir: 'asc',
    sortField: 'name',
    sortOpen: false,
    statusMessage: 'ready',
    thumbnailState: 'all',
    thumbSize: 150,
    typeFilter: 'all',
    viewMode: 'adaptive',
    visibleAssetIds,
  } satisfies ComponentProps<typeof LibraryView>
}

describe('LibraryView viewport thumbnail priority', () => {
  it('reflows the virtual grid immediately when the inspector is hidden', () => {
    const props = createProps(vi.fn())
    const view = render(<LibraryView {...props} inspectorVisible />)
    flushAnimationFrames()

    const before = view.container.querySelector<HTMLElement>('[data-asset-id="asset-2"]')
    expect(before?.style.transform).toBe('translate(12px, 290px)')

    assetScrollWidth = 900
    view.rerender(<LibraryView {...props} inspectorVisible={false} />)
    flushAnimationFrames()

    const after = view.container.querySelector<HTMLElement>('[data-asset-id="asset-2"]')
    expect(after?.style.transform).toBe('translate(458px, 8px)')
  })

  it('reports exact viewport IDs once per frame and assigns eager/high only inside the viewport', () => {
    const onViewportAssetIdsChange = vi.fn()
    const props = createProps(onViewportAssetIdsChange)
    const view = render(<LibraryView {...props} />)
    flushAnimationFrames()

    expect(onViewportAssetIdsChange).toHaveBeenLastCalledWith(['asset-0', 'asset-1', 'asset-2', 'asset-3'])

    const viewportImage = view.container.querySelector<HTMLElement>('[data-asset-id="asset-0"] img')
    const overscanImage = view.container.querySelector<HTMLElement>('[data-asset-id="asset-4"] img')
    expect(viewportImage?.getAttribute('loading')).toBe('eager')
    expect(viewportImage?.getAttribute('fetchpriority')).toBe('high')
    expect(overscanImage?.getAttribute('loading')).toBe('lazy')
    expect(overscanImage?.getAttribute('fetchpriority')).toBe('low')

    onViewportAssetIdsChange.mockClear()
    view.rerender(<LibraryView {...props} statusMessage="still ready" />)
    flushAnimationFrames()
    expect(onViewportAssetIdsChange).not.toHaveBeenCalled()
  })

  it('coalesces repeated scroll events and reports the newly intersecting rows', () => {
    const onViewportAssetIdsChange = vi.fn()
    const props = createProps(onViewportAssetIdsChange)
    const view = render(<LibraryView {...props} />)
    flushAnimationFrames()
    onViewportAssetIdsChange.mockClear()

    const scrollContainer = view.container.querySelector<HTMLElement>('.assets-scroll')
    expect(scrollContainer).not.toBeNull()
    if (!scrollContainer) return

    scrollContainer.scrollTop = 600
    fireEvent.scroll(scrollContainer)
    fireEvent.scroll(scrollContainer)
    fireEvent.scroll(scrollContainer)
    flushAnimationFrames()

    expect(onViewportAssetIdsChange).toHaveBeenCalledOnce()
    expect(onViewportAssetIdsChange).toHaveBeenLastCalledWith(['asset-4', 'asset-5', 'asset-6', 'asset-7'])
  })
})
