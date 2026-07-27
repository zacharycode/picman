import {
  Archive,
  Database,
  DownloadCloud,
  FileImage,
  FileJson,
  FolderOpen,
  HardDrive,
  Image,
  Monitor,
  Moon,
  RefreshCw,
  Sparkles,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ComponentType, KeyboardEvent } from 'react'
import { metadataExample } from '../data/mockLibrary'
import { formatMb } from '../lib/format'
import { eventToShortcut, formatShortcut } from '../lib/shortcut'
import type {
  AppUpdateState,
  FolderNode,
  SelectionKeyAxis,
  ThemePref,
  ThumbnailGenerationState,
  ThumbnailQuality,
} from '../types/library'

const THEME_OPTIONS: [ThemePref, string, ComponentType<{ size?: number }>][] = [
  ['system', '系统', Monitor],
  ['light', '浅色', Sun],
  ['dark', '深色', Moon],
]

const THUMBNAIL_QUALITY_LABELS: Record<ThumbnailQuality, string> = {
  compact: '紧凑',
  standard: '标准',
  high: '高清',
}

const THUMBNAIL_QUALITY_HINTS: Record<ThumbnailQuality, string> = {
  compact: '小体积',
  standard: '均衡',
  high: '高细节',
}

type SettingsPanelProps = {
  appSettingsPath: string
  cacheLimit: number
  cacheSize: number
  collectorEnabled: boolean
  deleteShortcut: string
  folders: FolderNode[]
  generatedCount: number
  hasNativeLibrary: boolean
  indexAssetCount: number
  indexBusy: boolean
  indexExists: boolean
  indexSizeBytes: number
  indexValid: boolean
  libraryName: string
  ocrApiKey: string
  ocrLanguage: string
  pendingCount: number
  sourceSize: number
  selectionKeyAxis: SelectionKeyAxis
  themePref: ThemePref
  thumbnailGeneration: ThumbnailGenerationState
  thumbnailQuality: ThumbnailQuality
  updateState: AppUpdateState
  onCheckForUpdate: () => void
  onClearLibraryIndex: () => void
  onClose: () => void
  onClearThumbnailCache: () => void
  onCompressThumbnailCache: () => void
  onGenerateAllThumbnails: () => void
  onGenerateFolderThumbnails: (folderPaths: string[]) => void
  onOpenFolder: () => void
  onRebuildLibraryIndex: () => void
  onRevealAppSettings: () => void
  onSetCacheLimit: (value: number) => void
  onSetCollectorEnabled: (value: boolean) => void
  onSetDeleteShortcut: (value: string) => void
  onSetOcrApiKey: (value: string) => void
  onSetOcrLanguage: (value: string) => void
  onSetSelectionKeyAxis: (value: SelectionKeyAxis) => void
  onSetThemePref: (value: ThemePref) => void
  onSetThumbnailQuality: (value: ThumbnailQuality) => void
}

export function SettingsPanel({
  appSettingsPath,
  cacheLimit,
  cacheSize,
  collectorEnabled,
  deleteShortcut,
  folders,
  generatedCount,
  hasNativeLibrary,
  indexAssetCount,
  indexBusy,
  indexExists,
  indexSizeBytes,
  indexValid,
  libraryName,
  ocrApiKey,
  ocrLanguage,
  pendingCount,
  sourceSize,
  selectionKeyAxis,
  themePref,
  thumbnailGeneration,
  thumbnailQuality,
  updateState,
  onCheckForUpdate,
  onClearLibraryIndex,
  onClose,
  onClearThumbnailCache,
  onCompressThumbnailCache,
  onGenerateAllThumbnails,
  onGenerateFolderThumbnails,
  onOpenFolder,
  onRebuildLibraryIndex,
  onRevealAppSettings,
  onSetCacheLimit,
  onSetCollectorEnabled,
  onSetDeleteShortcut,
  onSetOcrApiKey,
  onSetOcrLanguage,
  onSetSelectionKeyAxis,
  onSetThemePref,
  onSetThumbnailQuality,
}: SettingsPanelProps) {
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(() => new Set())
  const [capturingShortcut, setCapturingShortcut] = useState(false)

  function handleShortcutKey(event: KeyboardEvent<HTMLButtonElement>) {
    event.preventDefault()
    if (event.key === 'Escape') {
      setCapturingShortcut(false)
      return
    }
    const shortcut = eventToShortcut(event.nativeEvent)
    if (shortcut) {
      onSetDeleteShortcut(shortcut)
      setCapturingShortcut(false)
    }
  }
  const activeSelectedFolders = useMemo(
    () => folders.filter((folder) => selectedFolders.has(folder.path)).map((folder) => folder.path),
    [folders, selectedFolders],
  )
  const isGenerating = thumbnailGeneration.status === 'running'
  const generationProgress =
    thumbnailGeneration.total > 0 ? Math.round((thumbnailGeneration.completed / thumbnailGeneration.total) * 100) : 0
  const failedSuffix = thumbnailGeneration.failed ? ` · 失败 ${thumbnailGeneration.failed}` : ''
  const updateBusy =
    updateState.status === 'checking' ||
    updateState.status === 'available' ||
    updateState.status === 'downloading' ||
    updateState.status === 'installing' ||
    updateState.status === 'restarting'
  const generationDescription = isGenerating
    ? `进度 ${thumbnailGeneration.completed}/${thumbnailGeneration.total} · 当前：${
        thumbnailGeneration.currentName ?? '准备中'
      }${failedSuffix}`
    : thumbnailGeneration.status === 'completed'
      ? `上次已完成：${thumbnailGeneration.scopeLabel} · ${thumbnailGeneration.total} 个素材${failedSuffix}`
      : '打开资源目录后默认不生成缩略图，需要在这里手动生成。重复生成会覆盖已有缩略图。'

  function toggleFolder(path: string) {
    setSelectedFolders((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }

      return next
    })
  }

  return (
    <>
      <div className="sp-backdrop" onClick={onClose} />
      <div className="sp-panel">
        <div className="sp-header">
          <span>偏好设置</span>
          <button aria-label="关闭设置" className="sp-close" type="button" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="sp-section">
          <div className="sp-section-title">资源库</div>
          <div className="sp-lib-row">
            <div className="sp-lib-name">
              <span className="sp-lib-label">当前资源库</span>
              <strong>{libraryName}</strong>
            </div>
            <button className="sp-open-btn" onClick={onOpenFolder}>
              <FolderOpen size={13} /> 打开文件夹
            </button>
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-section-title">本地目录索引</div>
          <div className="sp-metrics">
            <div className="sp-metric">
              <Database size={14} />
              <span>索引记录</span>
              <strong>{indexExists ? indexAssetCount : 0}</strong>
            </div>
            <div className="sp-metric">
              <HardDrive size={14} />
              <span>索引占用</span>
              <strong>{formatMb(Math.ceil(indexSizeBytes / 1024))}</strong>
            </div>
          </div>
          <p className="sp-desc">
            {indexBusy
              ? '正在根据真实文件更新本地索引。'
              : !indexExists
                ? '当前没有索引；下次刷新或重新打开资源库时可自动重建。'
                : indexValid
                  ? '索引可用，仅用于快速打开；删除后不会影响图片和元数据。'
                  : '索引不可用，将在下次刷新时从真实文件重建。'}
          </p>
          <div className="sp-actions sp-index-actions">
            <button disabled={!hasNativeLibrary || indexBusy} onClick={onRebuildLibraryIndex}>
              <RefreshCw size={13} /> 重建索引
            </button>
            <button className="danger" disabled={!indexExists || indexBusy} onClick={onClearLibraryIndex}>
              <Trash2 size={13} /> 清理索引
            </button>
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-section-title">缩略图缓存</div>
          <div className="sp-metrics">
            <div className={`sp-metric ${isGenerating ? 'is-generating' : ''}`}>
              <Image size={14} />
              <span>已生成</span>
              <strong>{generatedCount}</strong>
              {isGenerating && (
                <div className="sp-metric-progress">
                  <div className="sp-progress-track">
                    <div style={{ width: `${generationProgress}%` }} />
                  </div>
                  <small>
                    本次 {thumbnailGeneration.completed}/{thumbnailGeneration.total}
                    {failedSuffix}
                  </small>
                </div>
              )}
            </div>
            <div className="sp-metric">
              <HardDrive size={14} />
              <span>缓存占用</span>
              <strong>{formatMb(cacheSize)}</strong>
            </div>
            <div className="sp-metric">
              <FileImage size={14} />
              <span>源文件</span>
              <strong>{formatMb(sourceSize)}</strong>
            </div>
            <div className="sp-metric">
              <Archive size={14} />
              <span>未生成</span>
              <strong>{pendingCount}</strong>
            </div>
          </div>

          <label className="sp-field range-row">
            <span>缓存上限：{cacheLimit} GB</span>
            <input
              disabled={isGenerating}
              max="20"
              min="1"
              onChange={(event) => onSetCacheLimit(Number(event.target.value))}
              type="range"
              value={cacheLimit}
            />
          </label>

          <div className="sp-generation-box">
            <div className="sp-generation-head">
              <span>{isGenerating ? `正在生成：${thumbnailGeneration.scopeLabel}` : '手动生成缩略图'}</span>
              {thumbnailGeneration.status === 'completed' && <strong>上次完成 {thumbnailGeneration.total} 个</strong>}
            </div>
            <div className="sp-generation-quality">
              <span>生成品质</span>
              <div className="segmented quality-segmented">
                {(['compact', 'standard', 'high'] as ThumbnailQuality[]).map((quality) => (
                  <button
                    key={quality}
                    className={thumbnailQuality === quality ? 'active' : ''}
                    disabled={isGenerating}
                    onClick={() => onSetThumbnailQuality(quality)}
                  >
                    <strong>{THUMBNAIL_QUALITY_LABELS[quality]}</strong>
                    <small>{THUMBNAIL_QUALITY_HINTS[quality]}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="sp-generation-progress" aria-label="缩略图生成进度">
              <div style={{ width: `${generationProgress}%` }} />
            </div>
            <div className="sp-generation-meta">
              {generationDescription}
            </div>
          </div>

          <div className="sp-folder-picker">
            <div className="sp-folder-picker-head">
              <span>按文件夹生成</span>
              <button type="button" onClick={() => setSelectedFolders(new Set())}>
                清空
              </button>
            </div>
            <div className="sp-folder-list">
              {folders.length === 0 ? (
                <div className="sp-empty-row">当前资源库暂无素材文件夹</div>
              ) : (
                folders.map((folder) => (
                  <label key={folder.path} className="sp-folder-option">
                    <input
                      checked={selectedFolders.has(folder.path)}
                      disabled={isGenerating}
                      type="checkbox"
                      onChange={() => toggleFolder(folder.path)}
                    />
                    <span title={folder.path}>{folder.name}</span>
                    <small>{folder.count}</small>
                  </label>
                ))
              )}
            </div>
          </div>

          <div className="sp-actions">
            <button disabled={isGenerating} onClick={onGenerateAllThumbnails}>
              <Sparkles size={13} /> 生成全部（{THUMBNAIL_QUALITY_LABELS[thumbnailQuality]}）
            </button>
            <button
              disabled={isGenerating || activeSelectedFolders.length === 0}
              onClick={() => onGenerateFolderThumbnails(activeSelectedFolders)}
            >
              <FolderOpen size={13} /> 生成所选文件夹（{THUMBNAIL_QUALITY_LABELS[thumbnailQuality]}）
            </button>
            <button disabled={isGenerating || generatedCount === 0} onClick={onCompressThumbnailCache}>
              <Archive size={13} /> 压缩已有缓存
            </button>
            <button className="danger" disabled={isGenerating || generatedCount === 0} onClick={onClearThumbnailCache}>
              <Trash2 size={13} /> 清理缓存
            </button>
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-section-title">通用</div>
          <div className="sp-field">
            <span>主题模式</span>
            <div className="segmented sp-theme-seg">
              {THEME_OPTIONS.map(([value, label, Icon]) => (
                <button
                  key={value}
                  className={themePref === value ? 'active' : ''}
                  title={label}
                  onClick={() => onSetThemePref(value)}
                >
                  <Icon size={13} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
          <label className="sp-row">
            <span>图片收集助手</span>
            <input
              checked={collectorEnabled}
              type="checkbox"
              onChange={(event) => onSetCollectorEnabled(event.target.checked)}
            />
          </label>
          <label className="sp-row">
            <span>方向键切换</span>
            <select
              className="sp-select"
              value={selectionKeyAxis}
              onChange={(event) => onSetSelectionKeyAxis(event.target.value as SelectionKeyAxis)}
            >
              <option value="horizontal">左右键</option>
              <option value="vertical">上下键</option>
            </select>
          </label>
          <div className="sp-row">
            <span>删除到回收站快捷键</span>
            <button
              className={`sp-shortcut ${capturingShortcut ? 'capturing' : ''}`}
              type="button"
              onBlur={() => setCapturingShortcut(false)}
              onClick={() => setCapturingShortcut(true)}
              onKeyDown={capturingShortcut ? handleShortcutKey : undefined}
            >
              {capturingShortcut ? '请按下快捷键…' : formatShortcut(deleteShortcut)}
            </button>
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-section-title">文字识别（OCR）</div>
          <label className="sp-field">
            <span>OCR.space API Key</span>
            <input
              className="sp-text-input"
              placeholder="在此填写 OCR.space API Key"
              spellCheck={false}
              type="text"
              value={ocrApiKey}
              onChange={(event) => onSetOcrApiKey(event.target.value)}
            />
          </label>
          <label className="sp-row">
            <span>识别语言</span>
            <select
              className="sp-select"
              value={ocrLanguage}
              onChange={(event) => onSetOcrLanguage(event.target.value)}
            >
              <option value="chs">简体中文</option>
              <option value="cht">繁体中文</option>
              <option value="eng">英文</option>
              <option value="jpn">日文</option>
              <option value="kor">韩文</option>
            </select>
          </label>
          <p className="sp-desc">在 ocr.space 免费注册即可获取 API Key；识别结果会去除换行、合并为一段，可在弹窗中编辑并复制。</p>
        </div>

        <div className="sp-section">
          <div className="sp-section-title">软件更新</div>
          <div className={`sp-update-box sp-update-box--${updateState.status}`}>
            <div className="sp-update-main">
              <div className="sp-lib-name">
                <span className="sp-lib-label">更新源</span>
                <strong>GitHub Releases</strong>
              </div>
              <button className="sp-open-btn" disabled={updateBusy} onClick={onCheckForUpdate}>
                <DownloadCloud size={13} /> {updateBusy ? '更新中' : '检查更新'}
              </button>
            </div>
            <div className="sp-update-message">{updateState.message}</div>
            {typeof updateState.progress === 'number' && (
              <div className="sp-generation-progress" aria-label="应用更新进度">
                <div style={{ width: `${updateState.progress}%` }} />
              </div>
            )}
            {updateState.version && <div className="sp-update-version">目标版本：{updateState.version}</div>}
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-section-title">文件结构</div>
          <p className="sp-desc">配置文件跟随普通文件夹保存，图片文件保持原生可复制。</p>
          <pre className="sp-pre">{`DesignAssets/
  .picman/
    settings.json
    cache/
      catalog.jsonl
      thumbnails/
    trash/
  Icons/
    navigation-home.png
    .picman.folder.json`}</pre>
          <pre className="sp-pre">{JSON.stringify(metadataExample, null, 2)}</pre>
          <div className="sp-lib-row sp-settings-file-row">
            <div className="sp-lib-name">
              <span className="sp-lib-label">本机应用设置</span>
              <code title={appSettingsPath}>{appSettingsPath || '浏览器环境使用本地回退存储'}</code>
            </div>
            {appSettingsPath && (
              <button className="sp-open-btn" onClick={onRevealAppSettings}>
                <FileJson size={13} /> 在 Finder 中显示
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
