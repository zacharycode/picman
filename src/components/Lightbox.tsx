import { ChevronLeft, ChevronRight, FileImage, Share2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import { formatMb } from '../lib/format'
import type { Asset } from '../types/library'

type LightboxProps = {
  asset: Asset
  hasNext: boolean
  hasPrev: boolean
  index: number
  total: number
  onClose: () => void
  onNext: () => void
  onPrev: () => void
  onShare: (asset: Asset) => void
}

export function Lightbox({ asset, hasNext, hasPrev, index, total, onClose, onNext, onPrev, onShare }: LightboxProps) {
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lb-counter" onClick={(event) => event.stopPropagation()}>
        {index + 1} / {total}
      </div>

      <button className="lb-close" onClick={onClose}>
        <X size={16} />
      </button>
      <button
        className="lb-share"
        title="使用 macOS 系统菜单分享"
        onClick={(event) => {
          event.stopPropagation()
          onShare(asset)
        }}
      >
        <Share2 size={15} />
      </button>

      {hasPrev && (
        <button
          className="lb-nav lb-prev"
          onClick={(event) => {
            event.stopPropagation()
            onPrev()
          }}
        >
          <ChevronLeft size={22} />
        </button>
      )}

      <ZoomStage key={asset.id} asset={asset} />

      {hasNext && (
        <button
          className="lb-nav lb-next"
          onClick={(event) => {
            event.stopPropagation()
            onNext()
          }}
        >
          <ChevronRight size={22} />
        </button>
      )}

      <div className="lb-info" onClick={(event) => event.stopPropagation()}>
        <div className="lb-name">{asset.name}</div>
        <div className="lb-meta">
          {asset.kind.toUpperCase()} · {formatMb(asset.sizeKb)} · {asset.dimensions}
        </div>
      </div>
    </div>
  )
}

function ZoomStage({ asset }: { asset: Asset }) {
  const [dragging, setDragging] = useState(false)
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [scale, setScale] = useState(1)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const movedRef = useRef(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const sourcePreviewUrl = asset.previewUrl ?? (asset.sourcePath ? convertFileSrc(asset.sourcePath) : undefined)
  const imageUrl =
    sourcePreviewUrl && sourcePreviewUrl !== failedPreviewUrl
      ? sourcePreviewUrl
      : asset.thumbnailReady
        ? asset.thumbnailUrl
        : undefined

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === '=' || event.key === '+') {
        setScale((current) => Math.min(8, current * 1.25))
        event.preventDefault()
      } else if (event.key === '-') {
        setScale((current) => {
          const next = Math.max(0.1, current / 1.25)
          if (next <= 1) setOffset({ x: 0, y: 0 })
          return next
        })
        event.preventDefault()
      } else if (event.key === '0') {
        setScale(1)
        setOffset({ x: 0, y: 0 })
        event.preventDefault()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function handleMouseDown(event: React.MouseEvent) {
    if (event.button !== 0) return

    event.stopPropagation()
    movedRef.current = false
    setDragging(true)
    dragRef.current = { sx: event.clientX, sy: event.clientY, ox: offset.x, oy: offset.y }
  }

  function handleMouseMove(event: React.MouseEvent) {
    if (!dragging || !dragRef.current) return

    const dx = event.clientX - dragRef.current.sx
    const dy = event.clientY - dragRef.current.sy
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) movedRef.current = true
    setOffset({ x: dragRef.current.ox + dx, y: dragRef.current.oy + dy })
  }

  function handleMouseUp() {
    setDragging(false)
    dragRef.current = null
  }

  function handleWheel(event: React.WheelEvent) {
    event.stopPropagation()
    if (!wrapRef.current) return

    const rect = wrapRef.current.getBoundingClientRect()
    const mx = event.clientX - (rect.left + rect.width / 2)
    const my = event.clientY - (rect.top + rect.height / 2)
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15

    setScale((current) => {
      const next = Math.min(8, Math.max(0.1, current * factor))
      const ratio = next / current
      setOffset((position) => ({ x: mx + (position.x - mx) * ratio, y: my + (position.y - my) * ratio }))
      return next
    })
  }

  function zoomIn() {
    setScale((current) => Math.min(8, current * 1.25))
  }

  function zoomOut() {
    setScale((current) => {
      const next = Math.max(0.1, current / 1.25)
      if (next <= 1) setOffset({ x: 0, y: 0 })
      return next
    })
  }

  function zoomReset() {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  const pct = Math.round(scale * 100)
  const isZoomed = scale !== 1

  return (
    <>
      <div
        ref={wrapRef}
        className="lb-img-wrap"
        onClick={(event) => event.stopPropagation()}
        onMouseDown={handleMouseDown}
        onMouseLeave={handleMouseUp}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        style={{ cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default', overflow: 'hidden' }}
      >
        {imageUrl ? (
          <img
            className="lb-img"
            draggable={false}
            src={imageUrl}
            alt={asset.name}
            onError={() => setFailedPreviewUrl(imageUrl)}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transformOrigin: 'center',
              transition: dragging ? 'none' : 'transform 0.08s ease-out',
              userSelect: 'none',
              pointerEvents: 'none',
            }}
          />
        ) : (
          <div
            className={`lb-swatch ${asset.swatch}`}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transition: dragging ? 'none' : 'transform 0.08s ease-out',
            }}
          >
            <FileImage size={56} />
          </div>
        )}
      </div>

      <div className="lb-zoom-bar" onClick={(event) => event.stopPropagation()}>
        <button className="lb-zoom-btn" onClick={zoomOut} title="Zoom out (-)">
          <ZoomOut size={13} />
        </button>
        <button className={`lb-zoom-pct ${isZoomed ? 'active' : ''}`} onClick={zoomReset} title="Reset zoom (0)">
          {pct}%
        </button>
        <button className="lb-zoom-btn" onClick={zoomIn} title="Zoom in (+)">
          <ZoomIn size={13} />
        </button>
      </div>
    </>
  )
}
