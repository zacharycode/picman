# Picman 架构

Picman 只有一个不可退让的原则：文件是真相源，软件只是文件的管理器。

图片、视频和未来支持的其它素材始终是普通文件。Picman 可以创建元数据、目录索引、缩略图和搜索缓存，但这些派生数据必须可查看、可清理、可压缩、可重建，删除它们不能损坏素材。

## 存储分层

1. 素材文件
   - 保留在用户选择的资源目录及其子目录中。
   - 不改名、不打包、不迁入私有数据库。
   - 不安装 Picman 也能直接复制、预览和使用。

2. 开放元数据
   - 资源库设置：根目录 `.picman/settings.json`。
   - 素材元数据：每个素材文件夹中的 `.picman.folder.json`。
   - JSON 使用版本号和稳定字段名；未知字段在 Picman 写回时会保留，便于 Web、iOS 和外部工具扩展。

3. 可重建本地索引
   - `.picman/cache/catalog.jsonl` 保存上次扫描快照。
   - 打开资源库时先恢复快照，再在后台遍历真实目录并校验。
   - 索引损坏、过期或被删除时自动回退到完整扫描。
   - 设置页显示索引记录数、真实体积和有效状态，并可独立清理或重建。

4. 可重建缩略图缓存
   - `.picman/cache/thumbnails/{compact,standard,high}`。
   - 由设置页管理生成数量、未生成数量、真实占用、品质、压缩、容量上限和清理。
   - 容量超限时按最早生成的缓存文件开始清理，素材原文件不受影响。

5. 本机应用设置
   - macOS 使用 `Application Support/app.picman.desktop/settings.json`。
   - 保存窗口布局、最近资源库、每个浏览上下文的位置、主题、快捷键、缓存策略等设备级偏好。
   - 设置页可以直接在 Finder 中定位该文件；WebView `localStorage` 只保留首屏主题镜像和浏览器预览回退，不是真相源。
   - 高频布局和滚动变化会合并写入，隐藏窗口前强制刷新最终状态。

## 当前资源库结构

```text
DesignAssets/
  .picman/
    settings.json
    cache/
      catalog.jsonl
      thumbnails/
        compact/
        standard/
        high/
    trash/
      trash.json
  Icons/
    home.png
    search.svg
    .picman.folder.json
  Inspiration/
    landing-page.png
    .picman.folder.json
```

## 同步边界

Dropbox、iOS 文件授权和外部客户端同步或访问以下内容：

```text
素材文件
.picman/settings.json
**/.picman.folder.json
```

以下内容是每台设备自己的派生数据，不应参与同步：

```text
.picman/cache/**
本机应用 settings.json
```

macOS 创建缓存时会为 `.picman/cache` 设置 Dropbox 忽略属性。其它平台应依据相同边界建立自己的缓存目录或忽略规则。正式格式约定见 `docs/LIBRARY_FORMAT.md` 和 `docs/schemas/`。

## 运行路径

- Tauri/Rust 负责文件授权、流式扫描、目录监听、元数据原子写入、缩略图生成、回收站和批量图像处理。
- React/TypeScript 负责虚拟化视图、筛选排序、选择模型、交互状态和进度展示。
- 打开已有资源库时先使用 JSONL 索引快速恢复，再后台校验真实文件；外部文件变化由原生监听器合并刷新。
- 外部端只修改 `.picman/settings.json` 时重读资源库设置；修改图片或 `.picman.folder.json` 时才触发素材刷新；本地缓存变化被忽略。
- 三种素材视图只挂载可视区附近的节点，缩略图任务使用有上限的原生 worker 池。

## 代码边界

- `src/lib/libraryModel.ts`：大资源库的纯数据合并、目录统计、选择集合和偏好校验。
- `src/components/LibraryView.tsx`：三种虚拟布局、滚动测量和键盘定位。
- `src-tauri/src/library_catalog.rs`：可重建 JSONL 索引。
- `src-tauri/src/library_watch.rs`：原生目录监听与事件合并。
- `src-tauri/src/thumbnail_cache.rs`：缓存统计和容量淘汰。
- `src-tauri/src/app_settings.rs`：本机 JSON 设置文件。
