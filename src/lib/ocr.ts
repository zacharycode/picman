const OCR_ENDPOINT = 'https://api.ocr.space/parse/image'

type OcrSpaceResponse = {
  IsErroredOnProcessing?: boolean
  ErrorMessage?: string | string[]
  ParsedResults?: { ParsedText?: string }[]
}

/** Collapse every run of whitespace (incl. line breaks and blank lines) into a
 * single space and trim, so the result is one continuous paragraph. */
export function collapseOcrText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export async function recognizeText(base64Image: string, apiKey: string, language: string): Promise<string> {
  const form = new FormData()
  form.append('base64Image', base64Image)
  form.append('language', language)
  form.append('isOverlayRequired', 'false')
  form.append('detectOrientation', 'true')
  form.append('scale', 'true')
  form.append('OCREngine', '1')

  const response = await fetch(OCR_ENDPOINT, {
    method: 'POST',
    headers: { apikey: apiKey },
    body: form,
  })

  if (!response.ok) {
    throw new Error(response.status === 403 ? 'API Key 无效或额度已用尽' : `OCR 服务返回 ${response.status}`)
  }

  const data = (await response.json()) as OcrSpaceResponse
  if (data.IsErroredOnProcessing) {
    const message = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join('；') : data.ErrorMessage
    throw new Error(message || 'OCR 识别失败')
  }

  const text = (data.ParsedResults ?? []).map((result) => result.ParsedText ?? '').join(' ')
  return collapseOcrText(text)
}

/** Browser/sample-mode fallback: rasterize a blob/preview URL to a bounded JPEG
 * data URI via canvas (native libraries use the Rust prepare command instead). */
export function imageUrlToJpegDataUri(url: string, maxEdge = 2048): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new window.Image()
    image.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight))
      const width = Math.max(1, Math.round(image.naturalWidth * scale))
      const height = Math.max(1, Math.round(image.naturalHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) {
        reject(new Error('无法处理图片'))
        return
      }
      context.drawImage(image, 0, 0, width, height)
      try {
        resolve(canvas.toDataURL('image/jpeg', 0.9))
      } catch {
        reject(new Error('无法读取图片像素'))
      }
    }
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = url
  })
}
