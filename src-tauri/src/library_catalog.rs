use super::{normalize_path, ScannedAsset, CATALOG_SCHEMA_VERSION};
use crate::thumbnail_cache::thumbnail_cache_root;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Component, Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;

#[derive(Debug, Deserialize, Serialize)]
struct CatalogHeader {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    asset_count: Option<usize>,
    schema: String,
    version: u32,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryIndexStats {
    pub(crate) asset_count: usize,
    pub(crate) exists: bool,
    pub(crate) file_size_bytes: u64,
    pub(crate) schema_version: u32,
    pub(crate) valid: bool,
}

fn catalog_path(root: &Path) -> PathBuf {
    root.join(".picman").join("cache").join("catalog.jsonl")
}

fn valid_catalog_header(line: &str) -> bool {
    serde_json::from_str::<CatalogHeader>(line)
        .map(|header| header.schema == "picman.catalog" && header.version == CATALOG_SCHEMA_VERSION)
        .unwrap_or(false)
}

pub(crate) fn has_valid_catalog(root: &Path) -> bool {
    let Ok(file) = fs::File::open(catalog_path(root)) else {
        return false;
    };
    let mut lines = BufReader::new(file).lines();
    matches!(lines.next(), Some(Ok(line)) if valid_catalog_header(&line))
}

fn sanitize_catalog_asset(root: &Path, mut asset: ScannedAsset) -> Option<ScannedAsset> {
    let relative = PathBuf::from(&asset.relative_path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return None;
    }
    asset.source_path = normalize_path(&root.join(&relative));

    if let Some(thumbnail_path) = asset.thumbnail_path.as_deref() {
        let candidate = PathBuf::from(thumbnail_path);
        let cache_root = thumbnail_cache_root(root);
        let unsafe_path = candidate
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
            || !candidate.starts_with(cache_root);
        if unsafe_path || !candidate.is_file() {
            asset.thumbnail_format = None;
            asset.thumbnail_height = None;
            asset.thumbnail_path = None;
            asset.thumbnail_quality = None;
            asset.thumbnail_ready = false;
            asset.thumbnail_size_kb = None;
            asset.thumbnail_width = None;
        }
    }
    Some(asset)
}

pub(crate) fn read_catalog_assets(root: &Path) -> Vec<ScannedAsset> {
    let Ok(file) = fs::File::open(catalog_path(root)) else {
        return Vec::new();
    };
    let mut lines = BufReader::new(file).lines();
    let Some(Ok(header)) = lines.next() else {
        return Vec::new();
    };
    if !valid_catalog_header(&header) {
        return Vec::new();
    }

    lines
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<ScannedAsset>(&line).ok())
        .filter_map(|asset| sanitize_catalog_asset(root, asset))
        .collect()
}

fn mark_cache_local(cache_dir: &Path) {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("xattr")
            .arg("-w")
            .arg("com.dropbox.ignored")
            .arg("1")
            .arg(cache_dir)
            .status();
    }
}

pub(crate) fn write_catalog_assets(root: &Path, assets: &[ScannedAsset]) -> Result<(), String> {
    let path = catalog_path(root);
    let cache_dir = path
        .parent()
        .ok_or_else(|| "目录索引路径无效".to_string())?;
    fs::create_dir_all(cache_dir).map_err(|error| format!("无法创建目录索引目录：{error}"))?;
    mark_cache_local(cache_dir);

    let temp = cache_dir.join("catalog.jsonl.tmp");
    let file = fs::File::create(&temp).map_err(|error| format!("无法创建目录索引：{error}"))?;
    let mut writer = BufWriter::new(file);
    let header = CatalogHeader {
        asset_count: Some(assets.len()),
        schema: "picman.catalog".to_string(),
        version: CATALOG_SCHEMA_VERSION,
    };
    serde_json::to_writer(&mut writer, &header)
        .map_err(|error| format!("目录索引头写入失败：{error}"))?;
    writer
        .write_all(b"\n")
        .map_err(|error| format!("目录索引写入失败：{error}"))?;

    for asset in assets {
        serde_json::to_writer(&mut writer, asset)
            .map_err(|error| format!("目录索引素材写入失败：{error}"))?;
        writer
            .write_all(b"\n")
            .map_err(|error| format!("目录索引写入失败：{error}"))?;
    }
    writer
        .flush()
        .map_err(|error| format!("目录索引刷新失败：{error}"))?;
    fs::rename(&temp, &path).map_err(|error| format!("目录索引保存失败：{error}"))
}

#[tauri::command]
pub(crate) fn get_library_index_stats(library_root: String) -> Result<LibraryIndexStats, String> {
    let root = PathBuf::from(library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }
    let path = catalog_path(&root);
    let Ok(file) = fs::File::open(&path) else {
        return Ok(LibraryIndexStats {
            schema_version: CATALOG_SCHEMA_VERSION,
            ..LibraryIndexStats::default()
        });
    };
    let file_size_bytes = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let mut lines = BufReader::new(file).lines();
    let Some(Ok(header_line)) = lines.next() else {
        return Ok(LibraryIndexStats {
            exists: true,
            file_size_bytes,
            ..LibraryIndexStats::default()
        });
    };
    let Ok(header) = serde_json::from_str::<CatalogHeader>(&header_line) else {
        return Ok(LibraryIndexStats {
            exists: true,
            file_size_bytes,
            ..LibraryIndexStats::default()
        });
    };
    let valid = header.schema == "picman.catalog" && header.version == CATALOG_SCHEMA_VERSION;
    let asset_count = header
        .asset_count
        .unwrap_or_else(|| lines.map_while(Result::ok).count());

    Ok(LibraryIndexStats {
        asset_count,
        exists: true,
        file_size_bytes,
        schema_version: header.version,
        valid,
    })
}

#[tauri::command]
pub(crate) fn clear_library_index(library_root: String) -> Result<LibraryIndexStats, String> {
    let root = PathBuf::from(library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }
    for path in [
        catalog_path(&root),
        root.join(".picman/cache/catalog.jsonl.tmp"),
    ] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法清理目录索引：{error}")),
        }
    }
    Ok(LibraryIndexStats {
        schema_version: CATALOG_SCHEMA_VERSION,
        ..LibraryIndexStats::default()
    })
}

#[cfg(test)]
mod tests {
    use super::{get_library_index_stats, read_catalog_assets, write_catalog_assets};
    use crate::ScannedAsset;
    use std::fs;

    fn asset(relative_path: &str) -> ScannedAsset {
        ScannedAsset {
            dimensions: "10 x 10".to_string(),
            favorite: false,
            folder: "/".to_string(),
            height: Some(10),
            id: format!("asset-{relative_path}"),
            kind: "png".to_string(),
            modified_at: "2026-01-01".to_string(),
            name: relative_path.to_string(),
            note: String::new(),
            preview_url: None,
            relative_path: relative_path.to_string(),
            size_kb: 1,
            source_path: "/stale/source".to_string(),
            swatch: "steel".to_string(),
            tags: Vec::new(),
            thumbnail_format: Some("webp".to_string()),
            thumbnail_height: Some(10),
            thumbnail_path: Some("/unsafe/cache.webp".to_string()),
            thumbnail_quality: Some("standard".to_string()),
            thumbnail_ready: true,
            thumbnail_size_kb: Some(1),
            thumbnail_width: Some(10),
            width: Some(10),
        }
    }

    #[test]
    fn catalog_is_rebuildable_and_rejects_paths_outside_the_library() {
        let root = std::env::temp_dir().join(format!("picman-catalog-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        write_catalog_assets(&root, &[asset("valid.png"), asset("../outside.png")]).unwrap();
        let restored = read_catalog_assets(&root);

        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].relative_path, "valid.png");
        assert_eq!(
            restored[0].source_path,
            root.join("valid.png").to_string_lossy()
        );
        assert!(!restored[0].thumbnail_ready);
        assert!(restored[0].thumbnail_path.is_none());
        let stats = get_library_index_stats(root.to_string_lossy().to_string()).unwrap();
        assert!(stats.exists);
        assert!(stats.valid);
        assert_eq!(stats.asset_count, 2);

        let _ = fs::remove_dir_all(root);
    }
}
