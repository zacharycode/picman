import { Folder, FolderOpen, Search, Tag, Trash2, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react'
import { normalizeSearchText } from '../lib/search'
import type { FolderNode } from '../types/library'

type SidebarProps = {
  activeFolder: string
  activeTag: string
  allTags: string[]
  canReveal: boolean
  folders: FolderNode[]
  libraryName: string
  trashActive: boolean
  trashCount: number
  onEmptyTrash: () => void
  onRevealLibrary: () => void
  onReorderFolders: (orderedChildPaths: string[]) => void
  onSetActiveFolder: (folder: string) => void
  onSetActiveTag: (tag: string) => void
  onShowTrash: () => void
}

const FOLDER_PANE_MIN = 48
const TAG_PANE_MIN = 96

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function Sidebar({
  activeFolder,
  activeTag,
  allTags,
  canReveal,
  folders,
  libraryName,
  trashActive,
  trashCount,
  onEmptyTrash,
  onRevealLibrary,
  onReorderFolders,
  onSetActiveFolder,
  onSetActiveTag,
  onShowTrash,
}: SidebarProps) {
  const [folderPaneHeight, setFolderPaneHeight] = useState(226)
  const [folderSearchOpen, setFolderSearchOpen] = useState(false)
  const [folderQuery, setFolderQuery] = useState('')
  const [folderSearchText, setFolderSearchText] = useState('')
  const [draggingPath, setDraggingPath] = useState<string | null>(null)
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null)
  const [trashMenu, setTrashMenu] = useState<{ x: number; y: number } | null>(null)
  const folderSearchComposingRef = useRef(false)
  const folderSearch = normalizeSearchText(folderQuery).trim()
  const allChildFolders = useMemo(() => folders.filter((folder) => folder.path !== '/'), [folders])
  const childFolders = useMemo(
    () =>
      allChildFolders.filter((folder) => {
        if (!folderSearch) return true
        return normalizeSearchText(`${folder.name} ${folder.path}`).includes(folderSearch)
      }),
    [allChildFolders, folderSearch],
  )
  // Manual reordering only makes sense on the full, unfiltered list.
  const canReorder = !folderSearch && allChildFolders.length > 1

  function handleFolderDragStart(event: ReactDragEvent<HTMLButtonElement>, path: string) {
    if (!canReorder) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-picman-folder', path)
    setDraggingPath(path)
  }

  function handleFolderDragOver(event: ReactDragEvent<HTMLButtonElement>, path: string) {
    if (!draggingPath) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (path !== dropTargetPath) setDropTargetPath(path)
  }

  function clearFolderDrag() {
    setDraggingPath(null)
    setDropTargetPath(null)
  }

  function handleFolderDrop(event: ReactDragEvent<HTMLButtonElement>, targetPath: string) {
    event.preventDefault()
    const sourcePath = draggingPath
    clearFolderDrag()
    if (!sourcePath || sourcePath === targetPath) return

    const paths = allChildFolders.map((folder) => folder.path)
    const from = paths.indexOf(sourcePath)
    const to = paths.indexOf(targetPath)
    if (from === -1 || to === -1) return

    paths.splice(from, 1)
    paths.splice(to, 0, sourcePath)
    onReorderFolders(paths)
  }

  function clearFolderSearch() {
    folderSearchComposingRef.current = false
    setFolderQuery('')
    setFolderSearchText('')
  }

  function updateFolderSearch(value: string) {
    setFolderSearchText(value)
    if (!folderSearchComposingRef.current) setFolderQuery(value)
  }

  function finishFolderSearchComposition(value: string) {
    folderSearchComposingRef.current = false
    setFolderSearchText(value)
    setFolderQuery(value)
  }

  function startVerticalResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)

    const startY = event.clientY
    const startHeight = folderPaneHeight
    const maxHeight = Math.max(FOLDER_PANE_MIN, window.innerHeight - TAG_PANE_MIN - 92)

    document.body.classList.add('is-resizing-row')

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setFolderPaneHeight(clamp(startHeight + moveEvent.clientY - startY, FOLDER_PANE_MIN, maxHeight))
    }

    const stopResize = () => {
      document.body.classList.remove('is-resizing-row')
      window.removeEventListener('pointermove', handlePointerMove)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize, { once: true })
  }

  return (
    <aside className="sidebar">
      <section className="sb-pane sb-folder-pane" style={{ height: folderPaneHeight }}>
        <div className="sb-section-head">
          <button
            className={`sb-title-btn sb-library-title ${activeFolder === '/' ? 'active' : ''}`}
            title={libraryName}
            onClick={() => onSetActiveFolder('/')}
          >
            {libraryName}
          </button>
          <div className="sb-head-actions">
            <button
              disabled={!canReveal}
              title="在 Finder 中显示资源库文件夹"
              onClick={onRevealLibrary}
            >
              <FolderOpen size={13} />
            </button>
            <button
              className={folderSearchOpen ? 'active' : ''}
              title={folderSearchOpen ? '关闭文件夹搜索' : '搜索文件夹'}
              onClick={() => {
                if (folderSearchOpen) clearFolderSearch()
                setFolderSearchOpen((open) => !open)
              }}
            >
              {folderSearchOpen ? <X size={13} /> : <Search size={13} />}
            </button>
          </div>
        </div>
        {folderSearchOpen && (
          <div className="sb-folder-search">
            <Search size={12} />
            <input
              autoFocus
              placeholder="搜索文件夹"
              value={folderSearchText}
              onChange={(event) => updateFolderSearch(event.target.value)}
              onCompositionStart={() => {
                folderSearchComposingRef.current = true
              }}
              onCompositionEnd={(event) => finishFolderSearchComposition(event.currentTarget.value)}
            />
          </div>
        )}
        <div className="sb-folders">
          {childFolders.map((folder) => (
            <button
              key={folder.path}
              className={`sb-item ${activeFolder === folder.path ? 'active' : ''} ${
                draggingPath === folder.path ? 'dragging' : ''
              } ${dropTargetPath === folder.path && draggingPath !== folder.path ? 'drag-over' : ''}`}
              draggable={canReorder}
              onClick={() => onSetActiveFolder(folder.path)}
              onDragStart={(event) => handleFolderDragStart(event, folder.path)}
              onDragOver={(event) => handleFolderDragOver(event, folder.path)}
              onDrop={(event) => handleFolderDrop(event, folder.path)}
              onDragEnd={clearFolderDrag}
            >
              <Folder size={13} />
              <span className="sb-item-label">{folder.name}</span>
              <span className="sb-item-count">{folder.count}</span>
            </button>
          ))}
          {childFolders.length === 0 && (
            <div className="sb-empty-row">{folderSearch ? '没有匹配的文件夹' : '暂无子文件夹'}</div>
          )}
        </div>
      </section>

      <div
        aria-label="调整文件夹和标签区域高度"
        aria-orientation="horizontal"
        className="sidebar-row-resizer"
        role="separator"
        onPointerDown={startVerticalResize}
      />
      <section className="sb-pane sb-tag-pane">
        <div className="sb-section-head">
          <div className="sb-title-btn sb-title-static">标签</div>
        </div>
        <div className="sb-tags">
          <button className={`sb-tag ${activeTag === 'all' ? 'active' : ''}`} onClick={() => onSetActiveTag('all')}>
            <Tag size={12} /> 全部
          </button>
          {allTags.map((tag) => (
            <button
              key={tag}
              className={`sb-tag ${activeTag === tag ? 'active' : ''}`}
              onClick={() => onSetActiveTag(tag)}
            >
              <Tag size={12} /> {tag}
            </button>
          ))}
          {allTags.length === 0 && <div className="sb-tag-empty">暂无标签</div>}
        </div>
      </section>

      <div className="sb-trash-row-wrap">
        <button
          className={`sb-trash-row ${trashActive ? 'active' : ''}`}
          title="回收站（右键清空）"
          onClick={onShowTrash}
          onContextMenu={(event) => {
            event.preventDefault()
            if (trashCount > 0) {
              setTrashMenu({ x: event.clientX, y: event.clientY })
            }
          }}
        >
          <Trash2 size={13} />
          <span className="sb-item-label">回收站</span>
          {trashCount > 0 && <span className="sb-item-count">{trashCount}</span>}
        </button>
        {trashMenu && (
          <>
            <div className="sb-ctx-backdrop" onClick={() => setTrashMenu(null)} onContextMenu={(event) => { event.preventDefault(); setTrashMenu(null) }} />
            <div className="sb-ctx-menu" style={{ left: trashMenu.x, top: trashMenu.y }}>
              <button
                onClick={() => {
                  setTrashMenu(null)
                  onEmptyTrash()
                }}
              >
                <Trash2 size={13} /> 清空回收站
              </button>
            </div>
          </>
        )}
      </div>

      <div className="sb-footer">
        <div className="sb-dot" />
        <span>文件优先资源库</span>
      </div>
    </aside>
  )
}
