import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { confirm as tauriConfirm, open } from '@tauri-apps/plugin-dialog'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
import type { MouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import './App.css'
import { BatchModal } from './components/BatchModal'
import type { BatchOptions } from './components/BatchModal'
import { CollectOverlay } from './components/CollectOverlay'
import { Lightbox } from './components/Lightbox'
import { LibraryView } from './components/LibraryView'
import { OcrModal } from './components/OcrModal'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { TrashView } from './components/TrashView'
import { assets as sampleAssets } from './data/mockLibrary'
import { dataTransferHasImage, extractImagePayload } from './lib/collect'
import type { CollectPayload } from './lib/collect'
import { formatMb } from './lib/format'
import { folderName, revokePreviewUrls, revokeThumbnailUrls, scanFilesInBatches } from './lib/library'
import { imageUrlToJpegDataUri, recognizeText } from './lib/ocr'
import { createAssetSearchText, normalizeSearchText, withAssetSearchText } from './lib/search'
import { eventToShortcut } from './lib/shortcut'
import { sortAssets } from './lib/sort'
import type {
  Asset,
  AssetKind,
  AssetViewMode,
  AppUpdateState,
  FolderNode,
  SelectionKeyAxis,
  SortDir,
  SortField,
  ThemePref,
  ThumbnailFormat,
  ThumbnailGenerationState,
  ThumbnailQuality,
  ThumbnailState,
  TrashItem,
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

const SCAN_BATCH_EVENT = 'picman-library-scan-batch'
const SCAN_ERROR_EVENT = 'picman-library-scan-error'
const SCAN_FINISHED_EVENT = 'picman-library-scan-finished'
const THUMBNAIL_BATCH_EVENT = 'picman-thumbnail-batch'
const THUMBNAIL_FINISHED_EVENT = 'picman-thumbnail-finished'
const THUMBNAIL_UPDATE_FLUSH_MS = 180
const THUMBNAIL_UPDATE_FLUSH_THRESHOLD = 256

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

type ScanLibraryStartResponse = {
  libraryName: string
  rootPath: string
}

type ScanLibraryBatchPayload = {
  assets: NativeScannedAsset[]
  scanId: string
  total: number
}

type ScanLibraryFinishedPayload = {
  libraryName: string
  rootPath: string
  scanId: string
  total: number
}

type ScanLibraryErrorPayload = {
  message: string
  scanId: string
}

type NativeThumbnailResult = {
  format: ThumbnailFormat
  height: number
  path: string
  sizeKb: number
  width: number
}

type NativeThumbnailJobStartResponse = {
  jobId: string
  total: number
}

type NativeThumbnailUpdate = {
  assetId: string
  error?: string | null
  format?: ThumbnailFormat | null
  height?: number | null
  path?: string | null
  sizeKb?: number | null
  width?: number | null
}

type NativeThumbnailBatchPayload = {
  completed: number
  currentName?: string | null
  failed: number
  jobId: string
  total: number
  updates: NativeThumbnailUpdate[]
}

type NativeThumbnailFinishedPayload = {
  cancelled: boolean
  completed: number
  failed: number
  jobId: string
  total: number
}

type NativeScanMode = 'open' | 'refresh'

type ActiveNativeScan = {
  collectedAssets: Asset[]
  firstSelected: boolean
  flushTimer?: number
  id: string
  libraryName: string
  mode: NativeScanMode
  pendingAssets: Asset[]
}

type RefreshMergeResult = {
  added: number
  assets: Asset[]
  idSet: Set<string>
  removed: number
  removedAssets: Asset[]
}

type NativeThumbnailProgressSnapshot = {
  completed: number
  currentName?: string
  failed: number
  total: number
}

type ActiveNativeThumbnailJob = {
  flushTimer?: number
  id: string
  pendingUpdates: Map<string, Partial<Asset>>
  progress: NativeThumbnailProgressSnapshot
  quality: ThumbnailQuality
  scopeLabel: string
  total: number
}

type LibraryScanStatus = 'idle' | 'open' | 'refresh'

type FolderAssetMetadataPayload = {
  favorite: boolean
  note: string
  tags: string[]
}

type LibraryCatalogState = {
  allTags: string[]
  folders: FolderNode[]
  sourceSize: number
  thumbnailFolders: FolderNode[]
}

type ThumbnailMetrics = {
  cacheSize: number
  generatedCount: number
}

type LibrarySettings = {
  folderOrder: string[]
}

const BATCH_PROCESSABLE_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>(['png', 'jpg', 'webp'])

type BatchProcessResult = {
  processed: { previousRelativePath: string; previousSizeKb: number; asset: NativeScannedAsset }[]
  failed: number
}

type AssetStore = {
  byId: Map<string, Asset>
  version: number
}

const LARGE_SCAN_SORT_THRESHOLD = 2000

function createAssetMap(assets: Asset[]): Map<string, Asset> {
  const assetMap = new Map<string, Asset>()
  for (const asset of assets) assetMap.set(asset.id, asset)
  return assetMap
}

function createAssetIndexMap(assets: Asset[]): Map<string, number> {
  const indexById = new Map<string, number>()
  for (let index = 0; index < assets.length; index += 1) {
    indexById.set(assets[index].id, index)
  }
  return indexById
}

function appendAssetsToAssetMap(assetMap: Map<string, Asset>, incoming: Asset[]) {
  for (const asset of incoming) assetMap.set(asset.id, asset)
}

function appendAssetIndexes(indexById: Map<string, number>, startIndex: number, incoming: Asset[]) {
  for (let index = 0; index < incoming.length; index += 1) {
    indexById.set(incoming[index].id, startIndex + index)
  }
}

function applyAssetUpdatesToArray(
  assets: Asset[],
  updates: Map<string, Partial<Asset>>,
  indexById: Map<string, number>,
) {
  if (updates.size === 0) return assets

  let next: Asset[] | undefined

  for (const [assetId, update] of updates) {
    const index = indexById.get(assetId)
    if (index === undefined) continue

    next ??= assets.slice()
    next[index] = { ...next[index], ...update }
  }

  return next ?? assets
}

function applyAssetUpdatesToMap(assetMap: Map<string, Asset>, updates: Map<string, Partial<Asset>>) {
  for (const [assetId, update] of updates) {
    const asset = assetMap.get(assetId)
    if (!asset) continue

    assetMap.set(assetId, { ...asset, ...update })
  }
}

function buildThumbnailClearUpdates(assets: Asset[]) {
  const updates = new Map<string, Partial<Asset>>()

  for (const asset of assets) {
    updates.set(asset.id, {
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
    })
  }

  return updates
}

function getLiveAssets(sourceAssets: Asset[], assetById: Map<string, Asset>) {
  return sourceAssets.map((asset) => assetById.get(asset.id) ?? asset)
}

function updateAssetStore(store: AssetStore, update: (assetMap: Map<string, Asset>) => void): AssetStore {
  update(store.byId)
  return {
    byId: store.byId,
    version: store.version + 1,
  }
}

function replaceAssetStore(store: AssetStore, assets: Asset[]): AssetStore {
  return {
    byId: createAssetMap(assets),
    version: store.version + 1,
  }
}

function blurActiveElement() {
  const activeElement = document.activeElement
  if (activeElement instanceof HTMLElement) activeElement.blur()
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
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

function createScanId() {
  return `scan_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function createThumbnailJobId(runId: number) {
  return `thumb_${runId}_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function nativeAssetToFrontend(asset: NativeScannedAsset): Asset {
  const thumbnailUrl = asset.thumbnailPath
    ? withCacheToken(convertFileSrc(asset.thumbnailPath), `${asset.id}-${asset.thumbnailQuality ?? 'cache'}`)
    : undefined

  return withAssetSearchText({
    ...asset,
    previewUrl: undefined,
    thumbnailReady: Boolean(asset.thumbnailReady && asset.thumbnailPath),
    thumbnailUrl,
  })
}

function mergeRefreshedAssets(scannedAssets: Asset[], previousAssets: Asset[]): RefreshMergeResult {
  const previousById = new Map(previousAssets.map((asset) => [asset.id, asset]))
  const previousSourcePaths = new Set(
    previousAssets.map((asset) => asset.sourcePath).filter((path): path is string => Boolean(path)),
  )
  const scannedSourcePaths = new Set(
    scannedAssets.map((asset) => asset.sourcePath).filter((path): path is string => Boolean(path)),
  )
  const idSet = new Set(scannedAssets.map((asset) => asset.id))
  const assets = scannedAssets.map((asset) => {
    const previous = previousById.get(asset.id)

    if (previous?.thumbnailReady) {
      return {
        ...asset,
        previewUrl: previous.previewUrl,
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

    return asset
  })
  const removedAssets = previousAssets.filter((asset) => asset.sourcePath && !scannedSourcePaths.has(asset.sourcePath))
  const added = scannedAssets.filter((asset) => asset.sourcePath && !previousSourcePaths.has(asset.sourcePath)).length

  return {
    added,
    assets,
    idSet,
    removed: removedAssets.length,
    removedAssets,
  }
}

function libraryNameFromPath(path: string) {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.at(-1) ?? 'Local Library'
}

function deriveLibraryCatalogState(libraryName: string, assets: Asset[]): LibraryCatalogState {
  const folderCounts = new Map<string, number>()
  const tags = new Set<string>()
  let sourceSize = 0

  folderCounts.set('/', assets.length)

  for (const asset of assets) {
    folderCounts.set(asset.folder, (folderCounts.get(asset.folder) ?? 0) + 1)
    sourceSize += asset.sizeKb

    for (const tag of asset.tags) tags.add(tag)
  }

  const folderItems = Array.from(folderCounts.entries()).sort(([a], [b]) =>
    a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b),
  )

  return {
    allTags: Array.from(tags).sort(),
    folders: folderItems.map(([path, count]) => ({ path, name: folderName(path, libraryName), count })),
    sourceSize,
    thumbnailFolders: folderItems
      .filter(([path]) => path !== '/')
      .map(([path, count]) => ({ path, name: folderName(path, libraryName), count })),
  }
}

function applyFolderOrder(folders: FolderNode[], order: string[]): FolderNode[] {
  if (order.length === 0) return folders

  const rank = new Map(order.map((path, index) => [path, index]))
  const root = folders.filter((folder) => folder.path === '/')
  const children = folders
    .filter((folder) => folder.path !== '/')
    .sort((a, b) => {
      const rankA = rank.get(a.path)
      const rankB = rank.get(b.path)
      if (rankA !== undefined && rankB !== undefined) return rankA - rankB
      if (rankA !== undefined) return -1
      if (rankB !== undefined) return 1
      return 0
    })

  return [...root, ...children]
}

function deriveThumbnailMetrics(assets: Asset[]): ThumbnailMetrics {
  let cacheSize = 0
  let generatedCount = 0

  for (const asset of assets) {
    if (asset.thumbnailReady) {
      generatedCount += 1
      cacheSize += asset.thumbnailSizeKb ?? 0
    }
  }

  return {
    cacheSize,
    generatedCount,
  }
}

function addThumbnailMetrics(a: ThumbnailMetrics, b: ThumbnailMetrics): ThumbnailMetrics {
  return {
    cacheSize: a.cacheSize + b.cacheSize,
    generatedCount: a.generatedCount + b.generatedCount,
  }
}

function subtractThumbnailMetrics(a: ThumbnailMetrics, b: ThumbnailMetrics): ThumbnailMetrics {
  return {
    cacheSize: Math.max(0, a.cacheSize - b.cacheSize),
    generatedCount: Math.max(0, a.generatedCount - b.generatedCount),
  }
}

function thumbnailMetricsFromUpdates(updates: Iterable<Partial<Asset>>): ThumbnailMetrics {
  let cacheSize = 0
  let generatedCount = 0

  for (const update of updates) {
    if (update.thumbnailReady) {
      generatedCount += 1
      cacheSize += update.thumbnailSizeKb ?? 0
    }
  }

  return {
    cacheSize,
    generatedCount,
  }
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
  const activeBrowserScanRef = useRef<string | null>(null)
  const activeNativeScanRef = useRef<ActiveNativeScan | null>(null)
  const activeNativeThumbnailJobRef = useRef<ActiveNativeThumbnailJob | null>(null)
  const libraryAssetsRef = useRef<Asset[]>(sampleAssets)
  const assetByIdRef = useRef<Map<string, Asset>>(createAssetMap(sampleAssets))
  const libraryAssetIndexByIdRef = useRef<Map<string, number>>(createAssetIndexMap(sampleAssets))
  const primaryIdRef = useRef<string | null>(sampleAssets[0].id)
  const selectedIdsRef = useRef<Set<string>>(new Set([sampleAssets[0].id]))
  const thumbnailRunRef = useRef(0)
  const ocrRunRef = useRef(0)
  const runDeleteRef = useRef<() => void>(() => {})
  const visualAssetIdsRef = useRef<string[]>(sampleAssets.map((asset) => asset.id))

  const [activeFolder, setActiveFolder] = useState('/')
  const [activeTag, setActiveTag] = useState('all')
  const [cacheLimit, setCacheLimit] = useState(5)
  const [collectPending, setCollectPending] = useState<{ payload: CollectPayload; previewUrl: string } | null>(null)
  const [lastCollectFolder, setLastCollectFolder] = useState('/Inbox')
  const [folderOrder, setFolderOrder] = useState<string[]>([])
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [libraryAssets, setLibraryAssets] = useState<Asset[]>(sampleAssets)
  const [assetStore, setAssetStore] = useState<AssetStore>(() => ({
    byId: createAssetMap(sampleAssets),
    version: 0,
  }))
  const [libraryName, setLibraryName] = useState('DesignAssets')
  const [libraryRootPath, setLibraryRootPath] = useState<string | null>(null)
  const [libraryScanStatus, setLibraryScanStatus] = useState<LibraryScanStatus>('idle')
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [primaryId, setPrimaryId] = useState<string | null>(sampleAssets[0].id)
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set([sampleAssets[0].id]))
  const [selectionKeyAxis, setSelectionKeyAxis] = useState<SelectionKeyAxis>('horizontal')
  const [keyboardScrollTargetId, setKeyboardScrollTargetId] = useState<string | null>(null)
  const [keyboardScrollVersion, setKeyboardScrollVersion] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [themePref, setThemePref] = useState<ThemePref>(
    () => (localStorage.getItem('picman-theme') as ThemePref | null) ?? 'system',
  )
  const [ocrApiKey, setOcrApiKey] = useState(() => localStorage.getItem('picman-ocr-apikey') ?? '')
  const [ocrLanguage, setOcrLanguage] = useState(() => localStorage.getItem('picman-ocr-language') ?? 'chs')
  const [ocr, setOcr] = useState<{ status: 'loading' | 'done' | 'error'; text: string; error?: string } | null>(null)
  const [trashItems, setTrashItems] = useState<TrashItem[]>([])
  const [trashView, setTrashView] = useState(false)
  const [trashSelectedIds, setTrashSelectedIds] = useState<Set<string>>(() => new Set())
  const [deleteShortcut, setDeleteShortcut] = useState(
    () => localStorage.getItem('picman-delete-shortcut') ?? 'Meta+Backspace',
  )
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchProcessing, setBatchProcessing] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(218)
  const [inspectorVisible, setInspectorVisible] = useState(true)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortOpen, setSortOpen] = useState(false)
  const [statusMessage, setStatusMessage] = useState('示例资源库已加载')
  const [thumbnailMetrics, setThumbnailMetrics] = useState<ThumbnailMetrics>(() =>
    deriveThumbnailMetrics(sampleAssets),
  )
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
  const deferredQuery = useDeferredValue(query)
  const assetById = assetStore.byId
  const libraryCatalog = useMemo(
    () => deriveLibraryCatalogState(libraryName, libraryAssets),
    [libraryAssets, libraryName],
  )
  const { allTags, folders, sourceSize, thumbnailFolders } = libraryCatalog
  const orderedFolders = useMemo(() => applyFolderOrder(folders, folderOrder), [folders, folderOrder])
  const { cacheSize, generatedCount } = thumbnailMetrics
  const pendingCount = Math.max(0, libraryAssets.length - generatedCount)
  const thumbnailFilterVersion = thumbnailState === 'all' ? 0 : assetStore.version

  const visibleAssetIds = useMemo(() => {
    const searchQuery = normalizeSearchText(deferredQuery).trim()
    const shouldUseLiveThumbnailState = thumbnailState !== 'all' && thumbnailFilterVersion >= 0
    const filtered = libraryAssets.filter((asset) => {
      const inFolder = activeFolder === '/' || asset.folder === activeFolder
      const inTag = activeTag === 'all' || asset.tags.includes(activeTag)
      const inType = typeFilter === 'all' || asset.kind === typeFilter
      const liveAsset = shouldUseLiveThumbnailState ? (assetById.get(asset.id) ?? asset) : asset
      const inThumb =
        thumbnailState === 'all' ||
        (thumbnailState === 'generated' && liveAsset.thumbnailReady) ||
        (thumbnailState === 'pending' && !liveAsset.thumbnailReady)
      const inSearch = !searchQuery || (asset.searchText ?? createAssetSearchText(asset)).includes(searchQuery)

      return inFolder && inTag && inType && inThumb && inSearch
    })

    const ordered =
      libraryScanStatus === 'open' && filtered.length > LARGE_SCAN_SORT_THRESHOLD
        ? filtered
        : sortAssets(filtered, sortField, sortDir)

    return ordered.map((asset) => asset.id)
  }, [
    activeFolder,
    activeTag,
    assetById,
    deferredQuery,
    libraryAssets,
    libraryScanStatus,
    sortDir,
    sortField,
    thumbnailState,
    thumbnailFilterVersion,
    typeFilter,
  ])

  const visibleCount = visibleAssetIds.length
  const visibleIdSet = useMemo(() => new Set(visibleAssetIds), [visibleAssetIds])
  const visibleIndexById = useMemo(
    () => {
      const indexById = new Map<string, number>()
      for (let index = 0; index < visibleAssetIds.length; index += 1) {
        indexById.set(visibleAssetIds[index], index)
      }
      return indexById
    },
    [visibleAssetIds],
  )
  const visibleSelectedIds = useMemo(
    () => new Set([...selectedIds].filter((id) => visibleIdSet.has(id))),
    [selectedIds, visibleIdSet],
  )
  const primaryAsset = primaryId && visibleIdSet.has(primaryId) ? assetById.get(primaryId) : undefined
  const lightboxIndex = primaryId ? (visibleIndexById.get(primaryId) ?? -1) : -1
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
    assetByIdRef.current = assetStore.byId
  }, [assetStore])

  useEffect(() => {
    primaryIdRef.current = primaryId
  }, [primaryId])

  useEffect(() => {
    selectedIdsRef.current = selectedIds
  }, [selectedIds])

  useEffect(() => {
    return () => revokePreviewUrls(libraryAssetsRef.current)
  }, [])

  useEffect(() => {
    localStorage.setItem('picman-theme', themePref)

    const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const resolved = themePref === 'system' ? (systemDark.matches ? 'dark' : 'light') : themePref
      document.documentElement.dataset.theme = resolved
    }

    apply()
    if (themePref !== 'system') return

    // Follow live OS appearance changes only while in system mode.
    systemDark.addEventListener('change', apply)
    return () => systemDark.removeEventListener('change', apply)
  }, [themePref])

  useEffect(() => {
    localStorage.setItem('picman-ocr-apikey', ocrApiKey)
  }, [ocrApiKey])

  useEffect(() => {
    localStorage.setItem('picman-ocr-language', ocrLanguage)
  }, [ocrLanguage])

  useEffect(() => {
    localStorage.setItem('picman-delete-shortcut', deleteShortcut)
  }, [deleteShortcut])

  const clearScanFlushTimer = useCallback((scan: ActiveNativeScan | null) => {
    if (!scan?.flushTimer) return

    window.clearTimeout(scan.flushTimer)
    scan.flushTimer = undefined
  }, [])

  const disposeActiveNativeScan = useCallback(() => {
    clearScanFlushTimer(activeNativeScanRef.current)
    activeNativeScanRef.current = null
  }, [clearScanFlushTimer])

  const flushOpenScanAssets = useCallback(
    (scanId: string) => {
      const scan = activeNativeScanRef.current
      if (!scan || scan.id !== scanId || scan.mode !== 'open') return

      clearScanFlushTimer(scan)
      const incoming = scan.pendingAssets.splice(0)
      if (incoming.length === 0) return

      const firstAsset = scan.firstSelected ? undefined : incoming[0]
      if (firstAsset) scan.firstSelected = true

      appendAssetIndexes(libraryAssetIndexByIdRef.current, libraryAssetIndexByIdRef.current.size, incoming)
      const restoredThumbnailMetrics = deriveThumbnailMetrics(incoming)
      startTransition(() => {
        setAssetStore((current) => updateAssetStore(current, (assetMap) => appendAssetsToAssetMap(assetMap, incoming)))
        setLibraryAssets((current) => [...current, ...incoming])
        if (restoredThumbnailMetrics.generatedCount > 0 || restoredThumbnailMetrics.cacheSize > 0) {
          setThumbnailMetrics((current) => addThumbnailMetrics(current, restoredThumbnailMetrics))
        }
      })

      if (firstAsset) {
        setSelectedIds(new Set([firstAsset.id]))
        setPrimaryId(firstAsset.id)
      }
    },
    [clearScanFlushTimer],
  )

  const scheduleOpenScanFlush = useCallback(
    (scanId: string) => {
      const scan = activeNativeScanRef.current
      if (!scan || scan.id !== scanId || scan.mode !== 'open' || scan.flushTimer) return

      scan.flushTimer = window.setTimeout(() => flushOpenScanAssets(scanId), 80)
    },
    [flushOpenScanAssets],
  )

  const finishRefreshScan = useCallback((scan: ActiveNativeScan, payload: ScanLibraryFinishedPayload) => {
    const merged = mergeRefreshedAssets(
      scan.collectedAssets,
      getLiveAssets(libraryAssetsRef.current, assetByIdRef.current),
    )
    const currentPrimaryId = primaryIdRef.current
    const currentSelectedIds = selectedIdsRef.current

    revokePreviewUrls(merged.removedAssets)
    libraryAssetIndexByIdRef.current = createAssetIndexMap(merged.assets)

    startTransition(() => {
      setAssetStore((current) => replaceAssetStore(current, merged.assets))
      setLibraryAssets(merged.assets)
      setLibraryName(payload.libraryName)
      setLibraryRootPath(payload.rootPath)
      setLibraryScanStatus('idle')
      setThumbnailMetrics(deriveThumbnailMetrics(merged.assets))
    })

    const survivingSelectedIds = new Set([...currentSelectedIds].filter((id) => merged.idSet.has(id)))
    if (survivingSelectedIds.size === 0 && merged.assets.length > 0) {
      setSelectedIds(new Set([merged.assets[0].id]))
      setPrimaryId(merged.assets[0].id)
    } else {
      setSelectedIds(survivingSelectedIds)
      setPrimaryId(currentPrimaryId && merged.idSet.has(currentPrimaryId) ? currentPrimaryId : null)
    }

    const summary =
      merged.added === 0 && merged.removed === 0
        ? `已刷新 · ${merged.assets.length} 个素材`
        : `已刷新 · ${merged.assets.length} 个素材（新增 ${merged.added} · 移除 ${merged.removed}）`
    setStatusMessage(summary)
  }, [])

  const cancelNativeThumbnailGeneration = useCallback((jobId?: string | null) => {
    const activeJobId = jobId ?? activeNativeThumbnailJobRef.current?.id ?? null
    const activeJob = activeNativeThumbnailJobRef.current
    if (activeJob?.flushTimer) window.clearTimeout(activeJob.flushTimer)
    activeNativeThumbnailJobRef.current = null
    void invoke('cancel_thumbnail_generation', { jobId: activeJobId }).catch(() => undefined)
  }, [])

  const flushNativeThumbnailUpdates = useCallback((jobId: string) => {
    const job = activeNativeThumbnailJobRef.current
    if (!job || job.id !== jobId) return

    if (job.flushTimer) {
      window.clearTimeout(job.flushTimer)
      job.flushTimer = undefined
    }

    const updates = new Map(job.pendingUpdates)
    job.pendingUpdates.clear()

    if (updates.size > 0) {
      const generated = thumbnailMetricsFromUpdates(updates.values())
      startTransition(() => {
        setAssetStore((current) =>
          updateAssetStore(current, (assetMap) => applyAssetUpdatesToMap(assetMap, updates)),
        )
        if (generated.generatedCount > 0 || generated.cacheSize > 0) {
          setThumbnailMetrics((current) => addThumbnailMetrics(current, generated))
        }
      })
    }

    setThumbnailGeneration({
      completed: job.progress.completed,
      currentName: job.progress.currentName,
      failed: job.progress.failed,
      quality: job.quality,
      scopeLabel: job.scopeLabel,
      status: 'running',
      total: job.progress.total,
    })
    setStatusMessage(`正在生成缩略图：${job.scopeLabel} · ${job.progress.completed}/${job.progress.total}`)
  }, [])

  const queueNativeThumbnailBatch = useCallback(
    (job: ActiveNativeThumbnailJob, payload: NativeThumbnailBatchPayload) => {
      job.progress = {
        completed: payload.completed,
        currentName: payload.currentName ?? undefined,
        failed: payload.failed,
        total: payload.total,
      }

      for (const update of payload.updates) {
        const thumbnailPath = update.path ?? undefined
        const thumbnailUrl = thumbnailPath
          ? withCacheToken(convertFileSrc(thumbnailPath), `${payload.jobId}-${payload.completed}-${update.assetId}`)
          : undefined

        job.pendingUpdates.set(
          update.assetId,
          {
            thumbnailError: update.error ?? undefined,
            thumbnailFormat: update.format ?? undefined,
            thumbnailHeight: update.height ?? undefined,
            thumbnailPath,
            thumbnailQuality: job.quality,
            thumbnailReady: Boolean(thumbnailPath && !update.error),
            thumbnailSizeKb: update.sizeKb ?? undefined,
            thumbnailUrl,
            thumbnailVersion: thumbnailPath ? `${payload.jobId}-${payload.completed}` : undefined,
            thumbnailWidth: update.width ?? undefined,
          } satisfies Partial<Asset>,
        )
      }

      if (job.pendingUpdates.size >= THUMBNAIL_UPDATE_FLUSH_THRESHOLD) {
        flushNativeThumbnailUpdates(job.id)
        return
      }

      if (!job.flushTimer) {
        job.flushTimer = window.setTimeout(() => flushNativeThumbnailUpdates(job.id), THUMBNAIL_UPDATE_FLUSH_MS)
      }
    },
    [flushNativeThumbnailUpdates],
  )

  useEffect(() => {
    let disposed = false
    const unlisteners: Array<() => void> = []

    async function registerScanListeners() {
      const unlistenBatch = await listen<ScanLibraryBatchPayload>(SCAN_BATCH_EVENT, (event) => {
        const scan = activeNativeScanRef.current
        if (!scan || scan.id !== event.payload.scanId) return

        const incoming = event.payload.assets.map(nativeAssetToFrontend)
        if (incoming.length === 0) return

        if (scan.mode === 'refresh') {
          scan.collectedAssets.push(...incoming)
          setStatusMessage(`${scan.libraryName} · 正在后台刷新 ${event.payload.total} 个素材`)
        } else {
          scan.pendingAssets.push(...incoming)
          scheduleOpenScanFlush(scan.id)
          setStatusMessage(`${scan.libraryName} · 正在扫描 ${event.payload.total} 个素材`)
        }
      })
      const unlistenFinished = await listen<ScanLibraryFinishedPayload>(SCAN_FINISHED_EVENT, (event) => {
        const scan = activeNativeScanRef.current
        if (!scan || scan.id !== event.payload.scanId) return

        if (scan.mode === 'refresh') {
          finishRefreshScan(scan, event.payload)
          disposeActiveNativeScan()
          return
        }

        flushOpenScanAssets(scan.id)
        disposeActiveNativeScan()
        setLibraryScanStatus('idle')
        setLibraryName(event.payload.libraryName)
        setLibraryRootPath(event.payload.rootPath)
        setStatusMessage(`${event.payload.libraryName} · ${event.payload.total} 个素材`)

        if (event.payload.total === 0) {
          setSelectedIds(new Set())
          setPrimaryId(null)
        }
      })
      const unlistenError = await listen<ScanLibraryErrorPayload>(SCAN_ERROR_EVENT, (event) => {
        const scan = activeNativeScanRef.current
        if (!scan || scan.id !== event.payload.scanId) return
        setStatusMessage(event.payload.message)
      })

      if (disposed) {
        unlistenBatch()
        unlistenFinished()
        unlistenError()
        return
      }

      unlisteners.push(unlistenBatch, unlistenFinished, unlistenError)
    }

    void registerScanListeners()

    return () => {
      disposed = true
      disposeActiveNativeScan()
      for (const unlisten of unlisteners) unlisten()
    }
  }, [disposeActiveNativeScan, finishRefreshScan, flushOpenScanAssets, scheduleOpenScanFlush])

  useEffect(() => {
    let disposed = false
    const unlisteners: Array<() => void> = []

    async function registerThumbnailListeners() {
      const unlistenBatch = await listen<NativeThumbnailBatchPayload>(THUMBNAIL_BATCH_EVENT, (event) => {
        const job = activeNativeThumbnailJobRef.current
        if (!job || job.id !== event.payload.jobId) return

        queueNativeThumbnailBatch(job, event.payload)
      })
      const unlistenFinished = await listen<NativeThumbnailFinishedPayload>(THUMBNAIL_FINISHED_EVENT, (event) => {
        const job = activeNativeThumbnailJobRef.current
        if (!job || job.id !== event.payload.jobId) return

        flushNativeThumbnailUpdates(job.id)
        activeNativeThumbnailJobRef.current = null

        if (event.payload.cancelled) {
          setThumbnailGeneration({
            completed: event.payload.completed,
            failed: event.payload.failed,
            quality: job.quality,
            scopeLabel: job.scopeLabel,
            status: 'idle',
            total: event.payload.total,
          })
          setStatusMessage(`缩略图生成已取消：${job.scopeLabel}`)
          return
        }

        setThumbnailGeneration({
          completed: event.payload.completed,
          failed: event.payload.failed,
          quality: job.quality,
          scopeLabel: job.scopeLabel,
          status: 'completed',
          total: event.payload.total,
        })
        setStatusMessage(
          event.payload.failed > 0
            ? `缩略图已生成：${job.scopeLabel} · 失败 ${event.payload.failed} 个`
            : `缩略图已生成：${job.scopeLabel} · ${event.payload.total} 个素材`,
        )
      })

      if (disposed) {
        unlistenBatch()
        unlistenFinished()
        return
      }

      unlisteners.push(unlistenBatch, unlistenFinished)
    }

    void registerThumbnailListeners()

    return () => {
      disposed = true
      const activeJob = activeNativeThumbnailJobRef.current
      if (activeJob?.flushTimer) window.clearTimeout(activeJob.flushTimer)
      activeNativeThumbnailJobRef.current = null
      for (const unlisten of unlisteners) unlisten()
    }
  }, [flushNativeThumbnailUpdates, queueNativeThumbnailBatch])

  const beginCollect = useCallback(
    (payload: CollectPayload) => {
      if (!libraryRootPath) {
        setStatusMessage('请先打开本地资源目录后再收藏图片')
        return
      }

      const previewUrl = URL.createObjectURL(new Blob([payload.bytes], { type: payload.mimeType }))
      setCollectPending((current) => {
        if (current) URL.revokeObjectURL(current.previewUrl)
        return { payload, previewUrl }
      })
    },
    [libraryRootPath],
  )

  useEffect(() => {
    function isEditableTarget(target: EventTarget | null) {
      const element = target as HTMLElement | null
      if (!element) return false
      const tag = element.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
    }

    async function handlePaste(event: ClipboardEvent) {
      const data = event.clipboardData
      if (!data) return

      const allowRemote = !isEditableTarget(document.activeElement)
      if (!dataTransferHasImage(data, allowRemote)) return

      event.preventDefault()
      const payload = await extractImagePayload(data, allowRemote)
      if (payload) beginCollect(payload)
      else setStatusMessage('剪贴板里没有可收藏的图片（跨域图片请改用“复制图片”）')
    }

    function handleDragOver(event: DragEvent) {
      if (event.dataTransfer) event.preventDefault()
    }

    async function handleDrop(event: DragEvent) {
      const data = event.dataTransfer
      if (!data) return

      event.preventDefault()
      if (!dataTransferHasImage(data, true)) return

      const payload = await extractImagePayload(data, true)
      if (payload) beginCollect(payload)
      else setStatusMessage('拖入的图片无法读取（防盗链/跨域时请改用“复制图片”再粘贴）')
    }

    window.addEventListener('paste', handlePaste)
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('paste', handlePaste)
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('drop', handleDrop)
    }
  }, [beginCollect])

  const handleVisualOrderChange = useCallback(
    (ids: string[]) => {
      visualAssetIdsRef.current = ids.length === visibleCount ? ids : visibleAssetIds
    },
    [visibleAssetIds, visibleCount],
  )

  const getCurrentVisualIds = useCallback(() => {
    const visualIds = visualAssetIdsRef.current
    return visualIds.length === visibleCount ? visualIds : visibleAssetIds
  }, [visibleAssetIds, visibleCount])

  useEffect(() => {
    if (!sortOpen) return

    const handler = (event: globalThis.MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.sort-btn-wrap')) setSortOpen(false)
    }

    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [sortOpen])

  const getVisibleAssetAt = useCallback(
    (index: number) => {
      const assetId = visibleAssetIds[index]
      return assetId ? assetByIdRef.current.get(assetId) : undefined
    },
    [visibleAssetIds],
  )

  const navigateLightbox = useCallback(
    (dir: 'prev' | 'next') => {
      if (visibleCount === 0) return

      const currentIndex = primaryId ? (visibleIndexById.get(primaryId) ?? -1) : -1
      const current = currentIndex === -1 ? 0 : currentIndex
      const nextIndex = dir === 'prev' ? Math.max(0, current - 1) : Math.min(visibleCount - 1, current + 1)
      const nextAsset = getVisibleAssetAt(nextIndex)
      if (!nextAsset) return

      setPrimaryId(nextAsset.id)
      setSelectedIds(new Set([nextAsset.id]))
      blurActiveElement()
    },
    [getVisibleAssetAt, primaryId, visibleCount, visibleIndexById],
  )

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const tag = (event.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (deleteShortcut && eventToShortcut(event) === deleteShortcut) {
        event.preventDefault()
        runDeleteRef.current()
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        setSelectedIds(new Set(visibleAssetIds))
        setPrimaryId(visibleAssetIds[0] ?? null)
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
        if (visibleCount === 0) return

        const visualIds = getCurrentVisualIds()
        const currentIndex = primaryId ? visualIds.indexOf(primaryId) : -1
        const isPrevKey = selectionKeyAxis === 'horizontal' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp'

        const nextIndex =
          currentIndex === -1
            ? 0
            : isPrevKey
            ? Math.max(0, currentIndex - 1)
            : Math.min(visualIds.length - 1, currentIndex + 1)
        const nextId = visualIds[nextIndex]
        const nextAsset = assetByIdRef.current.get(nextId) ?? getVisibleAssetAt(nextIndex)
        if (!nextAsset) return

        setSelectedIds(new Set([nextAsset.id]))
        setPrimaryId(nextAsset.id)
        setKeyboardScrollTargetId(nextAsset.id)
        setKeyboardScrollVersion((version) => version + 1)
        blurActiveElement()
        event.preventDefault()
      } else if (event.key === ' ' && visibleCount > 0) {
        if (!primaryAsset) {
          const firstAsset = getVisibleAssetAt(0)
          if (firstAsset) {
            setPrimaryId(firstAsset.id)
            setSelectedIds(new Set([firstAsset.id]))
          }
        }
        setLightboxOpen(true)
        event.preventDefault()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    deleteShortcut,
    getCurrentVisualIds,
    getVisibleAssetAt,
    lightboxOpen,
    navigateLightbox,
    primaryAsset,
    primaryId,
    selectionKeyAxis,
    visibleAssetIds,
    visibleCount,
  ])

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
      const startIndex = primaryId ? (visibleIndexById.get(primaryId) ?? -1) : -1
      const endIndex = visibleIndexById.get(asset.id) ?? -1
      const safeStart = startIndex === -1 ? endIndex : startIndex
      const [from, to] = safeStart <= endIndex ? [safeStart, endIndex] : [endIndex, safeStart]

      setSelectedIds(new Set(visibleAssetIds.slice(from, to + 1)))
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
    const scanId = createScanId()
    const optimisticLibraryName = libraryNameFromPath(rootPath)

    activeBrowserScanRef.current = null
    disposeActiveNativeScan()
    cancelNativeThumbnailGeneration()
    activeNativeScanRef.current = {
      collectedAssets: [],
      firstSelected: false,
      id: scanId,
      libraryName: optimisticLibraryName,
      mode: 'open',
      pendingAssets: [],
    }
    thumbnailRunRef.current += 1
    setLibraryScanStatus('open')
    setThumbnailMetrics({ cacheSize: 0, generatedCount: 0 })
    libraryAssetIndexByIdRef.current = new Map<string, number>()
    setAssetStore((current) => replaceAssetStore(current, []))
    setLibraryAssets((current) => {
      revokePreviewUrls(current)
      return []
    })
    setLibraryRootPath(rootPath)
    setLibraryName(optimisticLibraryName)
    setActiveFolder('/')
    setActiveTag('all')
    setTypeFilter('all')
    setThumbnailState('all')
    setFolderOrder([])
    setTrashView(false)
    setTrashItems([])
    setTrashSelectedIds(new Set())
    setThumbnailGeneration({
      completed: 0,
      failed: 0,
      quality: thumbnailQuality,
      scopeLabel: '',
      status: 'idle',
      total: 0,
    })
    setSettingsOpen(false)
    setSelectedIds(new Set())
    setPrimaryId(null)
    setStatusMessage(`${optimisticLibraryName} · 正在启动后台扫描...`)

    try {
      const scan = await invoke<ScanLibraryStartResponse>('scan_library_folder_stream', { rootPath, scanId })
      const activeScan = activeNativeScanRef.current
      if (!activeScan || activeScan.id !== scanId) return

      activeScan.libraryName = scan.libraryName
      setLibraryRootPath(scan.rootPath)
      setLibraryName(scan.libraryName)
      setStatusMessage(`${scan.libraryName} · 正在扫描资源目录...`)

      void invoke<LibrarySettings>('read_library_settings', { libraryRoot: scan.rootPath })
        .then((settings) => {
          if (activeNativeScanRef.current?.id === scanId) setFolderOrder(settings.folderOrder ?? [])
        })
        .catch(() => undefined)

      void invoke<TrashItem[]>('list_trash', { libraryRoot: scan.rootPath })
        .then((items) => {
          if (activeNativeScanRef.current?.id === scanId) setTrashItems(items)
        })
        .catch(() => undefined)
    } catch (error) {
      if (activeNativeScanRef.current?.id !== scanId) return

      disposeActiveNativeScan()
      setLibraryScanStatus('idle')
      const message = error instanceof Error ? error.message : '扫描失败'
      setStatusMessage(`扫描失败：${message}`)
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

    const scanId = createScanId()
    const nextLibraryName = files[0].webkitRelativePath?.split('/')[0] || 'Local Library'
    activeBrowserScanRef.current = scanId
    disposeActiveNativeScan()
    cancelNativeThumbnailGeneration()
    thumbnailRunRef.current += 1
    setLibraryScanStatus('open')
    setThumbnailMetrics({ cacheSize: 0, generatedCount: 0 })
    libraryAssetIndexByIdRef.current = new Map<string, number>()
    setAssetStore((current) => replaceAssetStore(current, []))

    setLibraryAssets((current) => {
      revokePreviewUrls(current)
      return []
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
    setStatusMessage(`${nextLibraryName} · 正在分批扫描资源目录...`)

    let firstAssetSelected = false
    let scannedTotal = 0

    const total = await scanFilesInBatches(
      files,
      (batch, scanned) => {
        const incoming = batch.map(withAssetSearchText)
        scannedTotal = scanned

        appendAssetIndexes(libraryAssetIndexByIdRef.current, libraryAssetIndexByIdRef.current.size, incoming)
        startTransition(() => {
          setAssetStore((current) => updateAssetStore(current, (assetMap) => appendAssetsToAssetMap(assetMap, incoming)))
          setLibraryAssets((current) => [...current, ...incoming])
        })

        if (!firstAssetSelected && incoming[0]) {
          firstAssetSelected = true
          setSelectedIds(new Set([incoming[0].id]))
          setPrimaryId(incoming[0].id)
        }

        setStatusMessage(`${nextLibraryName} · 正在扫描 ${scanned} 个素材`)
      },
      500,
      () => activeBrowserScanRef.current === scanId,
    )

    if (activeBrowserScanRef.current !== scanId) return
    activeBrowserScanRef.current = null
    setLibraryScanStatus('idle')
    setStatusMessage(`${nextLibraryName} · ${scannedTotal || total} 个素材`)

    if (total === 0) {
      setSelectedIds(new Set())
      setPrimaryId(null)
    }
  }

  async function refreshLibrary() {
    if (!libraryRootPath) {
      setStatusMessage('请先打开本地资源目录后再刷新')
      return
    }

    const scanId = createScanId()
    const optimisticLibraryName = libraryNameFromPath(libraryRootPath)
    disposeActiveNativeScan()
    thumbnailRunRef.current += 1
    cancelNativeThumbnailGeneration()
    setLibraryScanStatus('refresh')
    activeNativeScanRef.current = {
      collectedAssets: [],
      firstSelected: true,
      id: scanId,
      libraryName: libraryName || optimisticLibraryName,
      mode: 'refresh',
      pendingAssets: [],
    }
    setStatusMessage(`${libraryName || optimisticLibraryName} · 正在启动后台刷新...`)

    try {
      const scan = await invoke<ScanLibraryStartResponse>('scan_library_folder_stream', {
        rootPath: libraryRootPath,
        scanId,
      })
      const activeScan = activeNativeScanRef.current
      if (!activeScan || activeScan.id !== scanId) return

      activeScan.libraryName = scan.libraryName
      setLibraryRootPath(scan.rootPath)
      setLibraryName(scan.libraryName)
      setStatusMessage(`${scan.libraryName} · 正在后台刷新资源目录...`)
    } catch (error) {
      if (activeNativeScanRef.current?.id !== scanId) return

      disposeActiveNativeScan()
      setLibraryScanStatus('idle')
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
    const clearedThumbnailMetrics = deriveThumbnailMetrics(targetAssets)
    const firstName = targetAssets[0]?.name
    const pendingAssetUpdates = new Map<string, Partial<Asset>>()
    let failedCount = 0
    let lastProgressAt = 0

    const liveAssets = getLiveAssets(libraryAssetsRef.current, assetByIdRef.current)
    revokeThumbnailUrls(liveAssets.filter((asset) => targetIds.has(asset.id)))
    const clearedUpdates = buildThumbnailClearUpdates(targetAssets)
    setThumbnailMetrics((current) => subtractThumbnailMetrics(current, clearedThumbnailMetrics))
    setAssetStore((current) =>
      updateAssetStore(current, (assetMap) => applyAssetUpdatesToMap(assetMap, clearedUpdates)),
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

    if (libraryRootPath && targetAssets.every((asset) => asset.sourcePath)) {
      const jobId = createThumbnailJobId(runId)
      activeNativeThumbnailJobRef.current = {
        id: jobId,
        pendingUpdates: new Map(),
        progress: {
          completed: 0,
          currentName: firstName,
          failed: 0,
          total: targetAssets.length,
        },
        quality,
        scopeLabel,
        total: targetAssets.length,
      }

      try {
        const started = await invoke<NativeThumbnailJobStartResponse>('generate_thumbnails_stream', {
          jobId,
          libraryRoot: libraryRootPath,
          quality,
          sources: targetAssets.map((asset) => ({
            id: asset.id,
            kind: asset.kind,
            relativePath: asset.relativePath,
            sourcePath: asset.sourcePath,
          })),
        })

        const activeJob = activeNativeThumbnailJobRef.current
        if (!activeJob || activeJob.id !== jobId) return

        activeJob.total = started.total
        setThumbnailGeneration({
          completed: 0,
          currentName: firstName,
          failed: 0,
          quality,
          scopeLabel,
          status: 'running',
          total: started.total,
        })
      } catch (error) {
        const activeJob = activeNativeThumbnailJobRef.current
        if (!activeJob || activeJob.id !== jobId) return

        activeNativeThumbnailJobRef.current = null
        const message = error instanceof Error ? error.message : '缩略图生成失败'
        setThumbnailGeneration({
          completed: 0,
          failed: targetAssets.length,
          quality,
          scopeLabel,
          status: 'idle',
          total: targetAssets.length,
        })
        setStatusMessage(`缩略图生成失败：${message}`)
      }

      return
    }

    const flushAssetUpdates = () => {
      if (pendingAssetUpdates.size === 0) return

      const updates = new Map(pendingAssetUpdates)
      pendingAssetUpdates.clear()
      const generated = thumbnailMetricsFromUpdates(updates.values())
      setAssetStore((current) =>
        updateAssetStore(current, (assetMap) => applyAssetUpdatesToMap(assetMap, updates)),
      )
      if (generated.generatedCount > 0 || generated.cacheSize > 0) {
        setThumbnailMetrics((current) => addThumbnailMetrics(current, generated))
      }
    }

    const updateGenerationProgress = (index: number, asset: Asset, force = false) => {
      const now = window.performance.now()
      if (!force && now - lastProgressAt < 160) return

      lastProgressAt = now
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

      pendingAssetUpdates.set(asset.id, {
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
      })
      if (pendingAssetUpdates.size >= 80) flushAssetUpdates()
      updateGenerationProgress(index, asset, index === targetAssets.length - 1)
    }

    if (thumbnailRunRef.current !== runId) return

    flushAssetUpdates()
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
    void generateThumbnailAssets(getLiveAssets(libraryAssetsRef.current, assetByIdRef.current), '全部素材')
  }

  function generateFolderThumbnails(folderPaths: string[]) {
    const selectedFolders = new Set(folderPaths)
    const selectedAssets = getLiveAssets(libraryAssetsRef.current, assetByIdRef.current).filter((asset) =>
      selectedFolders.has(asset.folder),
    )
    const label =
      folderPaths.length === 1
        ? folderName(folderPaths[0], libraryName)
        : `${folderPaths.length} 个文件夹`

    void generateThumbnailAssets(selectedAssets, label)
  }

  function clearThumbnailCache() {
    thumbnailRunRef.current += 1
    cancelNativeThumbnailGeneration()
    const liveAssets = getLiveAssets(libraryAssetsRef.current, assetByIdRef.current)
    revokeThumbnailUrls(liveAssets)
    setThumbnailMetrics({ cacheSize: 0, generatedCount: 0 })
    if (libraryRootPath) {
      void invoke('clear_thumbnail_cache', { libraryRoot: libraryRootPath }).catch(() => undefined)
    }
    const clearedUpdates = buildThumbnailClearUpdates(liveAssets)
    setAssetStore((current) =>
      updateAssetStore(current, (assetMap) => applyAssetUpdatesToMap(assetMap, clearedUpdates)),
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

  function closeCollect() {
    setCollectPending((current) => {
      if (current) URL.revokeObjectURL(current.previewUrl)
      return null
    })
  }

  function insertCollectedAsset(asset: Asset) {
    appendAssetIndexes(libraryAssetIndexByIdRef.current, libraryAssetIndexByIdRef.current.size, [asset])
    setAssetStore((current) =>
      updateAssetStore(current, (assetMap) => appendAssetsToAssetMap(assetMap, [asset])),
    )
    setLibraryAssets((current) => [...current, asset])
  }

  async function generateCollectedThumbnail(asset: Asset) {
    if (!libraryRootPath || !asset.sourcePath) return

    try {
      const result = await invoke<NativeThumbnailResult>('generate_thumbnail', {
        libraryRoot: libraryRootPath,
        quality: thumbnailQuality,
        source: {
          id: asset.id,
          kind: asset.kind,
          relativePath: asset.relativePath,
          sourcePath: asset.sourcePath,
        },
      })
      const token = `collect-${asset.id}-${Date.now()}`
      const update = new Map<string, Partial<Asset>>([
        [
          asset.id,
          {
            thumbnailError: undefined,
            thumbnailFormat: result.format,
            thumbnailHeight: result.height,
            thumbnailPath: result.path,
            thumbnailQuality,
            thumbnailReady: true,
            thumbnailSizeKb: result.sizeKb,
            thumbnailUrl: withCacheToken(convertFileSrc(result.path), token),
            thumbnailVersion: token,
            thumbnailWidth: result.width,
          },
        ],
      ])
      setAssetStore((current) =>
        updateAssetStore(current, (assetMap) => applyAssetUpdatesToMap(assetMap, update)),
      )
      setThumbnailMetrics((current) =>
        addThumbnailMetrics(current, { cacheSize: result.sizeKb, generatedCount: 1 }),
      )
    } catch {
      // Leave the placeholder; the file is collected and can be generated later.
    }
  }

  async function collectIntoFolder(folderPath: string) {
    const pending = collectPending
    if (!pending || !libraryRootPath) return

    const targetFolder = folderPath === '/' ? '' : folderPath.replace(/^\/+/, '')
    closeCollect()

    try {
      const scanned = await invoke<NativeScannedAsset>('collect_image', {
        bytes: pending.payload.bytes,
        libraryRoot: libraryRootPath,
        provenance: {
          sourceUrl: pending.payload.sourceUrl ?? null,
          title: pending.payload.title ?? null,
        },
        targetFolder,
      })
      const asset = nativeAssetToFrontend(scanned)
      const alreadyInLibrary = assetByIdRef.current.has(asset.id)

      if (!alreadyInLibrary) insertCollectedAsset(asset)
      setLastCollectFolder(asset.folder)
      setTrashView(false)
      setActiveFolder(asset.folder)
      setSelectedIds(new Set([asset.id]))
      setPrimaryId(asset.id)
      setStatusMessage(
        alreadyInLibrary
          ? `该图片已在 ${folderName(asset.folder, libraryName)} 中`
          : `已收藏到 ${folderName(asset.folder, libraryName)}`,
      )
      if (!alreadyInLibrary) void generateCollectedThumbnail(asset)
    } catch (error) {
      const message = error instanceof Error ? error.message : '收藏失败'
      setStatusMessage(`收藏失败：${message}`)
    }
  }

  function reorderFolders(orderedChildPaths: string[]) {
    setFolderOrder(orderedChildPaths)
    if (!libraryRootPath) return

    void invoke('write_library_settings', {
      libraryRoot: libraryRootPath,
      settings: { folderOrder: orderedChildPaths },
    }).catch((error) => {
      const message = error instanceof Error ? error.message : '文件夹排序保存失败'
      setStatusMessage(`文件夹排序保存失败：${message}`)
    })
  }

  function revealLibraryInFinder() {
    if (!libraryRootPath) {
      setStatusMessage('请先打开本地资源目录后再在 Finder 中显示')
      return
    }

    void invoke('reveal_in_finder', { path: libraryRootPath }).catch((error) => {
      const message = error instanceof Error ? error.message : '无法打开 Finder'
      setStatusMessage(`无法打开 Finder：${message}`)
    })
  }

  function closeOcr() {
    ocrRunRef.current += 1
    setOcr(null)
  }

  async function runOcr(asset: Asset) {
    const apiKey = ocrApiKey.trim()
    if (!apiKey) {
      setOcr({ status: 'error', text: '', error: '请先在「偏好设置 → 文字识别」中填写 OCR.space API Key。' })
      return
    }

    const runId = ocrRunRef.current + 1
    ocrRunRef.current = runId
    setOcr({ status: 'loading', text: '' })

    try {
      let base64Image: string
      if (asset.sourcePath) {
        base64Image = await invoke<string>('prepare_image_for_ocr', { sourcePath: asset.sourcePath })
      } else if (asset.previewUrl) {
        base64Image = await imageUrlToJpegDataUri(asset.previewUrl)
      } else {
        throw new Error('无法读取图片内容')
      }

      const text = await recognizeText(base64Image, apiKey, ocrLanguage)
      if (ocrRunRef.current !== runId) return
      setOcr({ status: 'done', text })
    } catch (error) {
      if (ocrRunRef.current !== runId) return
      const message = error instanceof Error ? error.message : 'OCR 识别失败'
      setOcr({ status: 'error', text: '', error: message })
    }
  }

  async function confirmAction(message: string, title: string): Promise<boolean> {
    try {
      return await tauriConfirm(message, { title, kind: 'warning' })
    } catch {
      return window.confirm(message)
    }
  }

  function removeAssetsFromLibrary(removedIds: Set<string>) {
    if (removedIds.size === 0) return

    const liveAssets = getLiveAssets(libraryAssetsRef.current, assetByIdRef.current)
    const removedAssets = liveAssets.filter((asset) => removedIds.has(asset.id))
    revokePreviewUrls(removedAssets)
    const removedMetrics = deriveThumbnailMetrics(removedAssets)
    const nextAssets = libraryAssetsRef.current.filter((asset) => !removedIds.has(asset.id))
    libraryAssetIndexByIdRef.current = createAssetIndexMap(nextAssets)

    setAssetStore((current) =>
      updateAssetStore(current, (assetMap) => {
        for (const id of removedIds) assetMap.delete(id)
      }),
    )
    setLibraryAssets(nextAssets)
    if (removedMetrics.generatedCount > 0 || removedMetrics.cacheSize > 0) {
      setThumbnailMetrics((current) => subtractThumbnailMetrics(current, removedMetrics))
    }
    setSelectedIds((current) => new Set([...current].filter((id) => !removedIds.has(id))))
    setPrimaryId((current) => (current && removedIds.has(current) ? null : current))
  }

  async function deleteSelectedToTrash() {
    if (!libraryRootPath) {
      setStatusMessage('请先打开本地资源目录后再删除')
      return
    }

    const targets = [...visibleSelectedIds]
      .map((id) => assetByIdRef.current.get(id))
      .filter((asset): asset is Asset => Boolean(asset?.relativePath && asset.sourcePath))
    if (targets.length === 0) return

    try {
      const created = await invoke<TrashItem[]>('move_to_trash', {
        libraryRoot: libraryRootPath,
        relativePaths: targets.map((asset) => asset.relativePath),
      })
      removeAssetsFromLibrary(new Set(targets.map((asset) => asset.id)))
      setTrashItems((current) => [...created, ...current])
      setStatusMessage(`已删除 ${created.length} 项到回收站`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除失败'
      setStatusMessage(`删除失败：${message}`)
    }
  }

  async function restoreTrashItems(ids: string[]) {
    if (!libraryRootPath || ids.length === 0) return

    try {
      const restored = await invoke<NativeScannedAsset[]>('restore_from_trash', {
        libraryRoot: libraryRootPath,
        ids,
      })
      for (const scanned of restored) {
        const asset = nativeAssetToFrontend(scanned)
        if (!assetByIdRef.current.has(asset.id)) insertCollectedAsset(asset)
      }
      const idSet = new Set(ids)
      setTrashItems((current) => current.filter((item) => !idSet.has(item.id)))
      setTrashSelectedIds((current) => new Set([...current].filter((id) => !idSet.has(id))))
      setStatusMessage(`已恢复 ${restored.length} 项`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '恢复失败'
      setStatusMessage(`恢复失败：${message}`)
    }
  }

  async function emptyTrash() {
    if (!libraryRootPath || trashItems.length === 0) return

    const confirmed = await confirmAction(
      `确定要清空回收站吗？将永久删除 ${trashItems.length} 项，且无法恢复。`,
      '清空回收站',
    )
    if (!confirmed) return

    try {
      await invoke('empty_trash', { libraryRoot: libraryRootPath })
      setTrashItems([])
      setTrashSelectedIds(new Set())
      setStatusMessage('回收站已清空')
    } catch (error) {
      const message = error instanceof Error ? error.message : '清空失败'
      setStatusMessage(`清空失败：${message}`)
    }
  }

  function toggleTrashSelect(id: string) {
    setTrashSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function showTrashView() {
    setTrashView(true)
    setTrashSelectedIds(new Set())
    if (libraryRootPath) {
      void invoke<TrashItem[]>('list_trash', { libraryRoot: libraryRootPath })
        .then(setTrashItems)
        .catch(() => undefined)
    }
  }

  function selectFolder(folder: string) {
    setTrashView(false)
    setActiveFolder(folder)
  }

  function selectTag(tag: string) {
    setTrashView(false)
    setActiveTag(tag)
  }

  useEffect(() => {
    runDeleteRef.current = deleteSelectedToTrash
  })

  async function regenerateThumbnailsSequentially(assets: Asset[]) {
    for (const asset of assets) {
      await generateCollectedThumbnail(asset)
    }
  }

  async function runBatchProcess(options: BatchOptions) {
    if (!libraryRootPath) return

    const targets = [...visibleSelectedIds]
      .map((id) => assetByIdRef.current.get(id))
      .filter((asset): asset is Asset => Boolean(asset?.sourcePath && BATCH_PROCESSABLE_KINDS.has(asset.kind)))
    if (targets.length === 0) {
      setStatusMessage('所选素材中没有可处理的图片（仅支持 PNG/JPG/WebP）')
      return
    }

    setBatchProcessing(true)
    try {
      const result = await invoke<BatchProcessResult>('batch_process_images', {
        libraryRoot: libraryRootPath,
        relativePaths: targets.map((asset) => asset.relativePath),
        options: {
          maxEdge: options.resizeMode === 'maxEdge' ? options.maxEdge : null,
          scalePercent: options.resizeMode === 'percent' ? options.percent : null,
          quality: options.quality,
        },
      })

      const processedPaths = new Set(result.processed.map((entry) => entry.previousRelativePath))
      const removedIds = new Set(
        targets.filter((asset) => processedPaths.has(asset.relativePath)).map((asset) => asset.id),
      )
      removeAssetsFromLibrary(removedIds)

      const newAssets = result.processed.map((entry) => nativeAssetToFrontend(entry.asset))
      for (const asset of newAssets) insertCollectedAsset(asset)
      setSelectedIds(new Set(newAssets.map((asset) => asset.id)))
      setPrimaryId(newAssets[0]?.id ?? null)

      const previousKb = result.processed.reduce((sum, entry) => sum + entry.previousSizeKb, 0)
      const nextKb = newAssets.reduce((sum, asset) => sum + asset.sizeKb, 0)
      const savedPercent = previousKb > 0 ? Math.max(0, Math.round((1 - nextKb / previousKb) * 100)) : 0
      setStatusMessage(
        `已处理 ${result.processed.length} 张${result.failed ? ` · 失败 ${result.failed}` : ''} · ${formatMb(previousKb)} → ${formatMb(nextKb)}（省 ${savedPercent}%）`,
      )
      setBatchOpen(false)
      void regenerateThumbnailsSequentially(newAssets)
    } catch (error) {
      const message = error instanceof Error ? error.message : '批量处理失败'
      setStatusMessage(`批量处理失败：${message}`)
    } finally {
      setBatchProcessing(false)
    }
  }

  function writeAssetToStore(updatedAsset: Asset) {
    const updates = new Map<string, Partial<Asset>>([[updatedAsset.id, updatedAsset]])
    setAssetStore((current) =>
      updateAssetStore(current, (assetMap) => applyAssetUpdatesToMap(assetMap, updates)),
    )
  }

  function commitAssetMetadataUpdate(updatedAsset: Asset) {
    writeAssetToStore(updatedAsset)
    setLibraryAssets((current) =>
      applyAssetUpdatesToArray(
        current,
        new Map<string, Partial<Asset>>([[updatedAsset.id, updatedAsset]]),
        libraryAssetIndexByIdRef.current,
      ),
    )
  }

  function saveFolderAssetMetadata(asset: Asset) {
    if (!libraryRootPath || !asset.sourcePath) return

    const metadata: FolderAssetMetadataPayload = {
      favorite: asset.favorite,
      note: asset.note,
      tags: asset.tags,
    }

    void invoke('write_folder_asset_metadata', {
      libraryRoot: libraryRootPath,
      metadata,
      relativePath: asset.relativePath,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : '文件夹元数据保存失败'
      setStatusMessage(`元数据保存失败：${message}`)
    })
  }

  function addAssetTag(assetId: string, rawTag: string) {
    const tag = rawTag.trim().replace(/\s+/g, ' ')
    if (!tag) return

    const target = assetByIdRef.current.get(assetId)
    if (!target || target.tags.includes(tag)) {
      setStatusMessage(`标签已存在：${tag}`)
      return
    }

    const updatedAsset = withAssetSearchText({ ...target, tags: [...target.tags, tag] })
    commitAssetMetadataUpdate(updatedAsset)
    saveFolderAssetMetadata(updatedAsset)
    setStatusMessage(libraryRootPath ? `已添加标签并写入文件：${tag}` : `已添加标签：${tag}`)
  }

  function removeAssetTag(assetId: string, tag: string) {
    const target = assetByIdRef.current.get(assetId)
    if (!target?.tags.includes(tag)) return

    const tagStillUsed = libraryAssets.some((asset) => asset.id !== assetId && asset.tags.includes(tag))
    const updatedAsset = withAssetSearchText({
      ...target,
      tags: target.tags.filter((assetTag) => assetTag !== tag),
    })
    commitAssetMetadataUpdate(updatedAsset)
    saveFolderAssetMetadata(updatedAsset)
    if (activeTag === tag && !tagStillUsed) setActiveTag('all')
    setStatusMessage(libraryRootPath ? `已移除标签并写入文件：${tag}` : `已移除标签：${tag}`)
  }

  function setAssetFavorite(assetId: string, favorite: boolean) {
    const target = assetByIdRef.current.get(assetId)
    if (!target || target.favorite === favorite) return

    const updatedAsset = { ...target, favorite }
    writeAssetToStore(updatedAsset)
    saveFolderAssetMetadata(updatedAsset)
    setStatusMessage(libraryRootPath ? '已更新收藏并写入文件' : '已更新收藏')
  }

  function updateAssetNote(assetId: string, note: string) {
    const target = assetByIdRef.current.get(assetId)
    if (!target || target.note === note) return

    const updatedAsset = withAssetSearchText({ ...target, note })
    commitAssetMetadataUpdate(updatedAsset)
    saveFolderAssetMetadata(updatedAsset)
    setStatusMessage(libraryRootPath ? '已更新备注并写入文件' : '已更新备注')
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
          canReveal={Boolean(libraryRootPath)}
          folders={orderedFolders}
          libraryName={libraryName}
          trashActive={trashView}
          trashCount={trashItems.length}
          onEmptyTrash={emptyTrash}
          onRevealLibrary={revealLibraryInFinder}
          onReorderFolders={reorderFolders}
          onSetActiveFolder={selectFolder}
          onSetActiveTag={selectTag}
          onShowTrash={showTrashView}
        />

        <div
          aria-label="调整左侧栏宽度"
          aria-orientation="vertical"
          className="sidebar-col-resizer"
          role="separator"
          onPointerDown={startSidebarResize}
        />

        <div className="workspace">
          {trashView ? (
            <TrashView
              items={trashItems}
              selectedIds={trashSelectedIds}
              thumbSize={thumbSize}
              onBack={() => setTrashView(false)}
              onEmpty={emptyTrash}
              onRestore={restoreTrashItems}
              onToggleSelect={(id) => toggleTrashSelect(id)}
            />
          ) : (
          <LibraryView
            activeTag={activeTag}
            activeFilterCount={activeFilterCount}
            allTags={allTags}
            assetById={assetById}
            assetIndexById={visibleIndexById}
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
            visibleAssetIds={visibleAssetIds}
            onAddAssetTag={addAssetTag}
            onAssetClick={handleAssetClick}
            onAssetDoubleClick={handleAssetDoubleClick}
            onOpenFolder={openLibraryFolder}
            onRefresh={refreshLibrary}
            onRemoveAssetTag={removeAssetTag}
            onOcr={runOcr}
            onDeleteSelected={deleteSelectedToTrash}
            onOpenBatch={() => setBatchOpen(true)}
            onSetActiveTag={selectTag}
            onSetAssetFavorite={setAssetFavorite}
            onSetFiltersOpen={setFiltersOpen}
            onSetQuery={setQuery}
            onSetSortDir={setSortDir}
            onSetSortField={setSortField}
            onSetSortOpen={setSortOpen}
            onSetThumbnailState={setThumbnailState}
            onSetThumbSize={setThumbSize}
            onSetTypeFilter={setTypeFilter}
            onSetViewMode={setViewMode}
            onUpdateAssetNote={updateAssetNote}
            onVisualOrderChange={handleVisualOrderChange}
          />
          )}
        </div>
      </div>

      {settingsOpen && (
        <SettingsPanel
          cacheLimit={cacheLimit}
          cacheSize={cacheSize}
          deleteShortcut={deleteShortcut}
          folders={thumbnailFolders}
          generatedCount={generatedCount}
          libraryName={libraryName}
          ocrApiKey={ocrApiKey}
          ocrLanguage={ocrLanguage}
          pendingCount={pendingCount}
          selectionKeyAxis={selectionKeyAxis}
          sourceSize={sourceSize}
          themePref={themePref}
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
          onSetDeleteShortcut={setDeleteShortcut}
          onSetOcrApiKey={setOcrApiKey}
          onSetOcrLanguage={setOcrLanguage}
          onSetSelectionKeyAxis={setSelectionKeyAxis}
          onSetThemePref={setThemePref}
          onSetThumbnailQuality={setThumbnailQuality}
        />
      )}

      {ocr && <OcrModal status={ocr.status} text={ocr.text} error={ocr.error} onClose={closeOcr} />}

      {batchOpen && (
        <BatchModal
          selectedCount={visibleSelectedIds.size}
          processableCount={
            [...visibleSelectedIds].filter((id) => {
              const asset = assetById.get(id)
              return Boolean(asset && BATCH_PROCESSABLE_KINDS.has(asset.kind))
            }).length
          }
          processing={batchProcessing}
          onClose={() => !batchProcessing && setBatchOpen(false)}
          onStart={runBatchProcess}
        />
      )}

      {collectPending && libraryRootPath && (
        <CollectOverlay
          previewUrl={collectPending.previewUrl}
          title={collectPending.payload.title}
          sourceUrl={collectPending.payload.sourceUrl}
          folders={orderedFolders}
          libraryName={libraryName}
          defaultFolder={lastCollectFolder}
          onConfirm={collectIntoFolder}
          onCancel={closeCollect}
        />
      )}

      {lightboxOpen && primaryAsset && (
        <Lightbox
          asset={primaryAsset}
          hasNext={lightboxIndex < visibleCount - 1}
          hasPrev={lightboxIndex > 0}
          index={lightboxIndex}
          total={visibleCount}
          onClose={() => setLightboxOpen(false)}
          onNext={() => navigateLightbox('next')}
          onPrev={() => navigateLightbox('prev')}
        />
      )}
    </div>
  )
}
