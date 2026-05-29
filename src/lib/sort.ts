import type { Asset, SortDir, SortField } from '../types/library'

export const SORT_LABELS: Record<SortField, string> = {
  name: '名称',
  date: '修改时间',
  size: '文件大小',
  type: '文件类型',
}

export function sortAssets(assets: Asset[], sortField: SortField, sortDir: SortDir) {
  return [...assets].sort((a, b) => {
    let cmp = 0

    if (sortField === 'name') cmp = a.name.localeCompare(b.name)
    else if (sortField === 'date') cmp = a.modifiedAt.localeCompare(b.modifiedAt)
    else if (sortField === 'size') cmp = a.sizeKb - b.sizeKb
    else if (sortField === 'type') cmp = a.kind.localeCompare(b.kind)

    return sortDir === 'asc' ? cmp : -cmp
  })
}
