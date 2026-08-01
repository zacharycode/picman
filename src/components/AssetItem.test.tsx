import { Profiler } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Asset } from '../types/library'
import { AssetItem } from './AssetItem'

afterEach(cleanup)

const asset: Asset = {
  dimensions: '800 x 600',
  favorite: false,
  folder: '/',
  height: 600,
  id: 'asset-1',
  kind: 'jpg',
  modifiedAt: '2026-07-28',
  name: 'asset-1.jpg',
  note: '',
  relativePath: 'asset-1.jpg',
  sizeKb: 120,
  swatch: 'blue',
  tags: [],
  thumbnailQuality: 'standard',
  thumbnailReady: true,
  thumbnailUrl: 'https://example.test/asset-1.webp',
  thumbnailHeight: 180,
  thumbnailWidth: 240,
  width: 800,
}

const handlers = {
  onClick: vi.fn(),
  onContextMenu: vi.fn(),
  onDoubleClick: vi.fn(),
  onDragStart: vi.fn(),
}

function item(priority: 'high' | 'low') {
  return (
    <AssetItem
      {...handlers}
      asset={asset}
      layout={{ height: 120, left: 12, top: 34, width: 160 }}
      primary={false}
      selected={false}
      thumbnailPriority={priority}
      viewMode="adaptive"
    />
  )
}

describe('AssetItem thumbnail scheduling', () => {
  it('loads viewport images eagerly with high fetch priority', () => {
    const { container } = render(item('high'))
    const image = container.querySelector('img')

    expect(image).not.toBeNull()
    expect(image?.getAttribute('loading')).toBe('eager')
    expect(image?.getAttribute('fetchpriority')).toBe('high')
  })

  it('keeps a ready overscan thumbnail mounted while its priority changes', () => {
    const view = render(item('low'))
    const overscanImage = view.container.querySelector('img')
    expect(overscanImage).not.toBeNull()
    expect(overscanImage?.getAttribute('loading')).toBe('lazy')
    expect(overscanImage?.getAttribute('fetchpriority')).toBe('low')

    view.rerender(item('high'))
    const viewportImage = view.container.querySelector('img')
    expect(viewportImage).toBe(overscanImage)
    expect(viewportImage?.getAttribute('loading')).toBe('eager')
    expect(viewportImage?.getAttribute('fetchpriority')).toBe('high')
  })

  it('records a normal load without causing a redundant React commit', () => {
    const onRender = vi.fn()
    const { container } = render(
      <Profiler id="asset" onRender={onRender}>
        {item('high')}
      </Profiler>,
    )
    expect(onRender).toHaveBeenCalledOnce()

    const image = container.querySelector('img')
    expect(image).not.toBeNull()
    fireEvent.load(image as HTMLImageElement)

    expect(onRender).toHaveBeenCalledOnce()
  })

  it('uses a lightweight two-dimensional transform for virtual positioning', () => {
    const { container } = render(item('high'))
    const root = container.querySelector<HTMLElement>('[data-asset-id="asset-1"]')

    expect(root?.style.transform).toBe('translate(12px, 34px)')
  })
})
