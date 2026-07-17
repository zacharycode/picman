import type { Asset, SortDir, SortField } from '../types/library'

export const SORT_LABELS: Record<SortField, string> = {
  name: '名称',
  date: '修改时间',
  size: '文件大小',
  type: '文件类型',
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

type SortableAssetRef = {
  asset?: Asset
  id: string
}

function compareAssets(a: Asset, b: Asset, sortField: SortField, sortDir: SortDir) {
  let cmp = 0

  if (sortField === 'name') cmp = nameCollator.compare(a.name, b.name)
  else if (sortField === 'date') cmp = a.modifiedAt.localeCompare(b.modifiedAt) || nameCollator.compare(a.name, b.name)
  else if (sortField === 'size') cmp = a.sizeKb - b.sizeKb
  else if (sortField === 'type') cmp = a.kind.localeCompare(b.kind) || nameCollator.compare(a.name, b.name)

  if (cmp === 0) cmp = a.relativePath.localeCompare(b.relativePath)

  return sortDir === 'asc' ? cmp : -cmp
}

function compareAssetRefs(a: SortableAssetRef, b: SortableAssetRef, sortField: SortField, sortDir: SortDir) {
  if (!a.asset || !b.asset) return a.asset ? -1 : b.asset ? 1 : 0
  return compareAssets(a.asset, b.asset, sortField, sortDir)
}

export function sortAssets(assets: Asset[], sortField: SortField, sortDir: SortDir) {
  if (assets.length <= 1) return assets

  return [...assets].sort((a, b) => compareAssets(a, b, sortField, sortDir))
}

export function sortAssetIds(
  assetIds: string[],
  assetById: ReadonlyMap<string, Asset>,
  sortField: SortField,
  sortDir: SortDir,
) {
  if (assetIds.length <= 1) return assetIds

  const refs = new Array<SortableAssetRef>(assetIds.length)
  for (let index = 0; index < assetIds.length; index += 1) {
    const id = assetIds[index]
    refs[index] = { asset: assetById.get(id), id }
  }

  refs.sort((a, b) => compareAssetRefs(a, b, sortField, sortDir))

  const sortedIds = new Array<string>(refs.length)
  for (let index = 0; index < refs.length; index += 1) {
    sortedIds[index] = refs[index].id
  }

  return sortedIds
}
