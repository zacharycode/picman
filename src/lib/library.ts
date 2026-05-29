import type { Asset, AssetKind, FolderNode } from '../types/library'

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif'])
const swatches = ['mint', 'steel', 'coral', 'amber', 'ink', 'blue']

type ImageDimensions = {
  label: string
  width?: number
  height?: number
}

export function normalizeFolder(path: string) {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 1 ? '/' : `/${parts.slice(0, -1).join('/')}`
}

export function folderName(path: string, fallback: string) {
  if (path === '/') return fallback
  return path.split('/').filter(Boolean).at(-1) ?? fallback
}

export function getKind(name: string): AssetKind {
  const ext = name.split('.').pop()?.toLowerCase()

  if (ext === 'jpeg') return 'jpg'
  if (
    ext === 'png' ||
    ext === 'jpg' ||
    ext === 'svg' ||
    ext === 'webp' ||
    ext === 'gif' ||
    ext === 'avif' ||
    ext === 'pdf'
  ) {
    return ext
  }

  return 'png'
}

function formatDimensions(width: number, height: number) {
  return `${Math.round(width)} x ${Math.round(height)}`
}

function readSvgAttribute(svgTag: string, name: string) {
  const match = svgTag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'))
  return match?.[1]
}

function parseSvgLength(value?: string) {
  if (!value || value.trim().endsWith('%')) return undefined

  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function parseSvgDimensions(svgText: string): ImageDimensions | undefined {
  const svgTag = svgText.match(/<svg\b[^>]*>/i)?.[0]
  if (!svgTag) return undefined

  const width = parseSvgLength(readSvgAttribute(svgTag, 'width'))
  const height = parseSvgLength(readSvgAttribute(svgTag, 'height'))

  if (width && height) {
    return { label: formatDimensions(width, height), width, height }
  }

  const viewBox = readSvgAttribute(svgTag, 'viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part))

  if (viewBox?.length === 4) {
    const [, , viewBoxWidth, viewBoxHeight] = viewBox
    if (viewBoxWidth > 0 && viewBoxHeight > 0) {
      return {
        label: formatDimensions(viewBoxWidth, viewBoxHeight),
        width: viewBoxWidth,
        height: viewBoxHeight,
      }
    }
  }

  return undefined
}

function loadImageDimensions(url: string) {
  return new Promise<ImageDimensions>((resolve) => {
    const img = new window.Image()
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        resolve({
          label: formatDimensions(img.naturalWidth, img.naturalHeight),
          width: img.naturalWidth,
          height: img.naturalHeight,
        })
      } else {
        resolve({ label: 'unknown' })
      }
    }
    img.onerror = () => resolve({ label: 'unknown' })
    img.src = url
  })
}

export async function getImageDimensions(url: string, kind: AssetKind, file?: File): Promise<ImageDimensions> {
  if (kind === 'svg' && file) {
    try {
      const parsed = parseSvgDimensions(await file.text())
      if (parsed) return parsed
    } catch {
      // Fall back to the browser image decoder below.
    }
  }

  return loadImageDimensions(url)
}

export async function scanFiles(files: FileList) {
  const picked = Array.from(files).filter((file) => {
    const ext = file.name.split('.').pop()?.toLowerCase()
    return ext ? imageExtensions.has(ext) : file.type.startsWith('image/')
  })

  return Promise.all(
    picked.map(async (file, index) => {
      const relativePath = file.webkitRelativePath || file.name
      const previewUrl = URL.createObjectURL(file)
      const kind = getKind(file.name)
      const dimensions = await getImageDimensions(previewUrl, kind, file)

      return {
        id: `local_${index}_${file.name}_${file.lastModified}`,
        name: file.name,
        folder: normalizeFolder(relativePath),
        relativePath,
        sourcePath: undefined,
        kind,
        sizeKb: Math.max(1, Math.round(file.size / 1024)),
        dimensions: dimensions.label,
        width: dimensions.width,
        height: dimensions.height,
        tags: [],
        favorite: false,
        note: 'Imported from local folder.',
        thumbnailReady: false,
        modifiedAt: new Date(file.lastModified).toISOString().slice(0, 10),
        swatch: swatches[index % swatches.length],
        previewUrl,
      } satisfies Asset
    }),
  )
}

export function buildFolders(libraryName: string, assets: Asset[]): FolderNode[] {
  const counts = new Map<string, number>()
  counts.set('/', assets.length)

  for (const asset of assets) counts.set(asset.folder, (counts.get(asset.folder) ?? 0) + 1)

  return Array.from(counts.entries())
    .sort(([a], [b]) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)))
    .map(([path, count]) => ({ path, name: folderName(path, libraryName), count }))
}

function revokeObjectUrl(url?: string) {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
}

export function revokeThumbnailUrls(assets: Asset[]) {
  for (const asset of assets) {
    revokeObjectUrl(asset.thumbnailUrl)
  }
}

export function revokePreviewUrls(assets: Asset[]) {
  for (const asset of assets) {
    revokeObjectUrl(asset.previewUrl)
    revokeObjectUrl(asset.thumbnailUrl)
  }
}
