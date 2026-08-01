import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../types/library'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { revealAssetFile, shareAssetFiles } from './nativeActions'

function asset(id: string, sourcePath?: string): Asset {
  return {
    dimensions: '100 x 80',
    favorite: false,
    folder: '/',
    id,
    kind: 'jpg',
    modifiedAt: '2026-07-28',
    name: `${id}.jpg`,
    note: '',
    relativePath: `${id}.jpg`,
    sizeKb: 10,
    sourcePath,
    swatch: 'blue',
    tags: [],
    thumbnailReady: false,
  }
}

describe('native asset actions', () => {
  beforeEach(() => invokeMock.mockReset().mockResolvedValue(undefined))

  it('passes every selected local file to the native macOS share picker', async () => {
    await shareAssetFiles([asset('a', '/tmp/a.jpg'), asset('b', '/tmp/b.jpg')])
    expect(invokeMock).toHaveBeenCalledWith('share_files', { paths: ['/tmp/a.jpg', '/tmp/b.jpg'] })
  })

  it('rejects a selection without local files and reveals a failed source file', async () => {
    await expect(shareAssetFiles([asset('remote')])).rejects.toThrow('没有可分享的本地文件')
    await revealAssetFile(asset('failed', '/tmp/failed.jpg'))
    expect(invokeMock).toHaveBeenCalledWith('reveal_in_finder', { path: '/tmp/failed.jpg' })
  })
})
