import type { Asset, SortDir, SortField } from '../types/library'

export const SORT_LABELS: Record<SortField, string> = {
  name: '名称',
  date: '修改时间',
  size: '文件大小',
  type: '文件类型',
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function sortAssets(assets: Asset[], sortField: SortField, sortDir: SortDir) {
  if (assets.length <= 1) return assets

  return [...assets].sort((a, b) => {
    let cmp = 0

    if (sortField === 'name') cmp = nameCollator.compare(a.name, b.name)
    else if (sortField === 'date') cmp = a.modifiedAt.localeCompare(b.modifiedAt) || nameCollator.compare(a.name, b.name)
    else if (sortField === 'size') cmp = a.sizeKb - b.sizeKb
    else if (sortField === 'type') cmp = a.kind.localeCompare(b.kind) || nameCollator.compare(a.name, b.name)

    if (cmp === 0) cmp = a.relativePath.localeCompare(b.relativePath)

    return sortDir === 'asc' ? cmp : -cmp
  })
}
