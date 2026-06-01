import {
  ArrowDownUp,
  Columns3,
  FolderOpen,
  LayoutGrid,
  RefreshCw,
  Rows3,
  Search,
  SlidersHorizontal,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { SORT_LABELS } from '../lib/sort'
import type { Asset, AssetKind, AssetViewMode, SortDir, SortField, ThumbnailState } from '../types/library'
import { AssetItem } from './AssetItem'
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
const FAST_SCROLL_SETTLE_MS = 120
const FAST_SCROLL_VELOCITY_PX_PER_MS = 1.2
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

type VirtualAssetItem = {
  assetId: string
  style: CSSProperties
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

type MasonryVirtualItem = VirtualAssetItem & {
  height: number
  top: number
}

type MasonryLayoutData = {
  items: MasonryVirtualItem[]
  maxItemHeight: number
  positionById: Map<string, VirtualPosition>
  totalHeight: number
  visualIds: string[]
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function virtualItemStyle(left: number, top: number, style: CSSProperties): CSSProperties {
  return {
    ...style,
    left: 0,
    position: 'absolute',
    top: 0,
    transform: `translate3d(${left}px, ${top}px, 0)`,
  }
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
  const items: VirtualAssetItem[] = []

  for (let index = startIndex; index < endIndex; index += 1) {
    const assetId = assetIds[index]
    const row = Math.floor(index / metrics.columns)
    const column = index % metrics.columns
    items.push({
      assetId,
      style: virtualItemStyle(ADAPTIVE_PADDING_X + column * (metrics.itemWidth + ADAPTIVE_GAP_X), ADAPTIVE_PADDING_TOP + row * metrics.rowPitch, {
        height: metrics.itemHeight,
        width: metrics.itemWidth,
      }),
    })
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
  const items: VirtualAssetItem[] = []

  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const assetId = assetIds[index]
    items.push({
      assetId,
      style: virtualItemStyle(0, LIST_PADDING_TOP + index * LIST_ROW_HEIGHT, {
        height: LIST_ROW_HEIGHT,
        right: 0,
      }),
    })
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
  const items: MasonryVirtualItem[] = []
  const positionById = new Map<string, VirtualPosition>()
  let maxItemHeight = 0

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

    items.push({
      assetId,
      height: itemHeight,
      style: virtualItemStyle(left, top, {
        width: columnWidth,
      }),
      top,
    })
    positionById.set(assetId, { height: itemHeight, top })
    maxItemHeight = Math.max(maxItemHeight, itemHeight)
    columnHeights[column] += itemHeight + MASONRY_GAP_Y
  }

  const sortedItems = [...items].sort((a, b) => {
    const aLeft = Number(a.style.left ?? 0)
    const bLeft = Number(b.style.left ?? 0)
    return a.top - b.top || aLeft - bLeft
  })
  const totalHeight = Math.max(
    MASONRY_PADDING_TOP + MASONRY_PADDING_BOTTOM,
    Math.max(...columnHeights) - MASONRY_GAP_Y + MASONRY_PADDING_BOTTOM,
  )
  const visualIds = sortedItems.map((item) => item.assetId)

  return {
    items: sortedItems,
    maxItemHeight,
    positionById,
    totalHeight,
    visualIds,
  }
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

function createMasonryLayout(layoutData: MasonryLayoutData, viewport: ViewportState): VirtualLayout {
  const viewportHeight = Math.max(1, viewport.height || 620)
  const overscan = getOverscanWindow(viewport)
  const minTop = viewport.scrollTop - overscan.before
  const maxTop = viewport.scrollTop + viewportHeight + overscan.after
  const startIndex = lowerBoundMasonryItems(layoutData.items, minTop - layoutData.maxItemHeight)
  const items: VirtualAssetItem[] = []

  for (let index = startIndex; index < layoutData.items.length; index += 1) {
    const item = layoutData.items[index]
    if (item.top > maxTop) break
    if (item.top + item.height >= minTop) items.push({ assetId: item.assetId, style: item.style })
  }

  return {
    items,
    totalHeight: layoutData.totalHeight,
  }
}

type LibraryViewProps = {
  activeTag: string
  activeFilterCount: number
  allTags: string[]
  assetById: ReadonlyMap<string, Asset>
  assetIndexById: ReadonlyMap<string, number>
  breadcrumb: string
  filtersOpen: boolean
  inspectorVisible: boolean
  keyboardScrollTargetId: string | null
  keyboardScrollVersion: number
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
  onAssetDoubleClick: (asset: Asset) => void
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
  onVisualOrderChange: (ids: string[]) => void
}

export function LibraryView({
  activeTag,
  activeFilterCount,
  allTags,
  assetById,
  assetIndexById,
  breadcrumb,
  filtersOpen,
  inspectorVisible,
  keyboardScrollTargetId,
  keyboardScrollVersion,
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
  onAssetDoubleClick,
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
  onVisualOrderChange,
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
  const [isFastScrolling, setIsFastScrolling] = useState(false)
  const fastScrollTimeoutRef = useRef<number | null>(null)
  const fastScrollingRef = useRef(false)
  const scrollSampleRef = useRef({ scrollTop: 0, time: 0 })
  const searchComposingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const libraryGridColumns = inspectorVisible ? `minmax(0, 1fr) 5px ${inspectorWidth}px` : 'minmax(0, 1fr)'
  const fixedThumbSize = `${thumbSize}px`
  const adaptiveMinSize = `${Math.max(178, thumbSize + 34)}px`
  const assetGridStyle: AssetGridStyle =
    viewMode === 'masonry'
      ? { '--asset-thumb-size': fixedThumbSize, columnGap: 18, columnWidth: Math.max(124, thumbSize) }
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
    () =>
      viewMode === 'masonry'
        ? createMasonryLayoutData(visibleAssetIds, assetById, viewport.width, thumbSize)
        : undefined,
    [assetById, thumbSize, viewMode, viewport.width, visibleAssetIds],
  )
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
  const visualAssetIds = useMemo(() => {
    if (viewMode === 'masonry') return masonryLayoutData?.visualIds ?? []
    return visibleAssetIds
  }, [masonryLayoutData, viewMode, visibleAssetIds])
  const getVirtualPosition = useCallback(
    (assetId: string): VirtualPosition | undefined => {
      const index = assetIndexById.get(assetId)
      if (index === undefined) return undefined

      if (viewMode === 'list') return getListPosition(index)
      if (viewMode === 'masonry') return masonryLayoutData?.positionById.get(assetId)
      return getAdaptivePosition(index, adaptiveMetrics)
    },
    [adaptiveMetrics, assetIndexById, masonryLayoutData, viewMode],
  )

  useEffect(() => {
    if (!searchComposingRef.current) setSearchText(query)
  }, [query])

  useEffect(() => {
    onVisualOrderChange(visualAssetIds)
  }, [onVisualOrderChange, visualAssetIds])

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
      const scrollSpeed = Math.abs(deltaY) / elapsed
      const scrollDirection: ViewportState['scrollDirection'] = deltaY < 0 ? 'up' : 'down'
      scrollSampleRef.current = {
        scrollTop: container.scrollTop,
        time: now,
      }

      if (Math.abs(deltaY) > 4 && scrollSpeed >= FAST_SCROLL_VELOCITY_PX_PER_MS) {
        if (!fastScrollingRef.current) {
          fastScrollingRef.current = true
          setIsFastScrolling(true)
        }
        if (fastScrollTimeoutRef.current) window.clearTimeout(fastScrollTimeoutRef.current)
        fastScrollTimeoutRef.current = window.setTimeout(() => {
          fastScrollingRef.current = false
          fastScrollTimeoutRef.current = null
          setIsFastScrolling(false)
        }, FAST_SCROLL_SETTLE_MS)
      }

      setViewport((current) => {
        const next = {
          height: container.clientHeight,
          scrollDirection,
          scrollSpeed,
          scrollTop: container.scrollTop,
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
    }
    const scheduleMeasure = () => {
      if (frameId) return
      frameId = window.requestAnimationFrame(measure)
    }
    const resizeObserver = new ResizeObserver(scheduleMeasure)

    resizeObserver.observe(container)
    container.addEventListener('scroll', scheduleMeasure, { passive: true })
    measure()

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId)
      if (fastScrollTimeoutRef.current) window.clearTimeout(fastScrollTimeoutRef.current)
      resizeObserver.disconnect()
      container.removeEventListener('scroll', scheduleMeasure)
    }
  }, [])

  useLayoutEffect(() => {
    if (!keyboardScrollTargetId) return

    const container = scrollRef.current
    if (!container) return

    const scrollKeyboardTargetIntoView = () => {
      const selected = Array.from(container.querySelectorAll<HTMLElement>('.asset-item')).find(
        (item) => item.dataset.assetId === keyboardScrollTargetId,
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

    document.body.classList.add('is-resizing-col')

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setInspectorWidth(clamp(startWidth - (moveEvent.clientX - startX), INSPECTOR_MIN, INSPECTOR_MAX))
    }

    const stopResize = () => {
      document.body.classList.remove('is-resizing-col')
      window.removeEventListener('pointermove', handlePointerMove)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize, { once: true })
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

          <div className="view-actions">
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
            <button className="view-icon-btn" title="Refresh" onClick={onRefresh}>
              <RefreshCw size={14} />
            </button>
            <button
              className={`view-icon-btn ${filtersOpen ? 'active' : ''}`}
              title="Filters"
              onClick={() => onSetFiltersOpen((open) => !open)}
            >
              <SlidersHorizontal size={14} />
              {activeFilterCount > 0 && <span className="gbar-badge" />}
            </button>
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
            <span>已选择 {selectedIds.size} 个素材</span>
            <span className="multiselect-hint">Shift+点击连续选择 · ⌘/Ctrl+点击切换选择</span>
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
          <div ref={scrollRef} className={`assets-scroll ${isFastScrolling ? 'is-fast-scrolling' : ''}`}>
            <div
              className={`asset-grid asset-grid--${viewMode} asset-grid--virtual`}
              style={{ ...assetGridStyle, height: virtualLayout.totalHeight }}
            >
              {virtualLayout.items.map(({ assetId, style }) => {
                const asset = assetById.get(assetId)
                if (!asset) return null

                return (
                  <AssetItem
                    key={asset.id}
                    asset={asset}
	                    primary={primaryAsset?.id === asset.id}
	                    selected={selectedIds.has(asset.id)}
	                    style={style}
	                    viewMode={viewMode}
	                    deferThumbnailLoad={isFastScrolling}
	                    onClick={(event) => onAssetClick(asset, event)}
	                    onDoubleClick={() => onAssetDoubleClick(asset)}
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
              <MultiSelectInspector count={selectedIds.size} />
            ) : primaryAsset ? (
              <Inspector
                key={primaryAsset.id}
                activeTag={activeTag}
                allTags={allTags}
                asset={primaryAsset}
                onAddTag={onAddAssetTag}
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
