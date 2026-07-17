import type { ReactNode } from 'react'

export type ContextMenuItem = {
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

type ContextMenuProps = {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

const MENU_WIDTH = 190
const ITEM_HEIGHT = 32

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8)
  const top = Math.min(y, window.innerHeight - items.length * ITEM_HEIGHT - 16)

  return (
    <>
      <div
        className="ctx-backdrop"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault()
          onClose()
        }}
      />
      <div className="ctx-menu" style={{ left, top, minWidth: MENU_WIDTH }}>
        {items.map((item, index) => (
          <button
            key={index}
            className={`ctx-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </>
  )
}
