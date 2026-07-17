import { FolderInput, FolderPlus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { FolderNode } from '../types/library'

type MovePickerProps = {
  count: number
  folders: FolderNode[]
  libraryName: string
  onConfirm: (targetFolder: string) => void
  onCancel: () => void
}

export function MovePicker({ count, folders, libraryName, onConfirm, onCancel }: MovePickerProps) {
  const [newFolder, setNewFolder] = useState('')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState('/')

  const options = useMemo(() => {
    const list = folders.map((folder) => ({
      path: folder.path,
      name: folder.path === '/' ? `${libraryName}（库根）` : folder.name,
    }))
    const query = filter.trim().toLowerCase()
    if (!query) return list
    return list.filter((o) => o.name.toLowerCase().includes(query) || o.path.toLowerCase().includes(query))
  }, [folders, libraryName, filter])

  const trimmedNew = newFolder.trim()

  function confirm() {
    if (trimmedNew) {
      onConfirm(trimmedNew.replace(/^\/+|\/+$/g, ''))
      return
    }
    onConfirm(selected === '/' ? '' : selected.replace(/^\/+/, ''))
  }

  return (
    <div className="collect-overlay" role="dialog" aria-modal="true">
      <div className="collect-backdrop" onClick={onCancel} />
      <div className="collect-panel">
        <div className="collect-head">
          <h2>移动 {count} 项到…</h2>
          <button className="collect-close" title="取消" onClick={onCancel}>
            <X size={15} />
          </button>
        </div>

        <div className="move-newfolder">
          <FolderPlus size={14} />
          <input
            placeholder="新建文件夹（留空则移动到下方所选）"
            value={newFolder}
            onChange={(event) => setNewFolder(event.target.value)}
          />
        </div>

        {!trimmedNew && (
          <input
            className="collect-filter move-filter"
            placeholder="筛选文件夹"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}

        {!trimmedNew && (
          <div className="collect-folders">
            {options.map((option) => (
              <button
                key={option.path}
                className={`collect-folder ${option.path === selected ? 'active' : ''}`}
                onClick={() => setSelected(option.path)}
                onDoubleClick={() => onConfirm(option.path === '/' ? '' : option.path.replace(/^\/+/, ''))}
              >
                <FolderInput size={14} />
                <span className="collect-folder-name">{option.name}</span>
                <span className="collect-folder-path">{option.path}</span>
              </button>
            ))}
            {options.length === 0 && <div className="collect-empty">没有匹配的文件夹</div>}
          </div>
        )}

        <div className="collect-foot">
          <span className="collect-hint">
            {trimmedNew ? `新建并移入「${trimmedNew}」` : '移动到所选文件夹'}
          </span>
          <div className="collect-actions">
            <button className="collect-btn" onClick={onCancel}>
              取消
            </button>
            <button className="collect-btn primary" onClick={confirm}>
              移动
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
