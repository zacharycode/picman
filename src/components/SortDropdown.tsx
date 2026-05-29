import { Check } from 'lucide-react'
import { SORT_LABELS } from '../lib/sort'
import type { SortDir, SortField } from '../types/library'

type SortDropdownProps = {
  sortField: SortField
  sortDir: SortDir
  onField: (field: SortField) => void
  onDir: (dir: SortDir) => void
}

export function SortDropdown({ sortField, sortDir, onField, onDir }: SortDropdownProps) {
  return (
    <div className="sort-dropdown" onClick={(event) => event.stopPropagation()}>
      <div className="sort-section-label">排序方式</div>
      {(['name', 'date', 'size', 'type'] as SortField[]).map((field) => (
        <button
          key={field}
          className={`sort-option ${sortField === field ? 'active' : ''}`}
          onClick={() => onField(field)}
        >
          {SORT_LABELS[field]}
          {sortField === field && <Check size={12} />}
        </button>
      ))}
      <hr className="sort-divider" />
      <div className="sort-section-label">排列顺序</div>
      <button className={`sort-option ${sortDir === 'asc' ? 'active' : ''}`} onClick={() => onDir('asc')}>
        升序 {sortDir === 'asc' && <Check size={12} />}
      </button>
      <button className={`sort-option ${sortDir === 'desc' ? 'active' : ''}`} onClick={() => onDir('desc')}>
        降序 {sortDir === 'desc' && <Check size={12} />}
      </button>
    </div>
  )
}
