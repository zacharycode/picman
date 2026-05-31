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
  const [packageJson, appSource, libraryViewSource, tauriSource] = await Promise.all([
    readProjectFile('package.json'),
    readProjectFile('src/App.tsx'),
    readProjectFile('src/components/LibraryView.tsx'),
    readProjectFile('src-tauri/src/lib.rs'),
  ])
  const packageConfig = JSON.parse(packageJson)
  const checks = []
  const scanBatchSize = constantNumber(tauriSource, 'SCAN_BATCH_SIZE')
  const thumbnailBatchSize = constantNumber(tauriSource, 'THUMBNAIL_BATCH_SIZE')
  const thumbnailWorkerLimit = constantNumber(tauriSource, 'THUMBNAIL_MAX_WORKERS')
  const thumbnailFlush = extractBetween(appSource, 'const flushNativeThumbnailUpdates', 'const queueNativeThumbnailBatch')

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
      libraryViewSource.includes('FAST_SCROLL_VELOCITY_PX_PER_MS') &&
      libraryViewSource.includes('deferThumbnailLoad'),
    '快速滚动使用动态预渲染和缩略图降级',
    'fast scroll overscan + deferred images',
  )
  assertCheck(
    checks,
    libraryViewSource.includes('translate3d') &&
      (await readProjectFile('src/components/AssetItem.tsx')).includes('decoding="async"'),
    '虚拟项使用合成层位移并异步解码图片',
    'translate3d + async decoding',
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
