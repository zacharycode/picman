import { X } from 'lucide-react'
import type { AssetKind, ThumbnailState } from '../types/library'

type FilterPopoverProps = {
  thumbnailState: ThumbnailState
  typeFilter: 'all' | AssetKind
  onClose: () => void
  onSetThumbnailState: (state: ThumbnailState) => void
  onSetTypeFilter: (type: 'all' | AssetKind) => void
}

export function FilterPopover({
  thumbnailState,
  typeFilter,
  onClose,
  onSetThumbnailState,
  onSetTypeFilter,
}: FilterPopoverProps) {
  return (
    <div className="filter-popover">
      <div className="filter-popover-heading">
        <strong>筛选</strong>
        <button className="fp-close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <label>
        文件类型
        <select value={typeFilter} onChange={(event) => onSetTypeFilter(event.target.value as 'all' | AssetKind)}>
          <option value="all">全部类型</option>
          <option value="png">PNG</option>
          <option value="jpg">JPG</option>
          <option value="webp">WEBP</option>
          <option value="gif">GIF</option>
          <option value="avif">AVIF</option>
          <option value="svg">SVG</option>
          <option value="pdf">PDF</option>
        </select>
      </label>
      <label>
        缩略图
        <select value={thumbnailState} onChange={(event) => onSetThumbnailState(event.target.value as ThumbnailState)}>
          <option value="all">全部</option>
          <option value="generated">已生成</option>
          <option value="pending">待生成</option>
        </select>
      </label>
    </div>
  )
}
