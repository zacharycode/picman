import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { deflateSync } from 'node:zlib'

const DEFAULT_COUNT = 25000
const DEFAULT_FOLDERS = 120
const DEFAULT_OUTPUT = path.join(tmpdir(), 'picman-stress-library')
const WRITE_CONCURRENCY = 256

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_VARIANTS = [
  { width: 64, height: 64 },
  { width: 96, height: 72 },
  { width: 72, height: 112 },
  { width: 144, height: 96 },
  { width: 96, height: 144 },
  { width: 160, height: 90 },
  { width: 90, height: 160 },
  { width: 128, height: 128 },
]

function parseArgs() {
  const options = {
    clean: false,
    count: DEFAULT_COUNT,
    folders: DEFAULT_FOLDERS,
    output: DEFAULT_OUTPUT,
  }

  for (const arg of process.argv.slice(2)) {
    if (arg === '--clean') options.clean = true
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/create-stress-library.mjs [--count=25000] [--folders=120] [--output=/path] [--clean]`)
      process.exit(0)
    } else if (arg.startsWith('--count=')) {
      options.count = Number(arg.slice('--count='.length))
    } else if (arg.startsWith('--folders=')) {
      options.folders = Number(arg.slice('--folders='.length))
    } else if (arg.startsWith('--output=')) {
      options.output = path.resolve(arg.slice('--output='.length))
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }

  if (!Number.isInteger(options.count) || options.count < 1) throw new Error('--count 必须是正整数')
  if (!Number.isInteger(options.folders) || options.folders < 1) throw new Error('--folders 必须是正整数')

  return options
}

function makeCrcTable() {
  const table = new Uint32Array(256)

  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }

  return table
}

const CRC_TABLE = makeCrcTable()

function crc32(buffer) {
  let crc = 0xffffffff

  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.allocUnsafe(4)
  const crc = Buffer.allocUnsafe(4)

  length.writeUInt32BE(data.length, 0)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)

  return Buffer.concat([length, typeBuffer, data, crc])
}

function makePng(width, height, seed) {
  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const rowStride = 1 + width * 3
  const raw = Buffer.allocUnsafe(rowStride * height)

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * rowStride
    raw[rowOffset] = 0

    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + 1 + x * 3
      raw[offset] = (x * 3 + seed * 17) & 0xff
      raw[offset + 1] = (y * 5 + seed * 29) & 0xff
      raw[offset + 2] = ((x + y) * 2 + seed * 43) & 0xff
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function makeSvg(width, height, seed) {
  const hue = (seed * 37) % 360
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="hsl(${hue} 54% 38%)"/>
  <circle cx="${Math.round(width * 0.34)}" cy="${Math.round(height * 0.38)}" r="${Math.round(Math.min(width, height) * 0.18)}" fill="hsl(${(hue + 70) % 360} 62% 58%)"/>
  <path d="M ${Math.round(width * 0.12)} ${Math.round(height * 0.82)} L ${Math.round(width * 0.45)} ${Math.round(height * 0.52)} L ${Math.round(width * 0.72)} ${Math.round(height * 0.68)} L ${Math.round(width * 0.9)} ${Math.round(height * 0.28)}" fill="none" stroke="white" stroke-width="${Math.max(2, Math.round(Math.min(width, height) * 0.04))}" stroke-linecap="round"/>
</svg>
`
}

function folderPathForIndex(root, index, folderCount) {
  const folderIndex = index % folderCount
  const group = Math.floor(folderIndex / 20)
  const set = Math.floor((folderIndex % 20) / 5)
  const leaf = folderIndex % 5

  return path.join(
    root,
    `Collection-${String(group + 1).padStart(2, '0')}`,
    `Set-${String(set + 1).padStart(2, '0')}`,
    `Folder-${String(leaf + 1).padStart(2, '0')}`,
  )
}

async function writeInBatches(tasks, batchSize) {
  for (let index = 0; index < tasks.length; index += batchSize) {
    await Promise.all(tasks.slice(index, index + batchSize).map((task) => task()))
  }
}

async function main() {
  const options = parseArgs()
  const startedAt = performance.now()

  if (options.clean) {
    await rm(options.output, { force: true, recursive: true })
  }

  await mkdir(options.output, { recursive: true })

  const buffers = new Map()
  const folders = new Set()

  for (let index = 0; index < options.count; index += 1) {
    folders.add(folderPathForIndex(options.output, index, options.folders))
  }

  await Promise.all([...folders].map((folder) => mkdir(folder, { recursive: true })))

  const tasks = Array.from({ length: options.count }, (_, index) => async () => {
    const variant = PNG_VARIANTS[index % PNG_VARIANTS.length]
    const folder = folderPathForIndex(options.output, index, options.folders)
    const serial = String(index + 1).padStart(5, '0')

    if (index % 20 === 0) {
      const svg = makeSvg(variant.width * 2, variant.height * 2, index)
      await writeFile(path.join(folder, `vector-${serial}.svg`), svg, 'utf8')
    } else {
      const key = `${variant.width}x${variant.height}:${index % 64}`
      let buffer = buffers.get(key)
      if (!buffer) {
        buffer = makePng(variant.width, variant.height, index % 64)
        buffers.set(key, buffer)
      }
      await writeFile(path.join(folder, `asset-${serial}.png`), buffer)
    }

    if ((index + 1) % 1000 === 0) {
      console.log(`已生成 ${index + 1}/${options.count}`)
    }
  })

  await writeInBatches(tasks, WRITE_CONCURRENCY)

  const metadata = {
    app: 'Picman',
    count: options.count,
    createdAt: new Date().toISOString(),
    folders: folders.size,
    purpose: 'local 25000 asset stress test library',
  }
  await writeFile(path.join(options.output, '.picman-library.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')

  const elapsedMs = Math.round(performance.now() - startedAt)
  console.log(`完成：${options.output}`)
  console.log(`素材：${options.count}，文件夹：${folders.size}，耗时：${elapsedMs}ms`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
