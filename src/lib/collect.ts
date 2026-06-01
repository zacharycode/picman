export type CollectPayload = {
  bytes: ArrayBuffer
  mimeType: string
  sourceUrl?: string
  title?: string
}

const IMAGE_URL_PATTERN = /^(https?:\/\/.+\.(png|jpe?g|webp|gif|avif|svg)(\?|#|$)|data:image\/)/i

function stripExtension(name: string) {
  return name.replace(/\.[^./\\]+$/, '')
}

function looksLikeImageUrl(value: string | null | undefined) {
  return Boolean(value && IMAGE_URL_PATTERN.test(value.trim()))
}

function firstRemoteImageUrl(uriList: string | null | undefined) {
  if (!uriList) return undefined

  for (const line of uriList.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (looksLikeImageUrl(trimmed) || /^https?:\/\//i.test(trimmed)) return trimmed
  }

  return undefined
}

function parseHtmlImage(html: string): { src?: string; alt?: string } | undefined {
  try {
    const img = new DOMParser().parseFromString(html, 'text/html').querySelector('img')
    if (!img) return undefined
    return { src: img.getAttribute('src') ?? undefined, alt: img.getAttribute('alt') ?? undefined }
  } catch {
    return undefined
  }
}

function urlBaseName(url: string) {
  try {
    const path = url.split(/[?#]/)[0]
    const base = path.split('/').filter(Boolean).at(-1)
    return base ? stripExtension(decodeURIComponent(base)) : undefined
  } catch {
    return undefined
  }
}

/**
 * Synchronous check used by the paste/drop handlers to decide whether to take
 * over the event. `allowRemote` is false when focus is in a text field so plain
 * text/URL pastes still behave normally.
 */
export function dataTransferHasImage(data: DataTransfer, allowRemote: boolean): boolean {
  if (data.files && Array.from(data.files).some((file) => file.type.startsWith('image/'))) return true
  if (
    data.items &&
    Array.from(data.items).some((item) => item.kind === 'file' && item.type.startsWith('image/'))
  ) {
    return true
  }

  if (allowRemote) {
    const html = data.getData('text/html')
    if (html && /<img\b/i.test(html)) return true
    if (firstRemoteImageUrl(data.getData('text/uri-list'))) return true
    if (looksLikeImageUrl(data.getData('text/plain'))) return true
  }

  return false
}

/**
 * Reads every `DataTransfer` field synchronously (it is only valid during the
 * event), then resolves the image bytes. Local images yield their bytes
 * directly; remote drags are best-effort fetched and may fail on CORS.
 */
export async function extractImagePayload(
  data: DataTransfer,
  allowRemote: boolean,
): Promise<CollectPayload | null> {
  let blob: Blob | null = null
  let title: string | undefined

  if (data.files) {
    for (const file of Array.from(data.files)) {
      if (file.type.startsWith('image/')) {
        blob = file
        title = stripExtension(file.name)
        break
      }
    }
  }

  if (!blob && data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          blob = file
          break
        }
      }
    }
  }

  let url: string | undefined
  if (!blob && allowRemote) {
    const htmlImage = parseHtmlImage(data.getData('text/html'))
    const plain = data.getData('text/plain')?.trim()
    url =
      htmlImage?.src ||
      firstRemoteImageUrl(data.getData('text/uri-list')) ||
      (looksLikeImageUrl(plain) ? plain : undefined)
    title = htmlImage?.alt || (url ? urlBaseName(url) : undefined)
  }

  if (blob) {
    return { bytes: await blob.arrayBuffer(), mimeType: blob.type || 'image/png', title }
  }

  if (url) {
    try {
      const response = await fetch(url)
      if (!response.ok) return null

      const fetched = await response.blob()
      if (!fetched.type.startsWith('image/') && !url.startsWith('data:image/')) return null

      return {
        bytes: await fetched.arrayBuffer(),
        mimeType: fetched.type || 'image/png',
        sourceUrl: url.startsWith('data:') ? undefined : url,
        title,
      }
    } catch {
      return null
    }
  }

  return null
}
