import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { arch } from 'node:process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const tauriConfigPath = path.join(projectRoot, 'src-tauri', 'tauri.conf.json')
const bundleRoot = path.join(projectRoot, 'src-tauri', 'target', 'release', 'bundle')
const macosBundleDir = path.join(bundleRoot, 'macos')
const dmgBundleDir = path.join(bundleRoot, 'dmg')
const defaultRepo = 'zacharycode/picman'

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function listFiles(dirPath) {
  try {
    return await readdir(dirPath)
  } catch {
    return []
  }
}

function newest(files) {
  return files.sort((a, b) => a.localeCompare(b)).at(-1)
}

function tauriPlatformKey() {
  return `darwin-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`
}

function repoFromUpdaterConfig(config) {
  const endpoints = config.plugins?.updater?.endpoints ?? []
  const githubEndpoint = endpoints.find((endpoint) => endpoint.includes('github.com/'))
  const match = githubEndpoint?.match(/github\.com\/([^/]+\/[^/]+)\/releases\//)
  return match?.[1]
}

async function main() {
  const config = await readJson(tauriConfigPath)
  const repo = process.env.PICMAN_GITHUB_REPO || repoFromUpdaterConfig(config) || defaultRepo
  const version = config.version
  const productName = config.productName || 'Picman'
  const tag = `v${version}`
  const outputDir = path.join(projectRoot, 'release', 'github', tag)

  const macosFiles = await listFiles(macosBundleDir)
  const archiveName = newest(macosFiles.filter((file) => file.endsWith('.app.tar.gz')))
  const signatureName = archiveName ? `${archiveName}.sig` : undefined
  const dmgName = newest((await listFiles(dmgBundleDir)).filter((file) => file.endsWith('.dmg')))

  if (!archiveName || !macosFiles.includes(signatureName)) {
    throw new Error('没有找到 macOS 更新包或签名。请先运行 npm run desktop:build。')
  }

  const signature = (await readFile(path.join(macosBundleDir, signatureName), 'utf8')).trim()
  const platform = tauriPlatformKey()
  const archiveUrl = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(archiveName)}`
  const latestJson = {
    version,
    notes: `${productName} ${version} 测试版更新。`,
    pub_date: new Date().toISOString(),
    platforms: {
      [platform]: {
        signature,
        url: archiveUrl,
      },
    },
  }

  await rm(outputDir, { force: true, recursive: true })
  await mkdir(outputDir, { recursive: true })
  await copyFile(path.join(macosBundleDir, archiveName), path.join(outputDir, archiveName))
  await copyFile(path.join(macosBundleDir, signatureName), path.join(outputDir, signatureName))

  if (dmgName) {
    await copyFile(path.join(dmgBundleDir, dmgName), path.join(outputDir, dmgName))
  }

  await writeFile(path.join(outputDir, 'latest.json'), `${JSON.stringify(latestJson, null, 2)}\n`, 'utf8')
  await writeFile(
    path.join(outputDir, 'README.md'),
    [
      `# ${productName} ${tag} GitHub Release`,
      '',
      `默认仓库：${repo}`,
      '',
      '需要上传到同一个 GitHub Release 的文件：',
      '',
      `- \`${archiveName}\``,
      `- \`${signatureName}\``,
      dmgName ? `- \`${dmgName}\`` : undefined,
      '- `latest.json`',
      '',
      '手动上传示例：',
      '',
      '```sh',
      `gh release create ${tag} ${archiveName} ${signatureName} ${dmgName || ''} latest.json --repo ${repo} --title "${productName} ${version}" --notes "${productName} ${version} 测试版更新。"`,
      '```',
      '',
      '如果真实仓库不是默认值，请使用：',
      '',
      '```sh',
      'PICMAN_GITHUB_REPO=owner/repo npm run release:github',
      '```',
      '',
      '注意：客户端检查更新的地址来自 `src-tauri/tauri.conf.json`，更换仓库时也要同步修改 updater endpoint 后重新打包。',
      '',
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
    'utf8',
  )

  console.log(`GitHub Release 产物已准备：${outputDir}`)
  console.log(`更新清单平台：${platform}`)
  console.log(`更新清单地址：https://github.com/${repo}/releases/latest/download/latest.json`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
