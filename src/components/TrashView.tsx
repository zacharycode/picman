import { convertFileSrc } from '@tauri-apps/api/core'
import { ArrowLeft, RotateCcw, Trash2 } from 'lucide-react'
import type { MouseEvent } from 'react'
import type { TrashItem } from '../types/library'

type TrashViewProps = {
  items: TrashItem[]
  selectedIds: Set<string>
  thumbSize: number
  onToggleSelect: (id: string, event: MouseEvent) => void
  onRestore: (ids: string[]) => void
  onBack: () => void
}

export function TrashView({
  items,
  selectedIds,
  thumbSize,
  onToggleSelect,
  onRestore,
  onBack,
}: TrashViewProps) {
  const selectedCount = selectedIds.size

  return (
    <section className="trash-view">
      <div className="view-toolbar trash-toolbar">
        <button className="trash-back" title="返回素材库" onClick={onBack}>
          <ArrowLeft size={14} /> 返回
        </button>
        <div className="trash-title">回收站 · {items.length} 项</div>
        <div className="view-actions">
          <button
            className="trash-action"
            disabled={selectedCount === 0}
            onClick={() => onRestore([...selectedIds])}
          >
            <RotateCcw size={13} /> 恢复所选{selectedCount > 0 ? `（${selectedCount}）` : ''}
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <Trash2 size={44} color="var(--muted)" />
          <h2>回收站为空</h2>
          <p>删除的图片会先移动到这里，可随时恢复或永久清空。</p>
        </div>
      ) : (
        <div className="trash-scroll">
          <div
            className="trash-grid"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.max(120, thumbSize)}px, 1fr))` }}
          >
            {items.map((item) => (
              <div
                key={item.id}
                className={`trash-item ${selectedIds.has(item.id) ? 'selected' : ''}`}
                role="button"
                tabIndex={0}
                onClick={(event) => onToggleSelect(item.id, event)}
                onDoubleClick={() => onRestore([item.id])}
              >
                <div className="trash-thumb">
                  <img alt="" decoding="async" draggable={false} loading="lazy" src={convertFileSrc(item.trashFilePath)} />
                  <button
                    className="trash-restore-btn"
                    title="恢复"
                    onClick={(event) => {
                      event.stopPropagation()
                      onRestore([item.id])
                    }}
                  >
                    <RotateCcw size={13} />
                  </button>
                </div>
                <div className="trash-meta">
                  <span className="trash-name" title={item.originalRelativePath}>
                    {item.name}
                  </span>
                  <span className="trash-sub">{item.deletedAt.replace('T', ' ')}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
