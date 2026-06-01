import { Check, Copy, Loader2, X } from 'lucide-react'
import { useState } from 'react'

type OcrModalProps = {
  status: 'loading' | 'done' | 'error'
  text: string
  error?: string
  onClose: () => void
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    try {
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      document.body.removeChild(textarea)
    }
  }
}

function OcrResult({ text }: { text: string }) {
  const [draft, setDraft] = useState(text)
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await copyText(draft)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <textarea
        className="ocr-text"
        autoFocus
        placeholder="未识别到文字"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="ocr-foot">
        <span className="ocr-hint">{draft.length} 字 · 可编辑</span>
        <button className="ocr-copy" disabled={!draft} onClick={handleCopy}>
          {copied ? (
            <>
              <Check size={13} /> 已复制
            </>
          ) : (
            <>
              <Copy size={13} /> 复制
            </>
          )}
        </button>
      </div>
    </>
  )
}

export function OcrModal({ status, text, error, onClose }: OcrModalProps) {
  return (
    <div className="ocr-overlay" role="dialog" aria-modal="true">
      <div className="ocr-backdrop" onClick={onClose} />
      <div className="ocr-panel">
        <div className="ocr-head">
          <h2>文字识别</h2>
          <button className="ocr-close" title="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        {status === 'loading' ? (
          <div className="ocr-loading">
            <Loader2 className="ocr-spin" size={22} />
            <span>正在识别图片中的文字…</span>
          </div>
        ) : status === 'error' ? (
          <div className="ocr-error">{error}</div>
        ) : (
          <OcrResult text={text} />
        )}
      </div>
    </div>
  )
}
