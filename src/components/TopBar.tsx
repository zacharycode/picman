import { getCurrentWindow } from '@tauri-apps/api/window'
import { PanelRight, PanelRightClose, Settings2 } from 'lucide-react'
import type { MouseEvent } from 'react'

type TopBarProps = {
  inspectorVisible: boolean
  settingsOpen: boolean
  onToggleInspector: () => void
  onToggleSettings: () => void
}

function shouldStartWindowDrag(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    !target.closest('button, input, select, textarea, a, [role="button"]')
  )
}

export function TopBar({
  inspectorVisible,
  settingsOpen,
  onToggleInspector,
  onToggleSettings,
}: TopBarProps) {
  function handleToolbarMouseDown(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0 || event.detail > 1 || !shouldStartWindowDrag(event.target)) return

    void getCurrentWindow()
      .startDragging()
      .catch(() => undefined)
  }

  return (
    <header className="global-bar" data-tauri-drag-region onMouseDown={handleToolbarMouseDown}>
      <div className="gbar-spacer" data-tauri-drag-region />

      <div className="chrome-actions">
        <button
          aria-pressed={inspectorVisible}
          className={`gbar-btn ${inspectorVisible ? 'active' : ''}`}
          title={inspectorVisible ? '隐藏右侧信息栏' : '显示右侧信息栏'}
          onClick={onToggleInspector}
        >
          {inspectorVisible ? <PanelRightClose size={14} /> : <PanelRight size={14} />}
        </button>
        <button className={`gbar-btn ${settingsOpen ? 'active' : ''}`} title="Settings" onClick={onToggleSettings}>
          <Settings2 size={14} />
        </button>
      </div>
    </header>
  )
}
