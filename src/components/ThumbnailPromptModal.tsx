import { Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import type { FolderNode } from '../types/library'

type ThumbnailPromptModalProps = {
  totalCount: number
  folders: FolderNode[]
  onConfirm: (selection: string[] | 'all') => void
  onDismiss: () => void
}

export function ThumbnailPromptModal({ totalCount, folders, onConfirm, onDismiss }: ThumbnailPromptModalProps) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(folders.map((folder) => folder.path)))
  const allChecked = folders.length > 0 && checked.size === folders.length

  function toggleAll() {
    setChecked(allChecked ? new Set() : new Set(folders.map((folder) => folder.path)))
  }

  function toggle(path: string) {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function confirm() {
    if (folders.length === 0 || allChecked) onConfirm('all')
    else onConfirm([...checked])
  }

  const wholeLibrary = folders.length === 0 || allChecked

  return (
    <div className="batch-overlay" role="dialog" aria-modal="true">
      <div className="batch-backdrop" onClick={onDismiss} />
      <div className="batch-panel">
        <div className="batch-head">
          <h2>生成缩略图</h2>
          <button className="batch-close" title="稍后" onClick={onDismiss}>
            <X size={15} />
          </button>
        </div>

        <div className="batch-summary">
          当前资源库还没有缩略图（共 {totalCount} 张素材）。是否现在生成？生成在后台进行，不影响浏览。
        </div>

        {folders.length > 0 && (
          <>
            <label className="tp-all">
              <input type="checkbox" checked={allChecked} onChange={toggleAll} />
              <span>全选（{folders.length} 个文件夹）</span>
            </label>
            <div className="tp-folders">
              {folders.map((folder) => (
                <label key={folder.path} className="tp-folder">
                  <input type="checkbox" checked={checked.has(folder.path)} onChange={() => toggle(folder.path)} />
                  <span title={folder.path}>{folder.name}</span>
                  <small>{folder.count}</small>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="batch-foot">
          <button className="batch-btn" onClick={onDismiss}>
            稍后
          </button>
          <button
            className="batch-btn primary"
            disabled={folders.length > 0 && checked.size === 0}
            onClick={confirm}
          >
            <Sparkles size={13} />
            {wholeLibrary ? `生成全部（${totalCount}）` : `生成所选（${checked.size} 个文件夹）`}
          </button>
        </div>
      </div>
    </div>
  )
}
