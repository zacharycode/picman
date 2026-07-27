# Picman

Picman 是一款文件优先的图片素材管理工具。图片始终以普通文件保存在用户选择的目录中；即使不安装 Picman，也可以直接查看、复制和移动这些文件。

## 核心原则

- 图片文件是真相源，不进入私有数据库，不被应用接管。
- 标签、收藏、备注和采集来源保存在每个素材文件夹的 `.picman.folder.json`。
- 资源库设置保存在根目录 `.picman/settings.json`。
- `.picman/cache/catalog.jsonl` 和缩略图都是可查看、可清理、可压缩、可重建的本地派生数据。
- 本机界面状态保存在 macOS Application Support 中的 JSON 文件，设置页可直接定位。

完整约定见 [架构说明](docs/ARCHITECTURE.md)、[资源库格式](docs/LIBRARY_FORMAT.md) 和 [性能契约](docs/PERFORMANCE.md)。

## 技术栈

- Tauri 2 / Rust
- React 19 / TypeScript / Vite
- `notify` 原生目录监听
- `image` 原生缩略图与批量图像处理
- Vitest / Testing Library / Rust tests / GitHub Actions

## 本地开发

```bash
npm install
npm run dev
npm run lint
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

构建 Apple Silicon 安装包：

```bash
npm run desktop:build
```

## 大资源库验证

```bash
npm run stress:create -- --count=25000 --folders=120 --output=/tmp/picman-stress-25000 --clean
npm run stress:audit -- --library=/tmp/picman-stress-25000 --min-count=25000
npm run stress:native
```

## 发布

`v*` 标签会触发 `.github/workflows/release.yml`，在 GitHub 的 Apple Silicon macOS runner 上构建 DMG、Tauri updater 包、签名和 `latest.json`。仓库需一次性配置：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，无密码时可留空

本地仍可执行 `npm run release:publish` 直接发布。

## 项目记录

所有功能更新只写入 [功能更新日志](功能更新日志.md)，使用中文并按日期由近到远排列。
