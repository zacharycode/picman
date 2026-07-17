export type AssetKind = 'png' | 'jpg' | 'svg' | 'webp' | 'gif' | 'avif' | 'pdf'

export type Asset = {
  id: string
  name: string
  folder: string
  relativePath: string
  sourcePath?: string
  kind: AssetKind
  sizeKb: number
  dimensions: string
  width?: number
  height?: number
  tags: string[]
  favorite: boolean
  note: string
  searchText?: string
  thumbnailError?: string
  thumbnailFormat?: ThumbnailFormat
  thumbnailReady: boolean
  thumbnailHeight?: number
  thumbnailPath?: string
  thumbnailQuality?: ThumbnailQuality
  thumbnailSizeKb?: number
  thumbnailUrl?: string
  thumbnailVersion?: string
  thumbnailWidth?: number
  modifiedAt: string
  swatch: string
  previewUrl?: string
}

export type FolderNode = {
  path: string
  name: string
  count: number
}

export type TrashItem = {
  id: string
  name: string
  kind: AssetKind
  originalRelativePath: string
  trashFileName: string
  trashFilePath: string
  sizeKb: number
  deletedAt: string
  metadata: { favorite: boolean; note: string; tags: string[]; sourceUrl?: string; capturedAt?: string }
}

export type ThemePref = 'system' | 'light' | 'dark'
export type ThumbnailState = 'all' | 'generated' | 'pending'
export type SortField = 'name' | 'date' | 'size' | 'type'
export type SortDir = 'asc' | 'desc'
export type AssetViewMode = 'adaptive' | 'masonry' | 'list'
export type SelectionKeyAxis = 'horizontal' | 'vertical'
export type ScrollJumpCommand = { edge: 'bottom' | 'top'; id: number }
export type ThumbnailFormat = 'jpeg' | 'png' | 'svg' | 'webp'
export type ThumbnailQuality = 'compact' | 'standard' | 'high'
export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'restarting'
  | 'none'
  | 'error'

export type AppUpdateState = {
  message: string
  progress?: number
  status: AppUpdateStatus
  version?: string
}

export type ThumbnailGenerationState = {
  completed: number
  currentName?: string
  failed?: number
  quality: ThumbnailQuality
  scopeLabel: string
  status: 'idle' | 'running' | 'completed'
  total: number
}
