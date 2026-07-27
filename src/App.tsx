import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { confirm as tauriConfirm, open } from '@tauri-apps/plugin-dialog'
import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { DragEvent as ReactDragEvent, MouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import './App.css'
import './styles/settings.css'
import { Copy, FolderInput, Pencil, Trash2 } from 'lucide-react'
import { BatchModal } from './components/BatchModal'
import type { BatchOptions } from './components/BatchModal'
import { CollectOverlay } from './components/CollectOverlay'
import { ContextMenu } from './components/ContextMenu'
import type { ContextMenuItem } from './components/ContextMenu'
import { Lightbox } from './components/Lightbox'
import { LibraryView } from './components/LibraryView'
import { MovePicker } from './components/MovePicker'
import { OcrModal } from './components/OcrModal'
import { RenameModal } from './components/RenameModal'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { ThumbnailPromptModal } from './components/ThumbnailPromptModal'
import { TopBar } from './components/TopBar'
import { TrashView } from './components/TrashView'
import { assets as sampleAssets } from './data/mockLibrary'
import { dataTransferHasImage, extractImagePayload } from './lib/collect'
import type { CollectPayload } from './lib/collect'
import { formatMb } from './lib/format'
import { folderName, revokePreviewUrls, scanFilesInBatches } from './lib/library'
import { imageUrlToJpegDataUri, recognizeText } from './lib/ocr'
import {
  flushAppPrefs,
  getAppSettingsPath,
  readAppPrefs,
  revealAppSettingsFile,
  updateAppPrefs,
  writeAppPrefs,
} from './lib/prefs'
import type { PicmanAppPrefs } from './lib/prefs'
import { createRafNumberCommitter } from './lib/rafState'
import { startAssetDrag } from './lib/drag'
import { normalizeSearchText, withAssetSearchText } from './lib/search'
import { eventToShortcut } from './lib/shortcut'
import { sortAssetIds } from './lib/sort'
import {
  addThumbnailMetrics,
  appendAssetIds,
  appendAssetIndexes,
  appendAssetsToAssetMap,
  appendAssetsToLibraryCatalogState,
  appendItems,
  applyAssetUpdatesToArray,
  applyAssetUpdatesToMap,
  applyFolderOrder,
  assetIdsFromAssets,
  assetMatchesVisibleFilters,
  assetsByIds,
  assetsWithSearchText,
  assetUpdateAffectsCatalog,
  assetUpdateCanPatchCatalogTags,
  blurActiveElement,
  clamp,
  clampedPrefNumber,
  clearThumbnailUpdate,
  countProcessableAssets,
  createAssetIndexMap,
  createAssetMap,
  createAssetOperationTargets,
  createIdRangeSet,
  createLiveAssetByRelativePath,
  createNativeThumbnailSources,
  createScrollRestoreKey,
  createVisibleIndexMap,
  deriveLibraryCatalogState,
  deriveThumbnailMetrics,
  dragSourcePathsForSelection,
  frontendAssetsFromNative,
  getLiveAssets,
  lastIdInSet,
  libraryNameFromPath,
  mergeRefreshedAssets,
  nativeAssetToFrontend,
  prefSelectionKeyAxis,
  prefSortDir,
  prefSortField,
  prefTheme,
  prefThumbnailQuality,
  prefViewMode,
  prependItems,
  prepareThumbnailClearPatch,
  pushItems,
  removeIdsFromSet,
  removeItemsById,
  renameLibraryCatalogState,
  replaceAssetStore,
  retainIdsInSet,
  subtractThumbnailMetrics,
  thumbnailMetricsFromUpdates,
  updateAssetStore,
  updateCatalogTagsForAssetMetadata,
} from './lib/libraryModel'
import type { AssetReplacement } from './lib/libraryModel'
import type {
  Asset,
  AssetKind,
  AssetViewMode,
  AppUpdateState,
  FolderNode,
  ScrollJumpCommand,
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
const LIBRARY_CHANGED_EVENT = 'picman-library-changed'
const THUMBNAIL_BATCH_EVENT = 'picman-thumbnail-batch'
const THUMBNAIL_FINISHED_EVENT = 'picman-thumbnail-finished'
const THUMBNAIL_UPDATE_FLUSH_MS = 180
const THUMBNAIL_UPDATE_FLUSH_THRESHOLD = 256
const SCROLL_POSITION_SAVE_MS = 320

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
  usedCatalog: boolean
}

type ScanLibraryBatchPayload = {
  assets: NativeScannedAsset[]
  phase: 'catalog' | 'scan'
  scanId: string
  total: number
  usedCatalog: boolean
}

type ScanLibraryFinishedPayload = {
  libraryName: string
  rootPath: string
  scanId: string
  total: number
  usedCatalog: boolean
}

type ScanLibraryErrorPayload = {
  message: string
  scanId: string
}

type LibraryChangedPayload = {
  contentChanged: boolean
  rootPath: string
  settingsChanged: boolean
  watchId: string
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
  cacheFileCount: number
  cacheSizeBytes: number
  cancelled: boolean
  completed: number
  failed: number
  jobId: string
  prunedPaths: string[]
  total: number
}

type NativeThumbnailCacheResult = {
  fileCount: number
  removedPaths: string[]
  sizeBytes: number
}

type NativeLibraryIndexStats = {
  assetCount: number
  exists: boolean
  fileSizeBytes: number
  schemaVersion: number
  valid: boolean
}

type NativeScanMode = 'open' | 'refresh'

type ActiveNativeScan = {
  collectedAssets: Asset[]
  firstSelected: boolean
  flushTimer?: number
  id: string
  lastStatusAt: number
  libraryName: string
  mode: NativeScanMode
  pendingAssets: Asset[]
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
  folderCounts: Map<string, number>
  folders: FolderNode[]
  sourceSize: number
  tagCounts: Map<string, number>
  thumbnailFolders: FolderNode[]
}

type ThumbnailMetrics = {
  cacheSize: number
  generatedCount: number
}

type LibrarySettings = {
  folderOrder: string[]
}

type RestoreLibraryOptions = {
  activeFolder?: string
  activeTag?: string
}

const BATCH_PROCESSABLE_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>(['png', 'jpg', 'webp'])

type BatchProcessResult = {
  processed: { previousRelativePath: string; previousSizeKb: number; asset: NativeScannedAsset }[]
  failed: number
}

type AssetStore = {
  byId: Map<string, Asset>
  layoutVersion: number
  version: number
}

type VisibleLookupCache = {
  idSet?: Set<string>
  ids: string[]
  indexById?: Map<string, number>
}

const LARGE_SCAN_SORT_THRESHOLD = 2000
const OPEN_SCAN_FAST_FLUSH_MS = 90
const OPEN_SCAN_STEADY_FLUSH_MS = 180
const OPEN_SCAN_STEADY_PENDING_THRESHOLD = 1500
const OPEN_SCAN_FORCE_FLUSH_THRESHOLD = 4000
const SCAN_STATUS_UPDATE_MS = 240
const SAMPLE_LIBRARY_NAME = 'DesignAssets'
const VISIBLE_LOOKUP_LINEAR_THRESHOLD = 160

async function hideCurrentWindow() {
  try {
    await flushAppPrefs()
    await getCurrentWindowSafely()?.hide()
  } catch {
    // Browser previews cannot hide a native window.
  }
}

function getCurrentWindowSafely() {
  try {
    return getCurrentWindow()
  } catch {
    return null
  }
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
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

type AppProps = {
  initialPrefs: PicmanAppPrefs
}

export default function App({ initialPrefs }: AppProps) {
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
  const restoredThumbnailCountRef = useRef(0)
  const visibleLookupRef = useRef<VisibleLookupCache>({ ids: sampleAssets.map((asset) => asset.id) })
  const scrollJumpIdRef = useRef(0)
  const activeWatchIdRef = useRef<string | null>(null)
  const libraryRootPathRef = useRef<string | null>(null)
  const libraryScanStatusRef = useRef<LibraryScanStatus>('idle')
  const refreshLibraryRef = useRef<() => void>(() => undefined)
  const watchRefreshTimerRef = useRef<number | undefined>(undefined)
  const persistedPrefsRef = useRef<PicmanAppPrefs>(initialPrefs)
  const restoreLastLibraryAttemptedRef = useRef(false)
  const scrollPositionsRef = useRef<Record<string, number>>(persistedPrefsRef.current.scrollPositions ?? {})
  const scrollSaveTimerRef = useRef<number | undefined>(undefined)
  const persistedPrefs = persistedPrefsRef.current

  const [activeFolder, setActiveFolder] = useState(persistedPrefs.activeFolder ?? '/')
  const [activeTag, setActiveTag] = useState(persistedPrefs.activeTag ?? 'all')
  const [cacheLimit, setCacheLimit] = useState(() => clampedPrefNumber(persistedPrefs.cacheLimitGb, 5, 1, 20))
  const [collectorEnabled, setCollectorEnabled] = useState(persistedPrefs.collectorEnabled ?? true)
  const [collectPending, setCollectPending] = useState<{ payload: CollectPayload; previewUrl: string } | null>(null)
  const [lastCollectFolder, setLastCollectFolder] = useState(persistedPrefs.lastCollectFolder ?? '/Inbox')
  const [folderOrder, setFolderOrder] = useState<string[]>([])
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [assetMetadataVersion, setAssetMetadataVersion] = useState(0)
  const [libraryAssets, setLibraryAssets] = useState<Asset[]>(sampleAssets)
  const [libraryAssetIds, setLibraryAssetIds] = useState<string[]>(() => assetIdsFromAssets(sampleAssets))
  const [assetStore, setAssetStore] = useState<AssetStore>(() => ({
    byId: createAssetMap(sampleAssets),
    layoutVersion: 0,
    version: 0,
  }))
  const [libraryCatalog, setLibraryCatalog] = useState<LibraryCatalogState>(() =>
    deriveLibraryCatalogState(SAMPLE_LIBRARY_NAME, sampleAssets),
  )
  const [libraryName, setLibraryName] = useState(SAMPLE_LIBRARY_NAME)
  const [libraryRootPath, setLibraryRootPath] = useState<string | null>(null)
  const [libraryScanStatus, setLibraryScanStatus] = useState<LibraryScanStatus>('idle')
  const [libraryIndexStats, setLibraryIndexStats] = useState<NativeLibraryIndexStats>({
    assetCount: 0,
    exists: false,
    fileSizeBytes: 0,
    schemaVersion: 1,
    valid: false,
  })
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [primaryId, setPrimaryId] = useState<string | null>(sampleAssets[0].id)
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set([sampleAssets[0].id]))
  const [selectionKeyAxis, setSelectionKeyAxis] = useState<SelectionKeyAxis>(() =>
    prefSelectionKeyAxis(persistedPrefs.selectionKeyAxis),
  )
  const [keyboardScrollTargetId, setKeyboardScrollTargetId] = useState<string | null>(null)
  const [keyboardScrollVersion, setKeyboardScrollVersion] = useState(0)
  const [scrollJump, setScrollJump] = useState<ScrollJumpCommand | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [themePref, setThemePref] = useState<ThemePref>(() => prefTheme(persistedPrefs.themePref))
  const [ocrApiKey, setOcrApiKey] = useState(persistedPrefs.ocrApiKey ?? '')
  const [ocrLanguage, setOcrLanguage] = useState(persistedPrefs.ocrLanguage ?? 'chs')
  const [ocr, setOcr] = useState<{ status: 'loading' | 'done' | 'error'; text: string; error?: string } | null>(null)
  const [trashItems, setTrashItems] = useState<TrashItem[]>([])
  const [trashView, setTrashView] = useState(false)
  const [trashSelectedIds, setTrashSelectedIds] = useState<Set<string>>(() => new Set())
  const [deleteShortcut, setDeleteShortcut] = useState(persistedPrefs.deleteShortcut ?? 'Meta+Backspace')
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchProcessing, setBatchProcessing] = useState(false)
  const [assetMenu, setAssetMenu] = useState<{ x: number; y: number } | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Asset | null>(null)
  const [renameFolderTarget, setRenameFolderTarget] = useState<FolderNode | null>(null)
  const [thumbnailPromptOpen, setThumbnailPromptOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => clampedPrefNumber(persistedPrefs.sidebarWidth, 218, 176, 340))
  const [folderPaneHeight, setFolderPaneHeight] = useState(() =>
    clampedPrefNumber(persistedPrefs.folderPaneHeight, 226, 48, 700),
  )
  const [inspectorVisible, setInspectorVisible] = useState(persistedPrefs.inspectorVisible ?? true)
  const [sortDir, setSortDir] = useState<SortDir>(() => prefSortDir(persistedPrefs.sortDir))
  const [sortField, setSortField] = useState<SortField>(() => prefSortField(persistedPrefs.sortField))
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
  const [thumbnailQuality, setThumbnailQuality] = useState<ThumbnailQuality>(() =>
    prefThumbnailQuality(persistedPrefs.thumbnailQuality),
  )
  const [thumbnailState, setThumbnailState] = useState<ThumbnailState>('all')
  const [thumbSize, setThumbSize] = useState(() => clampedPrefNumber(persistedPrefs.thumbSize, 150, 90, 240))
  const [typeFilter, setTypeFilter] = useState<'all' | AssetKind>('all')
  const [updateState, setUpdateState] = useState<AppUpdateState>({
    message: '从 GitHub Releases 检查 Picman 测试版更新。',
    status: 'idle',
  })
  const [viewMode, setViewMode] = useState<AssetViewMode>(() => prefViewMode(persistedPrefs.viewMode))
  const appSettingsPath = getAppSettingsPath()
  const deferredQuery = useDeferredValue(query)
  const assetById = assetStore.byId
  const { allTags, folders, sourceSize, thumbnailFolders } = libraryCatalog
  const orderedFolders = useMemo(() => applyFolderOrder(folders, folderOrder), [folders, folderOrder])
  const { cacheSize, generatedCount } = thumbnailMetrics
  const totalAssetCount = libraryAssetIds.length
  const pendingCount = Math.max(0, totalAssetCount - generatedCount)
  const thumbnailFilterVersion = thumbnailState === 'all' ? 0 : assetStore.version
  const normalizedQuery = useMemo(() => normalizeSearchText(deferredQuery).trim(), [deferredQuery])
  const hasVisibleFilters =
    activeFolder !== '/' ||
    activeTag !== 'all' ||
    typeFilter !== 'all' ||
    thumbnailState !== 'all' ||
    normalizedQuery.length > 0
  const useOpenScanIdFastPath =
    libraryScanStatus === 'open' && !hasVisibleFilters && libraryAssetIds.length > LARGE_SCAN_SORT_THRESHOLD
  const shouldDeferSortDuringOpenScan =
    libraryScanStatus === 'open' && libraryAssetIds.length > LARGE_SCAN_SORT_THRESHOLD
  const sortedAssetIds = useMemo(
    () =>
      shouldDeferSortDuringOpenScan
        ? libraryAssetIds
        : sortAssetIds(libraryAssetIds, assetById, sortField, sortDir),
    [assetById, libraryAssetIds, shouldDeferSortDuringOpenScan, sortDir, sortField],
  )

  const visibleAssetIds = useMemo(() => {
    void assetMetadataVersion
    void thumbnailFilterVersion

    if (useOpenScanIdFastPath) return libraryAssetIds
    if (!hasVisibleFilters) return sortedAssetIds

    const searchQuery = normalizedQuery
    const ids = new Array<string>(sortedAssetIds.length)
    let matchedCount = 0

    for (const assetId of sortedAssetIds) {
      const asset = assetById.get(assetId)
      if (!asset) continue

      if (assetMatchesVisibleFilters(asset, activeFolder, activeTag, typeFilter, thumbnailState, searchQuery)) {
        ids[matchedCount] = assetId
        matchedCount += 1
      }
    }
    ids.length = matchedCount

    if (shouldDeferSortDuringOpenScan && ids.length <= LARGE_SCAN_SORT_THRESHOLD) {
      return sortAssetIds(ids, assetById, sortField, sortDir)
    }

    return ids
  }, [
    activeFolder,
    activeTag,
    assetMetadataVersion,
    assetById,
    hasVisibleFilters,
    libraryAssetIds,
    normalizedQuery,
    shouldDeferSortDuringOpenScan,
    sortedAssetIds,
    sortDir,
    sortField,
    thumbnailState,
    thumbnailFilterVersion,
    typeFilter,
    useOpenScanIdFastPath,
  ])

  const visibleCount = visibleAssetIds.length
  const getVisibleLookup = useCallback(() => {
    const cached = visibleLookupRef.current
    if (cached.ids === visibleAssetIds) return cached

    const next: VisibleLookupCache = { ids: visibleAssetIds }
    visibleLookupRef.current = next
    return next
  }, [visibleAssetIds])
  const getVisibleAssetIndex = useCallback(
    (assetId: string) => {
      if (visibleAssetIds.length <= VISIBLE_LOOKUP_LINEAR_THRESHOLD) return visibleAssetIds.indexOf(assetId)

      const lookup = getVisibleLookup()
      lookup.indexById ??= createVisibleIndexMap(visibleAssetIds)
      return lookup.indexById.get(assetId) ?? -1
    },
    [getVisibleLookup, visibleAssetIds],
  )
  const visibleSelectedIds = useMemo(
    () => {
      void assetMetadataVersion
      void thumbnailFilterVersion

      if (selectedIds.size === 0) return selectedIds
      if (!hasVisibleFilters) return selectedIds

      const next = new Set<string>()
      if (visibleAssetIds.length <= selectedIds.size) {
        for (const id of visibleAssetIds) {
          if (selectedIds.has(id)) next.add(id)
        }
        return next
      }

      for (const id of selectedIds) {
        const asset = assetById.get(id)
        if (asset && assetMatchesVisibleFilters(asset, activeFolder, activeTag, typeFilter, thumbnailState, normalizedQuery)) {
          next.add(id)
        }
      }
      return next
    },
    [
      activeFolder,
      activeTag,
      assetById,
      assetMetadataVersion,
      hasVisibleFilters,
      normalizedQuery,
      selectedIds,
      thumbnailFilterVersion,
      thumbnailState,
      typeFilter,
      visibleAssetIds,
    ],
  )
  const primaryCandidate = primaryId ? assetById.get(primaryId) : undefined
  const primaryAsset =
    primaryCandidate &&
    (!hasVisibleFilters ||
      assetMatchesVisibleFilters(primaryCandidate, activeFolder, activeTag, typeFilter, thumbnailState, normalizedQuery))
      ? primaryCandidate
      : undefined
  const lightboxIndex = lightboxOpen && primaryId ? getVisibleAssetIndex(primaryId) : -1
  const activeFilterCount =
    Number(activeTag !== 'all') +
    Number(typeFilter !== 'all') +
    Number(thumbnailState !== 'all') +
    Number(query.trim().length > 0)
  const breadcrumb =
    activeFolder === '/' ? libraryName : (activeFolder.split('/').filter(Boolean).at(-1) ?? libraryName)
  const scrollRestoreKey = useMemo(
    () =>
      createScrollRestoreKey(
        libraryRootPath,
        activeFolder,
        activeTag,
        viewMode,
        typeFilter,
        thumbnailState,
        sortField,
        sortDir,
      ),
    [activeFolder, activeTag, libraryRootPath, sortDir, sortField, thumbnailState, typeFilter, viewMode],
  )
  const restoredScrollTop = scrollPositionsRef.current[scrollRestoreKey] ?? 0

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
    libraryRootPathRef.current = libraryRootPath
  }, [libraryRootPath])

  useEffect(() => {
    libraryScanStatusRef.current = libraryScanStatus
  }, [libraryScanStatus])

  useEffect(() => {
    const nextPrefs: PicmanAppPrefs = {
      ...readAppPrefs(),
      activeFolder,
      activeTag,
      cacheLimitGb: cacheLimit,
      collectorEnabled,
      deleteShortcut,
      folderPaneHeight,
      inspectorVisible,
      lastCollectFolder,
      ocrApiKey,
      ocrLanguage,
      scrollPositions: scrollPositionsRef.current,
      selectionKeyAxis,
      sidebarWidth,
      sortDir,
      sortField,
      themePref,
      thumbSize,
      thumbnailQuality,
      viewMode,
    }
    if (libraryRootPath) nextPrefs.lastLibraryRootPath = libraryRootPath
    writeAppPrefs(nextPrefs)
  }, [
    activeFolder,
    activeTag,
    cacheLimit,
    collectorEnabled,
    deleteShortcut,
    folderPaneHeight,
    inspectorVisible,
    lastCollectFolder,
    libraryRootPath,
    ocrApiKey,
    ocrLanguage,
    selectionKeyAxis,
    sidebarWidth,
    sortDir,
    sortField,
    themePref,
    thumbSize,
    thumbnailQuality,
    viewMode,
  ])

  useEffect(() => {
    if (!isTauriRuntime()) return
    if (restoreLastLibraryAttemptedRef.current) return
    restoreLastLibraryAttemptedRef.current = true

    const lastLibraryRootPath = persistedPrefsRef.current.lastLibraryRootPath
    if (!lastLibraryRootPath) return

    void handleNativeFolderSelection(lastLibraryRootPath, {
      activeFolder: persistedPrefsRef.current.activeFolder,
      activeTag: persistedPrefsRef.current.activeTag,
    })
    // Run only once on app startup; the restore target comes from persisted prefs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    const appWindow = getCurrentWindowSafely()
    if (!appWindow) return

    let disposed = false
    let removeCloseListener: (() => void) | undefined

    void appWindow
      .onCloseRequested(async (event) => {
        event.preventDefault()
        await hideCurrentWindow()
      })
      .then((unlisten) => {
        if (disposed) unlisten()
        else removeCloseListener = unlisten
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      removeCloseListener?.()
    }
  }, [])

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
      restoredThumbnailCountRef.current += restoredThumbnailMetrics.generatedCount
      startTransition(() => {
        setAssetStore((current) => updateAssetStore(current, (assetMap) => appendAssetsToAssetMap(assetMap, incoming)))
        setLibraryCatalog((current) => appendAssetsToLibraryCatalogState(scan.libraryName, current, incoming))
        setLibraryAssetIds((current) => appendAssetIds(current, incoming))
        setLibraryAssets((current) => appendItems(current, incoming))
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
      if (!scan || scan.id !== scanId || scan.mode !== 'open') return

      if (scan.pendingAssets.length >= OPEN_SCAN_FORCE_FLUSH_THRESHOLD) {
        clearScanFlushTimer(scan)
        flushOpenScanAssets(scanId)
        return
      }

      if (scan.flushTimer) return

      const delay =
        scan.pendingAssets.length >= OPEN_SCAN_STEADY_PENDING_THRESHOLD
          ? OPEN_SCAN_STEADY_FLUSH_MS
          : OPEN_SCAN_FAST_FLUSH_MS
      scan.flushTimer = window.setTimeout(() => flushOpenScanAssets(scanId), delay)
    },
    [clearScanFlushTimer, flushOpenScanAssets],
  )

  const refreshLibraryIndexStats = useCallback((rootPath: string) => {
    if (!isTauriRuntime()) return
    void invoke<NativeLibraryIndexStats>('get_library_index_stats', { libraryRoot: rootPath })
      .then(setLibraryIndexStats)
      .catch(() => undefined)
  }, [])

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
      setLibraryCatalog(deriveLibraryCatalogState(payload.libraryName, merged.assets))
      setLibraryAssetIds(assetIdsFromAssets(merged.assets))
      setLibraryAssets(merged.assets)
      setLibraryName(payload.libraryName)
      setLibraryRootPath(payload.rootPath)
      setLibraryScanStatus('idle')
      setThumbnailMetrics(deriveThumbnailMetrics(merged.assets))
    })

    const survivingSelectedIds = retainIdsInSet(currentSelectedIds, merged.idSet)
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

  const applyNativeThumbnailCacheResult = useCallback((result: NativeThumbnailCacheResult) => {
    const cacheSize = Math.ceil(result.sizeBytes / 1024)
    if (result.removedPaths.length === 0) {
      setThumbnailMetrics((current) => ({ ...current, cacheSize }))
      return
    }

    const removedPaths = new Set(result.removedPaths)
    window.requestAnimationFrame(() => {
      const updates = new Map<string, Partial<Asset>>()
      let removedGeneratedCount = 0
      for (const asset of assetByIdRef.current.values()) {
        if (!asset.thumbnailPath || !removedPaths.has(asset.thumbnailPath)) continue
        if (asset.thumbnailUrl?.startsWith('blob:')) URL.revokeObjectURL(asset.thumbnailUrl)
        if (asset.thumbnailReady) removedGeneratedCount += 1
        updates.set(asset.id, clearThumbnailUpdate())
      }
      if (updates.size > 0) {
        setAssetStore((current) =>
          updateAssetStore(current, (assetMap) => applyAssetUpdatesToMap(assetMap, updates)),
        )
      }
      setThumbnailMetrics((current) => ({
        cacheSize,
        generatedCount: Math.max(0, current.generatedCount - removedGeneratedCount),
      }))
    })
  }, [])

  const refreshThumbnailCacheStats = useCallback(
    (rootPath: string) => {
      void invoke<NativeThumbnailCacheResult>('get_thumbnail_cache_stats', { libraryRoot: rootPath })
        .then(applyNativeThumbnailCacheResult)
        .catch(() => undefined)
    },
    [applyNativeThumbnailCacheResult],
  )

  useEffect(() => {
    if (!libraryRootPath || !isTauriRuntime()) return
    const timer = window.setTimeout(() => {
      void invoke<NativeThumbnailCacheResult>('apply_thumbnail_cache_limit', {
        libraryRoot: libraryRootPath,
        maxBytes: Math.round(cacheLimit * 1024 * 1024 * 1024),
      })
        .then(applyNativeThumbnailCacheResult)
        .catch(() => undefined)
    }, 450)
    return () => window.clearTimeout(timer)
  }, [applyNativeThumbnailCacheResult, cacheLimit, libraryRootPath])

  useEffect(() => {
    if (settingsOpen && libraryRootPath) refreshLibraryIndexStats(libraryRootPath)
  }, [libraryRootPath, refreshLibraryIndexStats, settingsOpen])

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
    if (!isTauriRuntime()) return

    let disposed = false
    const unlisteners: Array<() => void> = []

    async function registerScanListeners() {
      const unlistenBatch = await listen<ScanLibraryBatchPayload>(SCAN_BATCH_EVENT, (event) => {
        const scan = activeNativeScanRef.current
        if (!scan || scan.id !== event.payload.scanId) return

        const incoming = frontendAssetsFromNative(event.payload.assets)
        if (incoming.length === 0) return
        const now = window.performance.now()
        const shouldUpdateStatus = now - scan.lastStatusAt >= SCAN_STATUS_UPDATE_MS
        if (shouldUpdateStatus) scan.lastStatusAt = now

        const reconcileCatalog = event.payload.usedCatalog && event.payload.phase === 'scan'
        if (scan.mode === 'refresh' || reconcileCatalog) {
          pushItems(scan.collectedAssets, incoming)
          if (shouldUpdateStatus) {
            const action = scan.mode === 'refresh' ? '正在后台刷新' : '正在后台校验'
            setStatusMessage(`${scan.libraryName} · ${action} ${event.payload.total} 个素材`)
          }
        } else {
          pushItems(scan.pendingAssets, incoming)
          scheduleOpenScanFlush(scan.id)
          if (shouldUpdateStatus) {
            const action = event.payload.phase === 'catalog' ? '正在恢复目录索引' : '正在扫描'
            setStatusMessage(`${scan.libraryName} · ${action} ${event.payload.total} 个素材`)
          }
        }
      })
      const unlistenFinished = await listen<ScanLibraryFinishedPayload>(SCAN_FINISHED_EVENT, (event) => {
        const scan = activeNativeScanRef.current
        if (!scan || scan.id !== event.payload.scanId) return
        refreshLibraryIndexStats(event.payload.rootPath)

        if (scan.mode === 'refresh') {
          finishRefreshScan(scan, event.payload)
          refreshThumbnailCacheStats(event.payload.rootPath)
          disposeActiveNativeScan()
          return
        }

        if (event.payload.usedCatalog) {
          flushOpenScanAssets(scan.id)
          const freshThumbnailCount = deriveThumbnailMetrics(scan.collectedAssets).generatedCount
          finishRefreshScan(scan, event.payload)
          refreshThumbnailCacheStats(event.payload.rootPath)
          disposeActiveNativeScan()
          if (event.payload.total === 0) {
            setSelectedIds(new Set())
            setPrimaryId(null)
          } else if (freshThumbnailCount === 0) {
            setThumbnailPromptOpen(true)
          }
          return
        }

        flushOpenScanAssets(scan.id)
        disposeActiveNativeScan()
        setLibraryScanStatus('idle')
        setLibraryName(event.payload.libraryName)
        setLibraryCatalog((current) => renameLibraryCatalogState(event.payload.libraryName, current))
        setLibraryRootPath(event.payload.rootPath)
        refreshThumbnailCacheStats(event.payload.rootPath)
        setStatusMessage(`${event.payload.libraryName} · ${event.payload.total} 个素材`)

        if (event.payload.total === 0) {
          setSelectedIds(new Set())
          setPrimaryId(null)
        } else if (restoredThumbnailCountRef.current === 0) {
          // Freshly opened a library that has no thumbnails yet — offer to generate.
          setThumbnailPromptOpen(true)
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
  }, [
    disposeActiveNativeScan,
    finishRefreshScan,
    flushOpenScanAssets,
    refreshLibraryIndexStats,
    refreshThumbnailCacheStats,
    scheduleOpenScanFlush,
  ])

  useEffect(() => {
    if (!isTauriRuntime()) return
    let disposed = false
    let unlisten: (() => void) | undefined

    function queueWatchedLibraryRefresh(payload: LibraryChangedPayload) {
      if (payload.watchId !== activeWatchIdRef.current) return
      if (payload.rootPath !== libraryRootPathRef.current) return
      if (payload.settingsChanged) {
        void invoke<LibrarySettings>('read_library_settings', { libraryRoot: payload.rootPath })
          .then((settings) => {
            if (payload.watchId === activeWatchIdRef.current && payload.rootPath === libraryRootPathRef.current) {
              setFolderOrder(settings.folderOrder ?? [])
            }
          })
          .catch(() => undefined)
      }
      if (!payload.contentChanged) return
      if (watchRefreshTimerRef.current) window.clearTimeout(watchRefreshTimerRef.current)

      const attemptRefresh = () => {
        if (disposed || payload.watchId !== activeWatchIdRef.current) return
        if (libraryScanStatusRef.current !== 'idle') {
          watchRefreshTimerRef.current = window.setTimeout(attemptRefresh, 600)
          return
        }
        watchRefreshTimerRef.current = undefined
        refreshLibraryRef.current()
      }
      watchRefreshTimerRef.current = window.setTimeout(attemptRefresh, 850)
    }

    void listen<LibraryChangedPayload>(LIBRARY_CHANGED_EVENT, (event) => {
      queueWatchedLibraryRefresh(event.payload)
    }).then((removeListener) => {
      if (disposed) removeListener()
      else unlisten = removeListener
    })

    return () => {
      disposed = true
      if (watchRefreshTimerRef.current) window.clearTimeout(watchRefreshTimerRef.current)
      watchRefreshTimerRef.current = undefined
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!isTauriRuntime()) return

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
        applyNativeThumbnailCacheResult({
          fileCount: event.payload.cacheFileCount,
          removedPaths: event.payload.prunedPaths,
          sizeBytes: event.payload.cacheSizeBytes,
        })
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
  }, [applyNativeThumbnailCacheResult, flushNativeThumbnailUpdates, queueNativeThumbnailBatch])

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
    if (!collectorEnabled) return

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
  }, [beginCollect, collectorEnabled])

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

      const currentIndex = primaryId ? getVisibleAssetIndex(primaryId) : -1
      const current = currentIndex === -1 ? 0 : currentIndex
      const nextIndex = dir === 'prev' ? Math.max(0, current - 1) : Math.min(visibleCount - 1, current + 1)
      const nextAsset = getVisibleAssetAt(nextIndex)
      if (!nextAsset) return

      setPrimaryId(nextAsset.id)
      setSelectedIds(new Set([nextAsset.id]))
      blurActiveElement()
    },
    [getVisibleAssetAt, getVisibleAssetIndex, primaryId, visibleCount],
  )

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        void hideCurrentWindow()
        return
      }

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

      if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const edge = event.key === 'ArrowUp' ? 'top' : event.key === 'ArrowDown' ? 'bottom' : null
        if (edge) {
          event.preventDefault()
          if (visibleCount === 0) return

          const targetId = edge === 'top' ? visibleAssetIds[0] : visibleAssetIds.at(-1)
          if (!targetId) return

          setSelectedIds(new Set([targetId]))
          setPrimaryId(targetId)
          setKeyboardScrollTargetId(targetId)
          setKeyboardScrollVersion((version) => version + 1)
          scrollJumpIdRef.current += 1
          setScrollJump({ edge, id: scrollJumpIdRef.current })
          blurActiveElement()
          return
        }
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

        const currentIndex = primaryId ? getVisibleAssetIndex(primaryId) : -1
        const isPrevKey = selectionKeyAxis === 'horizontal' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp'

        const nextIndex =
          currentIndex === -1
            ? 0
            : isPrevKey
            ? Math.max(0, currentIndex - 1)
            : Math.min(visibleAssetIds.length - 1, currentIndex + 1)
        const nextId = visibleAssetIds[nextIndex]
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
    getVisibleAssetAt,
    getVisibleAssetIndex,
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
        setPrimaryId(primaryId && next.has(primaryId) ? primaryId : lastIdInSet(next))
      } else {
        next.add(asset.id)
        setPrimaryId(asset.id)
      }
      setSelectedIds(next)
    } else if (event.shiftKey) {
      const startIndex = primaryId ? getVisibleAssetIndex(primaryId) : -1
      const endIndex = getVisibleAssetIndex(asset.id)
      const safeStart = startIndex === -1 ? endIndex : startIndex
      const [from, to] = safeStart <= endIndex ? [safeStart, endIndex] : [endIndex, safeStart]

      setSelectedIds(createIdRangeSet(visibleAssetIds, from, to))
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

  async function handleNativeFolderSelection(rootPath: string, restoreOptions: RestoreLibraryOptions = {}) {
    const scanId = createScanId()
    const optimisticLibraryName = libraryNameFromPath(rootPath)
    const nextActiveFolder = restoreOptions.activeFolder ?? '/'
    const nextActiveTag = restoreOptions.activeTag ?? 'all'

    activeBrowserScanRef.current = null
    disposeActiveNativeScan()
    cancelNativeThumbnailGeneration()
    activeNativeScanRef.current = {
      collectedAssets: [],
      firstSelected: false,
      id: scanId,
      lastStatusAt: 0,
      libraryName: optimisticLibraryName,
      mode: 'open',
      pendingAssets: [],
    }
    thumbnailRunRef.current += 1
    restoredThumbnailCountRef.current = 0
    setThumbnailPromptOpen(false)
    setLibraryScanStatus('open')
    setLibraryIndexStats({ assetCount: 0, exists: false, fileSizeBytes: 0, schemaVersion: 1, valid: false })
    setThumbnailMetrics({ cacheSize: 0, generatedCount: 0 })
    libraryAssetIndexByIdRef.current = new Map<string, number>()
    setAssetStore((current) => replaceAssetStore(current, []))
    setLibraryCatalog(deriveLibraryCatalogState(optimisticLibraryName, []))
    setLibraryAssetIds([])
    setLibraryAssets((current) => {
      revokePreviewUrls(current)
      return []
    })
    setLibraryRootPath(rootPath)
    setLibraryName(optimisticLibraryName)
    setActiveFolder(nextActiveFolder)
    setActiveTag(nextActiveTag)
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
      const scan = await invoke<ScanLibraryStartResponse>('scan_library_folder_stream', {
        rootPath,
        scanId,
        useCatalogSnapshot: true,
      })
      const activeScan = activeNativeScanRef.current
      if (!activeScan || activeScan.id !== scanId) return

      activeScan.libraryName = scan.libraryName
      const watchId = `library-${scanId}`
      activeWatchIdRef.current = watchId
      void invoke('watch_library', {
        rootPath: scan.rootPath,
        watchId,
      }).catch(() => undefined)
      setLibraryRootPath(scan.rootPath)
      setLibraryName(scan.libraryName)
      setLibraryCatalog((current) => renameLibraryCatalogState(scan.libraryName, current))
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
    activeWatchIdRef.current = null
    void invoke('stop_library_watch').catch(() => undefined)
    disposeActiveNativeScan()
    cancelNativeThumbnailGeneration()
    thumbnailRunRef.current += 1
    setLibraryScanStatus('open')
    setLibraryIndexStats({ assetCount: 0, exists: false, fileSizeBytes: 0, schemaVersion: 1, valid: false })
    setThumbnailMetrics({ cacheSize: 0, generatedCount: 0 })
    libraryAssetIndexByIdRef.current = new Map<string, number>()
    setAssetStore((current) => replaceAssetStore(current, []))
    setLibraryCatalog(deriveLibraryCatalogState(nextLibraryName, []))
    setLibraryAssetIds([])

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
        const incoming = assetsWithSearchText(batch)
        scannedTotal = scanned

        appendAssetIndexes(libraryAssetIndexByIdRef.current, libraryAssetIndexByIdRef.current.size, incoming)
        startTransition(() => {
          setAssetStore((current) => updateAssetStore(current, (assetMap) => appendAssetsToAssetMap(assetMap, incoming)))
          setLibraryCatalog((current) => appendAssetsToLibraryCatalogState(nextLibraryName, current, incoming))
          setLibraryAssetIds((current) => appendAssetIds(current, incoming))
          setLibraryAssets((current) => appendItems(current, incoming))
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
      lastStatusAt: 0,
      libraryName: libraryName || optimisticLibraryName,
      mode: 'refresh',
      pendingAssets: [],
    }
    setStatusMessage(`${libraryName || optimisticLibraryName} · 正在启动后台刷新...`)

    try {
      const scan = await invoke<ScanLibraryStartResponse>('scan_library_folder_stream', {
        rootPath: libraryRootPath,
        scanId,
        useCatalogSnapshot: false,
      })
      const activeScan = activeNativeScanRef.current
      if (!activeScan || activeScan.id !== scanId) return

      activeScan.libraryName = scan.libraryName
      setLibraryRootPath(scan.rootPath)
      setLibraryName(scan.libraryName)
      setLibraryCatalog((current) => renameLibraryCatalogState(scan.libraryName, current))
      setStatusMessage(`${scan.libraryName} · 正在后台刷新资源目录...`)
    } catch (error) {
      if (activeNativeScanRef.current?.id !== scanId) return

      disposeActiveNativeScan()
      setLibraryScanStatus('idle')
      const message = error instanceof Error ? error.message : '刷新失败'
      setStatusMessage(`刷新失败：${message}`)
    }
  }

  useEffect(() => {
    refreshLibraryRef.current = () => {
      void refreshLibrary()
    }
  })

  async function generateThumbnailAssets(
    targetAssets: Asset[],
    scopeLabel: string,
    quality: ThumbnailQuality = thumbnailQuality,
    force = true,
  ) {
    if (targetAssets.length === 0) {
      setStatusMessage(`${scopeLabel} 中没有可生成缩略图的素材`)
      return
    }

    const runId = thumbnailRunRef.current + 1
    thumbnailRunRef.current = runId
    const thumbnailClear = prepareThumbnailClearPatch(targetAssets)
    const firstName = targetAssets[0]?.name
    const pendingAssetUpdates = new Map<string, Partial<Asset>>()
    let failedCount = 0
    let lastProgressAt = 0

    setThumbnailMetrics((current) => subtractThumbnailMetrics(current, thumbnailClear.metrics))
    setAssetStore((current) =>
      updateAssetStore(current, (assetMap) => applyAssetUpdatesToMap(assetMap, thumbnailClear.updates)),
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

    const nativeSources = libraryRootPath ? createNativeThumbnailSources(targetAssets) : null
    if (libraryRootPath && nativeSources) {
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
          cacheLimitBytes: Math.round(cacheLimit * 1024 * 1024 * 1024),
          force,
          jobId,
          libraryRoot: libraryRootPath,
          quality,
          sources: nativeSources,
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

  function compressThumbnailCache() {
    const generatedAssets: Asset[] = []
    for (const asset of libraryAssetsRef.current) {
      const liveAsset = assetByIdRef.current.get(asset.id) ?? asset
      if (liveAsset.thumbnailReady) generatedAssets.push(liveAsset)
    }
    void generateThumbnailAssets(generatedAssets, '压缩已有缓存', 'compact', true)
  }

  function generateFolderThumbnails(folderPaths: string[]) {
    const selectedFolders = new Set(folderPaths)
    const selectedAssets: Asset[] = []
    for (const asset of libraryAssetsRef.current) {
      const liveAsset = assetByIdRef.current.get(asset.id) ?? asset
      if (selectedFolders.has(liveAsset.folder)) selectedAssets.push(liveAsset)
    }
    const label =
      folderPaths.length === 1
        ? folderName(folderPaths[0], libraryName)
        : `${folderPaths.length} 个文件夹`

    void generateThumbnailAssets(selectedAssets, label)
  }

  function confirmThumbnailPrompt(selection: string[] | 'all') {
    setThumbnailPromptOpen(false)
    if (selection === 'all') generateAllThumbnails()
    else if (selection.length > 0) generateFolderThumbnails(selection)
  }

  function clearThumbnailCache() {
    thumbnailRunRef.current += 1
    cancelNativeThumbnailGeneration()
    const liveAssets = getLiveAssets(libraryAssetsRef.current, assetByIdRef.current)
    const thumbnailClear = prepareThumbnailClearPatch(liveAssets)
    setThumbnailMetrics({ cacheSize: 0, generatedCount: 0 })
    if (libraryRootPath) {
      void invoke('clear_thumbnail_cache', { libraryRoot: libraryRootPath }).catch(() => undefined)
    }
    setAssetStore((current) =>
      updateAssetStore(current, (assetMap) => applyAssetUpdatesToMap(assetMap, thumbnailClear.updates)),
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

  async function clearLibraryIndex() {
    if (!libraryRootPath || !isTauriRuntime()) return
    try {
      const stats = await invoke<NativeLibraryIndexStats>('clear_library_index', { libraryRoot: libraryRootPath })
      setLibraryIndexStats(stats)
      setStatusMessage('本地目录索引已清理；图片和元数据文件未改动')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatusMessage(`目录索引清理失败：${message}`)
    }
  }

  function rebuildLibraryIndex() {
    if (!libraryRootPath || libraryScanStatus !== 'idle') return
    void refreshLibrary()
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

  function insertCollectedAssets(assets: Asset[]) {
    if (assets.length === 0) return

    appendAssetIndexes(libraryAssetIndexByIdRef.current, libraryAssetIndexByIdRef.current.size, assets)
    setAssetStore((current) =>
      updateAssetStore(current, (assetMap) => appendAssetsToAssetMap(assetMap, assets)),
    )
    setLibraryCatalog((current) => appendAssetsToLibraryCatalogState(libraryName, current, assets))
    setLibraryAssetIds((current) => appendAssetIds(current, assets))
    setLibraryAssets((current) => appendItems(current, assets))
  }

  function insertCollectedAsset(asset: Asset) {
    insertCollectedAssets([asset])
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
      void invoke<NativeThumbnailCacheResult>('apply_thumbnail_cache_limit', {
        libraryRoot: libraryRootPath,
        maxBytes: Math.round(cacheLimit * 1024 * 1024 * 1024),
      })
        .then(applyNativeThumbnailCacheResult)
        .catch(() => undefined)
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

  async function revealSettingsFile() {
    try {
      await revealAppSettingsFile()
    } catch (error) {
      setStatusMessage(error instanceof Error ? `无法定位设置文件：${error.message}` : '无法定位设置文件')
    }
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

    const sourceAssets = libraryAssetsRef.current
    const removedAssets = new Array<Asset>(Math.min(removedIds.size, sourceAssets.length))
    const nextAssets = new Array<Asset>(Math.max(0, sourceAssets.length - removedIds.size))
    let nextAssetCount = 0
    let removedAssetCount = 0
    const removedMetrics: ThumbnailMetrics = { cacheSize: 0, generatedCount: 0 }

    for (const asset of sourceAssets) {
      if (!removedIds.has(asset.id)) {
        nextAssets[nextAssetCount] = asset
        nextAssetCount += 1
        continue
      }

      const liveAsset = assetByIdRef.current.get(asset.id) ?? asset
      removedAssets[removedAssetCount] = liveAsset
      removedAssetCount += 1
      if (liveAsset.thumbnailReady) {
        removedMetrics.generatedCount += 1
        removedMetrics.cacheSize += liveAsset.thumbnailSizeKb ?? 0
      }
    }
    nextAssets.length = nextAssetCount
    removedAssets.length = removedAssetCount

    revokePreviewUrls(removedAssets)
    libraryAssetIndexByIdRef.current = createAssetIndexMap(nextAssets)

    setAssetStore((current) =>
      updateAssetStore(current, (assetMap) => {
        for (const id of removedIds) assetMap.delete(id)
        return true
      }),
    )
    setLibraryCatalog(deriveLibraryCatalogState(libraryName, nextAssets))
    setLibraryAssetIds(assetIdsFromAssets(nextAssets))
    setLibraryAssets(nextAssets)
    if (removedMetrics.generatedCount > 0 || removedMetrics.cacheSize > 0) {
      setThumbnailMetrics((current) => subtractThumbnailMetrics(current, removedMetrics))
    }
    setSelectedIds((current) => removeIdsFromSet(current, removedIds))
    setPrimaryId((current) => (current && removedIds.has(current) ? null : current))
  }

  async function deleteSelectedToTrash() {
    if (!libraryRootPath) {
      setStatusMessage('请先打开本地资源目录后再删除')
      return
    }

    const targets = createAssetOperationTargets(
      assetsByIds(visibleSelectedIds, assetByIdRef.current),
      (asset) => Boolean(asset.sourcePath),
    )
    if (targets.targets.length === 0) return

    try {
      const created = await invoke<TrashItem[]>('move_to_trash', {
        libraryRoot: libraryRootPath,
        relativePaths: targets.relativePaths,
      })
      removeAssetsFromLibrary(targets.ids)
      setTrashItems((current) => prependItems(created, current))
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
      const restoredAssets = new Array<Asset>(restored.length)
      let restoredAssetCount = 0
      for (const scanned of restored) {
        const asset = nativeAssetToFrontend(scanned)
        if (!assetByIdRef.current.has(asset.id)) {
          restoredAssets[restoredAssetCount] = asset
          restoredAssetCount += 1
        }
      }
      restoredAssets.length = restoredAssetCount
      insertCollectedAssets(restoredAssets)
      const idSet = new Set(ids)
      setTrashItems((current) => removeItemsById(current, idSet))
      setTrashSelectedIds((current) => removeIdsFromSet(current, idSet))
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

    const targets = createAssetOperationTargets(
      assetsByIds(visibleSelectedIds, assetByIdRef.current),
      (asset) => Boolean(asset.sourcePath && BATCH_PROCESSABLE_KINDS.has(asset.kind)),
    )
    if (targets.targets.length === 0) {
      setStatusMessage('所选素材中没有可处理的图片（仅支持 PNG/JPG/WebP）')
      return
    }

    setBatchProcessing(true)
    try {
      const result = await invoke<BatchProcessResult>('batch_process_images', {
        libraryRoot: libraryRootPath,
        relativePaths: targets.relativePaths,
        options: {
          maxEdge: options.resizeMode === 'maxEdge' ? options.maxEdge : null,
          scalePercent: options.resizeMode === 'percent' ? options.percent : null,
          quality: options.quality,
        },
      })

      const removedIds = new Set<string>()
      const newAssets: Asset[] = []
      const newAssetIds = new Set<string>()
      let previousKb = 0
      let nextKb = 0
      for (const entry of result.processed) {
        const removedId = targets.idByRelativePath.get(entry.previousRelativePath)
        if (removedId) removedIds.add(removedId)

        const asset = nativeAssetToFrontend(entry.asset)
        newAssets.push(asset)
        newAssetIds.add(asset.id)
        previousKb += entry.previousSizeKb
        nextKb += asset.sizeKb
      }
      removeAssetsFromLibrary(removedIds)

      insertCollectedAssets(newAssets)
      setSelectedIds(newAssetIds)
      setPrimaryId(newAssets[0]?.id ?? null)

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

  async function rotateAssets(assets: Asset[], quarterTurns: number) {
    if (!libraryRootPath) return

    const targets = createAssetOperationTargets(
      assets,
      (asset) => Boolean(asset.sourcePath && BATCH_PROCESSABLE_KINDS.has(asset.kind)),
    )
    if (targets.targets.length === 0) {
      setStatusMessage('所选素材中没有可旋转的图片（仅支持 PNG/JPG/WebP）')
      return
    }

    try {
      const results = await invoke<{ previousRelativePath: string; asset: NativeScannedAsset }[]>('rotate_images', {
        libraryRoot: libraryRootPath,
        relativePaths: targets.relativePaths,
        quarterTurns,
      })
      if (results.length === 0) {
        setStatusMessage('旋转失败')
        return
      }

      const removedIds = new Set<string>()
      const newAssets: Asset[] = []
      const newAssetIds = new Set<string>()
      for (const entry of results) {
        const removedId = targets.idByRelativePath.get(entry.previousRelativePath)
        if (removedId) removedIds.add(removedId)

        const asset = nativeAssetToFrontend(entry.asset)
        newAssets.push(asset)
        newAssetIds.add(asset.id)
      }
      removeAssetsFromLibrary(removedIds)

      insertCollectedAssets(newAssets)
      setSelectedIds(newAssetIds)
      setPrimaryId(newAssets[0]?.id ?? null)
      void regenerateThumbnailsSequentially(newAssets)
      setStatusMessage(`已旋转 ${newAssets.length} 张`)
    } catch (error) {
      setStatusMessage(`旋转失败：${error instanceof Error ? error.message : ''}`)
    }
  }

  function handleAssetDragStart(asset: Asset, event: ReactDragEvent<HTMLDivElement>) {
    if (!libraryRootPath) return

    const paths = dragSourcePathsForSelection(asset, visibleSelectedIds, assetByIdRef.current)
    if (paths.length === 0) return

    event.preventDefault()
    void startAssetDrag(paths).catch(() => undefined)
  }

  function handleAssetContextMenu(asset: Asset, event: MouseEvent<HTMLDivElement>) {
    event.preventDefault()
    if (!visibleSelectedIds.has(asset.id)) {
      setSelectedIds(new Set([asset.id]))
      setPrimaryId(asset.id)
    }
    setAssetMenu({ x: event.clientX, y: event.clientY })
  }

  function copyAssetImage(asset: Asset) {
    if (!asset.sourcePath) {
      setStatusMessage('该素材无法复制图片')
      return
    }
    void invoke('copy_image_to_clipboard', { sourcePath: asset.sourcePath })
      .then(() => setStatusMessage(`已复制图片到剪贴板：${asset.name}`))
      .catch((error) => setStatusMessage(`复制失败：${error instanceof Error ? error.message : ''}`))
  }

  function replaceLibraryAssets(replacements: AssetReplacement[]) {
    if (replacements.length === 0) return

    const oldIds = new Set<string>()
    const oldToNew = new Map<string, string>()
    const merged: Asset[] = []
    for (const { oldAsset, oldId, asset } of replacements) {
      oldIds.add(oldId)
      const nextAsset = oldAsset?.thumbnailReady
        ? {
            ...asset,
            thumbnailReady: true,
            thumbnailUrl: oldAsset.thumbnailUrl,
            thumbnailPath: oldAsset.thumbnailPath,
            thumbnailFormat: oldAsset.thumbnailFormat,
            thumbnailWidth: oldAsset.thumbnailWidth,
            thumbnailHeight: oldAsset.thumbnailHeight,
            thumbnailSizeKb: oldAsset.thumbnailSizeKb,
            thumbnailQuality: oldAsset.thumbnailQuality,
            thumbnailVersion: oldAsset.thumbnailVersion,
          }
        : asset

      merged.push(nextAsset)
      oldToNew.set(oldId, nextAsset.id)
    }

    const nextAssets: Asset[] = []
    for (const asset of libraryAssetsRef.current) {
      if (!oldIds.has(asset.id)) nextAssets.push(asset)
    }
    pushItems(nextAssets, merged)
    libraryAssetIndexByIdRef.current = createAssetIndexMap(nextAssets)

    setAssetStore((current) =>
      updateAssetStore(current, (assetMap) => {
        for (const id of oldIds) assetMap.delete(id)
        for (const asset of merged) assetMap.set(asset.id, asset)
        return true
      }),
    )
    setLibraryCatalog(deriveLibraryCatalogState(libraryName, nextAssets))
    setLibraryAssetIds(assetIdsFromAssets(nextAssets))
    setLibraryAssets(nextAssets)
    setSelectedIds((current) => {
      const next = new Set<string>()
      for (const id of current) next.add(oldToNew.get(id) ?? id)
      return next
    })
    setPrimaryId((current) => (current ? (oldToNew.get(current) ?? current) : current))
  }

  async function moveSelectedTo(targetFolder: string) {
    setMoveOpen(false)
    if (!libraryRootPath) return

    const targets = createAssetOperationTargets(
      assetsByIds(visibleSelectedIds, assetByIdRef.current),
      (asset) => Boolean(asset.sourcePath),
    )
    if (targets.targets.length === 0) return

    try {
      const moved = await invoke<{ previousRelativePath: string; asset: NativeScannedAsset }[]>('move_assets', {
        libraryRoot: libraryRootPath,
        relativePaths: targets.relativePaths,
        targetFolder,
      })
      if (moved.length === 0) {
        setStatusMessage('未移动（已在目标文件夹）')
        return
      }

      const replacements: AssetReplacement[] = []
      for (const entry of moved) {
        const oldAsset = targets.assetByRelativePath.get(entry.previousRelativePath)
        if (oldAsset) replacements.push({ oldId: oldAsset.id, oldAsset, asset: nativeAssetToFrontend(entry.asset) })
      }
      replaceLibraryAssets(replacements)
      setStatusMessage(`已移动 ${replacements.length} 项`)
    } catch (error) {
      setStatusMessage(`移动失败：${error instanceof Error ? error.message : ''}`)
    }
  }

  async function renameSelectedAsset(newName: string) {
    const target = renameTarget
    setRenameTarget(null)
    if (!target || !libraryRootPath) return

    try {
      const scanned = await invoke<NativeScannedAsset>('rename_asset', {
        libraryRoot: libraryRootPath,
        relativePath: target.relativePath,
        newName,
      })
      replaceLibraryAssets([{ oldId: target.id, oldAsset: target, asset: nativeAssetToFrontend(scanned) }])
      setStatusMessage(`已重命名为 ${scanned.name}`)
    } catch (error) {
      setStatusMessage(`重命名失败：${error instanceof Error ? error.message : ''}`)
    }
  }

  function revealFolderInFinder(folder: FolderNode) {
    if (!libraryRootPath) return
    const path = folder.path === '/' ? libraryRootPath : `${libraryRootPath}${folder.path}`
    void invoke('reveal_in_finder', { path }).catch((error) => {
      setStatusMessage(`无法打开 Finder：${error instanceof Error ? error.message : ''}`)
    })
  }

  function remapFolderPath(path: string, oldPath: string, newPath: string) {
    if (path === oldPath) return newPath
    if (path.startsWith(`${oldPath}/`)) return `${newPath}${path.slice(oldPath.length)}`
    return path
  }

  async function renameFolderTo(newName: string) {
    const folder = renameFolderTarget
    setRenameFolderTarget(null)
    if (!folder || !libraryRootPath || folder.path === '/') return

    const oldPath = folder.path
    const cleanName = newName.trim()
    if (!cleanName || cleanName === folder.name) return

    try {
      const remaps = await invoke<{ previousRelativePath: string; asset: NativeScannedAsset }[]>('rename_folder', {
        libraryRoot: libraryRootPath,
        folderRelativePath: oldPath.replace(/^\/+/, ''),
        newName: cleanName,
      })

      const parent = oldPath.slice(0, oldPath.lastIndexOf('/'))
      const newPath = `${parent}/${cleanName}`

      const byRelativePath = createLiveAssetByRelativePath(libraryAssetsRef.current, assetByIdRef.current)
      const replacements: AssetReplacement[] = []
      for (const entry of remaps) {
        const oldAsset = byRelativePath.get(entry.previousRelativePath)
        if (oldAsset) replacements.push({ oldId: oldAsset.id, oldAsset, asset: nativeAssetToFrontend(entry.asset) })
      }
      replaceLibraryAssets(replacements)

      setActiveFolder((current) => remapFolderPath(current, oldPath, newPath))
      setFolderOrder((current) => {
        const next = current.map((path) => remapFolderPath(path, oldPath, newPath))
        if (libraryRootPath) {
          void invoke('write_library_settings', {
            libraryRoot: libraryRootPath,
            settings: { folderOrder: next },
          }).catch(() => undefined)
        }
        return next
      })
      setStatusMessage(`已重命名文件夹为 ${cleanName}`)
    } catch (error) {
      setStatusMessage(`重命名文件夹失败：${error instanceof Error ? error.message : ''}`)
    }
  }

  function writeAssetToStore(updatedAsset: Asset) {
    const updates = new Map<string, Partial<Asset>>([[updatedAsset.id, updatedAsset]])
    setAssetStore((current) =>
      updateAssetStore(current, (assetMap) => applyAssetUpdatesToMap(assetMap, updates)),
    )
  }

  function commitAssetMetadataUpdate(updatedAsset: Asset) {
    const previousAsset = assetByIdRef.current.get(updatedAsset.id)
    const affectsCatalog = assetUpdateAffectsCatalog(previousAsset, updatedAsset)

    writeAssetToStore(updatedAsset)
    setAssetMetadataVersion((version) => version + 1)

    if (!affectsCatalog) return

    const nextAssets = applyAssetUpdatesToArray(
      libraryAssetsRef.current,
      new Map<string, Partial<Asset>>([[updatedAsset.id, updatedAsset]]),
      libraryAssetIndexByIdRef.current,
    )
    if (assetUpdateCanPatchCatalogTags(previousAsset, updatedAsset) && previousAsset) {
      setLibraryCatalog((current) =>
        updateCatalogTagsForAssetMetadata(libraryName, current, previousAsset, updatedAsset),
      )
    } else {
      setLibraryCatalog(deriveLibraryCatalogState(libraryName, nextAssets))
    }
    setLibraryAssets(nextAssets)
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

    const tagStillUsed =
      activeTag === tag && (libraryCatalog.tagCounts.get(tag) ?? 0) > 1
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
    const sidebarWidthCommitter = createRafNumberCommitter(setSidebarWidth, startWidth)

    document.body.classList.add('is-resizing-col')

    const updateWidthFromPointer = (clientX: number) => {
      sidebarWidthCommitter.update(clamp(startWidth + clientX - startX, 176, 340))
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateWidthFromPointer(moveEvent.clientX)
    }

    const stopResize = (pointerEvent: PointerEvent) => {
      updateWidthFromPointer(pointerEvent.clientX)
      sidebarWidthCommitter.flush()
      document.body.classList.remove('is-resizing-col')
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize, { once: true })
    window.addEventListener('pointercancel', stopResize, { once: true })
  }

  const rememberScrollPosition = useCallback((key: string, nextScrollTop: number) => {
    scrollPositionsRef.current[key] = Math.max(0, Math.round(nextScrollTop))
    if (scrollSaveTimerRef.current) return

    scrollSaveTimerRef.current = window.setTimeout(() => {
      updateAppPrefs((prefs) => ({
        ...prefs,
        scrollPositions: scrollPositionsRef.current,
      }))
      scrollSaveTimerRef.current = undefined
    }, SCROLL_POSITION_SAVE_MS)
  }, [])

  useEffect(() => {
    return () => {
      if (scrollSaveTimerRef.current) window.clearTimeout(scrollSaveTimerRef.current)
    }
  }, [])

  const assetMenuSingle = visibleSelectedIds.size === 1 ? primaryAsset : undefined
  function getVisibleSelectedAssets() {
    const assets: Asset[] = []
    for (const id of visibleSelectedIds) {
      const asset = assetByIdRef.current.get(id)
      if (asset) assets.push(asset)
    }
    return assets
  }
  const assetMenuItems: ContextMenuItem[] = [
    ...(assetMenuSingle
      ? [
          { label: '复制图片', icon: <Copy size={13} />, onSelect: () => copyAssetImage(assetMenuSingle) },
          { label: '重命名', icon: <Pencil size={13} />, onSelect: () => setRenameTarget(assetMenuSingle) },
        ]
      : []),
    {
      label: '移动到…',
      icon: <FolderInput size={13} />,
      disabled: visibleSelectedIds.size === 0,
      onSelect: () => setMoveOpen(true),
    },
    {
      label: '删除到回收站',
      icon: <Trash2 size={13} />,
      danger: true,
      disabled: visibleSelectedIds.size === 0,
      onSelect: deleteSelectedToTrash,
    },
  ]

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
          folderPaneHeight={folderPaneHeight}
          libraryName={libraryName}
          trashActive={trashView}
          trashCount={trashItems.length}
          onEmptyTrash={emptyTrash}
          onRenameFolder={setRenameFolderTarget}
          onRevealFolder={revealFolderInFinder}
          onRevealLibrary={revealLibraryInFinder}
          onReorderFolders={reorderFolders}
          onSetFolderPaneHeight={setFolderPaneHeight}
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
              onRestore={restoreTrashItems}
              onToggleSelect={(id) => toggleTrashSelect(id)}
            />
          ) : (
          <LibraryView
            activeTag={activeTag}
            activeFilterCount={activeFilterCount}
            allTags={allTags}
            assetById={assetById}
            getAssetIndex={getVisibleAssetIndex}
            assetLayoutVersion={assetStore.layoutVersion}
            breadcrumb={breadcrumb}
            filtersOpen={filtersOpen}
            inspectorVisible={inspectorVisible}
            keyboardScrollTargetId={keyboardScrollTargetId}
            keyboardScrollVersion={keyboardScrollVersion}
            scrollJump={scrollJump}
            scrollRestoreKey={scrollRestoreKey}
            scrollTop={restoredScrollTop}
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
            onAssetContextMenu={handleAssetContextMenu}
            onAssetDoubleClick={handleAssetDoubleClick}
            onAssetDragStart={handleAssetDragStart}
            onOpenFolder={openLibraryFolder}
            onRefresh={refreshLibrary}
            onRemoveAssetTag={removeAssetTag}
            onOcr={runOcr}
            onRotate={(asset, quarterTurns) => rotateAssets([asset], quarterTurns)}
            onRotateSelected={(quarterTurns) => rotateAssets(getVisibleSelectedAssets(), quarterTurns)}
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
            onScrollPositionChange={rememberScrollPosition}
            onUpdateAssetNote={updateAssetNote}
          />
          )}
        </div>
      </div>

      {settingsOpen && (
        <SettingsPanel
          appSettingsPath={appSettingsPath}
          cacheLimit={cacheLimit}
          cacheSize={cacheSize}
          collectorEnabled={collectorEnabled}
          deleteShortcut={deleteShortcut}
          folders={thumbnailFolders}
          generatedCount={generatedCount}
          hasNativeLibrary={Boolean(libraryRootPath && isTauriRuntime())}
          indexAssetCount={libraryIndexStats.assetCount}
          indexBusy={libraryScanStatus !== 'idle'}
          indexExists={libraryIndexStats.exists}
          indexSizeBytes={libraryIndexStats.fileSizeBytes}
          indexValid={libraryIndexStats.valid}
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
          onClearLibraryIndex={() => void clearLibraryIndex()}
          onClose={() => setSettingsOpen(false)}
          onClearThumbnailCache={clearThumbnailCache}
          onCompressThumbnailCache={compressThumbnailCache}
          onGenerateAllThumbnails={generateAllThumbnails}
          onGenerateFolderThumbnails={generateFolderThumbnails}
          onOpenFolder={openLibraryFolder}
          onRebuildLibraryIndex={rebuildLibraryIndex}
          onRevealAppSettings={revealSettingsFile}
          onSetCacheLimit={setCacheLimit}
          onSetCollectorEnabled={setCollectorEnabled}
          onSetDeleteShortcut={setDeleteShortcut}
          onSetOcrApiKey={setOcrApiKey}
          onSetOcrLanguage={setOcrLanguage}
          onSetSelectionKeyAxis={setSelectionKeyAxis}
          onSetThemePref={setThemePref}
          onSetThumbnailQuality={setThumbnailQuality}
        />
      )}

      {assetMenu && (
        <ContextMenu x={assetMenu.x} y={assetMenu.y} items={assetMenuItems} onClose={() => setAssetMenu(null)} />
      )}

      {moveOpen && (
        <MovePicker
          count={visibleSelectedIds.size}
          folders={orderedFolders}
          libraryName={libraryName}
          onCancel={() => setMoveOpen(false)}
          onConfirm={moveSelectedTo}
        />
      )}

      {renameTarget && (
        <RenameModal name={renameTarget.name} onCancel={() => setRenameTarget(null)} onConfirm={renameSelectedAsset} />
      )}

      {renameFolderTarget && (
        <RenameModal
          name={renameFolderTarget.name}
          onCancel={() => setRenameFolderTarget(null)}
          onConfirm={renameFolderTo}
        />
      )}

      {thumbnailPromptOpen && (
        <ThumbnailPromptModal
          totalCount={totalAssetCount}
          folders={thumbnailFolders}
          onConfirm={confirmThumbnailPrompt}
          onDismiss={() => setThumbnailPromptOpen(false)}
        />
      )}

      {ocr && <OcrModal status={ocr.status} text={ocr.text} error={ocr.error} onClose={closeOcr} />}

      {batchOpen && (
        <BatchModal
          selectedCount={visibleSelectedIds.size}
          processableCount={countProcessableAssets(visibleSelectedIds, assetById)}
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
