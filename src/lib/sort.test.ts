import { describe, expect, it } from 'vitest'
import type { Asset } from '../types/library'
import { sortAssetIds } from './sort'

function asset(id: string, name: string, sizeKb: number): Asset {
  return {
    dimensions: '100 x 100',
    favorite: false,
    folder: '/',
    id,
    kind: 'png',
    modifiedAt: '2026-07-26',
    name,
    note: '',
    relativePath: name,
    sizeKb,
    swatch: 'blue',
    tags: [],
    thumbnailReady: false,
  }
}

describe('asset id sorting', () => {
  const assets = [asset('2', '图片10.png', 10), asset('1', '图片2.png', 20), asset('3', '封面.png', 5)]
  const byId = new Map(assets.map((item) => [item.id, item]))

  it('uses natural name ordering without mutating the source ids', () => {
    const ids = ['2', '1', '3']
    expect(sortAssetIds(ids, byId, 'name', 'asc')).toEqual(['1', '2', '3'])
    expect(ids).toEqual(['2', '1', '3'])
  })

  it('sorts numeric fields in either direction', () => {
    expect(sortAssetIds(['1', '2', '3'], byId, 'size', 'desc')).toEqual(['1', '2', '3'])
    expect(sortAssetIds(['1', '2', '3'], byId, 'size', 'asc')).toEqual(['3', '2', '1'])
  })
})
