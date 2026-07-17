import { Channel, invoke } from '@tauri-apps/api/core'

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** A small generic drag image (a card + count badge) drawn synchronously so the
 * native drag can start immediately from the dragstart gesture. */
function makeDragImage(count: number): string {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas.toDataURL('image/png')

  ctx.fillStyle = 'rgba(38,38,42,0.96)'
  roundRect(ctx, 10, 10, 44, 44, 9)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.strokeStyle = 'rgba(255,255,255,0.55)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(18, 40)
  ctx.lineTo(28, 30)
  ctx.lineTo(34, 36)
  ctx.lineTo(40, 28)
  ctx.lineTo(46, 40)
  ctx.stroke()

  if (count > 1) {
    ctx.fillStyle = '#2f80ff'
    ctx.beginPath()
    ctx.arc(50, 14, 12, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 13px -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(count > 99 ? '99+' : String(count), 50, 14)
  }

  return canvas.toDataURL('image/png')
}

/** Start a native file drag of the given absolute paths to other apps. */
export async function startAssetDrag(paths: string[]) {
  if (paths.length === 0) return
  const onEvent = new Channel()
  await invoke('plugin:drag|start_drag', {
    item: paths,
    image: makeDragImage(paths.length),
    options: { mode: 'copy' },
    onEvent,
  })
}
