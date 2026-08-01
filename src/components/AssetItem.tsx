import { FileImage, Heart, Maximize2 } from 'lucide-react'
import { memo, useState } from 'react'
import type { CSSProperties, DragEvent, KeyboardEvent, MouseEvent } from 'react'
import { formatMb } from '../lib/format'
import type { Asset, AssetViewMode } from '../types/library'

export type AssetItemLayout = {
  aspectRatio?: string
  height: number
  left: number
  right?: number
  top: number
  width?: number
}

type AssetItemStyle = CSSProperties & {
  '--asset-aspect-ratio'?: string
}

type AssetItemProps = {
  asset: Asset
  layout: AssetItemLayout
  primary: boolean
  selected: boolean
  thumbnailPriority: 'high' | 'low'
  viewMode: AssetViewMode
  onClick: (asset: Asset, event: MouseEvent<HTMLDivElement>) => void
  onContextMenu: (asset: Asset, event: MouseEvent<HTMLDivElement>) => void
  onDoubleClick: (asset: Asset) => void
  onDragStart: (asset: Asset, event: DragEvent<HTMLDivElement>) => void
}

function assetItemLayoutStyle(layout: AssetItemLayout): AssetItemStyle {
  const style: AssetItemStyle = {
    height: layout.height,
    left: 0,
    position: 'absolute',
    top: 0,
    transform: `translate(${layout.left}px, ${layout.top}px)`,
  }

  if (layout.width !== undefined) style.width = layout.width
  if (layout.right !== undefined) style.right = layout.right
  if (layout.aspectRatio !== undefined) style['--asset-aspect-ratio'] = layout.aspectRatio

  return style
}

function areAssetItemLayoutsEqual(a: AssetItemLayout, b: AssetItemLayout) {
  if (a === b) return true

  return (
    a.aspectRatio === b.aspectRatio &&
    a.height === b.height &&
    a.left === b.left &&
    a.right === b.right &&
    a.top === b.top &&
    a.width === b.width
  )
}

function areAssetItemPropsEqual(previous: AssetItemProps, next: AssetItemProps) {
  return (
    previous.asset === next.asset &&
    areAssetItemLayoutsEqual(previous.layout, next.layout) &&
    previous.primary === next.primary &&
    previous.selected === next.selected &&
    previous.thumbnailPriority === next.thumbnailPriority &&
    previous.viewMode === next.viewMode &&
    previous.onClick === next.onClick &&
    previous.onContextMenu === next.onContextMenu &&
    previous.onDoubleClick === next.onDoubleClick &&
    previous.onDragStart === next.onDragStart
  )
}

function AssetItemBase({
  asset,
  layout,
  primary,
  selected,
  thumbnailPriority,
  viewMode,
  onClick,
  onContextMenu,
  onDoubleClick,
  onDragStart,
}: AssetItemProps) {
  const isList = viewMode === 'list'
  const [failedThumbnailKey, setFailedThumbnailKey] = useState<string | null>(null)
  const thumbnailKey = `${asset.thumbnailUrl ?? ''}:${asset.thumbnailQuality ?? 'none'}:${asset.thumbnailReady}`
  const showThumbnail = asset.thumbnailReady && asset.thumbnailUrl && failedThumbnailKey !== thumbnailKey
  const placeholderLabel =
    asset.thumbnailReady || asset.thumbnailError
      ? '加载失败'
      : '待生成'

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.currentTarget.click()
    }
  }

  return (
    <div
      className={`asset-item asset-item--${viewMode} ${selected ? 'selected' : ''} ${
        primary && selected ? 'primary' : ''
      }`}
      data-asset-id={asset.id}
      draggable
      role="button"
      style={assetItemLayoutStyle(layout)}
      tabIndex={0}
      onClick={(event) => onClick(asset, event)}
      onContextMenu={(event) => onContextMenu(asset, event)}
      onDoubleClick={() => onDoubleClick(asset)}
      onDragStart={(event) => onDragStart(asset, event)}
      onKeyDown={handleKeyDown}
    >
      <div className="asset-thumb-wrap">
        {showThumbnail ? (
          <img
            alt=""
            decoding="async"
            draggable={false}
            fetchPriority={thumbnailPriority}
            loading={thumbnailPriority === 'high' ? 'eager' : 'lazy'}
            src={asset.thumbnailUrl}
            onError={() => setFailedThumbnailKey(thumbnailKey)}
          />
        ) : (
          <div className={`asset-thumb-swatch thumbnail-placeholder ${asset.swatch}`}>
            <FileImage size={28} />
            <span>{placeholderLabel}</span>
          </div>
        )}
        <span className="type-badge">{asset.kind.toUpperCase()}</span>
        {asset.favorite && (
          <span className="fav-mark">
            <Heart size={11} fill="currentColor" />
          </span>
        )}
        <div className="thumb-hover-overlay">
          <Maximize2 size={14} />
        </div>
      </div>
      <div className="asset-text">
        <span className="asset-label">{asset.name}</span>
        <span className="asset-dimensions">{asset.dimensions.replace(/\s*[x×]\s*/i, '*')}</span>
        {isList && (
          <span className="asset-list-path" title={asset.relativePath}>
            {asset.relativePath}
          </span>
        )}
      </div>
      {isList && (
        <div className="asset-list-meta" aria-hidden="true">
          <span>{asset.kind.toUpperCase()}</span>
          <span>{formatMb(asset.sizeKb)}</span>
          <span>{asset.modifiedAt}</span>
        </div>
      )}
    </div>
  )
}

export const AssetItem = memo(AssetItemBase, areAssetItemPropsEqual)
