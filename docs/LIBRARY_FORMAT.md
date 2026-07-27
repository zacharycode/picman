# Picman 资源库格式 v1

本文件定义 Mac、Web、iOS、Dropbox 和外部工具共同遵守的文件协议。资源库中的图片文件永远是第一数据源；所有客户端都必须能够在删除索引和缩略图后，仅依靠素材文件和开放元数据恢复。

## 同步内容

- 同步所有用户素材文件和普通子目录。
- 同步根目录 `.picman/settings.json`。
- 同步任意素材文件夹中的 `.picman.folder.json`。
- 不同步 `.picman/cache/**`；每台设备自行生成索引和缩略图。
- `.picman/trash/**` 是当前资源库级回收站。启用 Dropbox 时它会跟随资源库同步，客户端不得把其中内容当作可见素材扫描。

## 资源库设置

`.picman/settings.json`：

```json
{
  "version": 1,
  "folderOrder": ["/Icons", "/Inspiration"]
}
```

客户端必须忽略并保留不认识的字段。对应 Schema：`schemas/library-settings.v1.schema.json`。

## 文件夹元数据

每个文件夹最多一个 `.picman.folder.json`，以当前文件名为键：

```json
{
  "version": 1,
  "assets": {
    "home.png": {
      "favorite": true,
      "note": "主导航图标",
      "tags": ["图标", "界面"],
      "sourceUrl": "https://example.com/home.png",
      "capturedAt": "2026-07-26T10:30:00"
    }
  }
}
```

重命名或移动素材时，客户端必须同时迁移对应条目。未知字段必须原样保留。对应 Schema：`schemas/folder-metadata.v1.schema.json`。

v1 不为每张图片创建一个 JSON 碎文件。一个文件夹只维护一份元数据文件，图片仍然是目录中的普通文件；这样兼顾可读性、同步效率和大量素材下的文件系统负担。

## 写入规则

1. 读取现有 JSON 并保留未知字段。
2. 写入同目录临时文件。
3. 完整写入并关闭后，以原子重命名替换正式文件。
4. 解析失败时不得覆盖原文件，应向用户显示错误。
5. 同步冲突文件不得静默删除；未来客户端应提供冲突合并界面。

## 兼容规则

- `version` 缺失时按 v1 读取。
- 新客户端可以增加可选字段，不得改变已有字段含义。
- 需要破坏性变更时增加主版本，并保留旧版只读或迁移能力。
- 索引、缩略图、OCR、颜色分析和哈希都不是协议真相源。
