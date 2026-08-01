import { invoke } from '@tauri-apps/api/core'
import type { Asset } from '../types/library'

export async function shareAssetFiles(assets: Asset[]) {
  const paths = assets.flatMap((asset) => (asset.sourcePath ? [asset.sourcePath] : []))
  if (paths.length === 0) throw new Error('所选素材没有可分享的本地文件')
  await invoke('share_files', { paths })
}

export async function revealAssetFile(asset?: Asset) {
  if (!asset?.sourcePath) throw new Error('无法定位该素材的源文件')
  await invoke('reveal_in_finder', { path: asset.sourcePath })
}
