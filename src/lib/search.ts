import type { Asset } from '../types/library'

export function normalizeSearchText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase()
}

export function createAssetSearchText(asset: Asset) {
  return normalizeSearchText(`${asset.name} ${asset.folder} ${asset.relativePath} ${asset.tags.join(' ')} ${asset.note}`)
}

export function withAssetSearchText<T extends Asset>(asset: T): T {
  return {
    ...asset,
    searchText: createAssetSearchText(asset),
  }
}
