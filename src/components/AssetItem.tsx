import { FileImage, Heart, Maximize2 } from 'lucide-react'
import { useState } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react'
import { formatMb } from '../lib/format'
import type { Asset, AssetViewMode } from '../types/library'

type AssetItemProps = {
  asset: Asset
  primary: boolean
  selected: boolean
  style?: CSSProperties
  viewMode: AssetViewMode
  onClick: (event: MouseEvent<HTMLDivElement>) => void
  onDoubleClick: () => void
}

function getAssetRatio(asset: Asset) {
  if (asset.width && asset.height) return `${asset.width} / ${asset.height}`

  const match = asset.dimensions.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i)
  if (!match) return '16 / 10'

  const width = Number(match[1])
  const height = Number(match[2])

  if (!width || !height) return '16 / 10'
  return `${width} / ${height}`
}

export function AssetItem({ asset, primary, selected, style, viewMode, onClick, onDoubleClick }: AssetItemProps) {
  const isList = viewMode === 'list'
  const [failedThumbnailKey, setFailedThumbnailKey] = useState<string | null>(null)
  const thumbnailKey = `${asset.thumbnailUrl ?? ''}:${asset.thumbnailQuality ?? 'none'}:${asset.thumbnailReady}`
  const showThumbnail = asset.thumbnailReady && asset.thumbnailUrl && failedThumbnailKey !== thumbnailKey

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
      role="button"
      style={style}
      tabIndex={0}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={handleKeyDown}
    >
      <div
        className="asset-thumb-wrap"
        style={viewMode === 'masonry' ? { aspectRatio: getAssetRatio(asset) } : undefined}
      >
        {showThumbnail ? (
          <img src={asset.thumbnailUrl} alt="" onError={() => setFailedThumbnailKey(thumbnailKey)} />
        ) : (
          <div className={`asset-thumb-swatch thumbnail-placeholder ${asset.swatch}`}>
            <FileImage size={28} />
            <span>{asset.thumbnailReady || asset.thumbnailError ? '加载失败' : '待生成'}</span>
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
