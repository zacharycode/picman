import { FolderPlus, Inbox, Link2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { FolderNode } from '../types/library'

const INBOX_PATH = '/Inbox'

type CollectFolderOption = {
  path: string
  name: string
}

type CollectOverlayProps = {
  previewUrl: string
  title?: string
  sourceUrl?: string
  folders: FolderNode[]
  libraryName: string
  defaultFolder: string
  onConfirm: (folderPath: string) => void
  onCancel: () => void
}

export function CollectOverlay({
  previewUrl,
  title,
  sourceUrl,
  folders,
  libraryName,
  defaultFolder,
  onConfirm,
  onCancel,
}: CollectOverlayProps) {
  const options = useMemo<CollectFolderOption[]>(() => {
    const seen = new Set<string>()
    const list: CollectFolderOption[] = []
    const push = (path: string, name: string) => {
      if (seen.has(path)) return
      seen.add(path)
      list.push({ path, name })
    }

    push(INBOX_PATH, 'Inbox')
    for (const folder of folders) {
      push(folder.path, folder.path === '/' ? `${libraryName}（库根）` : folder.name)
    }

    return list
  }, [folders, libraryName])

  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(() =>
    options.some((option) => option.path === defaultFolder) ? defaultFolder : INBOX_PATH,
  )

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase()
    if (!query) return options
    return options.filter(
      (option) => option.name.toLowerCase().includes(query) || option.path.toLowerCase().includes(query),
    )
  }, [filter, options])

  // The active row is derived: it falls back to the first match when the user's
  // last explicit pick is filtered out, so no effect has to sync state.
  const activePath = filtered.some((option) => option.path === selected)
    ? selected
    : (filtered[0]?.path ?? '')

  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('.collect-folder.active')
    node?.scrollIntoView({ block: 'nearest' })
  }, [activePath])

  function moveSelection(delta: number) {
    if (filtered.length === 0) return
    const index = filtered.findIndex((option) => option.path === activePath)
    const nextIndex = Math.min(filtered.length - 1, Math.max(0, (index === -1 ? 0 : index) + delta))
    setSelected(filtered[nextIndex].path)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (activePath) onConfirm(activePath)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSelection(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelection(-1)
    }
  }

  return (
    <div className="collect-overlay" role="dialog" aria-modal="true" onKeyDown={handleKeyDown}>
      <div className="collect-backdrop" onClick={onCancel} />
      <div className="collect-panel">
        <div className="collect-head">
          <h2>收藏图片到…</h2>
          <button className="collect-close" title="取消" onClick={onCancel}>
            <X size={15} />
          </button>
        </div>

        <div className="collect-body">
          <div className="collect-preview">
            <img alt="" src={previewUrl} />
          </div>
          <div className="collect-meta">
            {title && <div className="collect-title">{title}</div>}
            {sourceUrl && (
              <div className="collect-source" title={sourceUrl}>
                <Link2 size={12} />
                <span>{sourceUrl}</span>
              </div>
            )}
            <input
              autoFocus
              className="collect-filter"
              placeholder="筛选文件夹"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
        </div>

        <div ref={listRef} className="collect-folders">
          {filtered.map((option) => (
            <button
              key={option.path}
              className={`collect-folder ${option.path === activePath ? 'active' : ''}`}
              onClick={() => setSelected(option.path)}
              onDoubleClick={() => onConfirm(option.path)}
            >
              {option.path === INBOX_PATH ? <Inbox size={14} /> : <FolderPlus size={14} />}
              <span className="collect-folder-name">{option.name}</span>
              <span className="collect-folder-path">{option.path}</span>
            </button>
          ))}
          {filtered.length === 0 && <div className="collect-empty">没有匹配的文件夹</div>}
        </div>

        <div className="collect-foot">
          <span className="collect-hint">Enter 收藏 · Esc 取消</span>
          <div className="collect-actions">
            <button className="collect-btn" onClick={onCancel}>
              取消
            </button>
            <button
              className="collect-btn primary"
              disabled={!activePath}
              onClick={() => activePath && onConfirm(activePath)}
            >
              收藏
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
