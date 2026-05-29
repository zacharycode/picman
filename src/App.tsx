import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
import type { MouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import './App.css'
import { Lightbox } from './components/Lightbox'
import { LibraryView } from './components/LibraryView'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { assets as sampleAssets } from './data/mockLibrary'
import { buildFolders, folderName, revokePreviewUrls, revokeThumbnailUrls, scanFiles } from './lib/library'
import { normalizeSearchText } from './lib/search'
import { sortAssets } from './lib/sort'
import type {
  Asset,
  AssetKind,
  AssetViewMode,
  AppUpdateState,
  SelectionKeyAxis,
  SortDir,
  SortField,
  ThumbnailFormat,
  ThumbnailGenerationState,
  ThumbnailQuality,
  ThumbnailState,
} from './types/library'

const THUMBNAIL_PRESETS: Record<
  ThumbnailQuality,
  {
    encoderQuality: number
    maxEdge: number
    smoothing: ImageSmoothingQuality
  }
> = {
  compact: { encoderQuality: 0.56, maxEdge: 160, smoothing: 'medium' },
  standard: { encoderQuality: 0.68, maxEdge: 240, smoothing: 'high' },
  high: { encoderQuality: 0.78, maxEdge: 360, smoothing: 'high' },
}

type EncodedThumbnail = {
  format: ThumbnailFormat
  height: number
  path?: string
  sizeKb: number
  url: string
  width: number
}

type NativeScannedAsset = Omit<Asset, 'kind'> & {
  kind: AssetKind
}

type ScanLibraryResponse = {
  assets: NativeScannedAsset[]
  libraryName: string
  rootPath: string
}

type NativeThumbnailResult = {
  format: ThumbnailFormat
  height: number
  path: string
  sizeKb: number
  width: number
}

function blurActiveElement() {
  const activeElement = document.activeElement
  if (activeElement instanceof HTMLElement) activeElement.blur()
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getVisualAssetIds(assets: Asset[]) {
  const fallbackIds = assets.map((asset) => asset.id)
  const items = Array.from(document.querySelectorAll<HTMLElement>('.assets-scroll .asset-item[data-asset-id]'))
  if (items.length === 0) return fallbackIds

  const assetIdSet = new Set(fallbackIds)
  const rowSnap = 14
  const visualIds = items
    .map((item, index) => {
      const box = item.getBoundingClientRect()

      return {
        id: item.dataset.assetId ?? '',
        index,
        left: box.left,
        top: Math.round(box.top / rowSnap) * rowSnap,
      }
    })
    .filter((item) => item.id && assetIdSet.has(item.id))
    .sort((a, b) => a.top - b.top || a.left - b.left || a.index - b.index)
    .map((item) => item.id)

  return visualIds.length === fallbackIds.length ? visualIds : fallbackIds
}

function loadPreviewImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image()

    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片无法解码'))
    image.src = url
  })
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function getThumbnailDimensions(image: HTMLImageElement, quality: ThumbnailQuality) {
  const preset = THUMBNAIL_PRESETS[quality]
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  const scale = Math.min(1, preset.maxEdge / Math.max(sourceWidth, sourceHeight))

  return {
    height: Math.max(1, Math.round(sourceHeight * scale)),
    width: Math.max(1, Math.round(sourceWidth * scale)),
  }
}

function drawDownscaledImage(image: HTMLImageElement, quality: ThumbnailQuality) {
  const preset = THUMBNAIL_PRESETS[quality]
  const target = getThumbnailDimensions(image, quality)
  let source: CanvasImageSource = image
  let sourceWidth = image.naturalWidth || image.width
  let sourceHeight = image.naturalHeight || image.height

  while (sourceWidth * 0.5 > target.width && sourceHeight * 0.5 > target.height) {
    const stepWidth = Math.max(target.width, Math.round(sourceWidth * 0.5))
    const stepHeight = Math.max(target.height, Math.round(sourceHeight * 0.5))
    const stepCanvas = createCanvas(stepWidth, stepHeight)
    const stepContext = stepCanvas.getContext('2d')

    if (!stepContext) break

    stepContext.imageSmoothingEnabled = true
    stepContext.imageSmoothingQuality = preset.smoothing
    stepContext.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, stepWidth, stepHeight)
    source = stepCanvas
    sourceWidth = stepWidth
    sourceHeight = stepHeight
  }

  const canvas = createCanvas(target.width, target.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建缩略图画布')

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = preset.smoothing
  context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, target.width, target.height)
  return canvas
}

function encodeCanvas(canvas: HTMLCanvasElement, mimeType: string, quality?: number) {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality)
  })
}

function getThumbnailFormat(blob: Blob): ThumbnailFormat {
  if (blob.type === 'image/webp') return 'webp'
  if (blob.type === 'image/jpeg') return 'jpeg'
  return 'png'
}

function withCacheToken(url: string, token: string) {
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(token)}`
}

async function encodeOptimizedThumbnail(canvas: HTMLCanvasElement, asset: Asset, quality: ThumbnailQuality) {
  const preset = THUMBNAIL_PRESETS[quality]
  const candidates = ['image/webp', asset.kind === 'jpg' ? 'image/jpeg' : 'image/png']
  const blobs = (
    await Promise.all(
      candidates.map(async (mimeType) => {
        const blob = await encodeCanvas(canvas, mimeType, mimeType === 'image/png' ? undefined : preset.encoderQuality)
        return blob && blob.size > 0 ? blob : null
      }),
    )
  ).filter((blob): blob is Blob => Boolean(blob))

  if (blobs.length === 0) throw new Error('缩略图编码失败')

  return blobs.reduce((best, blob) => (blob.size < best.size ? blob : best), blobs[0])
}

async function createOptimizedThumbnail(asset: Asset, quality: ThumbnailQuality): Promise<EncodedThumbnail> {
  if (!asset.previewUrl) throw new Error('缺少图片源')

  const image = await loadPreviewImage(asset.previewUrl)
  const canvas = drawDownscaledImage(image, quality)
  const blob = await encodeOptimizedThumbnail(canvas, asset, quality)

  return {
    format: getThumbnailFormat(blob),
    height: canvas.height,
    sizeKb: Math.max(1, Math.ceil(blob.size / 1024)),
    url: URL.createObjectURL(blob),
    width: canvas.width,
  }
}

async function createNativeThumbnail(
  libraryRootPath: string,
  asset: Asset,
  quality: ThumbnailQuality,
  token: string,
): Promise<EncodedThumbnail> {
  if (!asset.sourcePath) throw new Error('缺少本地文件路径')

  const result = await invoke<NativeThumbnailResult>('generate_thumbnail', {
    libraryRoot: libraryRootPath,
    quality,
    source: {
      id: asset.id,
      kind: asset.kind,
      relativePath: asset.relativePath,
      sourcePath: asset.sourcePath,
    },
  })

  return {
    format: result.format,
    height: result.height,
    path: result.path,
    sizeKb: result.sizeKb,
    url: withCacheToken(convertFileSrc(result.path), token),
    width: result.width,
  }
}

export default function App() {
  const folderInputRef = useRef<HTMLInputElement>(null)
  const libraryAssetsRef = useRef<Asset[]>(sampleAssets)
  const thumbnailRunRef = useRef(0)

  const [activeFolder, setActiveFolder] = useState('/')
  const [activeTag, setActiveTag] = useState('all')
  const [cacheLimit, setCacheLimit] = useState(5)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [libraryAssets, setLibraryAssets] = useState<Asset[]>(sampleAssets)
  const [libraryName, setLibraryName] = useState('DesignAssets')
  const [libraryRootPath, setLibraryRootPath] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [primaryId, setPrimaryId] = useState<string | null>(sampleAssets[0].id)
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set([sampleAssets[0].id]))
  const [selectionKeyAxis, setSelectionKeyAxis] = useState<SelectionKeyAxis>('horizontal')
  const [keyboardScrollTargetId, setKeyboardScrollTargetId] = useState<string | null>(null)
  const [keyboardScrollVersion, setKeyboardScrollVersion] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(218)
  const [inspectorVisible, setInspectorVisible] = useState(true)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortOpen, setSortOpen] = useState(false)
  const [statusMessage, setStatusMessage] = useState('示例资源库已加载')
  const [thumbnailGeneration, setThumbnailGeneration] = useState<ThumbnailGenerationState>({
    completed: 0,
    failed: 0,
    quality: 'standard',
    scopeLabel: '',
    status: 'idle',
    total: 0,
  })
  const [thumbnailQuality, setThumbnailQuality] = useState<ThumbnailQuality>('standard')
  const [thumbnailState, setThumbnailState] = useState<ThumbnailState>('all')
  const [thumbSize, setThumbSize] = useState(150)
  const [typeFilter, setTypeFilter] = useState<'all' | AssetKind>('all')
  const [updateState, setUpdateState] = useState<AppUpdateState>({
    message: '从 GitHub Releases 检查 Picman 测试版更新。',
    status: 'idle',
  })
  const [viewMode, setViewMode] = useState<AssetViewMode>('adaptive')

  const allTags = useMemo(
    () => Array.from(new Set(libraryAssets.flatMap((asset) => asset.tags))).sort(),
    [libraryAssets],
  )
  const folders = useMemo(() => buildFolders(libraryName, libraryAssets), [libraryAssets, libraryName])
  const thumbnailFolders = useMemo(() => {
    const counts = new Map<string, number>()

    for (const asset of libraryAssets) counts.set(asset.folder, (counts.get(asset.folder) ?? 0) + 1)

    return Array.from(counts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, count]) => ({ path, name: folderName(path, libraryName), count }))
  }, [libraryAssets, libraryName])

  const visibleAssets = useMemo(() => {
    const searchQuery = normalizeSearchText(query).trim()
    const filtered = libraryAssets.filter((asset) => {
      const inFolder = activeFolder === '/' || asset.folder === activeFolder
      const inTag = activeTag === 'all' || asset.tags.includes(activeTag)
      const inType = typeFilter === 'all' || asset.kind === typeFilter
      const inThumb =
        thumbnailState === 'all' ||
        (thumbnailState === 'generated' && asset.thumbnailReady) ||
        (thumbnailState === 'pending' && !asset.thumbnailReady)
      const text = `${asset.name} ${asset.folder} ${asset.relativePath} ${asset.tags.join(' ')} ${asset.note}`

      return inFolder && inTag && inType && inThumb && normalizeSearchText(text).includes(searchQuery)
    })

    return sortAssets(filtered, sortField, sortDir)
  }, [activeFolder, activeTag, libraryAssets, query, sortDir, sortField, thumbnailState, typeFilter])

  const visibleIdSet = useMemo(() => new Set(visibleAssets.map((asset) => asset.id)), [visibleAssets])
  const visibleSelectedIds = useMemo(
    () => new Set([...selectedIds].filter((id) => visibleIdSet.has(id))),
    [selectedIds, visibleIdSet],
  )
  const primaryAsset = primaryId ? visibleAssets.find((asset) => asset.id === primaryId) : undefined
  const lightboxIndex = primaryId ? visibleAssets.findIndex((asset) => asset.id === primaryId) : -1
  const generatedCount = libraryAssets.filter((asset) => asset.thumbnailReady).length
  const pendingCount = libraryAssets.length - generatedCount
  const sourceSize = libraryAssets.reduce((total, asset) => total + asset.sizeKb, 0)
  const cacheSize = libraryAssets.reduce((total, asset) => {
    if (!asset.thumbnailReady) return total

    return total + (asset.thumbnailSizeKb ?? 0)
  }, 0)
  const activeFilterCount =
    Number(activeTag !== 'all') +
    Number(typeFilter !== 'all') +
    Number(thumbnailState !== 'all') +
    Number(query.trim().length > 0)
  const breadcrumb =
    activeFolder === '/' ? libraryName : (activeFolder.split('/').filter(Boolean).at(-1) ?? libraryName)

  useEffect(() => {
    libraryAssetsRef.current = libraryAssets
  }, [libraryAssets])

  useEffect(() => {
    return () => revokePreviewUrls(libraryAssetsRef.current)
  }, [])

  useEffect(() => {
    if (!sortOpen) return

    const handler = (event: globalThis.MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.sort-btn-wrap')) setSortOpen(false)
    }

    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [sortOpen])

  const navigateLightbox = useCallback(
    (dir: 'prev' | 'next') => {
      if (visibleAssets.length === 0) return

      const currentIndex = visibleAssets.findIndex((asset) => asset.id === primaryId)
      const current = currentIndex === -1 ? 0 : currentIndex
      const nextIndex =
        dir === 'prev' ? Math.max(0, current - 1) : Math.min(visibleAssets.length - 1, current + 1)
      const nextAsset = visibleAssets[nextIndex]

      setPrimaryId(nextAsset.id)
      setSelectedIds(new Set([nextAsset.id]))
      blurActiveElement()
    },
    [primaryId, visibleAssets],
  )

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const tag = (event.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        const ids = visibleAssets.map((asset) => asset.id)
        setSelectedIds(new Set(ids))
        setPrimaryId(ids[0] ?? null)
        event.preventDefault()
        return
      }

      if (lightboxOpen) {
        if (event.key === 'Escape' || event.key === ' ') {
          setLightboxOpen(false)
          blurActiveElement()
          event.preventDefault()
        } else if (event.key === 'ArrowLeft') {
          navigateLightbox('prev')
          event.preventDefault()
        } else if (event.key === 'ArrowRight') {
          navigateLightbox('next')
          event.preventDefault()
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
        }
        return
      }

      const isArrowKey =
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight' ||
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown'
      const isSelectionKey =
        selectionKeyAxis === 'horizontal'
          ? event.key === 'ArrowLeft' || event.key === 'ArrowRight'
          : event.key === 'ArrowUp' || event.key === 'ArrowDown'

      if (isArrowKey && !isSelectionKey) {
        event.preventDefault()
        return
      }

      if (event.key === 'Escape') {
        setSelectedIds(new Set())
        setPrimaryId(null)
        blurActiveElement()
        event.preventDefault()
        return
      }

      if (isSelectionKey) {
        if (visibleAssets.length === 0) return

        const visualIds = getVisualAssetIds(visibleAssets)
        const currentIndex = primaryId ? visualIds.indexOf(primaryId) : -1
        const isPrevKey = selectionKeyAxis === 'horizontal' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp'

        const nextIndex =
          currentIndex === -1
            ? 0
            : isPrevKey
            ? Math.max(0, currentIndex - 1)
            : Math.min(visualIds.length - 1, currentIndex + 1)
        const nextId = visualIds[nextIndex]
        const nextAsset = visibleAssets.find((asset) => asset.id === nextId) ?? visibleAssets[nextIndex]

        setSelectedIds(new Set([nextAsset.id]))
        setPrimaryId(nextAsset.id)
        setKeyboardScrollTargetId(nextAsset.id)
        setKeyboardScrollVersion((version) => version + 1)
        blurActiveElement()
        event.preventDefault()
      } else if (event.key === ' ' && visibleAssets.length > 0) {
        if (!primaryAsset) {
          setPrimaryId(visibleAssets[0].id)
          setSelectedIds(new Set([visibleAssets[0].id]))
        }
        setLightboxOpen(true)
        event.preventDefault()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightboxOpen, navigateLightbox, primaryAsset, primaryId, selectionKeyAxis, visibleAssets])

  function handleAssetClick(asset: Asset, event: MouseEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(visibleSelectedIds)
      if (next.has(asset.id)) {
        next.delete(asset.id)
        setPrimaryId(next.has(primaryId ?? '') ? primaryId : (Array.from(next).at(-1) ?? null))
      } else {
        next.add(asset.id)
        setPrimaryId(asset.id)
      }
      setSelectedIds(next)
    } else if (event.shiftKey) {
      const ids = visibleAssets.map((visibleAsset) => visibleAsset.id)
      const startIndex = primaryId ? ids.indexOf(primaryId) : -1
      const endIndex = ids.indexOf(asset.id)
      const safeStart = startIndex === -1 ? endIndex : startIndex
      const [from, to] = safeStart <= endIndex ? [safeStart, endIndex] : [endIndex, safeStart]

      setSelectedIds(new Set(ids.slice(from, to + 1)))
      setPrimaryId(asset.id)
    } else {
      setSelectedIds(new Set([asset.id]))
      setPrimaryId(asset.id)
    }
  }

  function handleAssetDoubleClick(asset: Asset) {
    setPrimaryId(asset.id)
    setSelectedIds(new Set([asset.id]))
    setLightboxOpen(true)
  }

  async function handleNativeFolderSelection(rootPath: string) {
    const scanned = await invoke<ScanLibraryResponse>('scan_library_folder', { rootPath })
    const assets = scanned.assets.map((asset) => ({
      ...asset,
      previewUrl: asset.sourcePath ? convertFileSrc(asset.sourcePath) : asset.previewUrl,
      thumbnailReady: false,
    }))
    const first = assets[0]

    thumbnailRunRef.current += 1
    setLibraryAssets((current) => {
      revokePreviewUrls(current)
      return assets
    })
    setLibraryRootPath(scanned.rootPath)
    setLibraryName(scanned.libraryName)
    setActiveFolder('/')
    setActiveTag('all')
    setTypeFilter('all')
    setThumbnailState('all')
    setThumbnailGeneration({
      completed: 0,
      failed: 0,
      quality: thumbnailQuality,
      scopeLabel: '',
      status: 'idle',
      total: 0,
    })
    setSettingsOpen(false)
    setStatusMessage(`${scanned.libraryName} · ${assets.length} 个素材`)

    if (first) {
      setSelectedIds(new Set([first.id]))
      setPrimaryId(first.id)
    } else {
      setSelectedIds(new Set())
      setPrimaryId(null)
    }
  }

  async function openLibraryFolder() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        recursive: true,
        title: '选择 Picman 资源目录',
      })

      if (typeof selected === 'string') {
        await handleNativeFolderSelection(selected)
        return
      }
    } catch {
      // Browser fallback below keeps local Vite previews usable.
    }

    folderInputRef.current?.click()
  }

  async function handleFolderSelection(files: FileList | null) {
    if (!files?.length) return

    const scanned = await scanFiles(files)
    const nextLibraryName = files[0].webkitRelativePath?.split('/')[0] || 'Local Library'
    const first = scanned[0]
    thumbnailRunRef.current += 1

    setLibraryAssets((current) => {
      revokePreviewUrls(current)
      return scanned
    })
    setLibraryRootPath(null)
    setLibraryName(nextLibraryName)
    setActiveFolder('/')
    setActiveTag('all')
    setTypeFilter('all')
    setThumbnailState('all')
    setThumbnailGeneration({
      completed: 0,
      failed: 0,
      quality: thumbnailQuality,
      scopeLabel: '',
      status: 'idle',
      total: 0,
    })
    setSettingsOpen(false)
    setStatusMessage(`${nextLibraryName} · ${scanned.length} 个素材`)

    if (first) {
      setSelectedIds(new Set([first.id]))
      setPrimaryId(first.id)
    } else {
      setSelectedIds(new Set())
      setPrimaryId(null)
    }
  }

  async function refreshLibrary() {
    if (!libraryRootPath) {
      setStatusMessage('请先打开本地资源目录后再刷新')
      return
    }

    try {
      const scanned = await invoke<ScanLibraryResponse>('scan_library_folder', {
        rootPath: libraryRootPath,
      })
      const previousById = new Map(libraryAssetsRef.current.map((asset) => [asset.id, asset]))
      const previousSourcePaths = new Set(
        libraryAssetsRef.current.map((asset) => asset.sourcePath).filter((path): path is string => Boolean(path)),
      )
      const previousPrimaryId = primaryId
      const previousSelectedIds = selectedIds

      const merged = scanned.assets.map((asset) => {
        const previous = previousById.get(asset.id)
        const previewUrl = asset.sourcePath ? convertFileSrc(asset.sourcePath) : asset.previewUrl

        if (previous?.thumbnailReady) {
          return {
            ...asset,
            previewUrl,
            thumbnailError: previous.thumbnailError,
            thumbnailFormat: previous.thumbnailFormat,
            thumbnailHeight: previous.thumbnailHeight,
            thumbnailPath: previous.thumbnailPath,
            thumbnailQuality: previous.thumbnailQuality,
            thumbnailReady: true,
            thumbnailSizeKb: previous.thumbnailSizeKb,
            thumbnailUrl: previous.thumbnailUrl,
            thumbnailVersion: previous.thumbnailVersion,
            thumbnailWidth: previous.thumbnailWidth,
          }
        }

        return {
          ...asset,
          previewUrl,
          thumbnailReady: false,
        }
      })
      const mergedSourcePaths = new Set(
        merged.map((asset) => asset.sourcePath).filter((path): path is string => Boolean(path)),
      )
      const mergedIdSet = new Set(merged.map((asset) => asset.id))

      // Only revoke blob URLs for assets that are gone, so existing previews don't flicker.
      revokePreviewUrls(
        libraryAssetsRef.current.filter(
          (asset) => asset.sourcePath && !mergedSourcePaths.has(asset.sourcePath),
        ),
      )

      const added = merged.filter((asset) => asset.sourcePath && !previousSourcePaths.has(asset.sourcePath)).length
      const removed = libraryAssetsRef.current.filter(
        (asset) => asset.sourcePath && !mergedSourcePaths.has(asset.sourcePath),
      ).length

      setLibraryAssets(merged)
      setLibraryName(scanned.libraryName)

      const survivingSelectedIds = new Set([...previousSelectedIds].filter((id) => mergedIdSet.has(id)))
      if (survivingSelectedIds.size === 0 && merged.length > 0) {
        setSelectedIds(new Set([merged[0].id]))
        setPrimaryId(merged[0].id)
      } else {
        setSelectedIds(survivingSelectedIds)
        setPrimaryId(previousPrimaryId && mergedIdSet.has(previousPrimaryId) ? previousPrimaryId : null)
      }

      const summary =
        added === 0 && removed === 0
          ? `已刷新 · ${merged.length} 个素材`
          : `已刷新 · ${merged.length} 个素材（新增 ${added} · 移除 ${removed}）`
      setStatusMessage(summary)
    } catch (error) {
      const message = error instanceof Error ? error.message : '刷新失败'
      setStatusMessage(`刷新失败：${message}`)
    }
  }

  async function generateThumbnailAssets(targetAssets: Asset[], scopeLabel: string) {
    if (targetAssets.length === 0) {
      setStatusMessage(`${scopeLabel} 中没有可生成缩略图的素材`)
      return
    }

    const runId = thumbnailRunRef.current + 1
    thumbnailRunRef.current = runId
    const quality = thumbnailQuality
    const targetIds = new Set(targetAssets.map((asset) => asset.id))
    const firstName = targetAssets[0]?.name
    let failedCount = 0

    revokeThumbnailUrls(libraryAssetsRef.current.filter((asset) => targetIds.has(asset.id)))
    setLibraryAssets((current) =>
      current.map((asset) => {
        if (!targetIds.has(asset.id)) return asset

        return {
          ...asset,
          thumbnailError: undefined,
          thumbnailFormat: undefined,
          thumbnailHeight: undefined,
          thumbnailQuality: undefined,
          thumbnailReady: false,
          thumbnailSizeKb: undefined,
          thumbnailUrl: undefined,
          thumbnailWidth: undefined,
        }
      }),
    )
    setThumbnailGeneration({
      completed: 0,
      currentName: firstName,
      failed: 0,
      quality,
      scopeLabel,
      status: 'running',
      total: targetAssets.length,
    })
    setStatusMessage(`正在生成缩略图：${scopeLabel}`)

    for (let index = 0; index < targetAssets.length; index += 1) {
      const asset = targetAssets[index]
      let thumbnail: EncodedThumbnail | undefined
      let thumbnailError: string | undefined

      try {
        const token = `${runId}-${index}-${Date.now()}`
        thumbnail =
          libraryRootPath && asset.sourcePath
            ? await createNativeThumbnail(libraryRootPath, asset, quality, token)
            : await createOptimizedThumbnail(asset, quality)
      } catch (error) {
        failedCount += 1
        thumbnailError = error instanceof Error ? error.message : '缩略图生成失败'
      }

      if (thumbnailRunRef.current !== runId) {
        if (thumbnail?.url.startsWith('blob:')) URL.revokeObjectURL(thumbnail.url)
        return
      }

      setLibraryAssets((current) =>
        current.map((currentAsset) => {
          if (currentAsset.id !== asset.id) return currentAsset

          return {
            ...currentAsset,
            thumbnailError,
            thumbnailFormat: thumbnail?.format,
            thumbnailHeight: thumbnail?.height,
            thumbnailPath: thumbnail?.path,
            thumbnailQuality: quality,
            thumbnailReady: Boolean(thumbnail),
            thumbnailSizeKb: thumbnail?.sizeKb,
            thumbnailUrl: thumbnail?.url,
            thumbnailVersion: thumbnail ? `${runId}-${index}` : undefined,
            thumbnailWidth: thumbnail?.width,
          }
        }),
      )
      setThumbnailGeneration({
        completed: index + 1,
        currentName: targetAssets[index + 1]?.name ?? asset.name,
        failed: failedCount,
        quality,
        scopeLabel,
        status: 'running',
        total: targetAssets.length,
      })
    }

    if (thumbnailRunRef.current !== runId) return

    setThumbnailGeneration({
      completed: targetAssets.length,
      failed: failedCount,
      quality,
      scopeLabel,
      status: 'completed',
      total: targetAssets.length,
    })
    setStatusMessage(
      failedCount > 0
        ? `缩略图已生成：${scopeLabel} · 失败 ${failedCount} 个`
        : `缩略图已生成：${scopeLabel} · ${targetAssets.length} 个素材`,
    )
  }

  function generateAllThumbnails() {
    void generateThumbnailAssets(libraryAssets, '全部素材')
  }

  function generateFolderThumbnails(folderPaths: string[]) {
    const selectedFolders = new Set(folderPaths)
    const selectedAssets = libraryAssets.filter((asset) => selectedFolders.has(asset.folder))
    const label =
      folderPaths.length === 1
        ? folderName(folderPaths[0], libraryName)
        : `${folderPaths.length} 个文件夹`

    void generateThumbnailAssets(selectedAssets, label)
  }

  function clearThumbnailCache() {
    thumbnailRunRef.current += 1
    revokeThumbnailUrls(libraryAssetsRef.current)
    if (libraryRootPath) {
      void invoke('clear_thumbnail_cache', { libraryRoot: libraryRootPath }).catch(() => undefined)
    }
    setLibraryAssets((current) =>
      current.map((asset) => ({
        ...asset,
        thumbnailError: undefined,
        thumbnailFormat: undefined,
        thumbnailHeight: undefined,
        thumbnailPath: undefined,
        thumbnailQuality: undefined,
        thumbnailReady: false,
        thumbnailSizeKb: undefined,
        thumbnailUrl: undefined,
        thumbnailVersion: undefined,
        thumbnailWidth: undefined,
      })),
    )
    setThumbnailGeneration({
      completed: 0,
      failed: 0,
      quality: thumbnailQuality,
      scopeLabel: '',
      status: 'idle',
      total: 0,
    })
    setStatusMessage('已清理缩略图缓存')
  }

  async function checkAndInstallUpdate() {
    setUpdateState({
      message: '正在连接 GitHub Releases...',
      progress: 0,
      status: 'checking',
    })

    try {
      const update = await check({ timeout: 30000 })

      if (!update) {
        setUpdateState({
          message: '当前已经是最新版本。',
          status: 'none',
        })
        return
      }

      let downloaded = 0
      let contentLength = 0

      setUpdateState({
        message: `发现新版本 ${update.version}，开始下载。`,
        progress: 0,
        status: 'available',
        version: update.version,
      })

      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          contentLength = event.data.contentLength ?? 0
          downloaded = 0
          setUpdateState({
            message: `正在下载 ${update.version}。`,
            progress: 0,
            status: 'downloading',
            version: update.version,
          })
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength
          const progress = contentLength > 0 ? Math.min(99, Math.round((downloaded / contentLength) * 100)) : undefined
          setUpdateState({
            message: progress === undefined ? '正在下载更新包。' : `正在下载更新包：${progress}%`,
            progress,
            status: 'downloading',
            version: update.version,
          })
        } else if (event.event === 'Finished') {
          setUpdateState({
            message: '下载完成，正在安装更新。',
            progress: 100,
            status: 'installing',
            version: update.version,
          })
        }
      })

      setUpdateState({
        message: '更新已安装，正在重启 Picman。',
        progress: 100,
        status: 'restarting',
        version: update.version,
      })
      await relaunch()
    } catch (error) {
      setUpdateState({
        message: error instanceof Error ? `更新失败：${error.message}` : '更新失败，请检查 GitHub Release 配置。',
        status: 'error',
      })
    }
  }

  function addAssetTag(assetId: string, rawTag: string) {
    const tag = rawTag.trim().replace(/\s+/g, ' ')
    if (!tag) return

    const target = libraryAssets.find((asset) => asset.id === assetId)
    if (!target || target.tags.includes(tag)) {
      setStatusMessage(`标签已存在：${tag}`)
      return
    }

    setLibraryAssets((current) =>
      current.map((asset) => {
        return asset.id === assetId ? { ...asset, tags: [...asset.tags, tag] } : asset
      }),
    )
    setStatusMessage(`已添加标签：${tag}`)
  }

  function removeAssetTag(assetId: string, tag: string) {
    const target = libraryAssets.find((asset) => asset.id === assetId)
    if (!target?.tags.includes(tag)) return

    const tagStillUsed = libraryAssets.some((asset) => asset.id !== assetId && asset.tags.includes(tag))
    setLibraryAssets((current) =>
      current.map((asset) => {
        return asset.id === assetId
          ? { ...asset, tags: asset.tags.filter((assetTag) => assetTag !== tag) }
          : asset
      }),
    )
    if (activeTag === tag && !tagStillUsed) setActiveTag('all')
    setStatusMessage(`已移除标签：${tag}`)
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()

    const startX = event.clientX
    const startWidth = sidebarWidth

    document.body.classList.add('is-resizing-col')

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setSidebarWidth(clamp(startWidth + moveEvent.clientX - startX, 176, 340))
    }

    const stopResize = () => {
      document.body.classList.remove('is-resizing-col')
      window.removeEventListener('pointermove', handlePointerMove)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize, { once: true })
  }

  return (
    <div className="app-shell">
      <input
        ref={folderInputRef}
        className="hidden-input"
        multiple
        onChange={(event) => handleFolderSelection(event.target.files)}
        type="file"
        {...{ directory: '', webkitdirectory: '' }}
      />

        <TopBar
          inspectorVisible={inspectorVisible}
          settingsOpen={settingsOpen}
          onToggleInspector={() => setInspectorVisible((visible) => !visible)}
          onToggleSettings={() => setSettingsOpen((open) => !open)}
      />

      <div className="main-area" style={{ gridTemplateColumns: `${sidebarWidth}px 5px minmax(0, 1fr)` }}>
        <Sidebar
          activeFolder={activeFolder}
          activeTag={activeTag}
          allTags={allTags}
          folders={folders}
          libraryName={libraryName}
          onSetActiveFolder={setActiveFolder}
          onSetActiveTag={setActiveTag}
        />

        <div
          aria-label="调整左侧栏宽度"
          aria-orientation="vertical"
          className="sidebar-col-resizer"
          role="separator"
          onPointerDown={startSidebarResize}
        />

        <div className="workspace">
          <LibraryView
            activeTag={activeTag}
            activeFilterCount={activeFilterCount}
            allTags={allTags}
            breadcrumb={breadcrumb}
            filtersOpen={filtersOpen}
            inspectorVisible={inspectorVisible}
            keyboardScrollTargetId={keyboardScrollTargetId}
            keyboardScrollVersion={keyboardScrollVersion}
            primaryAsset={primaryAsset}
            query={query}
            selectedIds={visibleSelectedIds}
            sortDir={sortDir}
            sortField={sortField}
            sortOpen={sortOpen}
            statusMessage={statusMessage}
            thumbnailState={thumbnailState}
            thumbSize={thumbSize}
            typeFilter={typeFilter}
            viewMode={viewMode}
            visibleAssets={visibleAssets}
            onAddAssetTag={addAssetTag}
            onAssetClick={handleAssetClick}
            onAssetDoubleClick={handleAssetDoubleClick}
            onOpenFolder={openLibraryFolder}
            onRefresh={refreshLibrary}
            onRemoveAssetTag={removeAssetTag}
            onSetActiveTag={setActiveTag}
            onSetFiltersOpen={setFiltersOpen}
            onSetQuery={setQuery}
            onSetSortDir={setSortDir}
            onSetSortField={setSortField}
            onSetSortOpen={setSortOpen}
            onSetThumbnailState={setThumbnailState}
            onSetThumbSize={setThumbSize}
            onSetTypeFilter={setTypeFilter}
            onSetViewMode={setViewMode}
          />
        </div>
      </div>

      {settingsOpen && (
        <SettingsPanel
          cacheLimit={cacheLimit}
          cacheSize={cacheSize}
          folders={thumbnailFolders}
          generatedCount={generatedCount}
          libraryName={libraryName}
          pendingCount={pendingCount}
          selectionKeyAxis={selectionKeyAxis}
          sourceSize={sourceSize}
          thumbnailGeneration={thumbnailGeneration}
          thumbnailQuality={thumbnailQuality}
          updateState={updateState}
          onCheckForUpdate={checkAndInstallUpdate}
          onClose={() => setSettingsOpen(false)}
          onClearThumbnailCache={clearThumbnailCache}
          onGenerateAllThumbnails={generateAllThumbnails}
          onGenerateFolderThumbnails={generateFolderThumbnails}
          onOpenFolder={openLibraryFolder}
          onSetCacheLimit={setCacheLimit}
          onSetSelectionKeyAxis={setSelectionKeyAxis}
          onSetThumbnailQuality={setThumbnailQuality}
        />
      )}

      {lightboxOpen && primaryAsset && (
        <Lightbox
          asset={primaryAsset}
          hasNext={lightboxIndex < visibleAssets.length - 1}
          hasPrev={lightboxIndex > 0}
          index={lightboxIndex}
          total={visibleAssets.length}
          onClose={() => setLightboxOpen(false)}
          onNext={() => navigateLightbox('next')}
          onPrev={() => navigateLightbox('prev')}
        />
      )}
    </div>
  )
}
