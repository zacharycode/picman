import { readFile, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const releaseRoot = path.join(projectRoot, 'release', 'github')
const tauriConfigPath = path.join(projectRoot, 'src-tauri', 'tauri.conf.json')

function runGh(args, options = {}) {
  const result = spawnSync('gh', args, {
    cwd: options.cwd || projectRoot,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
  })

  return result
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function repoFromUpdaterConfig(config) {
  const endpoints = config.plugins?.updater?.endpoints ?? []
  const githubEndpoint = endpoints.find((endpoint) => endpoint.includes('github.com/'))
  const match = githubEndpoint?.match(/github\.com\/([^/]+\/[^/]+)\/releases\//)
  return match?.[1]
}

async function main() {
  const config = await readJson(tauriConfigPath)
  const repo = process.env.PICMAN_GITHUB_REPO || repoFromUpdaterConfig(config) || 'zacharycode/picman'
  const tags = (await readdir(releaseRoot)).filter((name) => name.startsWith('v')).sort()
  const tag = tags.at(-1)

  if (!tag) {
    throw new Error('没有找到 release/github/v* 目录。请先运行 npm run release:github。')
  }

  const ghVersion = runGh(['--version'])
  if (ghVersion.status !== 0) {
    throw new Error('没有找到 GitHub CLI。请先安装并登录 gh，或手动上传 release/github 下的文件。')
  }

  const auth = runGh(['auth', 'status', '--hostname', 'github.com'])
  if (auth.status !== 0) {
    throw new Error('GitHub CLI 尚未登录。请先运行 gh auth login。')
  }

  const releaseDir = path.join(releaseRoot, tag)
  const files = (await readdir(releaseDir))
    .filter((file) => file !== 'README.md')
    .map((file) => path.join(releaseDir, file))

  const view = runGh(['release', 'view', tag, '--repo', repo])
  if (view.status === 0) {
    const upload = runGh(['release', 'upload', tag, ...files, '--repo', repo, '--clobber'], {
      stdio: 'inherit',
    })
    process.exit(upload.status ?? 1)
  }

  const title = `Picman ${tag.slice(1)}`
  const create = runGh(
    ['release', 'create', tag, ...files, '--repo', repo, '--title', title, '--notes', `${title} 测试版更新。`],
    { stdio: 'inherit' },
  )
  process.exit(create.status ?? 1)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
