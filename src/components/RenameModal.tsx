import { X } from 'lucide-react'
import { useState } from 'react'
import type { KeyboardEvent } from 'react'

type RenameModalProps = {
  name: string
  onConfirm: (newName: string) => void
  onCancel: () => void
}

export function RenameModal({ name, onConfirm, onCancel }: RenameModalProps) {
  const [value, setValue] = useState(name)

  function submit() {
    const trimmed = value.trim()
    if (trimmed && trimmed !== name) onConfirm(trimmed)
    else onCancel()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
  }

  function focusName(input: HTMLInputElement | null) {
    if (!input) return
    input.focus()
    const dot = value.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : value.length)
  }

  return (
    <div className="rename-overlay" role="dialog" aria-modal="true">
      <div className="rename-backdrop" onClick={onCancel} />
      <div className="rename-panel">
        <div className="rename-head">
          <h2>重命名</h2>
          <button className="rename-close" title="取消" onClick={onCancel}>
            <X size={15} />
          </button>
        </div>
        <input
          ref={focusName}
          className="rename-input"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="rename-foot">
          <button className="rename-btn" onClick={onCancel}>
            取消
          </button>
          <button className="rename-btn primary" onClick={submit}>
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
