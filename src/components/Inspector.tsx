import { FileImage, Heart, Plus, ScanText, Smile, Tag, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { formatMb } from '../lib/format'
import type { Asset } from '../types/library'

const TAG_EMOJIS = ['⭐', '🔥', '🎨', '📌', '🧩', '📱', '💡', '✅']
const THUMBNAIL_QUALITY_LABELS = {
  compact: '紧凑',
  standard: '标准',
  high: '高清',
}

function normalizeTag(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

export function EmptyInspector() {
  return (
    <div className="empty-inspector">
      <div className="empty-inspector-icon">
        <FileImage size={28} />
      </div>
      <div>
        <div className="empty-inspector-title">未选择素材</div>
        <p>选择一张图片后查看文件信息。</p>
      </div>
    </div>
  )
}

type InspectorProps = {
  activeTag: string
  allTags: string[]
  asset: Asset
  onAddTag: (assetId: string, tag: string) => void
  onOcr: (asset: Asset) => void
  onRemoveTag: (assetId: string, tag: string) => void
  onSetFavorite: (assetId: string, favorite: boolean) => void
  onSelectTag: (tag: string) => void
  onUpdateNote: (assetId: string, note: string) => void
}

export function Inspector({
  activeTag,
  allTags,
  asset,
  onAddTag,
  onOcr,
  onRemoveTag,
  onSetFavorite,
  onSelectTag,
  onUpdateNote,
}: InspectorProps) {
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [failedPreviewKey, setFailedPreviewKey] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState(asset.note)
  const [tagInput, setTagInput] = useState('')
  const tagInputRef = useRef<HTMLInputElement>(null)
  const previewKey = `${asset.thumbnailUrl ?? ''}:${asset.thumbnailQuality ?? 'none'}:${asset.thumbnailReady}`
  const showPreview = asset.thumbnailReady && asset.thumbnailUrl && failedPreviewKey !== previewKey
  const availableTags = useMemo(
    () => allTags.filter((tag) => !asset.tags.includes(tag)).slice(0, 8),
    [allTags, asset.tags],
  )

  function handleAddTag(value: string) {
    const tag = normalizeTag(value)
    if (!tag) return

    onAddTag(asset.id, tag)
    setTagInput('')
    setEmojiOpen(false)
  }

  function handleEmojiSelect(emoji: string) {
    setTagInput((current) => {
      const text = normalizeTag(current)
      return text ? `${emoji} ${text}` : emoji
    })
    window.requestAnimationFrame(() => tagInputRef.current?.focus())
  }

  function commitNote() {
    const note = noteDraft.trim()
    if (note !== asset.note) onUpdateNote(asset.id, note)
  }

  return (
    <>
      <div className="insp-preview">
        {showPreview ? (
          <img src={asset.thumbnailUrl} alt={asset.name} onError={() => setFailedPreviewKey(previewKey)} />
        ) : (
          <div
            className={`asset-thumb-swatch thumbnail-placeholder ${asset.swatch}`}
            style={{ width: '100%', height: '100%' }}
          >
            <FileImage size={40} />
            <span>{asset.thumbnailReady || asset.thumbnailError ? '缩略图加载失败' : '待生成缩略图'}</span>
          </div>
        )}
      </div>
      <div className="insp-section">
        <div className="insp-name-row">
          <div className="insp-name">{asset.name}</div>
          <button
            className={`insp-favorite-btn ${asset.favorite ? 'active' : ''}`}
            title={asset.favorite ? '取消收藏' : '收藏'}
            type="button"
            onClick={() => onSetFavorite(asset.id, !asset.favorite)}
          >
            <Heart size={13} fill={asset.favorite ? 'currentColor' : 'none'} />
          </button>
        </div>
        <div className="insp-path">{asset.relativePath}</div>
        <button
          className="insp-ocr-btn"
          disabled={asset.kind === 'svg'}
          title={asset.kind === 'svg' ? '矢量图暂不支持文字识别' : '识别图片中的文字'}
          type="button"
          onClick={() => onOcr(asset)}
        >
          <ScanText size={13} /> 识别文字
        </button>
      </div>
      <div className="insp-section">
        <div className="insp-title">素材信息</div>
        <dl className="insp-meta">
          <div>
            <dt>类型</dt>
            <dd>{asset.kind.toUpperCase()}</dd>
          </div>
          <div>
            <dt>文件大小</dt>
            <dd>{formatMb(asset.sizeKb)}</dd>
          </div>
          <div>
            <dt>尺寸</dt>
            <dd>{asset.dimensions}</dd>
          </div>
          <div>
            <dt>修改时间</dt>
            <dd>{asset.modifiedAt}</dd>
          </div>
          <div>
            <dt>缩略图</dt>
            <dd>
              {asset.thumbnailReady
                ? `已生成 · ${THUMBNAIL_QUALITY_LABELS[asset.thumbnailQuality ?? 'standard']}`
                : asset.thumbnailError
                  ? '生成失败'
                  : '待生成'}
            </dd>
          </div>
          {asset.thumbnailReady && (
            <div>
              <dt>缩略图大小</dt>
              <dd>
                {asset.thumbnailWidth} x {asset.thumbnailHeight} · {asset.thumbnailSizeKb ?? 0} KB
              </dd>
            </div>
          )}
        </dl>
      </div>
      <div className="insp-section">
        <div className="insp-title">标签</div>
        <div className="insp-tags" aria-label="当前素材标签">
          {asset.tags.length === 0 ? (
            <span className="insp-tag-empty">
              <Tag size={11} /> 无标签
            </span>
          ) : (
            asset.tags.map((tag) => (
              <span key={tag} className="insp-tag-pill">
                <button
                  className={`insp-tag-main ${activeTag === tag ? 'active' : ''}`}
                  title={`按标签筛选：${tag}`}
                  type="button"
                  onClick={() => onSelectTag(tag)}
                >
                  <Tag size={11} /> {tag}
                </button>
                <button
                  className="insp-tag-remove"
                  title={`移除标签：${tag}`}
                  type="button"
                  onClick={() => onRemoveTag(asset.id, tag)}
                >
                  <X size={10} />
                </button>
              </span>
            ))
          )}
        </div>
        <form
          className="insp-tag-editor"
          onSubmit={(event) => {
            event.preventDefault()
            handleAddTag(tagInput)
          }}
        >
          <div className="insp-tag-input-row">
            <input
              ref={tagInputRef}
              placeholder="输入标签"
              value={tagInput}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return

                event.preventDefault()
                handleAddTag(tagInput)
              }}
            />
            <button
              className={`insp-tag-icon-btn ${emojiOpen ? 'active' : ''}`}
              title="选择表情"
              type="button"
              onClick={() => setEmojiOpen((open) => !open)}
            >
              <Smile size={13} />
            </button>
            <button
              className="insp-tag-icon-btn"
              disabled={!normalizeTag(tagInput)}
              title="添加标签"
              type="submit"
            >
              <Plus size={13} />
            </button>
          </div>
          {emojiOpen && (
            <div className="insp-emoji-picker" aria-label="选择标签表情">
              {TAG_EMOJIS.map((emoji) => (
                <button key={emoji} title={`插入 ${emoji}`} type="button" onClick={() => handleEmojiSelect(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </form>
        {availableTags.length > 0 && (
          <div className="insp-tag-suggestions">
            {availableTags.map((tag) => (
              <button key={tag} type="button" onClick={() => handleAddTag(tag)}>
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="insp-section insp-note">
        <div className="insp-title">备注</div>
        <textarea
          className="insp-note-input"
          placeholder="备注"
          value={noteDraft}
          onBlur={commitNote}
          onChange={(event) => setNoteDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.currentTarget.blur()
            }
          }}
        />
      </div>
    </>
  )
}

export function MultiSelectInspector({ count }: { count: number }) {
  return (
    <div className="multi-select-info">
      <div className="ms-count">{count}</div>
      <div className="ms-label">个素材已选择</div>
      <div className="ms-hint">
        <p>⌘A - 全选</p>
        <p>Shift+点击 - 连续选择</p>
        <p>⌘+点击 - 切换选择</p>
      </div>
    </div>
  )
}
