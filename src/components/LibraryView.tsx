import {
  ArrowDownUp,
  Columns3,
  FolderOpen,
  LayoutGrid,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Rows3,
  Search,
  Share2,
  SlidersHorizontal,
  Trash2,
  Wand2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, MouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { createRafNumberCommitter } from '../lib/rafState'
import { SORT_LABELS } from '../lib/sort'
import type {
  Asset,
  AssetKind,
  AssetViewMode,
  ScrollJumpCommand,
  SortDir,
  SortField,
  ThumbnailState,
} from '../types/library'
import { AssetItem } from './AssetItem'
import type { AssetItemLayout } from './AssetItem'
import { FilterPopover } from './FilterPopover'
import { EmptyInspector, Inspector, MultiSelectInspector } from './Inspector'
import { SortDropdown } from './SortDropdown'

const INSPECTOR_MIN = 176
const INSPECTOR_MAX = 340
const ADAPTIVE_GAP_X = 16
const ADAPTIVE_GAP_Y = 30
const ADAPTIVE_PADDING_X = 12
const ADAPTIVE_PADDING_TOP = 8
const ADAPTIVE_PADDING_BOTTOM = 22
const ADAPTIVE_TEXT_HEIGHT = 42
const LIST_ROW_HEIGHT = 66
const LIST_PADDING_TOP = 4
const LIST_PADDING_BOTTOM = 22
const MASONRY_GAP_X = 18
const MASONRY_GAP_Y = 26
const MASONRY_PADDING_X = 16
const MASONRY_PADDING_TOP = 12
const MASONRY_PADDING_BOTTOM = 28
const MASONRY_TEXT_HEIGHT = 42
const VIRTUAL_OVERSCAN_PX = 900
const VIRTUAL_FAST_OVERSCAN_PX = 2400
const VIRTUAL_SCROLL_STEP_PX = 48
const FAST_SCROLL_VELOCITY_PX_PER_MS = 1.2
const SCROLL_SETTLE_MS = 120
const VIEW_MODE_LABELS: Record<AssetViewMode, string> = {
  adaptive: '自适应',
  masonry: '瀑布流',
  list: '列表',
}

type AssetGridStyle = CSSProperties & {
  '--asset-thumb-size'?: string
}

type ViewportState = {
  height: number
  scrollDirection: 'down' | 'up'
  scrollSpeed: number
  scrollTop: number
  width: number
}

type VirtualAssetItem = AssetItemLayout & {
  assetId: string
}

type VirtualPosition = {
  height: number
  top: number
}

type VirtualLayout = {
  items: VirtualAssetItem[]
  totalHeight: number
}

type AdaptiveLayoutMetrics = {
  columns: number
  itemHeight: number
  itemWidth: number
  rowPitch: number
  totalHeight: number
}

type MasonryVirtualItem = {
  assetId: string
  height: number
  left: number
  ratio: number
  top: number
  width: number
}

type MasonryLayoutData = {
  items: MasonryVirtualItem[]
  maxItemHeight: number
  totalHeight: number
}

const masonryPositionCache = new WeakMap<MasonryLayoutData, Map<string, VirtualPosition>>()

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function cssAttributeString(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function getOverscanWindow(viewport: ViewportState) {
  const fastAmount = clamp(viewport.scrollSpeed / FAST_SCROLL_VELOCITY_PX_PER_MS, 0, 1)
  const overscan = VIRTUAL_OVERSCAN_PX + (VIRTUAL_FAST_OVERSCAN_PX - VIRTUAL_OVERSCAN_PX) * fastAmount
  const leading = Math.round(overscan)
  const trailing = Math.round(overscan * (fastAmount > 0 ? 0.45 : 1))

  return viewport.scrollDirection === 'down'
    ? { after: leading, before: trailing }
    : { after: trailing, before: leading }
}

function quantizeScrollSpeed(speed: number) {
  if (speed < 0.08) return 0
  if (speed < 0.45) return 0.3
  if (speed < 0.9) return 0.75
  return FAST_SCROLL_VELOCITY_PX_PER_MS
}

function quantizeScrollTop(scrollTop: number, scrollDirection: ViewportState['scrollDirection']) {
  if (scrollTop <= 0) return 0

  const bucket = scrollTop / VIRTUAL_SCROLL_STEP_PX
  const snapped = scrollDirection === 'up' ? Math.ceil(bucket) : Math.floor(bucket)
  return Math.max(0, snapped * VIRTUAL_SCROLL_STEP_PX)
}

function getAssetNumberRatio(asset?: Asset) {
  if (!asset) return 16 / 10
  if (asset.width && asset.height) return asset.width / asset.height
  if (asset.thumbnailWidth && asset.thumbnailHeight) return asset.thumbnailWidth / asset.thumbnailHeight

  const match = asset.dimensions.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i)
  if (!match) return 16 / 10

  const width = Number(match[1])
  const height = Number(match[2])

  return width > 0 && height > 0 ? width / height : 16 / 10
}

function createAdaptiveMetrics(assetCount: number, viewportWidth: number, thumbSize: number): AdaptiveLayoutMetrics {
  const safeViewportWidth = Math.max(1, viewportWidth || 960)
  const contentWidth = Math.max(1, safeViewportWidth - ADAPTIVE_PADDING_X * 2)
  const minColumnWidth = Math.max(178, thumbSize + 34)
  const columns = Math.max(1, Math.floor((contentWidth + ADAPTIVE_GAP_X) / (minColumnWidth + ADAPTIVE_GAP_X)))
  const itemWidth = Math.floor((contentWidth - ADAPTIVE_GAP_X * (columns - 1)) / columns)
  const thumbHeight = itemWidth * 0.75
  const itemHeight = thumbHeight + ADAPTIVE_TEXT_HEIGHT
  const rowPitch = itemHeight + ADAPTIVE_GAP_Y
  const rowCount = Math.ceil(assetCount / columns)
  const totalHeight =
    ADAPTIVE_PADDING_TOP +
    Math.max(0, rowCount * rowPitch - ADAPTIVE_GAP_Y) +
    ADAPTIVE_PADDING_BOTTOM

  return {
    columns,
    itemHeight,
    itemWidth,
    rowPitch,
    totalHeight,
  }
}

function getAdaptivePosition(index: number, metrics: AdaptiveLayoutMetrics): VirtualPosition {
  const row = Math.floor(index / metrics.columns)
  return {
    height: metrics.itemHeight,
    top: ADAPTIVE_PADDING_TOP + row * metrics.rowPitch,
  }
}

function createAdaptiveLayout(
  assetIds: string[],
  viewport: ViewportState,
  metrics: AdaptiveLayoutMetrics,
): VirtualLayout {
  const viewportHeight = Math.max(1, viewport.height || 620)
  const overscan = getOverscanWindow(viewport)
  const firstRow = Math.max(
    0,
    Math.floor((viewport.scrollTop - overscan.before - ADAPTIVE_PADDING_TOP) / metrics.rowPitch),
  )
  const lastRow = Math.min(
    Math.ceil(assetIds.length / metrics.columns) - 1,
    Math.ceil((viewport.scrollTop + viewportHeight + overscan.after - ADAPTIVE_PADDING_TOP) / metrics.rowPitch),
  )
  const startIndex = firstRow * metrics.columns
  const endIndex = Math.min(assetIds.length, (lastRow + 1) * metrics.columns)
  const items = new Array<VirtualAssetItem>(Math.max(0, endIndex - startIndex))
  let itemIndex = 0

  for (let index = startIndex; index < endIndex; index += 1) {
    const assetId = assetIds[index]
    const row = Math.floor(index / metrics.columns)
    const column = index % metrics.columns
    items[itemIndex] = {
      assetId,
      height: metrics.itemHeight,
      left: ADAPTIVE_PADDING_X + column * (metrics.itemWidth + ADAPTIVE_GAP_X),
      top: ADAPTIVE_PADDING_TOP + row * metrics.rowPitch,
      width: metrics.itemWidth,
    }
    itemIndex += 1
  }

  return {
    items,
    totalHeight: metrics.totalHeight,
  }
}

function getListPosition(index: number): VirtualPosition {
  return {
    height: LIST_ROW_HEIGHT,
    top: LIST_PADDING_TOP + index * LIST_ROW_HEIGHT,
  }
}

function createListLayout(assetIds: string[], viewport: ViewportState): VirtualLayout {
  const viewportHeight = Math.max(1, viewport.height || 620)
  const totalHeight = LIST_PADDING_TOP + assetIds.length * LIST_ROW_HEIGHT + LIST_PADDING_BOTTOM
  const overscan = getOverscanWindow(viewport)
  const firstIndex = Math.max(
    0,
    Math.floor((viewport.scrollTop - overscan.before - LIST_PADDING_TOP) / LIST_ROW_HEIGHT),
  )
  const lastIndex = Math.min(
    assetIds.length - 1,
    Math.ceil((viewport.scrollTop + viewportHeight + overscan.after - LIST_PADDING_TOP) / LIST_ROW_HEIGHT),
  )
  const items = new Array<VirtualAssetItem>(Math.max(0, lastIndex - firstIndex + 1))
  let itemIndex = 0

  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const assetId = assetIds[index]
    items[itemIndex] = {
      assetId,
      height: LIST_ROW_HEIGHT,
      left: 0,
      right: 0,
      top: LIST_PADDING_TOP + index * LIST_ROW_HEIGHT,
    }
    itemIndex += 1
  }

  return {
    items,
    totalHeight,
  }
}

function createMasonryLayoutData(
  assetIds: string[],
  assetById: ReadonlyMap<string, Asset>,
  viewportWidth: number,
  thumbSize: number,
): MasonryLayoutData {
  const width = Math.max(1, viewportWidth || 960)
  const contentWidth = Math.max(1, width - MASONRY_PADDING_X * 2)
  const minColumnWidth = Math.max(124, thumbSize)
  const columns = Math.max(1, Math.floor((contentWidth + MASONRY_GAP_X) / (minColumnWidth + MASONRY_GAP_X)))
  const columnWidth = Math.floor((contentWidth - MASONRY_GAP_X * (columns - 1)) / columns)
  const columnHeights = Array.from({ length: columns }, () => MASONRY_PADDING_TOP)
  const items = new Array<MasonryVirtualItem>(assetIds.length)
  let maxItemHeight = 0
  let maxColumnHeight = MASONRY_PADDING_TOP
  let itemIndex = 0

  // Shortest-column placement emits items in visual top/left order, so visibleAssetIds is already the visual order.
  for (const assetId of assetIds) {
    let column = 0
    for (let index = 1; index < columnHeights.length; index += 1) {
      if (columnHeights[index] < columnHeights[column]) column = index
    }

    const ratio = clamp(getAssetNumberRatio(assetById.get(assetId)), 0.18, 6)
    const thumbHeight = columnWidth / ratio
    const itemHeight = thumbHeight + MASONRY_TEXT_HEIGHT
    const top = columnHeights[column]
    const left = MASONRY_PADDING_X + column * (columnWidth + MASONRY_GAP_X)
    const item = {
      assetId,
      height: itemHeight,
      left,
      ratio,
      top,
      width: columnWidth,
    }

    items[itemIndex] = item
    itemIndex += 1
    maxItemHeight = Math.max(maxItemHeight, itemHeight)
    columnHeights[column] += itemHeight + MASONRY_GAP_Y
    maxColumnHeight = Math.max(maxColumnHeight, columnHeights[column])
  }

  const totalHeight = Math.max(
    MASONRY_PADDING_TOP + MASONRY_PADDING_BOTTOM,
    maxColumnHeight - MASONRY_GAP_Y + MASONRY_PADDING_BOTTOM,
  )

  return {
    items,
    maxItemHeight,
    totalHeight,
  }
}

function getMasonryPosition(layoutData: MasonryLayoutData | undefined, assetId: string): VirtualPosition | undefined {
  if (!layoutData) return undefined

  let positionById = masonryPositionCache.get(layoutData)
  if (!positionById) {
    positionById = new Map<string, VirtualPosition>()
    for (const item of layoutData.items) {
      positionById.set(item.assetId, { height: item.height, top: item.top })
    }
    masonryPositionCache.set(layoutData, positionById)
  }

  return positionById.get(assetId)
}

function lowerBoundMasonryItems(items: MasonryVirtualItem[], targetTop: number) {
  let low = 0
  let high = items.length

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (items[mid].top < targetTop) low = mid + 1
    else high = mid
  }

  return low
}

function upperBoundMasonryItems(items: MasonryVirtualItem[], targetTop: number) {
  let low = 0
  let high = items.length

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (items[mid].top <= targetTop) low = mid + 1
    else high = mid
  }

  return low
}

function createMasonryLayout(layoutData: MasonryLayoutData, viewport: ViewportState): VirtualLayout {
  const viewportHeight = Math.max(1, viewport.height || 620)
  const overscan = getOverscanWindow(viewport)
  const minTop = viewport.scrollTop - overscan.before
  const maxTop = viewport.scrollTop + viewportHeight + overscan.after
  const startIndex = lowerBoundMasonryItems(layoutData.items, minTop - layoutData.maxItemHeight)
  const endIndex = upperBoundMasonryItems(layoutData.items, maxTop)
  const items = new Array<VirtualAssetItem>(Math.max(0, endIndex - startIndex))
  let itemIndex = 0

  for (let index = startIndex; index < endIndex; index += 1) {
    const item = layoutData.items[index]
    if (item.top + item.height >= minTop) {
      items[itemIndex] = {
        aspectRatio: String(item.ratio),
        assetId: item.assetId,
        height: item.height,
        left: item.left,
        top: item.top,
        width: item.width,
      }
      itemIndex += 1
    }
  }
  items.length = itemIndex

  return {
    items,
    totalHeight: layoutData.totalHeight,
  }
}

function virtualAssetIdsInViewport(items: VirtualAssetItem[], scrollTop: number, viewportHeight: number) {
  const viewportBottom = scrollTop + Math.max(1, viewportHeight)
  const assetIds = new Array<string>(items.length)
  let assetCount = 0

  for (const item of items) {
    if (item.top >= viewportBottom || item.top + item.height <= scrollTop) continue

    assetIds[assetCount] = item.assetId
    assetCount += 1
  }

  assetIds.length = assetCount
  return assetIds
}

function sameAssetIds(a: string[], b: string[]) {
  if (a === b) return true
  if (a.length !== b.length) return false

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }

  return true
}

type LibraryViewProps = {
  activeTag: string
  activeFilterCount: number
  allTags: string[]
  assetById: ReadonlyMap<string, Asset>
  assetLayoutVersion: number
  breadcrumb: string
  filtersOpen: boolean
  getAssetIndex: (assetId: string) => number
  inspectorVisible: boolean
  keyboardScrollTargetId: string | null
  keyboardScrollVersion: number
  scrollJump: ScrollJumpCommand | null
  scrollRestoreKey: string
  scrollTop: number
  primaryAsset?: Asset
  query: string
  selectedIds: Set<string>
  sortDir: SortDir
  sortField: SortField
  sortOpen: boolean
  statusMessage: string
  thumbnailState: ThumbnailState
  thumbSize: number
  typeFilter: 'all' | AssetKind
  viewMode: AssetViewMode
  visibleAssetIds: string[]
  onAddAssetTag: (assetId: string, tag: string) => void
  onAssetClick: (asset: Asset, event: MouseEvent<HTMLDivElement>) => void
  onAssetContextMenu: (asset: Asset, event: MouseEvent<HTMLDivElement>) => void
  onAssetDoubleClick: (asset: Asset) => void
  onAssetDragStart: (asset: Asset, event: DragEvent<HTMLDivElement>) => void
  onDeleteSelected: () => void
  onOpenBatch: () => void
  onOcr: (asset: Asset) => void
  onRotate: (asset: Asset, quarterTurns: number) => void
  onRotateSelected: (quarterTurns: number) => void
  onShare: (asset: Asset) => void
  onShareSelected: () => void
  onOpenFolder: () => void
  onRefresh: () => void
  onRemoveAssetTag: (assetId: string, tag: string) => void
  onSetActiveTag: (tag: string) => void
  onSetAssetFavorite: (assetId: string, favorite: boolean) => void
  onSetFiltersOpen: (updater: (open: boolean) => boolean) => void
  onUpdateAssetNote: (assetId: string, note: string) => void
  onSetQuery: (query: string) => void
  onSetSortDir: (dir: SortDir) => void
  onSetSortField: (field: SortField) => void
  onSetSortOpen: (open: boolean | ((open: boolean) => boolean)) => void
  onSetThumbnailState: (state: ThumbnailState) => void
  onSetThumbSize: (size: number) => void
  onSetTypeFilter: (type: 'all' | AssetKind) => void
  onSetViewMode: (mode: AssetViewMode) => void
  onScrollPositionChange: (key: string, scrollTop: number) => void
  onViewportAssetIdsChange?: (assetIds: string[]) => void
}

export function LibraryView({
  activeTag,
  activeFilterCount,
  allTags,
  assetById,
  assetLayoutVersion,
  breadcrumb,
  filtersOpen,
  getAssetIndex,
  inspectorVisible,
  keyboardScrollTargetId,
  keyboardScrollVersion,
  scrollJump,
  scrollRestoreKey,
  scrollTop,
  primaryAsset,
  query,
  selectedIds,
  sortDir,
  sortField,
  sortOpen,
  statusMessage,
  thumbnailState,
  thumbSize,
  typeFilter,
  viewMode,
  visibleAssetIds,
  onAddAssetTag,
  onAssetClick,
  onAssetContextMenu,
  onAssetDoubleClick,
  onAssetDragStart,
  onDeleteSelected,
  onOpenBatch,
  onOcr,
  onRotate,
  onRotateSelected,
  onShare,
  onShareSelected,
  onOpenFolder,
  onRefresh,
  onRemoveAssetTag,
  onSetActiveTag,
  onSetAssetFavorite,
  onSetFiltersOpen,
  onUpdateAssetNote,
  onSetQuery,
  onSetSortDir,
  onSetSortField,
  onSetSortOpen,
  onSetThumbnailState,
  onSetThumbSize,
  onSetTypeFilter,
  onSetViewMode,
  onScrollPositionChange,
  onViewportAssetIdsChange,
}: LibraryViewProps) {
  const [inspectorWidth, setInspectorWidth] = useState(202)
  const [searchText, setSearchText] = useState(query)
  const [viewport, setViewport] = useState<ViewportState>({
    height: 620,
    scrollDirection: 'down',
    scrollSpeed: 0,
    scrollTop: 0,
    width: 960,
  })
  const scrollSampleRef = useRef({ scrollTop: 0, time: 0 })
  const scrollSettleTimerRef = useRef<number | undefined>(undefined)
  const scrollRestoreRef = useRef({ attempts: 0, done: false, key: '' })
  const lastNotifiedScrollRef = useRef({ key: '', top: -1 })
  const lastReportedViewportAssetIdsRef = useRef<string[]>([])
  const onViewportAssetIdsChangeRef = useRef(onViewportAssetIdsChange)
  const pendingViewportAssetIdsReportRef = useRef<string[] | null>(null)
  const virtualItemsRef = useRef<VirtualAssetItem[]>([])
  const viewportAssetIdsReportFrameRef = useRef<number | undefined>(undefined)
  const searchComposingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewportAssetIds, setViewportAssetIds] = useState<string[]>([])
  const libraryGridColumns = inspectorVisible ? `minmax(0, 1fr) 5px ${inspectorWidth}px` : 'minmax(0, 1fr)'
  const fixedThumbSize = `${thumbSize}px`
  const adaptiveMinSize = `${Math.max(178, thumbSize + 34)}px`
  const assetGridStyle: AssetGridStyle =
    viewMode === 'masonry'
      ? { '--asset-thumb-size': fixedThumbSize }
      : viewMode === 'adaptive'
        ? {
            '--asset-thumb-size': fixedThumbSize,
            gridTemplateColumns: `repeat(auto-fit, minmax(${adaptiveMinSize}, 1fr))`,
          }
        : { '--asset-thumb-size': fixedThumbSize }
  const adaptiveMetrics = useMemo(
    () => createAdaptiveMetrics(visibleAssetIds.length, viewport.width, thumbSize),
    [thumbSize, viewport.width, visibleAssetIds.length],
  )
  const masonryLayoutData = useMemo(
    () => {
      void assetLayoutVersion
      return viewMode === 'masonry'
        ? createMasonryLayoutData(visibleAssetIds, assetById, viewport.width, thumbSize)
        : undefined
    },
    [assetById, assetLayoutVersion, thumbSize, viewMode, viewport.width, visibleAssetIds],
  )
  const assetHandlersRef = useRef({
    onAssetClick,
    onAssetContextMenu,
    onAssetDoubleClick,
    onAssetDragStart,
  })
  useLayoutEffect(() => {
    assetHandlersRef.current = {
      onAssetClick,
      onAssetContextMenu,
      onAssetDoubleClick,
      onAssetDragStart,
    }
  }, [onAssetClick, onAssetContextMenu, onAssetDoubleClick, onAssetDragStart])
  useLayoutEffect(() => {
    onViewportAssetIdsChangeRef.current = onViewportAssetIdsChange
  }, [onViewportAssetIdsChange])
  const handleItemClick = useCallback((asset: Asset, event: MouseEvent<HTMLDivElement>) => {
    assetHandlersRef.current.onAssetClick(asset, event)
  }, [])
  const handleItemContextMenu = useCallback((asset: Asset, event: MouseEvent<HTMLDivElement>) => {
    assetHandlersRef.current.onAssetContextMenu(asset, event)
  }, [])
  const handleItemDoubleClick = useCallback((asset: Asset) => {
    assetHandlersRef.current.onAssetDoubleClick(asset)
  }, [])
  const handleItemDragStart = useCallback((asset: Asset, event: DragEvent<HTMLDivElement>) => {
    assetHandlersRef.current.onAssetDragStart(asset, event)
  }, [])
  const virtualLayout = useMemo(() => {
    if (viewMode === 'list') return createListLayout(visibleAssetIds, viewport)
    if (viewMode === 'masonry') {
      return masonryLayoutData
        ? createMasonryLayout(masonryLayoutData, viewport)
        : {
            items: [],
            totalHeight: 0,
          }
    }
    return createAdaptiveLayout(visibleAssetIds, viewport, adaptiveMetrics)
  }, [adaptiveMetrics, masonryLayoutData, viewMode, viewport, visibleAssetIds])
  const fallbackViewportAssetIds = useMemo(
    () => virtualAssetIdsInViewport(virtualLayout.items, viewport.scrollTop, viewport.height),
    [viewport.height, viewport.scrollTop, virtualLayout.items],
  )
  const effectiveViewportAssetIds = viewportAssetIds.length > 0 ? viewportAssetIds : fallbackViewportAssetIds
  const viewportAssetIdSet = useMemo(() => new Set(effectiveViewportAssetIds), [effectiveViewportAssetIds])
  const getVirtualPosition = useCallback(
    (assetId: string): VirtualPosition | undefined => {
      const index = getAssetIndex(assetId)
      if (index < 0) return undefined

      if (viewMode === 'list') return getListPosition(index)
      if (viewMode === 'masonry') return getMasonryPosition(masonryLayoutData, assetId)
      return getAdaptivePosition(index, adaptiveMetrics)
    },
    [adaptiveMetrics, getAssetIndex, masonryLayoutData, viewMode],
  )

  useEffect(() => {
    if (!searchComposingRef.current) setSearchText(query)
  }, [query])

  const commitViewportAssetIds = useCallback((nextScrollTop: number, nextViewportHeight: number) => {
    const nextIds = virtualAssetIdsInViewport(virtualItemsRef.current, nextScrollTop, nextViewportHeight)
    setViewportAssetIds((current) => (sameAssetIds(current, nextIds) ? current : nextIds))
  }, [])

  const syncViewportSize = useCallback(() => {
    const container = scrollRef.current
    if (!container) return

    const height = container.clientHeight
    const width = container.clientWidth
    setViewport((current) =>
      current.height === height && current.width === width ? current : { ...current, height, width },
    )
  }, [])

  useLayoutEffect(() => {
    syncViewportSize()
  }, [inspectorVisible, inspectorWidth, syncViewportSize])

  useLayoutEffect(() => {
    virtualItemsRef.current = virtualLayout.items
    const container = scrollRef.current
    if (!container) {
      setViewportAssetIds((current) => (current.length === 0 ? current : []))
      return
    }

    commitViewportAssetIds(container.scrollTop, container.clientHeight)
  }, [commitViewportAssetIds, virtualLayout.items])

  useEffect(() => {
    if (!onViewportAssetIdsChange) return
    if (sameAssetIds(lastReportedViewportAssetIdsRef.current, effectiveViewportAssetIds)) return

    pendingViewportAssetIdsReportRef.current = effectiveViewportAssetIds
    if (viewportAssetIdsReportFrameRef.current !== undefined) return

    viewportAssetIdsReportFrameRef.current = window.requestAnimationFrame(() => {
      viewportAssetIdsReportFrameRef.current = undefined
      const nextAssetIds = pendingViewportAssetIdsReportRef.current
      pendingViewportAssetIdsReportRef.current = null
      if (!nextAssetIds || sameAssetIds(lastReportedViewportAssetIdsRef.current, nextAssetIds)) return

      const handleViewportAssetIdsChange = onViewportAssetIdsChangeRef.current
      if (!handleViewportAssetIdsChange) return

      lastReportedViewportAssetIdsRef.current = nextAssetIds
      handleViewportAssetIdsChange(nextAssetIds)
    })
  }, [effectiveViewportAssetIds, onViewportAssetIdsChange])

  useEffect(() => {
    return () => {
      if (viewportAssetIdsReportFrameRef.current !== undefined) {
        window.cancelAnimationFrame(viewportAssetIdsReportFrameRef.current)
      }
    }
  }, [])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return

    let frameId = 0
    const measure = () => {
      frameId = 0
      const now = window.performance.now()
      const previousSample = scrollSampleRef.current
      const deltaY = container.scrollTop - previousSample.scrollTop
      const elapsed = Math.max(1, now - previousSample.time)
      const scrollDirection: ViewportState['scrollDirection'] = deltaY < 0 ? 'up' : 'down'
      const scrollSpeed = quantizeScrollSpeed(Math.abs(deltaY) / elapsed)
      const scrollTop = quantizeScrollTop(container.scrollTop, scrollDirection)
      commitViewportAssetIds(container.scrollTop, container.clientHeight)
      scrollSampleRef.current = {
        scrollTop: container.scrollTop,
        time: now,
      }
      const previousNotified = lastNotifiedScrollRef.current
      if (
        previousNotified.key !== scrollRestoreKey ||
        Math.abs(previousNotified.top - container.scrollTop) >= 8
      ) {
        previousNotified.key = scrollRestoreKey
        previousNotified.top = container.scrollTop
        onScrollPositionChange(scrollRestoreKey, container.scrollTop)
      }

      setViewport((current) => {
        const next = {
          height: container.clientHeight,
          scrollDirection,
          scrollSpeed,
          scrollTop,
          width: container.clientWidth,
        }

        return current.height === next.height &&
          current.scrollDirection === next.scrollDirection &&
          current.scrollSpeed === next.scrollSpeed &&
          current.scrollTop === next.scrollTop &&
          current.width === next.width
          ? current
          : next
      })
      if (scrollSettleTimerRef.current !== undefined) window.clearTimeout(scrollSettleTimerRef.current)
      if (scrollSpeed > 0) {
        scrollSettleTimerRef.current = window.setTimeout(() => {
          scrollSettleTimerRef.current = undefined
          setViewport((current) => (current.scrollSpeed === 0 ? current : { ...current, scrollSpeed: 0 }))
        }, SCROLL_SETTLE_MS)
      }
    }
    const scheduleMeasure = () => {
      if (frameId) return
      frameId = window.requestAnimationFrame(measure)
    }
    const resizeObserver = new ResizeObserver(() => {
      syncViewportSize()
      scheduleMeasure()
    })

    resizeObserver.observe(container)
    container.addEventListener('scroll', scheduleMeasure, { passive: true })
    measure()

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId)
      if (scrollSettleTimerRef.current !== undefined) window.clearTimeout(scrollSettleTimerRef.current)
      scrollSettleTimerRef.current = undefined
      resizeObserver.disconnect()
      container.removeEventListener('scroll', scheduleMeasure)
    }
  }, [commitViewportAssetIds, onScrollPositionChange, scrollRestoreKey, syncViewportSize])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) return

    if (scrollRestoreRef.current.key !== scrollRestoreKey) {
      scrollRestoreRef.current = { attempts: 0, done: false, key: scrollRestoreKey }
    }
    if (scrollRestoreRef.current.done) return

    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
    const targetTop = clamp(scrollTop, 0, maxScroll)
    if (Math.abs(container.scrollTop - targetTop) > 1) {
      container.scrollTo({ top: targetTop, behavior: 'auto' })
    }
    const restoredScrollTop = quantizeScrollTop(targetTop, targetTop < viewport.scrollTop ? 'up' : 'down')
    setViewport((current) => {
      const next = {
        height: container.clientHeight,
        scrollDirection: targetTop < current.scrollTop ? ('up' as const) : ('down' as const),
        scrollSpeed: 0,
        scrollTop: restoredScrollTop,
        width: container.clientWidth,
      }
      return current.height === next.height &&
        current.scrollDirection === next.scrollDirection &&
        current.scrollSpeed === next.scrollSpeed &&
        current.scrollTop === next.scrollTop &&
        current.width === next.width
        ? current
        : next
    })

    scrollRestoreRef.current.attempts += 1
    if (scrollTop <= 0 || maxScroll >= scrollTop || scrollRestoreRef.current.attempts > 24) {
      scrollRestoreRef.current.done = true
    }
  }, [scrollRestoreKey, scrollTop, viewport.scrollTop, virtualLayout.totalHeight])

  const scrollJumpEdge = scrollJump?.edge
  const scrollJumpId = scrollJump?.id

  useLayoutEffect(() => {
    if (!scrollJumpEdge || !scrollJumpId) return

    const container = scrollRef.current
    if (!container) return

    let secondFrameId = 0
    const scrollToEdge = () => {
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
      const targetTop = scrollJumpEdge === 'top' ? 0 : maxScroll

      if (Math.abs(container.scrollTop - targetTop) > 0.5) {
        container.scrollTo({ top: targetTop, behavior: 'auto' })
      }

      scrollSampleRef.current = {
        scrollTop: targetTop,
        time: window.performance.now(),
      }
      lastNotifiedScrollRef.current = {
        key: scrollRestoreKey,
        top: targetTop,
      }
      onScrollPositionChange(scrollRestoreKey, targetTop)
    }

    const frameId = window.requestAnimationFrame(() => {
      scrollToEdge()
      secondFrameId = window.requestAnimationFrame(scrollToEdge)
    })

    return () => {
      window.cancelAnimationFrame(frameId)
      window.cancelAnimationFrame(secondFrameId)
    }
  }, [onScrollPositionChange, scrollJumpEdge, scrollJumpId, scrollRestoreKey])

  useLayoutEffect(() => {
    if (!keyboardScrollTargetId) return

    const container = scrollRef.current
    if (!container) return

    const scrollKeyboardTargetIntoView = () => {
      const selected = container.querySelector<HTMLElement>(
        `.asset-item[data-asset-id="${cssAttributeString(keyboardScrollTargetId)}"]`,
      )
      if (!selected) {
        const virtualPosition = getVirtualPosition(keyboardScrollTargetId)
        if (!virtualPosition) return

        const edgePadding = Math.min(56, Math.max(24, container.clientHeight * 0.1))
        const maxScroll = container.scrollHeight - container.clientHeight
        const targetScrollTop = clamp(virtualPosition.top - edgePadding, 0, maxScroll)

        if (Math.abs(targetScrollTop - container.scrollTop) > 0.5) {
          container.scrollTo({ top: targetScrollTop, behavior: 'auto' })
        }
        return
      }

      const containerBox = container.getBoundingClientRect()
      const selectedBox = selected.getBoundingClientRect()
      const edgePadding = Math.min(56, Math.max(24, containerBox.height * 0.1))
      const topLimit = containerBox.top + edgePadding
      const bottomLimit = containerBox.bottom - edgePadding
      const maxScroll = container.scrollHeight - container.clientHeight
      let nextScrollTop = container.scrollTop

      if (selectedBox.top < topLimit) {
        nextScrollTop += selectedBox.top - topLimit
      } else if (selectedBox.bottom > bottomLimit) {
        nextScrollTop += selectedBox.bottom - bottomLimit
      }

      const clampedScrollTop = clamp(nextScrollTop, 0, maxScroll)
      if (Math.abs(clampedScrollTop - container.scrollTop) > 0.5) {
        container.scrollTo({
          top: clampedScrollTop,
          behavior: 'auto',
        })
      }
    }

    let secondFrameId = 0
    const frameId = window.requestAnimationFrame(() => {
      scrollKeyboardTargetIntoView()
      secondFrameId = window.requestAnimationFrame(scrollKeyboardTargetIntoView)
    })

    return () => {
      window.cancelAnimationFrame(frameId)
      window.cancelAnimationFrame(secondFrameId)
    }
  }, [getVirtualPosition, keyboardScrollTargetId, keyboardScrollVersion, viewMode])

  function startInspectorResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()

    const startX = event.clientX
    const startWidth = inspectorWidth
    const inspectorWidthCommitter = createRafNumberCommitter(setInspectorWidth, startWidth)

    document.body.classList.add('is-resizing-col')

    const updateWidthFromPointer = (clientX: number) => {
      inspectorWidthCommitter.update(clamp(startWidth - (clientX - startX), INSPECTOR_MIN, INSPECTOR_MAX))
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateWidthFromPointer(moveEvent.clientX)
    }

    const stopResize = (pointerEvent: PointerEvent) => {
      updateWidthFromPointer(pointerEvent.clientX)
      inspectorWidthCommitter.flush()
      document.body.classList.remove('is-resizing-col')
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize, { once: true })
    window.addEventListener('pointercancel', stopResize, { once: true })
  }

  function adjustThumbSize(delta: number) {
    onSetThumbSize(clamp(thumbSize + delta, 90, 240))
  }

  function updateSearchText(value: string) {
    setSearchText(value)
    if (!searchComposingRef.current) onSetQuery(value)
  }

  function finishSearchComposition(value: string) {
    searchComposingRef.current = false
    setSearchText(value)
    onSetQuery(value)
  }

  return (
    <div
      className={`library-layout ${inspectorVisible ? '' : 'inspector-hidden'}`}
      style={{ gridTemplateColumns: libraryGridColumns }}
    >
      <section className="assets-pane">
        <div className="view-toolbar">
          <div className="view-path">
            <span className="view-path-name">{breadcrumb}</span>
          </div>

          <div className="view-search">
            <Search size={14} />
            <input
              value={searchText}
              onChange={(event) => updateSearchText(event.target.value)}
              onCompositionStart={() => {
                searchComposingRef.current = true
              }}
              onCompositionEnd={(event) => finishSearchComposition(event.currentTarget.value)}
              placeholder="搜索素材"
            />
          </div>

          <div className="thumb-slider-wrap">
            <button className="thumb-step-btn" title="缩小缩略图" onClick={() => adjustThumbSize(-10)}>
              <ZoomOut size={13} />
            </button>
            <input
              className="thumb-slider"
              max={240}
              min={90}
              onChange={(event) => onSetThumbSize(Number(event.target.value))}
              step={10}
              type="range"
              value={thumbSize}
            />
            <button className="thumb-step-btn" title="放大缩略图" onClick={() => adjustThumbSize(10)}>
              <ZoomIn size={13} />
            </button>
          </div>

          <div className="view-actions" aria-label="素材视图操作">
            <div className="view-action-group" aria-label="排序和筛选">
              <div className="sort-btn-wrap">
                <button
                  className={`view-icon-btn ${sortOpen ? 'active' : ''}`}
                  title={`排序：${SORT_LABELS[sortField]} ${sortDir === 'asc' ? '升序' : '降序'}`}
                  onClick={() => onSetSortOpen((open) => !open)}
                >
                  <ArrowDownUp size={14} />
                </button>
                {sortOpen && (
                  <SortDropdown
                    sortDir={sortDir}
                    sortField={sortField}
                    onDir={onSetSortDir}
                    onField={(field) => {
                      onSetSortField(field)
                      onSetSortOpen(false)
                    }}
                  />
                )}
              </div>
              <button
                className={`view-icon-btn ${filtersOpen ? 'active' : ''}`}
                title="筛选"
                onClick={() => onSetFiltersOpen((open) => !open)}
              >
                <SlidersHorizontal size={14} />
                {activeFilterCount > 0 && <span className="gbar-badge" />}
              </button>
              <button className="view-icon-btn" title="刷新资源库" onClick={onRefresh}>
                <RefreshCw size={14} />
              </button>
            </div>
            <span className="view-action-separator" aria-hidden="true" />
            <div className="view-action-group" aria-label="视图模式">
              <button
                aria-pressed={viewMode === 'adaptive'}
                className={`view-icon-btn ${viewMode === 'adaptive' ? 'active' : ''}`}
                title="自适应视图"
                onClick={() => onSetViewMode('adaptive')}
              >
                <LayoutGrid size={14} />
              </button>
              <button
                aria-pressed={viewMode === 'masonry'}
                className={`view-icon-btn ${viewMode === 'masonry' ? 'active' : ''}`}
                title="瀑布流视图"
                onClick={() => onSetViewMode('masonry')}
              >
                <Columns3 size={14} />
              </button>
              <button
                aria-pressed={viewMode === 'list'}
                className={`view-icon-btn ${viewMode === 'list' ? 'active' : ''}`}
                title="列表视图"
                onClick={() => onSetViewMode('list')}
              >
                <Rows3 size={14} />
              </button>
            </div>
          </div>
        </div>

        <div className="tag-bar">
          <button className={`tag-bar-btn ${activeTag === 'all' ? 'active' : ''}`} onClick={() => onSetActiveTag('all')}>
            全部
          </button>
          {allTags.slice(0, 10).map((tag) => (
            <button
              key={tag}
              className={`tag-bar-btn ${activeTag === tag ? 'active' : ''}`}
              onClick={() => onSetActiveTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>

        {filtersOpen && (
          <FilterPopover
            thumbnailState={thumbnailState}
            typeFilter={typeFilter}
            onClose={() => onSetFiltersOpen(() => false)}
            onSetThumbnailState={onSetThumbnailState}
            onSetTypeFilter={onSetTypeFilter}
          />
        )}

        {selectedIds.size > 1 && (
          <div className="multiselect-bar">
            <div className="multiselect-copy">
              <span>已选择 {selectedIds.size} 个素材</span>
              <span className="multiselect-hint">Shift+点击连续选择 · ⌘/Ctrl+点击切换选择</span>
            </div>
            <div className="multiselect-actions" aria-label="批量操作">
              <button className="multiselect-action" title="向左批量旋转 90°" onClick={() => onRotateSelected(3)}>
                <RotateCcw size={13} /> 左转
              </button>
              <button className="multiselect-action" title="向右批量旋转 90°" onClick={() => onRotateSelected(1)}>
                <RotateCw size={13} /> 右转
              </button>
              <button className="multiselect-action" title={`批量调整与压缩（${selectedIds.size}）`} onClick={onOpenBatch}>
                <Wand2 size={13} /> 调整/压缩
              </button>
              <button className="multiselect-action" title={`分享所选（${selectedIds.size}）`} onClick={onShareSelected}>
                <Share2 size={13} /> 分享
              </button>
              <button className="multiselect-action danger" title={`删除所选到回收站（${selectedIds.size}）`} onClick={onDeleteSelected}>
                <Trash2 size={13} /> 删除
              </button>
            </div>
          </div>
        )}

        {visibleAssetIds.length === 0 ? (
          <div className="empty-state">
            <FolderOpen size={44} color="var(--muted)" />
            <h2>这里还没有素材</h2>
            <p>打开包含 PNG、JPG、WEBP、SVG、GIF 或 AVIF 的文件夹。</p>
            <button className="empty-btn" onClick={onOpenFolder}>
              <FolderOpen size={14} /> 打开图片文件夹
            </button>
          </div>
        ) : (
          <div ref={scrollRef} className="assets-scroll">
            <div
              className={`asset-grid asset-grid--${viewMode} asset-grid--virtual`}
              style={{ ...assetGridStyle, height: virtualLayout.totalHeight }}
            >
              {virtualLayout.items.map((item) => {
                const { assetId } = item
                const asset = assetById.get(assetId)
                if (!asset) return null

                return (
                  <AssetItem
                    key={asset.id}
                    asset={asset}
                    layout={item}
                    primary={primaryAsset?.id === asset.id}
                    selected={selectedIds.has(asset.id)}
                    thumbnailPriority={viewportAssetIdSet.has(asset.id) ? 'high' : 'low'}
                    viewMode={viewMode}
                    onClick={handleItemClick}
                    onContextMenu={handleItemContextMenu}
                    onDoubleClick={handleItemDoubleClick}
                    onDragStart={handleItemDragStart}
                  />
                )
              })}
            </div>
          </div>
        )}

        <div className="assets-statusbar">
          <span>
            {visibleAssetIds.length} 个素材{selectedIds.size > 0 ? ` · 已选择 ${selectedIds.size} 个` : ''}
          </span>
          <span>
            {VIEW_MODE_LABELS[viewMode]} · {statusMessage}
          </span>
        </div>
      </section>

      {inspectorVisible && (
        <>
          <div
            aria-label="调整右侧信息栏宽度"
            aria-orientation="vertical"
            className="inspector-col-resizer"
            role="separator"
            onPointerDown={startInspectorResize}
          />

          <aside className="inspector">
            {selectedIds.size > 1 ? (
              <MultiSelectInspector count={selectedIds.size} onShare={onShareSelected} />
            ) : primaryAsset ? (
              <Inspector
                key={primaryAsset.id}
                activeTag={activeTag}
                allTags={allTags}
                asset={primaryAsset}
                onAddTag={onAddAssetTag}
                onOcr={onOcr}
                onRotate={onRotate}
                onShare={onShare}
                onRemoveTag={onRemoveAssetTag}
                onSetFavorite={onSetAssetFavorite}
                onSelectTag={onSetActiveTag}
                onUpdateNote={onUpdateAssetNote}
              />
            ) : (
              <EmptyInspector />
            )}
          </aside>
        </>
      )}
    </div>
  )
}
