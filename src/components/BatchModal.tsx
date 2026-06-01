import { Loader2, X } from 'lucide-react'
import { useState } from 'react'

export type BatchOptions = {
  resizeMode: 'none' | 'maxEdge' | 'percent'
  maxEdge: number
  percent: number
  quality: number
}

type BatchModalProps = {
  selectedCount: number
  processableCount: number
  processing: boolean
  onClose: () => void
  onStart: (options: BatchOptions) => void
}

export function BatchModal({ selectedCount, processableCount, processing, onClose, onStart }: BatchModalProps) {
  const [resizeMode, setResizeMode] = useState<BatchOptions['resizeMode']>('none')
  const [maxEdge, setMaxEdge] = useState(1920)
  const [percent, setPercent] = useState(50)
  const [quality, setQuality] = useState(80)

  function start() {
    onStart({ resizeMode, maxEdge, percent, quality })
  }

  return (
    <div className="batch-overlay" role="dialog" aria-modal="true">
      <div className="batch-backdrop" onClick={processing ? undefined : onClose} />
      <div className="batch-panel">
        <div className="batch-head">
          <h2>批量调整与压缩</h2>
          <button className="batch-close" title="关闭" disabled={processing} onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="batch-summary">
          已选 {selectedCount} 张 · 可处理 <strong>{processableCount}</strong> 张（PNG / JPG / WebP）
        </div>

        <div className="batch-field">
          <span className="batch-label">调整分辨率</span>
          <div className="segmented batch-seg">
            {([
              ['none', '不调整'],
              ['maxEdge', '最长边'],
              ['percent', '百分比'],
            ] as [BatchOptions['resizeMode'], string][]).map(([mode, label]) => (
              <button
                key={mode}
                className={resizeMode === mode ? 'active' : ''}
                disabled={processing}
                onClick={() => setResizeMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {resizeMode === 'maxEdge' && (
          <label className="batch-row">
            <span>最长边不超过</span>
            <div className="batch-num">
              <input
                disabled={processing}
                max={8000}
                min={32}
                type="number"
                value={maxEdge}
                onChange={(event) => setMaxEdge(Number(event.target.value) || 0)}
              />
              <small>px</small>
            </div>
          </label>
        )}

        {resizeMode === 'percent' && (
          <label className="batch-row">
            <span>缩放到</span>
            <div className="batch-num">
              <input
                disabled={processing}
                max={99}
                min={5}
                type="number"
                value={percent}
                onChange={(event) => setPercent(Number(event.target.value) || 0)}
              />
              <small>%</small>
            </div>
          </label>
        )}

        <label className="batch-field">
          <span className="batch-label">压缩质量：{quality}</span>
          <input
            className="batch-quality"
            disabled={processing}
            max={100}
            min={30}
            step={1}
            type="range"
            value={quality}
            onChange={(event) => setQuality(Number(event.target.value))}
          />
          <small className="batch-hint">质量仅对 JPEG 有损压缩生效；PNG/WebP 为无损，主要靠缩放减小体积。</small>
        </label>

        <div className="batch-warn">⚠ 处理会覆盖原图且不可撤销；标签、备注与收藏会保留。</div>

        <div className="batch-foot">
          <button className="batch-btn" disabled={processing} onClick={onClose}>
            取消
          </button>
          <button className="batch-btn primary" disabled={processing || processableCount === 0} onClick={start}>
            {processing ? (
              <>
                <Loader2 className="batch-spin" size={14} /> 正在处理…
              </>
            ) : (
              `开始处理（${processableCount}）`
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
