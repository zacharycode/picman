import { describe, expect, it } from 'vitest'
import {
  appendAssetsToLibraryCatalogState,
  clearThumbnailUpdate,
  createAssetMap,
  createIdRangeSet,
  deriveLibraryCatalogState,
  mergeRefreshedAssets,
  prefThumbnailQuality,
  prefViewMode,
  prepareThumbnailClearPatch,
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
    expect(result.removed).toBe(1)
    expect(result.removedAssets[0].id).toBe('removed')
    expect(result.assets[0].thumbnailReady).toBe(true)
    expect(result.assets[0].thumbnailPath).toBe('/cache/keep.webp')
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

  it('选择区间和偏好值校验具有稳定回退', () => {
    expect([...createIdRangeSet(['a', 'b', 'c'], 1, 2)]).toEqual(['b', 'c'])
    expect(prefViewMode('masonry')).toBe('masonry')
    expect(prefViewMode('unknown')).toBe('adaptive')
    expect(prefThumbnailQuality('compact')).toBe('compact')
    expect(prefThumbnailQuality('unknown')).toBe('standard')
  })
})
