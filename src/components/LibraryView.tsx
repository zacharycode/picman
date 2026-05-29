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
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { SORT_LABELS } from '../lib/sort'
import type { Asset, AssetKind, AssetViewMode, SortDir, SortField, ThumbnailState } from '../types/library'
import { AssetItem } from './AssetItem'
import { FilterPopover } from './FilterPopover'
import { EmptyInspector, Inspector, MultiSelectInspector } from './Inspector'
import { SortDropdown } from './SortDropdown'

const INSPECTOR_MIN = 176
const INSPECTOR_MAX = 340
const VIEW_MODE_LABELS: Record<AssetViewMode, string> = {
  adaptive: '自适应',
  masonry: '瀑布流',
  list: '列表',
}

type AssetGridStyle = CSSProperties & {
  '--asset-thumb-size'?: string
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

type LibraryViewProps = {
  activeTag: string
  activeFilterCount: number
  allTags: string[]
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
  visibleAssets: Asset[]
  onAddAssetTag: (assetId: string, tag: string) => void
  onAssetClick: (asset: Asset, event: MouseEvent<HTMLDivElement>) => void
  onAssetDoubleClick: (asset: Asset) => void
  onOpenFolder: () => void
  onRefresh: () => void
  onRemoveAssetTag: (assetId: string, tag: string) => void
  onSetActiveTag: (tag: string) => void
  onSetFiltersOpen: (updater: (open: boolean) => boolean) => void
  onSetQuery: (query: string) => void
  onSetSortDir: (dir: SortDir) => void
  onSetSortField: (field: SortField) => void
  onSetSortOpen: (open: boolean | ((open: boolean) => boolean)) => void
  onSetThumbnailState: (state: ThumbnailState) => void
  onSetThumbSize: (size: number) => void
  onSetTypeFilter: (type: 'all' | AssetKind) => void
  onSetViewMode: (mode: AssetViewMode) => void
}

export function LibraryView({
  activeTag,
  activeFilterCount,
  allTags,
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
  visibleAssets,
  onAddAssetTag,
  onAssetClick,
  onAssetDoubleClick,
  onOpenFolder,
  onRefresh,
  onRemoveAssetTag,
  onSetActiveTag,
  onSetFiltersOpen,
  onSetQuery,
  onSetSortDir,
  onSetSortField,
  onSetSortOpen,
  onSetThumbnailState,
  onSetThumbSize,
  onSetTypeFilter,
  onSetViewMode,
}: LibraryViewProps) {
  const [inspectorWidth, setInspectorWidth] = useState(202)
  const [searchText, setSearchText] = useState(query)
  const searchComposingRef = useRef(false)
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

  useEffect(() => {
    if (!searchComposingRef.current) setSearchText(query)
  }, [query])

  useLayoutEffect(() => {
    if (!keyboardScrollTargetId) return

    const container = document.querySelector<HTMLElement>('.assets-scroll')
    if (!container) return

    const scrollKeyboardTargetIntoView = () => {
      const selected = Array.from(container.querySelectorAll<HTMLElement>('.asset-item')).find(
        (item) => item.dataset.assetId === keyboardScrollTargetId,
      )
      if (!selected) return

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
  }, [keyboardScrollTargetId, keyboardScrollVersion, viewMode])

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

        {visibleAssets.length === 0 ? (
          <div className="empty-state">
            <FolderOpen size={44} color="var(--muted)" />
            <h2>这里还没有素材</h2>
            <p>打开包含 PNG、JPG、WEBP、SVG、GIF 或 AVIF 的文件夹。</p>
            <button className="empty-btn" onClick={onOpenFolder}>
              <FolderOpen size={14} /> 打开图片文件夹
            </button>
          </div>
        ) : (
          <div className="assets-scroll">
            <div className={`asset-grid asset-grid--${viewMode}`} style={assetGridStyle}>
              {visibleAssets.map((asset) => (
                <AssetItem
                  key={asset.id}
                  asset={asset}
                  primary={primaryAsset?.id === asset.id}
                  selected={selectedIds.has(asset.id)}
                  viewMode={viewMode}
                  onClick={(event) => onAssetClick(asset, event)}
                  onDoubleClick={() => onAssetDoubleClick(asset)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="assets-statusbar">
          <span>
            {visibleAssets.length} 个素材{selectedIds.size > 0 ? ` · 已选择 ${selectedIds.size} 个` : ''}
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
                onSelectTag={onSetActiveTag}
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
