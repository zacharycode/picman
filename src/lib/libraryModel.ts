import { convertFileSrc } from '@tauri-apps/api/core'
import { folderName } from './library'
import { createAssetSearchText, withAssetSearchText } from './search'
import type {
  Asset,
  AssetKind,
  AssetViewMode,
  FolderNode,
  SelectionKeyAxis,
  SortDir,
  SortField,
  ThemePref,
  ThumbnailState,
} from '../types/library'

type NativeScannedAsset = Omit<Asset, 'kind'> & {
  kind: AssetKind
}

type NativeThumbnailSource = {
  id: string
  kind: Asset['kind']
  relativePath: string
  sourcePath: string
}

type RefreshMergeResult = {
  added: number
  addedAssets: Asset[]
  assets: Asset[]
  idSet: Set<string>
  removed: number
  removedAssets: Asset[]
  thumbnailGenerationAssets: Asset[]
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

type AssetStore = {
  byId: Map<string, Asset>
  layoutVersion: number
  version: number
}

export type AssetReplacement = { asset: Asset; oldAsset?: Asset; oldId: string }

const BATCH_PROCESSABLE_KINDS: ReadonlySet<AssetKind> = new Set<AssetKind>(['png', 'jpg', 'webp'])

export function createAssetMap(assets: Asset[]): Map<string, Asset> {
  const assetMap = new Map<string, Asset>()
  for (const asset of assets) assetMap.set(asset.id, asset)
  return assetMap
}

export function createAssetIndexMap(assets: Asset[]): Map<string, number> {
  const indexById = new Map<string, number>()
  for (let index = 0; index < assets.length; index += 1) {
    indexById.set(assets[index].id, index)
  }
  return indexById
}

export function appendAssetsToAssetMap(assetMap: Map<string, Asset>, incoming: Asset[]) {
  for (const asset of incoming) assetMap.set(asset.id, asset)
  return incoming.length > 0
}

export function assetIdsFromAssets(assets: Asset[]) {
  const assetIds = new Array<string>(assets.length)
  for (let index = 0; index < assets.length; index += 1) {
    assetIds[index] = assets[index].id
  }
  return assetIds
}

export function appendItems<T>(current: T[], incoming: T[]) {
  if (incoming.length === 0) return current

  const currentLength = current.length
  const next = new Array<T>(currentLength + incoming.length)
  for (let index = 0; index < currentLength; index += 1) next[index] = current[index]
  for (let index = 0; index < incoming.length; index += 1) next[currentLength + index] = incoming[index]
  return next
}

export function prependItems<T>(incoming: T[], current: T[]) {
  if (incoming.length === 0) return current
  if (current.length === 0) return incoming

  const incomingLength = incoming.length
  const next = new Array<T>(incomingLength + current.length)
  for (let index = 0; index < incomingLength; index += 1) next[index] = incoming[index]
  for (let index = 0; index < current.length; index += 1) next[incomingLength + index] = current[index]
  return next
}

export function removeItemsById<T extends { id: string }>(current: T[], removedIds: Set<string>) {
  let next: T[] | undefined
  let nextIndex = 0

  for (let index = 0; index < current.length; index += 1) {
    const item = current[index]
    if (removedIds.has(item.id)) {
      if (!next) {
        next = new Array<T>(current.length)
        for (let copyIndex = 0; copyIndex < index; copyIndex += 1) next[copyIndex] = current[copyIndex]
        nextIndex = index
      }
      continue
    }

    if (next) {
      next[nextIndex] = item
      nextIndex += 1
    }
  }

  if (!next) return current
  next.length = nextIndex
  return next
}

export function pushItems<T>(target: T[], incoming: T[]) {
  for (const item of incoming) target.push(item)
}

export function appendAssetIds(current: string[], incoming: Asset[]) {
  if (incoming.length === 0) return current

  const currentLength = current.length
  const next = new Array<string>(currentLength + incoming.length)
  for (let index = 0; index < currentLength; index += 1) next[index] = current[index]
  for (let index = 0; index < incoming.length; index += 1) next[currentLength + index] = incoming[index].id
  return next
}

export function createVisibleIndexMap(assetIds: string[]) {
  const indexById = new Map<string, number>()
  for (let index = 0; index < assetIds.length; index += 1) {
    indexById.set(assetIds[index], index)
  }
  return indexById
}

export function appendAssetIndexes(indexById: Map<string, number>, startIndex: number, incoming: Asset[]) {
  for (let index = 0; index < incoming.length; index += 1) {
    indexById.set(incoming[index].id, startIndex + index)
  }
}

export function applyAssetUpdatesToArray(
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

function assetLayoutRatio(asset: Asset) {
  if (asset.width && asset.height) return asset.width / asset.height
  if (asset.thumbnailWidth && asset.thumbnailHeight) return asset.thumbnailWidth / asset.thumbnailHeight

  const match = asset.dimensions.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i)
  if (!match) return 16 / 10

  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? width / height : 16 / 10
}

export function assetUpdateAffectsLayout(asset: Asset, update: Partial<Asset>) {
  if (
    update.dimensions === undefined &&
    update.height === undefined &&
    update.thumbnailHeight === undefined &&
    update.thumbnailWidth === undefined &&
    update.width === undefined
  ) {
    return false
  }

  return Math.abs(assetLayoutRatio(asset) - assetLayoutRatio({ ...asset, ...update })) > 0.0001
}

export function sameTags(a: string[], b: string[]) {
  if (a.length !== b.length) return false

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }

  return true
}

export function assetUpdateAffectsCatalog(previous: Asset | undefined, next: Asset) {
  return (
    !previous ||
    previous.folder !== next.folder ||
    previous.sizeKb !== next.sizeKb ||
    !sameTags(previous.tags, next.tags)
  )
}

export function assetUpdateCanPatchCatalogTags(previous: Asset | undefined, next: Asset) {
  return Boolean(previous && previous.folder === next.folder && previous.sizeKb === next.sizeKb)
}

export function applyAssetUpdatesToMap(assetMap: Map<string, Asset>, updates: Map<string, Partial<Asset>>) {
  let layoutChanged = false

  for (const [assetId, update] of updates) {
    const asset = assetMap.get(assetId)
    if (!asset) continue

    if (assetUpdateAffectsLayout(asset, update)) layoutChanged = true
    assetMap.set(assetId, { ...asset, ...update })
  }

  return layoutChanged
}

export function clearThumbnailUpdate(): Partial<Asset> {
  return {
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
  }
}

export function prepareThumbnailClearPatch(assets: Iterable<Asset>) {
  const metrics: ThumbnailMetrics = { cacheSize: 0, generatedCount: 0 }
  const updates = new Map<string, Partial<Asset>>()

  for (const asset of assets) {
    if (asset.thumbnailUrl?.startsWith('blob:')) URL.revokeObjectURL(asset.thumbnailUrl)
    if (asset.thumbnailReady) {
      metrics.generatedCount += 1
      metrics.cacheSize += asset.thumbnailSizeKb ?? 0
    }
    updates.set(asset.id, clearThumbnailUpdate())
  }

  return { metrics, updates }
}

export function revokeUncommittedThumbnailBlobUrls(
  updates: Iterable<[string, Partial<Asset>]>,
  currentAssets: ReadonlyMap<string, Asset>,
) {
  let revokedCount = 0
  for (const [assetId, update] of updates) {
    const url = update.thumbnailUrl
    if (!url?.startsWith('blob:') || currentAssets.get(assetId)?.thumbnailUrl === url) continue
    URL.revokeObjectURL(url)
    revokedCount += 1
  }
  return revokedCount
}

export function getLiveAssets(sourceAssets: Asset[], assetById: Map<string, Asset>) {
  const liveAssets = new Array<Asset>(sourceAssets.length)
  for (let index = 0; index < sourceAssets.length; index += 1) {
    const asset = sourceAssets[index]
    liveAssets[index] = assetById.get(asset.id) ?? asset
  }
  return liveAssets
}

export function createNativeThumbnailSources(targetAssets: Asset[]) {
  const sources = new Array<NativeThumbnailSource>(targetAssets.length)
  for (let index = 0; index < targetAssets.length; index += 1) {
    const asset = targetAssets[index]
    const sourcePath = asset.sourcePath
    if (!sourcePath) return null

    sources[index] = {
      id: asset.id,
      kind: asset.kind,
      relativePath: asset.relativePath,
      sourcePath,
    }
  }
  return sources
}

export function updateAssetStore(store: AssetStore, update: (assetMap: Map<string, Asset>) => boolean | void): AssetStore {
  const layoutChanged = Boolean(update(store.byId))
  return {
    byId: store.byId,
    layoutVersion: layoutChanged ? store.layoutVersion + 1 : store.layoutVersion,
    version: store.version + 1,
  }
}

export function replaceAssetStore(store: AssetStore, assets: Asset[]): AssetStore {
  return {
    byId: createAssetMap(assets),
    layoutVersion: store.layoutVersion + 1,
    version: store.version + 1,
  }
}

export function blurActiveElement() {
  const activeElement = document.activeElement
  if (activeElement instanceof HTMLElement) activeElement.blur()
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function clampedPrefNumber(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback
}

export function prefViewMode(value: unknown): AssetViewMode {
  return value === 'adaptive' || value === 'masonry' || value === 'list' ? value : 'adaptive'
}

export function prefSelectionKeyAxis(value: unknown): SelectionKeyAxis {
  return value === 'vertical' ? 'vertical' : 'horizontal'
}

export function prefTheme(value: unknown): ThemePref {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

export function prefSortDir(value: unknown): SortDir {
  return value === 'desc' ? 'desc' : 'asc'
}

export function prefSortField(value: unknown): SortField {
  return value === 'date' || value === 'size' || value === 'type' ? value : 'name'
}

export function createScrollRestoreKey(
  libraryRootPath: string | null,
  activeFolder: string,
  activeTag: string,
  viewMode: AssetViewMode,
  typeFilter: 'all' | AssetKind,
  thumbnailState: ThumbnailState,
  sortField: SortField,
  sortDir: SortDir,
) {
  return [libraryRootPath ?? 'sample', activeFolder, activeTag, viewMode, typeFilter, thumbnailState, sortField, sortDir].join(
    '\u001f',
  )
}

function withCacheToken(url: string, token: string) {
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(token)}`
}

export function nativeAssetToFrontend(asset: NativeScannedAsset): Asset {
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

export function frontendAssetsFromNative(nativeAssets: NativeScannedAsset[]) {
  const assets = new Array<Asset>(nativeAssets.length)
  for (let index = 0; index < nativeAssets.length; index += 1) {
    assets[index] = nativeAssetToFrontend(nativeAssets[index])
  }
  return assets
}

export function assetsWithSearchText(assets: Asset[]) {
  const nextAssets = new Array<Asset>(assets.length)
  for (let index = 0; index < assets.length; index += 1) {
    nextAssets[index] = withAssetSearchText(assets[index])
  }
  return nextAssets
}

export function mergeRefreshedAssets(scannedAssets: Asset[], previousAssets: Asset[]): RefreshMergeResult {
  const previousById = new Map<string, Asset>()
  const previousSourcePaths = new Set<string>()
  for (const asset of previousAssets) {
    previousById.set(asset.id, asset)
    if (asset.sourcePath) previousSourcePaths.add(asset.sourcePath)
  }

  const scannedSourcePaths = new Set<string>()
  const idSet = new Set<string>()
  const assets = new Array<Asset>(scannedAssets.length)
  const addedAssets = new Array<Asset>(scannedAssets.length)
  const thumbnailGenerationAssets = new Array<Asset>(scannedAssets.length)
  let added = 0
  let addedAssetCount = 0
  let thumbnailGenerationAssetCount = 0

  for (let index = 0; index < scannedAssets.length; index += 1) {
    const asset = scannedAssets[index]
    let isAdded = false
    idSet.add(asset.id)
    if (asset.sourcePath) {
      scannedSourcePaths.add(asset.sourcePath)
      if (!previousSourcePaths.has(asset.sourcePath)) {
        added += 1
        isAdded = true
      }
    }

    const previous = previousById.get(asset.id)

    if (asset.thumbnailReady) {
      assets[index] = {
        ...asset,
        previewUrl: previous?.previewUrl,
      }
    } else if (previous?.thumbnailReady) {
      assets[index] = {
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
    } else {
      assets[index] = asset
    }

    if (isAdded) {
      addedAssets[addedAssetCount] = assets[index]
      addedAssetCount += 1
    }
    if (!assets[index].thumbnailReady && (!previous || previous.thumbnailError)) {
      thumbnailGenerationAssets[thumbnailGenerationAssetCount] = assets[index]
      thumbnailGenerationAssetCount += 1
    }
  }
  addedAssets.length = addedAssetCount
  thumbnailGenerationAssets.length = thumbnailGenerationAssetCount

  const removedAssets: Asset[] = []
  for (const asset of previousAssets) {
    if (asset.sourcePath && !scannedSourcePaths.has(asset.sourcePath)) removedAssets.push(asset)
  }

  return {
    added,
    addedAssets,
    assets,
    idSet,
    removed: removedAssets.length,
    removedAssets,
    thumbnailGenerationAssets,
  }
}

export function reconcilePendingThumbnailAssets(
  pending: Map<string, Asset>,
  assets: Asset[],
  idSet: Set<string>,
  candidates: Asset[],
) {
  for (const asset of candidates) pending.set(asset.id, asset)
  if (pending.size === 0) return

  for (const assetId of pending.keys()) {
    if (!idSet.has(assetId)) pending.delete(assetId)
  }
  for (const asset of assets) {
    if (!pending.has(asset.id)) continue
    if (asset.thumbnailReady) pending.delete(asset.id)
    else pending.set(asset.id, asset)
  }
}

export function pendingThumbnailTargets(pending: Map<string, Asset>, currentAssets: ReadonlyMap<string, Asset>) {
  const targets = new Array<Asset>(pending.size)
  let targetCount = 0
  for (const [assetId, pendingAsset] of pending) {
    const asset = currentAssets.get(assetId) ?? pendingAsset
    if (asset.thumbnailReady) {
      pending.delete(assetId)
      continue
    }
    targets[targetCount] = asset
    targetCount += 1
  }
  targets.length = targetCount
  return targets
}

export function enqueueVisiblePendingThumbnails(
  pending: Map<string, Asset>,
  visibleAssetIds: string[],
  currentAssets: ReadonlyMap<string, Asset>,
) {
  let queued = 0
  for (const assetId of visibleAssetIds) {
    if (pending.has(assetId)) continue
    const asset = currentAssets.get(assetId)
    if (!asset || asset.thumbnailReady || asset.thumbnailError || !asset.sourcePath) continue
    pending.set(assetId, asset)
    queued += 1
  }
  return queued
}

export function libraryNameFromPath(path: string) {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.at(-1) ?? 'Local Library'
}

export function buildLibraryCatalogState(
  libraryName: string,
  folderCounts: Map<string, number>,
  tagCounts: Map<string, number>,
  sourceSize: number,
): LibraryCatalogState {
  if (!folderCounts.has('/')) folderCounts.set('/', 0)
  const folderItems = Array.from(folderCounts.entries()).sort(([a], [b]) =>
    a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b),
  )
  const liveTagCounts = new Map<string, number>()
  const allTags = new Array<string>(tagCounts.size)
  let tagIndex = 0
  for (const [tag, count] of tagCounts) {
    if (count <= 0) continue

    liveTagCounts.set(tag, count)
    allTags[tagIndex] = tag
    tagIndex += 1
  }
  allTags.length = tagIndex
  allTags.sort()

  const folders = new Array<FolderNode>(folderItems.length)
  const thumbnailFolders = new Array<FolderNode>(Math.max(0, folderItems.length - 1))
  let thumbnailFolderIndex = 0
  for (let index = 0; index < folderItems.length; index += 1) {
    const [path, count] = folderItems[index]
    const node = { path, name: folderName(path, libraryName), count }
    folders[index] = node
    if (path !== '/') {
      thumbnailFolders[thumbnailFolderIndex] = node
      thumbnailFolderIndex += 1
    }
  }
  thumbnailFolders.length = thumbnailFolderIndex

  return {
    allTags,
    folderCounts,
    folders,
    sourceSize,
    tagCounts: liveTagCounts,
    thumbnailFolders,
  }
}

export function deriveLibraryCatalogState(libraryName: string, assets: Asset[]): LibraryCatalogState {
  const folderCounts = new Map<string, number>()
  const tagCounts = new Map<string, number>()
  let sourceSize = 0

  folderCounts.set('/', assets.length)

  for (const asset of assets) {
    folderCounts.set(asset.folder, (folderCounts.get(asset.folder) ?? 0) + 1)
    sourceSize += asset.sizeKb

    for (const tag of asset.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  }

  return buildLibraryCatalogState(libraryName, folderCounts, tagCounts, sourceSize)
}

export function assetMatchesVisibleFilters(
  asset: Asset,
  activeFolder: string,
  activeTag: string,
  typeFilter: 'all' | AssetKind,
  thumbnailState: ThumbnailState,
  searchQuery: string,
) {
  if (activeFolder !== '/' && asset.folder !== activeFolder) return false
  if (activeTag !== 'all' && !asset.tags.includes(activeTag)) return false
  if (typeFilter !== 'all' && asset.kind !== typeFilter) return false
  if (thumbnailState === 'generated' && !asset.thumbnailReady) return false
  if (thumbnailState === 'pending' && asset.thumbnailReady) return false
  if (searchQuery && !(asset.searchText ?? createAssetSearchText(asset)).includes(searchQuery)) return false

  return true
}

export function patchFolderNodeCounts(
  folders: FolderNode[],
  folderCounts: Map<string, number>,
  touchedFolderPaths: Set<string>,
) {
  let nextFolders: FolderNode[] | undefined

  for (let index = 0; index < folders.length; index += 1) {
    const folder = folders[index]
    if (!touchedFolderPaths.has(folder.path)) continue

    const count = folderCounts.get(folder.path) ?? 0
    if (folder.count === count) continue

    nextFolders ??= folders.slice()
    nextFolders[index] = { ...folder, count }
  }

  return nextFolders ?? folders
}

export function patchLibraryCatalogCounts(
  catalog: LibraryCatalogState,
  folderCounts: Map<string, number>,
  tagCounts: Map<string, number>,
  sourceSize: number,
  touchedFolderPaths: Set<string>,
): LibraryCatalogState {
  return {
    ...catalog,
    folderCounts,
    folders: patchFolderNodeCounts(catalog.folders, folderCounts, touchedFolderPaths),
    sourceSize,
    tagCounts,
    thumbnailFolders: patchFolderNodeCounts(catalog.thumbnailFolders, folderCounts, touchedFolderPaths),
  }
}

export function appendAssetsToLibraryCatalogState(
  libraryName: string,
  catalog: LibraryCatalogState,
  incoming: Asset[],
): LibraryCatalogState {
  if (incoming.length === 0) return catalog

  const folderCounts = new Map(catalog.folderCounts)
  const tagCounts = new Map(catalog.tagCounts)
  const touchedFolderPaths = new Set<string>(['/'])
  let hasNewFolder = false
  let hasNewTag = false
  let sourceSize = catalog.sourceSize

  folderCounts.set('/', (folderCounts.get('/') ?? 0) + incoming.length)
  for (const asset of incoming) {
    const previousFolderCount = folderCounts.get(asset.folder) ?? 0
    if (previousFolderCount === 0 && asset.folder !== '/') hasNewFolder = true
    folderCounts.set(asset.folder, previousFolderCount + 1)
    touchedFolderPaths.add(asset.folder)
    sourceSize += asset.sizeKb

    for (const tag of asset.tags) {
      const previousTagCount = tagCounts.get(tag) ?? 0
      if (previousTagCount === 0) hasNewTag = true
      tagCounts.set(tag, previousTagCount + 1)
    }
  }

  if (hasNewFolder || hasNewTag) {
    return buildLibraryCatalogState(libraryName, folderCounts, tagCounts, sourceSize)
  }

  return patchLibraryCatalogCounts(catalog, folderCounts, tagCounts, sourceSize, touchedFolderPaths)
}

export function updateCatalogTagsForAssetMetadata(
  libraryName: string,
  catalog: LibraryCatalogState,
  previous: Asset,
  next: Asset,
): LibraryCatalogState {
  if (sameTags(previous.tags, next.tags)) return catalog

  const tagCounts = new Map(catalog.tagCounts)

  for (const tag of previous.tags) {
    if (!next.tags.includes(tag)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) - 1)
  }

  for (const tag of next.tags) {
    if (!previous.tags.includes(tag)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  }

  return buildLibraryCatalogState(
    libraryName,
    new Map(catalog.folderCounts),
    tagCounts,
    catalog.sourceSize,
  )
}

export function renameLibraryCatalogState(libraryName: string, catalog: LibraryCatalogState): LibraryCatalogState {
  return buildLibraryCatalogState(
    libraryName,
    new Map(catalog.folderCounts),
    new Map(catalog.tagCounts),
    catalog.sourceSize,
  )
}

export function applyFolderOrder(folders: FolderNode[], order: string[]): FolderNode[] {
  if (order.length === 0) return folders

  const rank = new Map<string, number>()
  for (let index = 0; index < order.length; index += 1) {
    rank.set(order[index], index)
  }

  const rootFolders: FolderNode[] = []
  const children = new Array<FolderNode>(folders.length)
  let childCount = 0
  for (let index = 0; index < folders.length; index += 1) {
    const folder = folders[index]
    if (folder.path === '/') rootFolders.push(folder)
    else {
      children[childCount] = folder
      childCount += 1
    }
  }
  children.length = childCount

  children.sort((a, b) => {
    const rankA = rank.get(a.path)
    const rankB = rank.get(b.path)
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB
    if (rankA !== undefined) return -1
    if (rankB !== undefined) return 1
    return 0
  })

  if (rootFolders.length === 0) return children

  const orderedFolders = new Array<FolderNode>(rootFolders.length + children.length)
  for (let index = 0; index < rootFolders.length; index += 1) {
    orderedFolders[index] = rootFolders[index]
  }
  for (let index = 0; index < children.length; index += 1) {
    orderedFolders[rootFolders.length + index] = children[index]
  }
  return orderedFolders
}

export function deriveThumbnailMetrics(assets: Asset[]): ThumbnailMetrics {
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

export function addThumbnailMetrics(a: ThumbnailMetrics, b: ThumbnailMetrics): ThumbnailMetrics {
  return {
    cacheSize: a.cacheSize + b.cacheSize,
    generatedCount: a.generatedCount + b.generatedCount,
  }
}

export function subtractThumbnailMetrics(a: ThumbnailMetrics, b: ThumbnailMetrics): ThumbnailMetrics {
  return {
    cacheSize: Math.max(0, a.cacheSize - b.cacheSize),
    generatedCount: Math.max(0, a.generatedCount - b.generatedCount),
  }
}

/**
 * Reconciles one background-generation result with the thumbnail currently on
 * screen. Failed generation deliberately keeps the last usable thumbnail so a
 * refresh never turns an image grid back into placeholders.
 */
export function prepareThumbnailGenerationUpdate(previous: Asset, candidate: Partial<Asset>) {
  const update: Partial<Asset> =
    candidate.thumbnailReady === true
      ? candidate
      : previous.thumbnailReady
        ? { thumbnailError: candidate.thumbnailError }
        : candidate
  const asset = { ...previous, ...update }
  const previousSize = previous.thumbnailReady ? (previous.thumbnailSizeKb ?? 0) : 0
  const nextSize = asset.thumbnailReady ? (asset.thumbnailSizeKb ?? 0) : 0

  return {
    asset,
    metricsDelta: {
      cacheSize: nextSize - previousSize,
      generatedCount: Number(asset.thumbnailReady) - Number(previous.thumbnailReady),
    } satisfies ThumbnailMetrics,
    replacedBlobUrl:
      candidate.thumbnailReady === true &&
      previous.thumbnailUrl?.startsWith('blob:') &&
      previous.thumbnailUrl !== asset.thumbnailUrl
        ? previous.thumbnailUrl
        : undefined,
    update,
  }
}

export function applyThumbnailMetricsDelta(current: ThumbnailMetrics, delta: ThumbnailMetrics): ThumbnailMetrics {
  return {
    cacheSize: Math.max(0, current.cacheSize + delta.cacheSize),
    generatedCount: Math.max(0, current.generatedCount + delta.generatedCount),
  }
}

export function thumbnailMetricsFromUpdates(updates: Iterable<Partial<Asset>>): ThumbnailMetrics {
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

export function removeIdsFromSet(current: Set<string>, removedIds: Set<string>) {
  let next: Set<string> | undefined
  for (const id of current) {
    if (!removedIds.has(id)) continue

    next ??= new Set(current)
    next.delete(id)
  }

  return next ?? current
}

export function retainIdsInSet(current: Set<string>, allowedIds: Set<string>) {
  let hasRemoved = false
  for (const id of current) {
    if (!allowedIds.has(id)) {
      hasRemoved = true
      break
    }
  }

  if (!hasRemoved) return current

  const next = new Set<string>()
  for (const id of current) {
    if (allowedIds.has(id)) next.add(id)
  }
  return next
}

export function lastIdInSet(ids: Set<string>) {
  let lastId: string | null = null
  for (const id of ids) lastId = id
  return lastId
}

export function createIdRangeSet(assetIds: string[], from: number, to: number) {
  const ids = new Set<string>()
  for (let index = from; index <= to; index += 1) {
    const id = assetIds[index]
    if (id) ids.add(id)
  }
  return ids
}

export function createAssetOperationTargets(
  assets: Iterable<Asset | undefined>,
  canUseAsset: (asset: Asset) => boolean,
) {
  const assetByRelativePath = new Map<string, Asset>()
  const idByRelativePath = new Map<string, string>()
  const ids = new Set<string>()
  const relativePaths: string[] = []
  const targets: Asset[] = []

  for (const asset of assets) {
    if (!asset || !canUseAsset(asset)) continue

    targets.push(asset)
    relativePaths.push(asset.relativePath)
    ids.add(asset.id)
    assetByRelativePath.set(asset.relativePath, asset)
    idByRelativePath.set(asset.relativePath, asset.id)
  }

  return {
    assetByRelativePath,
    idByRelativePath,
    ids,
    relativePaths,
    targets,
  }
}

export function assetsByIds(assetIds: Iterable<string>, assetById: Map<string, Asset>) {
  return {
    *[Symbol.iterator]() {
      for (const id of assetIds) yield assetById.get(id)
    },
  }
}

export function countProcessableAssets(assetIds: Iterable<string>, assetById: Map<string, Asset>) {
  let count = 0
  for (const id of assetIds) {
    const asset = assetById.get(id)
    if (asset && BATCH_PROCESSABLE_KINDS.has(asset.kind)) count += 1
  }
  return count
}

export function dragSourcePathsForSelection(asset: Asset, selectedIds: Set<string>, assetById: Map<string, Asset>) {
  if (!selectedIds.has(asset.id)) return asset.sourcePath ? [asset.sourcePath] : []

  const paths: string[] = []
  for (const id of selectedIds) {
    const sourcePath = assetById.get(id)?.sourcePath
    if (sourcePath) paths.push(sourcePath)
  }
  return paths
}


export function createLiveAssetByRelativePath(sourceAssets: Asset[], assetById: Map<string, Asset>) {
  const byRelativePath = new Map<string, Asset>()
  for (const asset of sourceAssets) {
    const liveAsset = assetById.get(asset.id) ?? asset
    byRelativePath.set(liveAsset.relativePath, liveAsset)
  }
  return byRelativePath
}
