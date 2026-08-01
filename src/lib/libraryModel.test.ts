import { describe, expect, it, vi } from 'vitest'
import {
  appendAssetsToLibraryCatalogState,
  applyThumbnailMetricsDelta,
  assetUpdateAffectsLayout,
  clearThumbnailUpdate,
  createAssetMap,
  createIdRangeSet,
  deriveLibraryCatalogState,
  enqueueVisiblePendingThumbnails,
  mergeRefreshedAssets,
  pendingThumbnailTargets,
  prefViewMode,
  prepareThumbnailClearPatch,
  prepareThumbnailGenerationUpdate,
  reconcilePendingThumbnailAssets,
  revokeUncommittedThumbnailBlobUrls,
} from './libraryModel'
import type { Asset } from '../types/library'

function asset(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    dimensions: '100 x 80',
    favorite: false,
    folder: '/素材',
    height: 80,
    id,
    kind: 'jpg',
    modifiedAt: '2026-07-26',
    name: `${id}.jpg`,
    note: '',
    relativePath: `素材/${id}.jpg`,
    sizeKb: 100,
    sourcePath: `/library/素材/${id}.jpg`,
    swatch: 'steel',
    tags: [],
    thumbnailReady: false,
    width: 100,
    ...overrides,
  }
}

describe('libraryModel', () => {
  it('保留刷新前仍有效的缩略图，并准确报告新增和移除', () => {
    const previous = [
      asset('keep', {
        thumbnailPath: '/cache/keep.webp',
        thumbnailReady: true,
        thumbnailSizeKb: 8,
        thumbnailUrl: 'asset://keep',
      }),
      asset('removed'),
    ]
    const refreshed = [asset('keep'), asset('added')]

    const result = mergeRefreshedAssets(refreshed, previous)

    expect(result.added).toBe(1)
    expect(result.addedAssets.map((item) => item.id)).toEqual(['added'])
    expect(result.thumbnailGenerationAssets.map((item) => item.id)).toEqual(['added'])
    expect(result.removed).toBe(1)
    expect(result.removedAssets[0].id).toBe('removed')
    expect(result.assets[0].thumbnailReady).toBe(true)
    expect(result.assets[0].thumbnailPath).toBe('/cache/keep.webp')
  })

  it('后台扫描找到更新的缓存时优先采用新缩略图', () => {
    const previous = asset('fresh', {
      previewUrl: 'blob:preview',
      thumbnailPath: '/cache/old.webp',
      thumbnailQuality: 'standard',
      thumbnailReady: true,
      thumbnailSizeKb: 12,
      thumbnailUrl: 'asset://old',
    })
    const scanned = asset('fresh', {
      thumbnailPath: '/cache/new.webp',
      thumbnailQuality: 'compact',
      thumbnailReady: true,
      thumbnailSizeKb: 7,
      thumbnailUrl: 'asset://new',
    })

    const result = mergeRefreshedAssets([scanned], [previous])

    expect(result.assets[0].thumbnailPath).toBe('/cache/new.webp')
    expect(result.assets[0].thumbnailQuality).toBe('compact')
    expect(result.assets[0].previewUrl).toBe('blob:preview')
    expect(result.thumbnailGenerationAssets).toEqual([])
  })

  it('原文件被覆盖或上次生成失败时会重新进入自动缩略图队列', () => {
    const changed = mergeRefreshedAssets(
      [asset('new-id', { relativePath: '素材/shared.jpg', sourcePath: '/library/素材/shared.jpg' })],
      [asset('old-id', { relativePath: '素材/shared.jpg', sourcePath: '/library/素材/shared.jpg' })],
    )
    const retry = mergeRefreshedAssets(
      [asset('retry')],
      [asset('retry', { thumbnailError: 'decode failed' })],
    )

    expect(changed.added).toBe(0)
    expect(changed.thumbnailGenerationAssets.map((item) => item.id)).toEqual(['new-id'])
    expect(retry.thumbnailGenerationAssets.map((item) => item.id)).toEqual(['retry'])
  })

  it('连续刷新会保留未完成的自动缩略图任务，并清除已完成或已删除素材', () => {
    const pending = createAssetMap([asset('removed')])
    const incoming = asset('incoming')
    reconcilePendingThumbnailAssets(pending, [incoming], new Set([incoming.id]), [incoming])

    expect([...pending.keys()]).toEqual(['incoming'])
    expect(pendingThumbnailTargets(pending, createAssetMap([incoming]))).toEqual([incoming])

    const ready = { ...incoming, thumbnailReady: true, thumbnailUrl: 'asset://incoming' }
    expect(pendingThumbnailTargets(pending, createAssetMap([ready]))).toEqual([])
    expect(pending.size).toBe(0)
  })

  it('增量维护目录、标签和容量统计', () => {
    const initial = deriveLibraryCatalogState('测试库', [asset('a', { tags: ['红色'] })])
    const next = appendAssetsToLibraryCatalogState('测试库', initial, [
      asset('b', { folder: '/灵感', sizeKb: 250, tags: ['红色', '网页'] }),
    ])

    expect(next.folderCounts.get('/')).toBe(2)
    expect(next.folderCounts.get('/灵感')).toBe(1)
    expect(next.tagCounts.get('红色')).toBe(2)
    expect(next.tagCounts.get('网页')).toBe(1)
    expect(next.sourceSize).toBe(350)
  })

  it('清理缩略图只生成派生字段补丁，不改素材文件字段', () => {
    const source = asset('thumb', {
      thumbnailPath: '/cache/thumb.webp',
      thumbnailReady: true,
      thumbnailSizeKb: 12,
      thumbnailUrl: 'blob:thumb',
    })
    const result = prepareThumbnailClearPatch(createAssetMap([source]).values())

    expect(result.metrics).toEqual({ cacheSize: 12, generatedCount: 1 })
    expect(result.updates.get(source.id)).toEqual(clearThumbnailUpdate())
    expect(source.sourcePath).toBe('/library/素材/thumb.jpg')
  })

  it('后台重建缩略图时保留旧图，并只累计成功替换的差值', () => {
    const previous = asset('thumb', {
      thumbnailFormat: 'webp',
      thumbnailHeight: 80,
      thumbnailPath: '/cache/old.webp',
      thumbnailQuality: 'standard',
      thumbnailReady: true,
      thumbnailSizeKb: 12,
      thumbnailUrl: 'asset://old',
      thumbnailWidth: 100,
    })

    const failed = prepareThumbnailGenerationUpdate(previous, {
      thumbnailError: 'decode failed',
      thumbnailReady: false,
    })
    expect(failed.update).toEqual({ thumbnailError: 'decode failed' })
    expect(failed.asset.thumbnailPath).toBe('/cache/old.webp')
    expect(failed.asset.thumbnailQuality).toBe('standard')
    expect(failed.metricsDelta).toEqual({ cacheSize: 0, generatedCount: 0 })

    const replaced = prepareThumbnailGenerationUpdate(failed.asset, {
      thumbnailError: undefined,
      thumbnailPath: '/cache/new.webp',
      thumbnailReady: true,
      thumbnailSizeKb: 8,
      thumbnailUrl: 'asset://new',
    })
    expect(replaced.metricsDelta).toEqual({ cacheSize: -4, generatedCount: 0 })
    expect(applyThumbnailMetricsDelta({ cacheSize: 12, generatedCount: 1 }, replaced.metricsDelta)).toEqual({
      cacheSize: 8,
      generatedCount: 1,
    })

    const firstThumbnail = prepareThumbnailGenerationUpdate(asset('new'), {
      thumbnailPath: '/cache/new-first.webp',
      thumbnailReady: true,
      thumbnailSizeKb: 8,
      thumbnailUrl: 'asset://new-first',
    })
    expect(firstThumbnail.metricsDelta).toEqual({ cacheSize: 8, generatedCount: 1 })

    const browserReplacement = prepareThumbnailGenerationUpdate(
      { ...previous, thumbnailUrl: 'blob:old-thumbnail' },
      { thumbnailReady: true, thumbnailSizeKb: 8, thumbnailUrl: 'blob:new-thumbnail' },
    )
    expect(browserReplacement.replacedBlobUrl).toBe('blob:old-thumbnail')
    expect(failed.replacedBlobUrl).toBeUndefined()
  })

  it('已有原图尺寸时，缩略图批量写回不会触发瀑布流全量重排', () => {
    const source = asset('layout')

    expect(
      assetUpdateAffectsLayout(source, {
        thumbnailHeight: 160,
        thumbnailWidth: 200,
      }),
    ).toBe(false)
    expect(
      assetUpdateAffectsLayout(
        {
          ...source,
          dimensions: '未知',
          height: undefined,
          thumbnailHeight: 80,
          thumbnailWidth: 100,
          width: undefined,
        },
        { thumbnailWidth: 240 },
      ),
    ).toBe(true)
  })

  it('取消生成时只回收尚未提交的新 blob，不破坏当前缩略图', () => {
    const current = createAssetMap([
      asset('pending', { thumbnailReady: true, thumbnailUrl: 'blob:old' }),
      asset('committed', { thumbnailReady: true, thumbnailUrl: 'blob:committed' }),
    ])
    const updates = new Map<string, Partial<Asset>>([
      ['pending', { thumbnailReady: true, thumbnailUrl: 'blob:new' }],
      ['committed', { thumbnailReady: true, thumbnailUrl: 'blob:committed' }],
      ['native', { thumbnailReady: true, thumbnailUrl: 'asset://native' }],
    ])
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    expect(revokeUncommittedThumbnailBlobUrls(updates, current)).toBe(1)
    expect(revoke).toHaveBeenCalledWith('blob:new')
    expect(revoke).not.toHaveBeenCalledWith('blob:old')
    expect(revoke).not.toHaveBeenCalledWith('blob:committed')
    revoke.mockRestore()
  })

  it('选择区间和偏好值校验具有稳定回退', () => {
    expect([...createIdRangeSet(['a', 'b', 'c'], 1, 2)]).toEqual(['b', 'c'])
    expect(prefViewMode('masonry')).toBe('masonry')
    expect(prefViewMode('unknown')).toBe('adaptive')
  })

  it('只把进入可视区且尚未尝试的本地素材加入自动缩略图队列', () => {
    const pending = new Map<string, Asset>()
    const ready = asset('ready', { sourcePath: '/tmp/ready.jpg', thumbnailReady: true })
    const failed = asset('failed', { sourcePath: '/tmp/failed.jpg', thumbnailError: 'decode error' })
    const waiting = asset('waiting', { sourcePath: '/tmp/waiting.jpg' })
    const assets = createAssetMap([ready, failed, waiting])

    expect(enqueueVisiblePendingThumbnails(pending, ['ready', 'failed', 'waiting'], assets)).toBe(1)
    expect([...pending.keys()]).toEqual(['waiting'])
    expect(enqueueVisiblePendingThumbnails(pending, ['waiting'], assets)).toBe(0)
  })
})
