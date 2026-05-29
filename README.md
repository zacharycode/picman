# Picman

Picman is a file-first image asset manager. Source files stay as ordinary files
inside ordinary folders; Picman adds open JSON metadata, local indexes, and
local thumbnail caches around them.

## Current Stack

- Tauri 2 shell
- React 19
- TypeScript
- Vite
- lucide-react icons

## Commands

```bash
npm run dev
npm run build
npm run lint
```

Large local-library stress tests can be generated without extra dependencies:

```bash
npm run stress:create -- --count=25000 --folders=120 --output=/tmp/picman-stress-25000 --clean
npm run stress:audit -- --library=/tmp/picman-stress-25000 --min-count=25000
```

Desktop commands are available after Rust is installed:

```bash
npm run desktop:dev
npm run desktop:build
```

## Project Records

- `功能更新日志.md`：唯一的功能更新日志，使用中文书写，并按日期由近到远排列。
- `docs/ARCHITECTURE.md`：记录文件优先的存储模型。
- `docs/PERFORMANCE.md`：记录 25000 素材库性能策略与审计命令。

每一次功能更新都只记录在 `功能更新日志.md` 中。

## File-First Rule

Picman treats the source folder as the durable asset. Local indexes and
thumbnails are performance artifacts only. They must be visible, removable,
compressible, and rebuildable without changing source files.
