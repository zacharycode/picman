import { describe, expect, it } from 'vitest'
import type { Asset } from '../types/library'
import { createAssetSearchText, normalizeSearchText } from './search'

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    dimensions: '100 x 100',
    favorite: false,
    folder: '/灵感',
    id: 'asset-1',
    kind: 'png',
    modifiedAt: '2026-07-26',
    name: '首页设计.png',
    note: '移动端参考',
    relativePath: '灵感/首页设计.png',
    sizeKb: 20,
    swatch: 'blue',
    tags: ['中文标签', 'UI'],
    thumbnailReady: false,
    ...overrides,
  }
}

describe('search normalization', () => {
  it('keeps Chinese searchable and normalizes case and full-width Latin text', () => {
    expect(normalizeSearchText('首页 ＵＩ')).toBe('首页 ui')
  })

  it('indexes names, folders, tags, and notes in one reusable string', () => {
    const text = createAssetSearchText(asset())
    expect(text).toContain('首页设计.png')
    expect(text).toContain('中文标签')
    expect(text).toContain('移动端参考')
  })
})
