import { opendir, readFile } from 'node:fs/promises'
import path from 'node:path'

const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp'])

function parseArgs() {
  const options = {
    library: null,
    minCount: 25000,
  }

  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/performance-audit.mjs [--library=/tmp/picman-stress-25000] [--min-count=25000]')
      process.exit(0)
    } else if (arg.startsWith('--library=')) {
      options.library = path.resolve(arg.slice('--library='.length))
    } else if (arg.startsWith('--min-count=')) {
      options.minCount = Number(arg.slice('--min-count='.length))
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }

  if (!Number.isInteger(options.minCount) || options.minCount < 1) {
    throw new Error('--min-count 必须是正整数')
  }

  return options
}

async function readProjectFile(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8')
}

function assertCheck(checks, condition, label, detail) {
  checks.push({
    detail,
    label,
    ok: Boolean(condition),
  })
}

function constantNumber(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*:\\s*usize\\s*=\\s*(\\d+)`))
  return match ? Number(match[1]) : null
}

function extractBetween(source, startText, endText) {
  const start = source.indexOf(startText)
  const end = source.indexOf(endText, start + startText.length)

  if (start === -1 || end === -1) return ''
  return source.slice(start, end)
}

async function countLibraryImages(root) {
  const stack = [root]
  let fileCount = 0
  let folderCount = 0

  while (stack.length > 0) {
    const current = stack.pop()
    const directory = await opendir(current)

    for await (const entry of directory) {
      if (entry.name === '.picman') continue

      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        folderCount += 1
        stack.push(entryPath)
      } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        fileCount += 1
      }
    }
  }

  return { fileCount, folderCount }
}

async function main() {
  const options = parseArgs()
  const [
    packageJson,
    appSource,
    appCssSource,
    libraryViewSource,
    sidebarSource,
    assetItemSource,
    sortSource,
    rafStateSource,
    tauriSource,
  ] = await Promise.all([
    readProjectFile('package.json'),
    readProjectFile('src/App.tsx'),
    readProjectFile('src/App.css'),
    readProjectFile('src/components/LibraryView.tsx'),
    readProjectFile('src/components/Sidebar.tsx'),
    readProjectFile('src/components/AssetItem.tsx'),
    readProjectFile('src/lib/sort.ts'),
    readProjectFile('src/lib/rafState.ts'),
    readProjectFile('src-tauri/src/lib.rs'),
  ])
  const packageConfig = JSON.parse(packageJson)
  const checks = []
  const scanBatchSize = constantNumber(tauriSource, 'SCAN_BATCH_SIZE')
  const thumbnailBatchSize = constantNumber(tauriSource, 'THUMBNAIL_BATCH_SIZE')
  const thumbnailWorkerLimit = constantNumber(tauriSource, 'THUMBNAIL_MAX_WORKERS')
  const thumbnailFlush = extractBetween(appSource, 'const flushNativeThumbnailUpdates', 'const queueNativeThumbnailBatch')
  const visibleFilterSource = extractBetween(
    appSource,
    'function assetMatchesVisibleFilters',
    'function appendAssetsToLibraryCatalogState',
  )
  const catalogAppendSource = extractBetween(
    appSource,
    'function appendAssetsToLibraryCatalogState',
    'function updateCatalogTagsForAssetMetadata',
  )
  const refreshMergeSource = extractBetween(
    appSource,
    'function mergeRefreshedAssets',
    'function libraryNameFromPath',
  )
  const assetIdsFromAssetsSource = extractBetween(
    appSource,
    'function assetIdsFromAssets',
    'function appendItems',
  )
  const liveAssetSource = extractBetween(
    appSource,
    'function getLiveAssets',
    'function updateAssetStore',
  )
  const appendHelpersSource = extractBetween(
    appSource,
    'function appendItems',
    'function createVisibleIndexMap',
  )
  const metadataCommitSource = extractBetween(
    appSource,
    'function commitAssetMetadataUpdate',
    'function saveFolderAssetMetadata',
  )
  const removeAssetTagSource = extractBetween(
    appSource,
    'function removeAssetTag',
    'function setAssetFavorite',
  )
  const removeAssetsSource = extractBetween(
    appSource,
    'function removeAssetsFromLibrary',
    'async function deleteSelectedToTrash',
  )
  const deleteSelectedSource = extractBetween(
    appSource,
    'async function deleteSelectedToTrash',
    'async function restoreTrashItems',
  )
  const restoreTrashSource = extractBetween(
    appSource,
    'async function restoreTrashItems',
    'async function emptyTrash',
  )
  const batchProcessSource = extractBetween(
    appSource,
    'async function runBatchProcess',
    'async function rotateAssets',
  )
  const rotateAssetsSource = extractBetween(
    appSource,
    'async function rotateAssets',
    'function handleAssetDragStart',
  )
  const replaceAssetsSource = extractBetween(
    appSource,
    'function replaceLibraryAssets',
    'async function moveSelectedTo',
  )
  const moveSelectedSource = extractBetween(
    appSource,
    'async function moveSelectedTo',
    'async function renameSelectedAsset',
  )
  const renameFolderSource = extractBetween(
    appSource,
    'async function renameFolderTo',
    'function writeAssetToStore',
  )
  const visibleSelectedSource = extractBetween(
    appSource,
    'const visibleSelectedIds = useMemo',
    'const primaryCandidate',
  )
  const selectedActionSource = extractBetween(
    appSource,
    'const assetMenuSingle',
    'const assetMenuItems',
  )
  const assetClickSource = extractBetween(
    appSource,
    'function handleAssetClick',
    'function handleAssetDoubleClick',
  )
  const dragStartSource = extractBetween(
    appSource,
    'function handleAssetDragStart',
    'function handleAssetContextMenu',
  )
  const batchModalSource = extractBetween(
    appSource,
    '{batchOpen && (',
    '{collectPending && libraryRootPath',
  )
  const masonryLayoutDataSource = extractBetween(
    libraryViewSource,
    'function createMasonryLayoutData',
    'function getMasonryPosition',
  )
  const masonryPositionSource = extractBetween(
    libraryViewSource,
    'function getMasonryPosition',
    'function lowerBoundMasonryItems',
  )
  const masonryVirtualLayoutSource = extractBetween(
    libraryViewSource,
    'function createMasonryLayout(layoutData',
    'type LibraryViewProps',
  )
  const adaptiveVirtualLayoutSource = extractBetween(
    libraryViewSource,
    'function createAdaptiveLayout',
    'function getListPosition',
  )
  const listVirtualLayoutSource = extractBetween(
    libraryViewSource,
    'function createListLayout',
    'function createMasonryLayoutData',
  )
  const virtualRenderSource = extractBetween(
    libraryViewSource,
    '{virtualLayout.items.map',
    '</div>\n          </div>',
  )
  const sidebarResizeSource = extractBetween(appSource, 'function startSidebarResize', 'const rememberScrollPosition')
  const inspectorResizeSource = extractBetween(libraryViewSource, 'function startInspectorResize', 'function adjustThumbSize')
  const verticalResizeSource = extractBetween(sidebarSource, 'function startVerticalResize', 'return (')
  const thumbnailClearSource = extractBetween(appSource, 'function clearThumbnailUpdate', 'function getLiveAssets')
  const generateThumbnailAssetsSource = extractBetween(
    appSource,
    'async function generateThumbnailAssets',
    'function generateAllThumbnails',
  )
  const generateFolderThumbnailsSource = extractBetween(
    appSource,
    'function generateFolderThumbnails',
    'function confirmThumbnailPrompt',
  )
  const clearThumbnailCacheSource = extractBetween(
    appSource,
    'function clearThumbnailCache',
    'async function checkAndInstallUpdate',
  )

  assertCheck(checks, packageConfig.scripts?.['stress:create'], '压力素材库生成脚本存在', 'package.json scripts.stress:create')
  assertCheck(checks, packageConfig.scripts?.['stress:audit'], '性能审计脚本存在', 'package.json scripts.stress:audit')
  assertCheck(checks, tauriSource.includes('fn scan_library_folder_stream'), '本地资源目录扫描为后台流式命令', 'scan_library_folder_stream')
  assertCheck(checks, scanBatchSize !== null && scanBatchSize <= 500, '扫描结果按小批次发送', `SCAN_BATCH_SIZE=${scanBatchSize}`)
  assertCheck(checks, tauriSource.includes('SCAN_BATCH_EVENT') && tauriSource.includes('SCAN_FINISHED_EVENT'), '扫描有批次与完成事件', 'scan events')
  assertCheck(checks, libraryViewSource.includes('VIRTUAL_OVERSCAN_PX'), '素材墙使用虚拟滚动窗口', 'VIRTUAL_OVERSCAN_PX')
  assertCheck(checks, libraryViewSource.includes('visibleAssetIds: string[]'), '视图层传递可见 ID 而非全量对象数组', 'visibleAssetIds prop')
  assertCheck(checks, !libraryViewSource.includes('visibleAssets:'), '视图层不再接收 visibleAssets 全量数组', 'no visibleAssets prop')
  assertCheck(checks, appSource.includes('assetStore') && appSource.includes('thumbnailFilterVersion'), '缩略图状态与源素材数组解耦', 'assetStore + thumbnailFilterVersion')
  assertCheck(checks, !thumbnailFlush.includes('setLibraryAssets'), '缩略图批次写回不更新主素材数组', 'flushNativeThumbnailUpdates')
  assertCheck(checks, thumbnailBatchSize !== null && thumbnailBatchSize >= 128, '缩略图事件按批次聚合', `THUMBNAIL_BATCH_SIZE=${thumbnailBatchSize}`)
  assertCheck(checks, thumbnailWorkerLimit !== null && thumbnailWorkerLimit <= 3, '缩略图后台并发受控', `THUMBNAIL_MAX_WORKERS=${thumbnailWorkerLimit}`)
  assertCheck(checks, tauriSource.includes('available_parallelism') && tauriSource.includes('mpsc::channel'), '缩略图 worker 池按机器能力保守调度并聚合结果', 'available_parallelism + mpsc')
  assertCheck(checks, tauriSource.includes('completed: usize') && appSource.includes('completed: number'), '缩略图取消/完成事件携带真实完成数量', 'completed payload')
  assertCheck(
    checks,
    tauriSource.includes('allow_library_asset_scope') &&
      tauriSource.includes('asset_protocol_scope()') &&
      tauriSource.includes('root.join(".picman")'),
    '恢复目录时主动授权资源目录与 .picman 缓存',
    'allow_library_asset_scope + .picman',
  )
  assertCheck(checks, tauriSource.includes('has_visible_alpha') && tauriSource.includes('passthrough_limit_bytes'), '缩略图编码按实际透明度与体积限制优化', 'alpha-aware encoding')
  assertCheck(
    checks,
    tauriSource.includes('existing_thumbnail_for_quality') &&
      tauriSource.includes('existing_thumbnail_cache_hit') &&
      appSource.includes('thumbnailPath') &&
      appSource.includes('convertFileSrc(asset.thumbnailPath)'),
    '打开资源目录时恢复已有缩略图缓存',
    'existing thumbnail cache restore',
  )
  assertCheck(
    checks,
    tauriSource.includes('if let Some(existing) = existing_thumbnail_for_quality'),
    '生成缩略图前跳过未变化缓存',
    'skip unchanged thumbnail cache',
  )
  assertCheck(
    checks,
    libraryViewSource.includes('VIRTUAL_FAST_OVERSCAN_PX') &&
      libraryViewSource.includes('FAST_SCROLL_VELOCITY_PX_PER_MS'),
    '快速滚动使用动态预渲染（滚动方向上扩大预渲染范围）',
    'fast scroll overscan',
  )
  assertCheck(
    checks,
    libraryViewSource.includes('VIRTUAL_SCROLL_STEP_PX') &&
      libraryViewSource.includes('quantizeScrollTop') &&
      libraryViewSource.includes('quantizeScrollSpeed') &&
      libraryViewSource.includes('const scrollTop = quantizeScrollTop(container.scrollTop, scrollDirection)') &&
      libraryViewSource.includes('const scrollSpeed = quantizeScrollSpeed(Math.abs(deltaY) / elapsed)'),
    '滚动测量按虚拟窗口步进和速度档位提交，避免像素级滚动触发 React 重算',
    'quantized viewport updates',
  )
  assertCheck(
    checks,
    appSource.includes('layoutVersion') && libraryViewSource.includes('assetLayoutVersion'),
    '瀑布流布局使用独立布局版本，避免非尺寸状态触发布局重算',
    'assetStore.layoutVersion + assetLayoutVersion',
  )
  assertCheck(
    checks,
    masonryLayoutDataSource.includes('const items = new Array<MasonryVirtualItem>(assetIds.length)') &&
      masonryLayoutDataSource.includes('let itemIndex = 0') &&
      masonryLayoutDataSource.includes('Shortest-column placement emits items in visual top/left order, so visibleAssetIds is already the visual order') &&
      masonryLayoutDataSource.includes('items[itemIndex] = item') &&
      masonryLayoutDataSource.includes('itemIndex += 1') &&
      masonryLayoutDataSource.includes('items,') &&
      !libraryViewSource.includes('onVisualOrderChange') &&
      !libraryViewSource.includes('masonryLayoutData?.visualIds') &&
      !libraryViewSource.includes('visualIds: string[]') &&
      !masonryLayoutDataSource.includes('const visualIds') &&
      !masonryLayoutDataSource.includes('visualIds[itemIndex]') &&
      !masonryLayoutDataSource.includes('const columnItems') &&
      !masonryLayoutDataSource.includes('mergeMasonryColumns') &&
      !masonryLayoutDataSource.includes('items.push(bestItem)') &&
      !masonryLayoutDataSource.includes('visualIds.push(bestItem.assetId)') &&
      !masonryLayoutDataSource.includes('.sort(') &&
      !masonryLayoutDataSource.includes('sortedItems.map((item) => item.assetId)'),
    '瀑布流布局循环直接按视觉顺序生成渲染项，并复用 visibleAssetIds 作为视觉顺序，避免重复分配 ID 数组',
    'masonry column merge',
  )
  assertCheck(
    checks,
    masonryLayoutDataSource.includes('let maxColumnHeight = MASONRY_PADDING_TOP') &&
      masonryLayoutDataSource.includes('maxColumnHeight = Math.max(maxColumnHeight, columnHeights[column])') &&
      masonryLayoutDataSource.includes('maxColumnHeight - MASONRY_GAP_Y + MASONRY_PADDING_BOTTOM') &&
      !masonryLayoutDataSource.includes('Math.max(...columnHeights)'),
    '瀑布流总高度随布局循环累积，避免列高数组 spread 展开',
    'masonry max column height incremental',
  )
  assertCheck(
    checks,
    libraryViewSource.includes('const masonryPositionCache = new WeakMap<MasonryLayoutData, Map<string, VirtualPosition>>()') &&
      libraryViewSource.includes('function getMasonryPosition(layoutData: MasonryLayoutData | undefined, assetId: string)') &&
      masonryPositionSource.includes('masonryPositionCache.get(layoutData)') &&
      masonryPositionSource.includes('positionById = new Map<string, VirtualPosition>()') &&
      masonryPositionSource.includes('for (const item of layoutData.items)') &&
      masonryPositionSource.includes('positionById.set(item.assetId, { height: item.height, top: item.top })') &&
      masonryPositionSource.includes('masonryPositionCache.set(layoutData, positionById)') &&
      masonryPositionSource.includes('return positionById.get(assetId)') &&
      libraryViewSource.includes('return getMasonryPosition(masonryLayoutData, assetId)') &&
      !libraryViewSource.includes('positionById: Map<string, VirtualPosition>') &&
      !masonryLayoutDataSource.includes('const positionById = new Map<string, VirtualPosition>()') &&
      !masonryLayoutDataSource.includes('positionById.set(assetId'),
    '瀑布流素材位置 Map 改为键盘滚动定位时懒生成，避免每次布局都为全量素材建立位置索引',
    'lazy masonry position map',
  )
  assertCheck(
    checks,
    masonryLayoutDataSource.includes('width: columnWidth') &&
      !masonryLayoutDataSource.includes('style: virtualItemStyle') &&
      masonryVirtualLayoutSource.includes('left: item.left') &&
      masonryVirtualLayoutSource.includes('top: item.top') &&
      masonryVirtualLayoutSource.includes('width: item.width'),
    '瀑布流全量布局阶段只保存数值位置，可视阶段才生成 CSS style 对象',
    'lazy masonry item style',
  )
  assertCheck(
    checks,
    assetItemSource.includes('export type AssetItemLayout') &&
      assetItemSource.includes('aspectRatio?: string') &&
      libraryViewSource.includes("import type { AssetItemLayout } from './AssetItem'") &&
      libraryViewSource.includes('type VirtualAssetItem = AssetItemLayout &') &&
      adaptiveVirtualLayoutSource.includes('left: ADAPTIVE_PADDING_X + column * (metrics.itemWidth + ADAPTIVE_GAP_X)') &&
      adaptiveVirtualLayoutSource.includes('top: ADAPTIVE_PADDING_TOP + row * metrics.rowPitch') &&
      adaptiveVirtualLayoutSource.includes('width: metrics.itemWidth') &&
      listVirtualLayoutSource.includes('right: 0') &&
      listVirtualLayoutSource.includes('top: LIST_PADDING_TOP + index * LIST_ROW_HEIGHT') &&
      !adaptiveVirtualLayoutSource.includes('style: virtualItemStyle') &&
      !listVirtualLayoutSource.includes('style: virtualItemStyle') &&
      assetItemSource.includes('function assetItemLayoutStyle(layout: AssetItemLayout): AssetItemStyle') &&
      assetItemSource.includes('transform: `translate3d(${layout.left}px, ${layout.top}px, 0)`') &&
      virtualRenderSource.includes('layout={item}') &&
      !virtualRenderSource.includes('style={virtualItemStyle(item)}'),
    '自适应和列表虚拟布局只保存数值位置，并把布局数字直接传给素材项',
    'numeric adaptive list virtual items',
  )
  assertCheck(
    checks,
    adaptiveVirtualLayoutSource.includes('const items = new Array<VirtualAssetItem>(Math.max(0, endIndex - startIndex))') &&
      adaptiveVirtualLayoutSource.includes('let itemIndex = 0') &&
      adaptiveVirtualLayoutSource.includes('items[itemIndex] = {') &&
      adaptiveVirtualLayoutSource.includes('itemIndex += 1') &&
      !adaptiveVirtualLayoutSource.includes('items.push') &&
      listVirtualLayoutSource.includes('const items = new Array<VirtualAssetItem>(Math.max(0, lastIndex - firstIndex + 1))') &&
      listVirtualLayoutSource.includes('items[itemIndex] = {') &&
      !listVirtualLayoutSource.includes('items.push') &&
      libraryViewSource.includes('function upperBoundMasonryItems') &&
      masonryVirtualLayoutSource.includes('const endIndex = upperBoundMasonryItems(layoutData.items, maxTop)') &&
      masonryVirtualLayoutSource.includes('const items = new Array<VirtualAssetItem>(Math.max(0, endIndex - startIndex))') &&
      masonryVirtualLayoutSource.includes('for (let index = startIndex; index < endIndex; index += 1)') &&
      masonryVirtualLayoutSource.includes('items[itemIndex] = {') &&
      masonryVirtualLayoutSource.includes('items.length = itemIndex') &&
      !masonryVirtualLayoutSource.includes('layoutData.items.length - startIndex') &&
      !masonryVirtualLayoutSource.includes('item.top > maxTop') &&
      !masonryVirtualLayoutSource.includes('items.push'),
    '三种虚拟滚动可见项数组按真实窗口预分配并按索引写入，避免快速滚动时 push 动态增长或按全量剩余素材分配',
    'virtual visible items preallocated',
  )
  assertCheck(
    checks,
    appSource.includes('OPEN_SCAN_FORCE_FLUSH_THRESHOLD') &&
      appSource.includes('OPEN_SCAN_STEADY_FLUSH_MS') &&
      appSource.includes('SCAN_STATUS_UPDATE_MS'),
    '打开大资源目录时扫描批次提交和状态文案有自适应节流',
    'adaptive scan flush + status throttle',
  )
  assertCheck(
    checks,
    assetIdsFromAssetsSource.includes('const assetIds = new Array<string>(assets.length)') &&
      assetIdsFromAssetsSource.includes('assetIds[index] = assets[index].id') &&
      assetIdsFromAssetsSource.includes('return assetIds') &&
      !assetIdsFromAssetsSource.includes('assets.map((asset) => asset.id)'),
    '素材 ID 列表重建使用预分配循环，避免大资源库全量 ID 派生时 map 回调分配',
    'asset ids preallocated loop',
  )
  assertCheck(
    checks,
    appendHelpersSource.includes('function appendItems<T>') &&
      appendHelpersSource.includes('const next = new Array<T>(currentLength + incoming.length)') &&
      appendHelpersSource.includes('function appendAssetIds') &&
      appendHelpersSource.includes('const next = new Array<string>(currentLength + incoming.length)') &&
      appendHelpersSource.includes('function pushItems<T>') &&
      appSource.includes('setLibraryAssets((current) => appendItems(current, incoming))') &&
      appSource.includes('pushItems(scan.collectedAssets, incoming)') &&
      appSource.includes('pushItems(scan.pendingAssets, incoming)') &&
      !appendHelpersSource.includes('incoming.map((asset) => asset.id)') &&
      !appSource.includes('setLibraryAssets((current) => [...current, ...incoming])') &&
      !appSource.includes('scan.collectedAssets.push(...incoming)') &&
      !appSource.includes('scan.pendingAssets.push(...incoming)'),
    '打开大资源目录的批次追加使用预分配循环，避免 incoming.map、数组 spread 和 push 参数展开',
    'open scan append preallocated loops',
  )
  assertCheck(
    checks,
    refreshMergeSource.includes('for (const asset of previousAssets)') &&
      refreshMergeSource.includes('for (const asset of scannedAssets)') &&
      refreshMergeSource.includes('for (const asset of previousAssets)') &&
      refreshMergeSource.includes('if (!previousSourcePaths.has(asset.sourcePath)) added += 1') &&
      refreshMergeSource.includes('assets.push(asset)') &&
      !refreshMergeSource.includes('previousAssets.map') &&
      !refreshMergeSource.includes('scannedAssets.map') &&
      !refreshMergeSource.includes('previousAssets.filter') &&
      !refreshMergeSource.includes('scannedAssets.filter'),
    '刷新扫描合并使用单向循环累积索引、结果和统计，避免大资源库多次 map/filter 分配',
    'refresh merge single-pass loops',
  )
  assertCheck(
    checks,
    appSource.includes('function appendAssetsToLibraryCatalogState') &&
      appSource.includes('setLibraryCatalog((current) => appendAssetsToLibraryCatalogState') &&
      !appSource.includes('deriveLibraryCatalogState(libraryName, libraryAssets)'),
    '目录树、标签和容量统计在扫描追加时增量更新',
    'incremental library catalog state',
  )
  assertCheck(
    checks,
    appSource.includes('folderCounts: Map<string, number>') &&
      catalogAppendSource.includes('const folderCounts = new Map(catalog.folderCounts)') &&
      catalogAppendSource.includes('const touchedFolderPaths = new Set<string>([\'/\'])') &&
      catalogAppendSource.includes('let hasNewFolder = false') &&
      catalogAppendSource.includes('let hasNewTag = false') &&
      catalogAppendSource.includes('if (hasNewFolder || hasNewTag)') &&
      catalogAppendSource.includes('return patchLibraryCatalogCounts(catalog, folderCounts, tagCounts, sourceSize, touchedFolderPaths)') &&
      appSource.includes('function patchLibraryCatalogCounts') &&
      appSource.includes('function patchFolderNodeCounts') &&
      !catalogAppendSource.includes('new Map(catalog.folders.map'),
    '扫描批次追加复用运行时 folderCounts，无新文件夹或标签时只局部更新计数并避免目录重排',
    'catalog folderCounts patch',
  )
  assertCheck(
    checks,
    appSource.includes('libraryAssetIds') &&
      appSource.includes('appendAssetIds') &&
      appSource.includes('useOpenScanIdFastPath') &&
      appSource.includes('if (useOpenScanIdFastPath) return libraryAssetIds'),
    '无筛选打开扫描时直接复用增量素材 ID 列表',
    'open scan visible id fast path',
  )
  assertCheck(
    checks,
    appSource.includes('const totalAssetCount = libraryAssetIds.length') &&
      appSource.includes('const pendingCount = Math.max(0, totalAssetCount - generatedCount)') &&
      appSource.includes('totalCount={totalAssetCount}') &&
      !appSource.includes('libraryAssets.length - generatedCount') &&
      !appSource.includes('totalCount={libraryAssets.length}'),
    '总数类 UI 使用轻量素材 ID 列表长度，避免依赖整张素材对象数组',
    'asset count from ids',
  )
  assertCheck(
    checks,
    appSource.includes('sortedAssetIds') &&
      appSource.includes('sortAssetIds(libraryAssetIds, assetById, sortField, sortDir)') &&
      appSource.includes('if (!hasVisibleFilters) return sortedAssetIds') &&
      appSource.includes('for (const assetId of sortedAssetIds)'),
    '筛选和搜索复用当前排序方式的素材 ID 顺序',
    'sorted id reuse for filtered views',
  )
  assertCheck(
    checks,
    sortSource.includes('type SortableAssetRef') &&
      sortSource.includes('function compareAssetRefs') &&
      sortSource.includes('const refs = new Array<SortableAssetRef>(assetIds.length)') &&
      sortSource.includes('refs[index] = { asset: assetById.get(id), id }') &&
      sortSource.includes('refs.sort((a, b) => compareAssetRefs(a, b, sortField, sortDir))') &&
      sortSource.includes('const sortedIds = new Array<string>(refs.length)') &&
      sortSource.includes('sortedIds[index] = refs[index].id') &&
      !sortSource.includes('.map((id) => ({ asset: assetById.get(id), id }))') &&
      !sortSource.includes('.map(({ id }) => id)') &&
      !sortSource.includes('const a = assetById.get(aId)'),
    '素材 ID 排序预取素材引用，并预分配引用数组与结果数组，避免排序比较阶段反复查询 Map 和 map 回调分配',
    'sort id asset prefetch',
  )
  assertCheck(
    checks,
    visibleFilterSource.includes("if (activeFolder !== '/' && asset.folder !== activeFolder) return false") &&
      visibleFilterSource.includes("if (activeTag !== 'all' && !asset.tags.includes(activeTag)) return false") &&
      visibleFilterSource.includes("if (typeFilter !== 'all' && asset.kind !== typeFilter) return false") &&
      visibleFilterSource.includes('if (searchQuery && !(asset.searchText ?? createAssetSearchText(asset)).includes(searchQuery)) return false') &&
      !visibleFilterSource.includes('const inFolder') &&
      !visibleFilterSource.includes('const inSearch'),
    '可见素材筛选按文件夹、标签、类型、缩略图和搜索逐项短路，避免无关素材继续做昂贵匹配',
    'short-circuit visible filters',
  )
  assertCheck(
    checks,
    appSource.includes('function assetUpdateAffectsCatalog') &&
      appSource.includes('function sameTags') &&
      metadataCommitSource.includes('const previousAsset = assetByIdRef.current.get(updatedAsset.id)') &&
      metadataCommitSource.includes('const affectsCatalog = assetUpdateAffectsCatalog(previousAsset, updatedAsset)') &&
      metadataCommitSource.includes('if (!affectsCatalog) return') &&
      metadataCommitSource.indexOf('if (!affectsCatalog) return') <
        metadataCommitSource.indexOf('const nextAssets = applyAssetUpdatesToArray') &&
      metadataCommitSource.includes('setLibraryCatalog(deriveLibraryCatalogState(libraryName, nextAssets))'),
    '备注等非目录统计字段更新时跳过素材数组复制和目录/标签统计全量重建',
    'metadata array and catalog rebuild guard',
  )
  assertCheck(
    checks,
      appSource.includes('function updateCatalogTagsForAssetMetadata') &&
      appSource.includes('function assetUpdateCanPatchCatalogTags') &&
      appSource.includes('tagCounts: Map<string, number>') &&
      appSource.includes('folderCounts: Map<string, number>') &&
      appSource.includes('const tagCounts = new Map(catalog.tagCounts)') &&
      appSource.includes('new Map(catalog.folderCounts)') &&
      metadataCommitSource.includes('if (assetUpdateCanPatchCatalogTags(previousAsset, updatedAsset) && previousAsset)') &&
      metadataCommitSource.includes('updateCatalogTagsForAssetMetadata(libraryName, current, previousAsset, updatedAsset)') &&
      metadataCommitSource.includes('setLibraryCatalog(deriveLibraryCatalogState(libraryName, nextAssets))'),
    '标签增删通过运行时标签计数局部更新标签集合，避免重建文件夹和容量统计',
    'metadata tag count catalog patch',
  )
  assertCheck(
    checks,
    removeAssetTagSource.includes('const tagStillUsed =') &&
      removeAssetTagSource.includes('activeTag === tag && (libraryCatalog.tagCounts.get(tag) ?? 0) > 1') &&
      !removeAssetTagSource.includes('libraryAssets.some'),
    '删除标签时使用运行时标签计数判断是否仍被使用，避免扫描全库',
    'removed tag usage count',
  )
  assertCheck(
    checks,
    appSource.includes('function removeIdsFromSet') &&
      appSource.includes('function retainIdsInSet') &&
      appSource.includes('next ??= new Set(current)') &&
      removeAssetsSource.includes('const removedAssets: Asset[] = []') &&
      removeAssetsSource.includes('const nextAssets: Asset[] = []') &&
      removeAssetsSource.includes('const removedMetrics: ThumbnailMetrics = { cacheSize: 0, generatedCount: 0 }') &&
      removeAssetsSource.includes('for (const asset of libraryAssetsRef.current)') &&
      removeAssetsSource.includes('const liveAsset = assetByIdRef.current.get(asset.id) ?? asset') &&
      removeAssetsSource.includes('setSelectedIds((current) => removeIdsFromSet(current, removedIds))') &&
      !removeAssetsSource.includes('getLiveAssets(libraryAssetsRef.current') &&
      !removeAssetsSource.includes('liveAssets.filter') &&
      !removeAssetsSource.includes('libraryAssetsRef.current.filter') &&
      !removeAssetsSource.includes('[...current].filter'),
    '批量删除从资源库移除素材时单次遍历生成保留项、移除项和缩略图统计，避免多轮 filter/map 分配',
    'remove assets single-pass',
  )
  assertCheck(
    checks,
    appSource.includes('const survivingSelectedIds = retainIdsInSet(currentSelectedIds, merged.idSet)') &&
      restoreTrashSource.includes('setTrashSelectedIds((current) => removeIdsFromSet(current, idSet))') &&
      !appSource.includes('[...currentSelectedIds]') &&
      !appSource.includes('currentSelectedIds].filter') &&
      !restoreTrashSource.includes('[...current].filter'),
    '刷新合并和恢复回收站后的选中集合清理直接循环处理，避免展开 Set 再 filter',
    'selection cleanup direct set loops',
  )
  assertCheck(
    checks,
    appSource.includes('visibleLookupRef') &&
      appSource.includes('createVisibleIndexMap') &&
      appSource.includes('getVisibleAssetIndex') &&
      !appSource.includes('const visibleIdSet = useMemo') &&
      !appSource.includes('const visibleIndexById = useMemo') &&
      libraryViewSource.includes('getAssetIndex: (assetId: string) => number') &&
      !libraryViewSource.includes('assetIndexById'),
    '可见素材索引改为按需构建，避免大列表每次变化都生成 Set/Map',
    'lazy visible lookup',
  )
  assertCheck(
    checks,
    visibleSelectedSource.includes('if (selectedIds.size === 0) return selectedIds') &&
      visibleSelectedSource.includes('if (visibleAssetIds.length <= selectedIds.size)') &&
      visibleSelectedSource.includes('for (const id of visibleAssetIds)') &&
      visibleSelectedSource.includes('if (selectedIds.has(id)) next.add(id)'),
    '可见选中项计算优先遍历更小集合，避免筛选后仍扫描大选择集',
    'visible selected smaller-side intersection',
  )
  assertCheck(
    checks,
    appSource.includes('function lastIdInSet') &&
      appSource.includes('function createIdRangeSet') &&
      assetClickSource.includes('lastIdInSet(next)') &&
      assetClickSource.includes('createIdRangeSet(visibleAssetIds, from, to)') &&
      !assetClickSource.includes('Array.from(next)') &&
      !assetClickSource.includes('visibleAssetIds.slice'),
    '点击取消多选和 Shift 范围选择直接循环得到目标集合，避免大选择集临时数组',
    'selection click range direct loops',
  )
  assertCheck(
    checks,
    selectedActionSource.includes('function getVisibleSelectedAssets()') &&
      selectedActionSource.includes('for (const id of visibleSelectedIds)') &&
      appSource.includes('onRotateSelected={(quarterTurns) => rotateAssets(getVisibleSelectedAssets(), quarterTurns)}') &&
      !appSource.includes('const selectedAssets = [...visibleSelectedIds]'),
    '批量旋转所需素材数组改为操作触发时生成，避免渲染阶段重建大选择数组',
    'lazy selected assets for actions',
  )
  assertCheck(
    checks,
    appSource.includes('function dragSourcePathsForSelection') &&
      appSource.includes('for (const id of selectedIds)') &&
      dragStartSource.includes('dragSourcePathsForSelection(asset, visibleSelectedIds, assetByIdRef.current)') &&
      !dragStartSource.includes('[...visibleSelectedIds]') &&
      !dragStartSource.includes('.map((id) =>') &&
      !dragStartSource.includes('.filter((path)') &&
      appSource.includes('function countProcessableAssets') &&
      appSource.includes('for (const id of assetIds)') &&
      batchModalSource.includes('processableCount={countProcessableAssets(visibleSelectedIds, assetById)}') &&
      !batchModalSource.includes('[...visibleSelectedIds]') &&
      !batchModalSource.includes('.filter((id)'),
    '拖拽导出和批量弹窗计数直接遍历选择集，避免大选择集下展开数组再 map/filter',
    'selection action direct loops',
  )
  assertCheck(
    checks,
    appSource.includes('function insertCollectedAssets(assets: Asset[])') &&
      appSource.includes('if (assets.length === 0) return') &&
      appSource.includes('appendAssetIndexes(libraryAssetIndexByIdRef.current, libraryAssetIndexByIdRef.current.size, assets)') &&
      appSource.includes('appendAssetsToAssetMap(assetMap, assets)') &&
      appSource.includes('appendAssetsToLibraryCatalogState(libraryName, current, assets)') &&
      appSource.includes('setLibraryAssets((current) => appendItems(current, assets))') &&
      appSource.includes('function insertCollectedAsset(asset: Asset)') &&
      appSource.includes('insertCollectedAssets([asset])') &&
      restoreTrashSource.includes('const restoredAssets: Asset[] = []') &&
      restoreTrashSource.includes('restoredAssets.push(asset)') &&
      restoreTrashSource.includes('insertCollectedAssets(restoredAssets)') &&
      batchProcessSource.includes('insertCollectedAssets(newAssets)') &&
      rotateAssetsSource.includes('insertCollectedAssets(newAssets)') &&
      !restoreTrashSource.includes('insertCollectedAsset(asset)') &&
      !batchProcessSource.includes('for (const asset of newAssets) insertCollectedAsset(asset)') &&
      !rotateAssetsSource.includes('for (const asset of newAssets) insertCollectedAsset(asset)'),
    '恢复回收站、批量处理和旋转的新素材结果批量插入资源库，避免逐个素材触发多组状态更新',
    'batch insert collected assets',
  )
  assertCheck(
    checks,
    thumbnailClearSource.includes('function prepareThumbnailClearPatch(assets: Iterable<Asset>)') &&
      thumbnailClearSource.includes('const metrics: ThumbnailMetrics = { cacheSize: 0, generatedCount: 0 }') &&
      thumbnailClearSource.includes('const updates = new Map<string, Partial<Asset>>()') &&
      thumbnailClearSource.includes('for (const asset of assets)') &&
      thumbnailClearSource.includes("if (asset.thumbnailUrl?.startsWith('blob:')) URL.revokeObjectURL(asset.thumbnailUrl)") &&
      thumbnailClearSource.includes('metrics.generatedCount += 1') &&
      thumbnailClearSource.includes('metrics.cacheSize += asset.thumbnailSizeKb ?? 0') &&
      thumbnailClearSource.includes('updates.set(asset.id, clearThumbnailUpdate())'),
    '缩略图清理单次遍历完成 URL 回收、统计扣减和更新补丁生成',
    'thumbnail clear one-pass patch',
  )
  assertCheck(
    checks,
    generateThumbnailAssetsSource.includes('const thumbnailClear = prepareThumbnailClearPatch(targetAssets)') &&
      generateThumbnailAssetsSource.includes('const nativeSources = libraryRootPath ? createNativeThumbnailSources(targetAssets) : null') &&
      generateThumbnailAssetsSource.includes('if (libraryRootPath && nativeSources)') &&
      generateThumbnailAssetsSource.includes('sources: nativeSources') &&
      generateThumbnailAssetsSource.includes('subtractThumbnailMetrics(current, thumbnailClear.metrics)') &&
      generateThumbnailAssetsSource.includes('applyAssetUpdatesToMap(assetMap, thumbnailClear.updates)') &&
      !generateThumbnailAssetsSource.includes('targetIds') &&
      !generateThumbnailAssetsSource.includes('targetAssets.every((asset) => asset.sourcePath)') &&
      !generateThumbnailAssetsSource.includes('targetAssets.map((asset) => ({') &&
      !generateThumbnailAssetsSource.includes('revokeThumbnailUrls(liveAssets.filter') &&
      !generateThumbnailAssetsSource.includes('buildThumbnailClearUpdates'),
    '重新生成缩略图时复用单次清理补丁，并单次构造原生 sources，避免全库 live 数组过滤和重复遍历',
    'thumbnail regenerate clear patch',
  )
  assertCheck(
    checks,
    liveAssetSource.includes('const liveAssets = new Array<Asset>(sourceAssets.length)') &&
      liveAssetSource.includes('liveAssets[index] = assetById.get(asset.id) ?? asset') &&
      liveAssetSource.includes('return liveAssets') &&
      liveAssetSource.includes('const sources = new Array<NativeThumbnailSource>(targetAssets.length)') &&
      liveAssetSource.includes('if (!sourcePath) return null') &&
      liveAssetSource.includes('sources[index] = {') &&
      liveAssetSource.includes('return sources') &&
      !liveAssetSource.includes('sourceAssets.map((asset) => assetById.get(asset.id) ?? asset)') &&
      !liveAssetSource.includes('targetAssets.map'),
    '实时素材数组与原生缩略图 sources 使用预分配循环，避免大资源库全量 map 分配',
    'live assets native sources preallocated loops',
  )
  assertCheck(
    checks,
    generateFolderThumbnailsSource.includes('const selectedAssets: Asset[] = []') &&
      generateFolderThumbnailsSource.includes('for (const asset of libraryAssetsRef.current)') &&
      generateFolderThumbnailsSource.includes('const liveAsset = assetByIdRef.current.get(asset.id) ?? asset') &&
      generateFolderThumbnailsSource.includes('selectedAssets.push(liveAsset)') &&
      !generateFolderThumbnailsSource.includes('getLiveAssets(libraryAssetsRef.current, assetByIdRef.current).filter'),
    '按文件夹生成缩略图时单次遍历收集目标素材，避免先构造全量 live 数组再过滤',
    'folder thumbnail single-pass collection',
  )
  assertCheck(
    checks,
    clearThumbnailCacheSource.includes('const thumbnailClear = prepareThumbnailClearPatch(liveAssets)') &&
      clearThumbnailCacheSource.includes('applyAssetUpdatesToMap(assetMap, thumbnailClear.updates)') &&
      !clearThumbnailCacheSource.includes('buildThumbnailClearUpdates') &&
      !clearThumbnailCacheSource.includes('revokeThumbnailUrls(liveAssets)'),
    '清理缩略图缓存复用同一清理补丁路径，避免清理逻辑分叉',
    'clear thumbnail cache shared patch',
  )
  assertCheck(
    checks,
    appSource.includes('function createAssetOperationTargets') &&
      appSource.includes('idByRelativePath.set(asset.relativePath, asset.id)') &&
      appSource.includes('assetByRelativePath.set(asset.relativePath, asset)') &&
      appSource.includes('function assetsByIds') &&
      deleteSelectedSource.includes('createAssetOperationTargets(') &&
      deleteSelectedSource.includes('relativePaths: targets.relativePaths') &&
      deleteSelectedSource.includes('removeAssetsFromLibrary(targets.ids)') &&
      batchProcessSource.includes('createAssetOperationTargets(') &&
      batchProcessSource.includes('const removedId = targets.idByRelativePath.get(entry.previousRelativePath)') &&
      batchProcessSource.includes('newAssetIds.add(asset.id)') &&
      batchProcessSource.includes('setSelectedIds(newAssetIds)') &&
      rotateAssetsSource.includes('createAssetOperationTargets(') &&
      rotateAssetsSource.includes('const removedId = targets.idByRelativePath.get(entry.previousRelativePath)') &&
      rotateAssetsSource.includes('newAssetIds.add(asset.id)') &&
      rotateAssetsSource.includes('setSelectedIds(newAssetIds)') &&
      !deleteSelectedSource.includes('[...visibleSelectedIds]') &&
      !batchProcessSource.includes('processedPaths') &&
      !batchProcessSource.includes('targets.filter') &&
      !rotateAssetsSource.includes('processedPaths') &&
      !rotateAssetsSource.includes('targets.filter'),
    '批量删除、处理和旋转在目标收集时建立路径映射，后端结果回来后直接得到旧 ID，避免重复 map/filter',
    'batch operation target maps',
  )
  assertCheck(
    checks,
    appSource.includes('type AssetReplacement') &&
      appSource.includes('function createLiveAssetByRelativePath') &&
      replaceAssetsSource.includes('const oldIds = new Set<string>()') &&
      replaceAssetsSource.includes('const oldToNew = new Map<string, string>()') &&
      replaceAssetsSource.includes('for (const { oldAsset, oldId, asset } of replacements)') &&
      replaceAssetsSource.includes('const nextAssets: Asset[] = []') &&
      replaceAssetsSource.includes('for (const asset of libraryAssetsRef.current)') &&
      replaceAssetsSource.includes('pushItems(nextAssets, merged)') &&
      !replaceAssetsSource.includes('replacements.map') &&
      !replaceAssetsSource.includes('libraryAssetsRef.current.filter') &&
      !replaceAssetsSource.includes('...merged') &&
      moveSelectedSource.includes('createAssetOperationTargets(') &&
      moveSelectedSource.includes('relativePaths: targets.relativePaths') &&
      moveSelectedSource.includes('targets.assetByRelativePath.get(entry.previousRelativePath)') &&
      !moveSelectedSource.includes('targets.find') &&
      renameFolderSource.includes('createLiveAssetByRelativePath(libraryAssetsRef.current, assetByIdRef.current)') &&
      renameFolderSource.includes('for (const entry of remaps)') &&
      !renameFolderSource.includes('getLiveAssets(libraryAssetsRef.current, assetByIdRef.current).map'),
    '移动和替换素材时使用路径映射与单次循环归并，避免大量移动后反复 find、map、filter 和 spread',
    'move replace single-pass maps',
  )
  assertCheck(
    checks,
    appSource.includes('getVisibleAssetIndex(primaryId)') &&
      appSource.includes("const targetId = edge === 'top' ? visibleAssetIds[0] : visibleAssetIds.at(-1)") &&
      appSource.includes('const nextId = visibleAssetIds[nextIndex]') &&
      !appSource.includes('visualOrderRef') &&
      !appSource.includes('VisualOrderCache') &&
      !appSource.includes('getCurrentVisualIndex') &&
      !appSource.includes('getCurrentVisualIds') &&
      !libraryViewSource.includes('onVisualOrderChange') &&
      !appSource.includes('visualIds.indexOf(primaryId)') &&
      !appSource.includes('indexOf(primaryId)'),
    '连续键盘导航复用可见素材索引缓存，避免为同一可见顺序维护第二套视觉顺序索引',
    'lazy visual order lookup',
  )
  assertCheck(
    checks,
    libraryViewSource.includes('cssAttributeString') &&
      libraryViewSource.includes('container.querySelector<HTMLElement>') &&
      !libraryViewSource.includes('querySelectorAll<HTMLElement>(\'.asset-item\')'),
    '键盘滚动定位直接查询目标素材 DOM，避免扫描全部可见节点',
    'direct keyboard target query',
  )
  assertCheck(
    checks,
    assetItemSource.includes('memo(AssetItemBase, areAssetItemPropsEqual)') &&
      assetItemSource.includes('areAssetItemLayoutsEqual') &&
      assetItemSource.includes('a.aspectRatio === b.aspectRatio') &&
      !assetItemSource.includes('Object.keys') &&
      libraryViewSource.includes('assetHandlersRef'),
    '素材项支持固定字段布局比较，并通过稳定事件桥接减少滚动与缩略图刷新时的可见项重渲染',
    'AssetItem custom memo + stable handlers',
  )
  assertCheck(
    checks,
    assetItemSource.includes('translate3d') &&
      assetItemSource.includes('decoding="async"'),
    '虚拟项使用合成层位移并异步解码图片',
    'translate3d + async decoding',
  )
  assertCheck(
    checks,
    libraryViewSource.includes('ratio: number') &&
      masonryLayoutDataSource.includes('ratio,') &&
      masonryVirtualLayoutSource.includes('aspectRatio: String(item.ratio)') &&
      !masonryLayoutDataSource.includes('aspectRatio: String(ratio)') &&
      !masonryVirtualLayoutSource.includes('aspectRatio: item.aspectRatio') &&
      assetItemSource.includes("style['--asset-aspect-ratio'] = layout.aspectRatio") &&
      appCssSource.includes('aspect-ratio: var(--asset-aspect-ratio, 16 / 10)') &&
      !assetItemSource.includes('function getAssetRatio') &&
      !assetItemSource.includes("style={viewMode === 'masonry'"),
    '瀑布流缩略图比例沿用布局阶段数值结果，并只在可见项阶段生成 CSS 变量字符串',
    'masonry aspect ratio layout variable',
  )
  assertCheck(
    checks,
    appSource.includes('SCROLL_POSITION_SAVE_MS') &&
      appSource.includes('if (scrollSaveTimerRef.current) return') &&
      appSource.includes('scrollPositionsRef.current[key]'),
    '滚动位置持久化使用单定时器节流，避免连续滚动时反复创建和清理保存任务',
    'single timer scroll position persistence',
  )
  assertCheck(
    checks,
    rafStateSource.includes('function createRafNumberCommitter') &&
      rafStateSource.includes('window.requestAnimationFrame(flush)') &&
      rafStateSource.includes('window.cancelAnimationFrame(frameId)') &&
      rafStateSource.includes('commit(pendingValue)'),
    '高频数值状态提交通过 requestAnimationFrame 合并并保留最终值',
    'createRafNumberCommitter',
  )
  assertCheck(
    checks,
    sidebarResizeSource.includes('createRafNumberCommitter(setSidebarWidth, startWidth)') &&
      sidebarResizeSource.includes('sidebarWidthCommitter.update') &&
      sidebarResizeSource.includes('sidebarWidthCommitter.flush()') &&
      sidebarResizeSource.includes("window.addEventListener('pointercancel', stopResize") &&
      !sidebarResizeSource.includes('setSidebarWidth(clamp(startWidth + moveEvent.clientX - startX'),
    '左侧栏宽度拖拽按动画帧合并提交，避免 pointermove 频繁触发 React 更新',
    'sidebar resize rAF commit',
  )
  assertCheck(
    checks,
    inspectorResizeSource.includes('createRafNumberCommitter(setInspectorWidth, startWidth)') &&
      inspectorResizeSource.includes('inspectorWidthCommitter.update') &&
      inspectorResizeSource.includes('inspectorWidthCommitter.flush()') &&
      inspectorResizeSource.includes("window.addEventListener('pointercancel', stopResize") &&
      !inspectorResizeSource.includes('setInspectorWidth(clamp(startWidth - (moveEvent.clientX - startX)'),
    '右侧详情栏宽度拖拽按动画帧合并提交，避免 pointermove 频繁触发 React 更新',
    'inspector resize rAF commit',
  )
  assertCheck(
    checks,
    verticalResizeSource.includes('createRafNumberCommitter(onSetFolderPaneHeight, startHeight)') &&
      verticalResizeSource.includes('folderPaneHeightCommitter.update') &&
      verticalResizeSource.includes('folderPaneHeightCommitter.flush()') &&
      verticalResizeSource.includes("window.addEventListener('pointercancel', stopResize") &&
      !verticalResizeSource.includes('onSetFolderPaneHeight(clamp(startHeight + moveEvent.clientY - startY'),
    '左侧文件夹和标签分割线拖拽按动画帧合并提交，避免 pointermove 频繁触发 React 更新',
    'folder pane resize rAF commit',
  )
  assertCheck(
    checks,
    tauriSource.includes('FOLDER_METADATA_FILE_NAME') &&
      tauriSource.includes('FolderMetadataCache') &&
      tauriSource.includes('write_folder_asset_metadata'),
    '文件夹级元数据使用可读 JSON 文件',
    '.picman.folder.json metadata',
  )
  assertCheck(
    checks,
    appSource.includes('saveFolderAssetMetadata') &&
      appSource.includes('write_folder_asset_metadata') &&
      (await readProjectFile('src/components/Inspector.tsx')).includes('onUpdateNote'),
    '标签收藏备注会写回文件夹级元数据',
    'tags favorite note persistence',
  )

  if (options.library) {
    const { fileCount, folderCount } = await countLibraryImages(options.library)
    assertCheck(
      checks,
      fileCount >= options.minCount,
      '压力素材库达到目标文件数量',
      `${fileCount}/${options.minCount} files, ${folderCount} folders`,
    )
  }

  const failed = checks.filter((check) => !check.ok)

  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.label} - ${check.detail}`)
  }

  if (failed.length > 0) {
    console.error(`性能审计失败：${failed.length}/${checks.length}`)
    process.exit(1)
  }

  console.log(`性能审计通过：${checks.length}/${checks.length}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
