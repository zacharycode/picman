mod app_settings;
mod library_catalog;
mod library_watch;
mod thumbnail_cache;

use chrono::{DateTime, Local};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
use image::imageops::FilterType;
use image::{ColorType, GenericImageView, ImageEncoder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{Cursor, ErrorKind};
use std::path::Component;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use walkdir::WalkDir;

use app_settings::{read_app_settings, reveal_app_settings_file, write_app_settings};
use library_catalog::{
    clear_library_index, get_library_index_stats, has_valid_catalog, read_catalog_assets,
    write_catalog_assets,
};
use library_watch::{stop_library_watch, watch_library, LibraryWatchState};
use thumbnail_cache::{
    prune_thumbnail_cache, thumbnail_cache_dir, thumbnail_cache_result, ThumbnailCacheResult,
};

const THUMBNAIL_ALGORITHM_VERSION: &str = "rust-image-lanczos-v2-alpha-aware";
const SCAN_BATCH_SIZE: usize = 500;
const SCAN_BATCH_EVENT: &str = "picman-library-scan-batch";
const SCAN_ERROR_EVENT: &str = "picman-library-scan-error";
const SCAN_FINISHED_EVENT: &str = "picman-library-scan-finished";
const THUMBNAIL_BATCH_SIZE: usize = 128;
const THUMBNAIL_MAX_WORKERS: usize = 3;
const THUMBNAIL_BATCH_EVENT: &str = "picman-thumbnail-batch";
const THUMBNAIL_FINISHED_EVENT: &str = "picman-thumbnail-finished";
const THUMBNAIL_QUALITY_RESTORE_ORDER: [&str; 3] = ["standard", "high", "compact"];
const FOLDER_METADATA_FILE_NAME: &str = ".picman.folder.json";
const CATALOG_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Default)]
struct ThumbnailJobState {
    active_job_id: Arc<Mutex<Option<String>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanLibraryResponse {
    assets: Vec<ScannedAsset>,
    library_name: String,
    root_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanLibraryStartResponse {
    library_name: String,
    root_path: String,
    used_catalog: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanLibraryBatchPayload {
    assets: Vec<ScannedAsset>,
    phase: String,
    scan_id: String,
    total: usize,
    used_catalog: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanLibraryFinishedPayload {
    library_name: String,
    root_path: String,
    scan_id: String,
    total: usize,
    used_catalog: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanLibraryErrorPayload {
    message: String,
    scan_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScannedAsset {
    dimensions: String,
    favorite: bool,
    folder: String,
    height: Option<u32>,
    id: String,
    kind: String,
    modified_at: String,
    name: String,
    note: String,
    preview_url: Option<String>,
    relative_path: String,
    size_kb: u64,
    source_path: String,
    swatch: String,
    tags: Vec<String>,
    thumbnail_format: Option<String>,
    thumbnail_height: Option<u32>,
    thumbnail_path: Option<String>,
    thumbnail_quality: Option<String>,
    thumbnail_ready: bool,
    thumbnail_size_kb: Option<u64>,
    thumbnail_width: Option<u32>,
    width: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailSource {
    id: String,
    kind: String,
    relative_path: String,
    source_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailResult {
    format: String,
    height: u32,
    path: String,
    size_kb: u64,
    width: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailJobStartResponse {
    job_id: String,
    total: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailUpdatePayload {
    asset_id: String,
    error: Option<String>,
    format: Option<String>,
    height: Option<u32>,
    path: Option<String>,
    size_kb: Option<u64>,
    width: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailBatchPayload {
    completed: usize,
    current_name: Option<String>,
    failed: usize,
    job_id: String,
    total: usize,
    updates: Vec<ThumbnailUpdatePayload>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailFinishedPayload {
    cache_file_count: usize,
    cache_size_bytes: u64,
    cancelled: bool,
    completed: usize,
    failed: usize,
    job_id: String,
    pruned_paths: Vec<String>,
    total: usize,
}

struct ThumbnailWorkerResult {
    current_name: Option<String>,
    is_failed: bool,
    update: ThumbnailUpdatePayload,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderAssetMetadata {
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    note: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    captured_at: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderMetadataFile {
    #[serde(default)]
    assets: BTreeMap<String, FolderAssetMetadata>,
    #[serde(default = "folder_metadata_version")]
    version: u32,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

fn folder_metadata_version() -> u32 {
    1
}

impl Default for FolderMetadataFile {
    fn default() -> Self {
        Self {
            assets: BTreeMap::new(),
            extra: BTreeMap::new(),
            version: 1,
        }
    }
}

#[derive(Default)]
struct FolderMetadataCache {
    folders: HashMap<PathBuf, FolderMetadataFile>,
}

struct ThumbnailCacheHit {
    quality: &'static str,
    result: ThumbnailResult,
}

/// Quality cache directories that actually exist for a library, probed once per
/// scan. On a fresh library no thumbnail cache exists, so scanning can skip the
/// per-file hash and stat work that would otherwise always miss.
struct ThumbnailCacheProbe {
    qualities: Vec<&'static str>,
}

impl ThumbnailCacheProbe {
    fn new(root: &Path) -> Self {
        let qualities = THUMBNAIL_QUALITY_RESTORE_ORDER
            .into_iter()
            .filter(|quality| thumbnail_cache_dir(root, quality).is_dir())
            .collect();
        Self { qualities }
    }
}

#[derive(Debug)]
struct ThumbnailPreset {
    jpeg_quality: u8,
    max_edge: u32,
    passthrough_limit_bytes: u64,
}

fn thumbnail_preset(quality: &str) -> ThumbnailPreset {
    match quality {
        "compact" => ThumbnailPreset {
            jpeg_quality: 58,
            max_edge: 160,
            passthrough_limit_bytes: 8 * 1024,
        },
        "high" => ThumbnailPreset {
            jpeg_quality: 82,
            max_edge: 360,
            passthrough_limit_bytes: 24 * 1024,
        },
        _ => ThumbnailPreset {
            jpeg_quality: 72,
            max_edge: 240,
            passthrough_limit_bytes: 12 * 1024,
        },
    }
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn normalize_relative_path(path: &Path) -> String {
    path.components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize_folder(relative_path: &str) -> String {
    let parts = relative_path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    if parts.len() <= 1 {
        "/".to_string()
    } else {
        format!("/{}", parts[..parts.len() - 1].join("/"))
    }
}

fn get_kind(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();

    match ext.as_str() {
        "png" => Some("png"),
        "jpg" | "jpeg" => Some("jpg"),
        "svg" => Some("svg"),
        "webp" => Some("webp"),
        "gif" => Some("gif"),
        "avif" => Some("avif"),
        "bmp" => Some("png"),
        "tif" | "tiff" => Some("png"),
        "ico" => Some("png"),
        _ => None,
    }
}

fn asset_id(relative_path: &str, size: u64, modified: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(relative_path.as_bytes());
    hasher.update(size.to_le_bytes());
    hasher.update(modified.to_le_bytes());
    let digest = hasher.finalize();
    format!("asset_{}", &format!("{digest:x}")[..16])
}

fn modified_seconds(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn modified_date(metadata: &fs::Metadata) -> String {
    let Some(time) = metadata.modified().ok() else {
        return "unknown".to_string();
    };

    let datetime: DateTime<Local> = time.into();
    datetime.format("%Y-%m-%d").to_string()
}

fn swatch_for(index: usize) -> &'static str {
    const SWATCHES: [&str; 6] = ["mint", "steel", "coral", "amber", "ink", "blue"];
    SWATCHES[index % SWATCHES.len()]
}

fn library_name_for(root: &Path) -> String {
    root.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Local Library".to_string())
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();

    for tag in tags {
        let tag = tag.split_whitespace().collect::<Vec<_>>().join(" ");
        if tag.is_empty() || normalized.contains(&tag) {
            continue;
        }
        normalized.push(tag);
    }

    normalized
}

fn normalize_folder_asset_metadata(mut metadata: FolderAssetMetadata) -> FolderAssetMetadata {
    metadata.tags = normalize_tags(metadata.tags);
    metadata.note = metadata.note.trim().to_string();
    metadata
}

fn read_folder_metadata(path: &Path) -> Result<FolderMetadataFile, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<FolderMetadataFile>(&text)
            .map_err(|error| format!("文件夹元数据解析失败：{}：{error}", normalize_path(path))),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(FolderMetadataFile::default()),
        Err(error) => Err(format!(
            "无法读取文件夹元数据：{}：{error}",
            normalize_path(path)
        )),
    }
}

fn write_folder_metadata(path: &Path, metadata: &FolderMetadataFile) -> Result<(), String> {
    let text = serde_json::to_string_pretty(metadata)
        .map_err(|error| format!("文件夹元数据序列化失败：{error}"))?;
    let temp_path = path.with_file_name(format!("{FOLDER_METADATA_FILE_NAME}.tmp"));

    fs::write(&temp_path, format!("{text}\n"))
        .map_err(|error| format!("无法写入文件夹元数据临时文件：{error}"))?;
    fs::rename(&temp_path, path).map_err(|error| format!("无法保存文件夹元数据：{error}"))
}

impl FolderMetadataCache {
    fn metadata_for_asset(
        &mut self,
        folder_path: &Path,
        file_name: &str,
    ) -> Option<FolderAssetMetadata> {
        let metadata = self
            .folders
            .entry(folder_path.to_path_buf())
            .or_insert_with(|| {
                read_folder_metadata(&folder_path.join(FOLDER_METADATA_FILE_NAME))
                    .unwrap_or_default()
            });

        metadata
            .assets
            .get(file_name)
            .cloned()
            .map(normalize_folder_asset_metadata)
    }
}

fn image_dimensions(path: &Path) -> (String, Option<u32>, Option<u32>) {
    if path
        .extension()
        .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("svg"))
        .unwrap_or(false)
    {
        return svg_dimensions(path).unwrap_or_else(|| ("vector".to_string(), None, None));
    }

    match image::image_dimensions(path) {
        Ok((width, height)) => (format!("{width} x {height}"), Some(width), Some(height)),
        Err(_) => ("unknown".to_string(), None, None),
    }
}

fn read_svg_attribute(svg_tag: &str, name: &str) -> Option<String> {
    let pattern = format!("{name}=");
    let start = svg_tag.find(&pattern)? + pattern.len();
    let quote = svg_tag[start..].chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = &svg_tag[start + quote.len_utf8()..];
    let end = rest.find(quote)?;
    Some(rest[..end].to_string())
}

fn parse_svg_length(value: &str) -> Option<u32> {
    if value.trim().ends_with('%') {
        return None;
    }

    let number = value
        .trim()
        .chars()
        .take_while(|ch| ch.is_ascii_digit() || *ch == '.')
        .collect::<String>()
        .parse::<f32>()
        .ok()?;

    if number > 0.0 {
        Some(number.round() as u32)
    } else {
        None
    }
}

fn svg_dimensions(path: &Path) -> Option<(String, Option<u32>, Option<u32>)> {
    let text = fs::read_to_string(path).ok()?;
    let start = text.find("<svg")?;
    let end = text[start..].find('>')? + start;
    let svg_tag = &text[start..=end];

    let width = read_svg_attribute(svg_tag, "width").and_then(|value| parse_svg_length(&value));
    let height = read_svg_attribute(svg_tag, "height").and_then(|value| parse_svg_length(&value));

    if let (Some(width), Some(height)) = (width, height) {
        return Some((format!("{width} x {height}"), Some(width), Some(height)));
    }

    let view_box = read_svg_attribute(svg_tag, "viewBox")?
        .split(|ch: char| ch.is_ascii_whitespace() || ch == ',')
        .filter_map(|part| part.parse::<f32>().ok())
        .collect::<Vec<_>>();

    if view_box.len() == 4 && view_box[2] > 0.0 && view_box[3] > 0.0 {
        let width = view_box[2].round() as u32;
        let height = view_box[3].round() as u32;
        return Some((format!("{width} x {height}"), Some(width), Some(height)));
    }

    Some(("vector".to_string(), None, None))
}

fn cache_hash(
    root: &Path,
    source: &ThumbnailSource,
    quality: &str,
    metadata: &fs::Metadata,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(THUMBNAIL_ALGORITHM_VERSION.as_bytes());
    hasher.update(quality.as_bytes());
    hasher.update(normalize_path(root).as_bytes());
    hasher.update(source.id.as_bytes());
    hasher.update(source.kind.as_bytes());
    hasher.update(source.relative_path.as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified_seconds(metadata).to_le_bytes());
    let digest = hasher.finalize();
    format!("{digest:x}")
}

fn cached_thumbnail_candidates(
    source: &ThumbnailSource,
) -> &'static [(&'static str, &'static str)] {
    if source.kind == "svg"
        || source
            .source_path
            .rsplit_once('.')
            .map(|(_, ext)| ext.eq_ignore_ascii_case("svg"))
            .unwrap_or(false)
    {
        &[("svg", "svg")]
    } else {
        &[
            ("jpg", "jpeg"),
            ("png", "png"),
            ("webp", "webp"),
            ("jpeg", "jpeg"),
        ]
    }
}

fn cached_thumbnail_dimensions(
    source_path: &Path,
    cached_path: &Path,
    format: &str,
    preset: &ThumbnailPreset,
) -> (u32, u32) {
    if format == "svg" {
        let (_, width, height) = image_dimensions(source_path);
        return (
            width.unwrap_or(preset.max_edge),
            height.unwrap_or(preset.max_edge),
        );
    }

    image::image_dimensions(cached_path).unwrap_or((preset.max_edge, preset.max_edge))
}

fn existing_thumbnail_for_quality(
    root: &Path,
    source: &ThumbnailSource,
    quality: &str,
    metadata: &fs::Metadata,
) -> Option<ThumbnailResult> {
    let hash = cache_hash(root, source, quality, metadata);
    let cache_dir = thumbnail_cache_dir(root, quality);
    let source_path = Path::new(&source.source_path);
    let preset = thumbnail_preset(quality);

    for (extension, format) in cached_thumbnail_candidates(source) {
        let output_path = cache_dir.join(format!("{hash}.{extension}"));
        if !output_path.is_file() {
            continue;
        }

        let output_metadata = fs::metadata(&output_path).ok()?;
        let (width, height) =
            cached_thumbnail_dimensions(source_path, &output_path, format, &preset);

        return Some(ThumbnailResult {
            format: (*format).to_string(),
            height,
            path: normalize_path(&output_path),
            size_kb: std::cmp::max(1, output_metadata.len().div_ceil(1024)),
            width,
        });
    }

    None
}

fn existing_thumbnail_cache_hit(
    root: &Path,
    source: &ThumbnailSource,
    metadata: &fs::Metadata,
    probe: &ThumbnailCacheProbe,
) -> Option<ThumbnailCacheHit> {
    for &quality in &probe.qualities {
        if let Some(result) = existing_thumbnail_for_quality(root, source, quality, metadata) {
            return Some(ThumbnailCacheHit { quality, result });
        }
    }

    None
}

fn has_alpha(color: ColorType) -> bool {
    matches!(
        color,
        ColorType::La8
            | ColorType::La16
            | ColorType::Rgba8
            | ColorType::Rgba16
            | ColorType::Rgba32F
    )
}

fn has_visible_alpha(image: &image::DynamicImage) -> bool {
    if !has_alpha(image.color()) {
        return false;
    }

    image.to_rgba8().pixels().any(|pixel| pixel[3] < 250)
}

fn write_jpeg(path: &Path, image: &image::DynamicImage, quality: u8) -> Result<(), String> {
    let file = fs::File::create(path).map_err(|error| format!("无法创建缩略图文件：{error}"))?;
    let mut encoder = JpegEncoder::new_with_quality(file, quality);
    encoder
        .encode_image(&image.to_rgb8())
        .map_err(|error| format!("JPEG 编码失败：{error}"))
}

fn write_png(path: &Path, image: &image::DynamicImage) -> Result<(), String> {
    let rgba = image.to_rgba8();
    let file = fs::File::create(path).map_err(|error| format!("无法创建缩略图文件：{error}"))?;
    let encoder =
        PngEncoder::new_with_quality(file, CompressionType::Best, PngFilterType::Adaptive);
    encoder
        .write_image(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            ColorType::Rgba8.into(),
        )
        .map_err(|error| format!("PNG 编码失败：{error}"))
}

fn source_passthrough_format(path: &Path) -> Option<(&'static str, &'static str)> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();

    match ext.as_str() {
        "png" => Some(("png", "png")),
        "jpg" | "jpeg" => Some(("jpg", "jpeg")),
        "webp" => Some(("webp", "webp")),
        _ => None,
    }
}

fn ensure_inside(root: &Path, path: &Path) -> Result<(), String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("资源目录无效：{error}"))?;
    let path = path
        .canonicalize()
        .map_err(|error| format!("文件路径无效：{error}"))?;

    if path.starts_with(root) {
        Ok(())
    } else {
        Err("文件不在当前资源目录内".to_string())
    }
}

fn safe_relative_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = PathBuf::from(relative_path);

    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err("文件路径无效".to_string());
    }

    let path = root.join(relative);
    ensure_inside(root, &path)?;
    Ok(path)
}

fn allow_library_asset_scope(app: &AppHandle, root: &Path) -> Result<(), String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("资源目录无效：{error}"))?;
    let picman_dir = root.join(".picman");
    let asset_scope = app.asset_protocol_scope();

    asset_scope
        .allow_directory(root, true)
        .map_err(|error| format!("资源目录授权失败：{error}"))?;
    asset_scope
        .allow_directory(picman_dir, true)
        .map_err(|error| format!("缓存目录授权失败：{error}"))
}

fn scanned_asset_from_path(
    root: &Path,
    path: &Path,
    index: usize,
    folder_metadata: &mut FolderMetadataCache,
    cache_probe: &ThumbnailCacheProbe,
) -> Option<ScannedAsset> {
    let kind = get_kind(path)?;
    let relative_path = path.strip_prefix(root).ok()?;
    let metadata = fs::metadata(path).ok()?;
    let normalized_relative_path = normalize_relative_path(relative_path);
    let (dimensions, width, height) = if kind == "svg" {
        ("vector".to_string(), None, None)
    } else {
        ("unknown".to_string(), None, None)
    };
    let modified = modified_seconds(&metadata);
    let id = asset_id(&normalized_relative_path, metadata.len(), modified);
    let source_path = normalize_path(path);
    let thumbnail_source = ThumbnailSource {
        id: id.clone(),
        kind: kind.to_string(),
        relative_path: normalized_relative_path.clone(),
        source_path: source_path.clone(),
    };
    let cached_thumbnail =
        existing_thumbnail_cache_hit(root, &thumbnail_source, &metadata, cache_probe);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| normalized_relative_path.clone());
    let folder_asset_metadata = path
        .parent()
        .and_then(|folder| folder_metadata.metadata_for_asset(folder, &file_name))
        .unwrap_or_default();

    Some(ScannedAsset {
        dimensions,
        favorite: folder_asset_metadata.favorite,
        folder: normalize_folder(&normalized_relative_path),
        height,
        id,
        kind: kind.to_string(),
        modified_at: modified_date(&metadata),
        name: file_name,
        note: folder_asset_metadata.note,
        preview_url: None,
        relative_path: normalized_relative_path,
        size_kb: std::cmp::max(1, metadata.len().div_ceil(1024)),
        source_path,
        swatch: swatch_for(index).to_string(),
        tags: folder_asset_metadata.tags,
        thumbnail_format: cached_thumbnail
            .as_ref()
            .map(|thumbnail| thumbnail.result.format.clone()),
        thumbnail_height: cached_thumbnail
            .as_ref()
            .map(|thumbnail| thumbnail.result.height),
        thumbnail_path: cached_thumbnail
            .as_ref()
            .map(|thumbnail| thumbnail.result.path.clone()),
        thumbnail_quality: cached_thumbnail
            .as_ref()
            .map(|thumbnail| thumbnail.quality.to_string()),
        thumbnail_ready: cached_thumbnail.is_some(),
        thumbnail_size_kb: cached_thumbnail
            .as_ref()
            .map(|thumbnail| thumbnail.result.size_kb),
        thumbnail_width: cached_thumbnail
            .as_ref()
            .map(|thumbnail| thumbnail.result.width),
        width,
    })
}

#[tauri::command]
fn scan_library_folder(root_path: String) -> Result<ScanLibraryResponse, String> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err("请选择有效的资源目录".to_string());
    }

    let library_name = library_name_for(&root);
    let mut assets = Vec::new();
    let mut folder_metadata = FolderMetadataCache::default();
    let cache_probe = ThumbnailCacheProbe::new(&root);

    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_entry(|entry| entry.file_name() != ".picman")
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }

        if let Some(asset) = scanned_asset_from_path(
            &root,
            entry.path(),
            assets.len(),
            &mut folder_metadata,
            &cache_probe,
        ) {
            assets.push(asset);
        }
    }

    assets.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    let _ = write_catalog_assets(&root, &assets);

    Ok(ScanLibraryResponse {
        assets,
        library_name,
        root_path: normalize_path(&root),
    })
}

#[tauri::command]
fn scan_library_folder_stream(
    app: AppHandle,
    root_path: String,
    scan_id: String,
    use_catalog_snapshot: bool,
) -> Result<ScanLibraryStartResponse, String> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err("请选择有效的资源目录".to_string());
    }
    allow_library_asset_scope(&app, &root)?;

    let library_name = library_name_for(&root);
    let normalized_root = normalize_path(&root);
    let used_catalog = use_catalog_snapshot && has_valid_catalog(&root);
    let thread_root = root.clone();
    let thread_library_name = library_name.clone();
    let thread_root_path = normalized_root.clone();

    thread::spawn(move || {
        if used_catalog {
            let cached_assets = read_catalog_assets(&thread_root);
            let cached_total = cached_assets.len();
            for chunk in cached_assets.chunks(SCAN_BATCH_SIZE) {
                let _ = app.emit(
                    SCAN_BATCH_EVENT,
                    ScanLibraryBatchPayload {
                        assets: chunk.to_vec(),
                        phase: "catalog".to_string(),
                        scan_id: scan_id.clone(),
                        total: cached_total,
                        used_catalog: true,
                    },
                );
            }
        }

        let mut assets = Vec::with_capacity(SCAN_BATCH_SIZE);
        let mut catalog_assets = Vec::new();
        let mut folder_metadata = FolderMetadataCache::default();
        let cache_probe = ThumbnailCacheProbe::new(&thread_root);
        let mut total = 0usize;

        for entry_result in WalkDir::new(&thread_root)
            .into_iter()
            .filter_entry(|entry| entry.file_name() != ".picman")
        {
            let entry = match entry_result {
                Ok(entry) => entry,
                Err(error) => {
                    let _ = app.emit(
                        SCAN_ERROR_EVENT,
                        ScanLibraryErrorPayload {
                            message: format!("部分文件扫描失败：{error}"),
                            scan_id: scan_id.clone(),
                        },
                    );
                    continue;
                }
            };

            if !entry.file_type().is_file() {
                continue;
            }

            if let Some(asset) = scanned_asset_from_path(
                &thread_root,
                entry.path(),
                total,
                &mut folder_metadata,
                &cache_probe,
            ) {
                total += 1;
                catalog_assets.push(asset.clone());
                assets.push(asset);
            }

            if assets.len() >= SCAN_BATCH_SIZE {
                assets.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
                let _ = app.emit(
                    SCAN_BATCH_EVENT,
                    ScanLibraryBatchPayload {
                        assets: std::mem::take(&mut assets),
                        phase: "scan".to_string(),
                        scan_id: scan_id.clone(),
                        total,
                        used_catalog,
                    },
                );
            }
        }

        if !assets.is_empty() {
            assets.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
            let _ = app.emit(
                SCAN_BATCH_EVENT,
                ScanLibraryBatchPayload {
                    assets,
                    phase: "scan".to_string(),
                    scan_id: scan_id.clone(),
                    total,
                    used_catalog,
                },
            );
        }

        catalog_assets.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        if let Err(error) = write_catalog_assets(&thread_root, &catalog_assets) {
            let _ = app.emit(
                SCAN_ERROR_EVENT,
                ScanLibraryErrorPayload {
                    message: format!("目录索引保存失败：{error}"),
                    scan_id: scan_id.clone(),
                },
            );
        }

        let _ = app.emit(
            SCAN_FINISHED_EVENT,
            ScanLibraryFinishedPayload {
                library_name: thread_library_name,
                root_path: thread_root_path,
                scan_id,
                total,
                used_catalog,
            },
        );
    });

    Ok(ScanLibraryStartResponse {
        library_name,
        root_path: normalized_root,
        used_catalog,
    })
}

#[tauri::command]
fn generate_thumbnail(
    app: AppHandle,
    library_root: String,
    source: ThumbnailSource,
    quality: String,
) -> Result<ThumbnailResult, String> {
    let root = PathBuf::from(&library_root);
    allow_library_asset_scope(&app, &root)?;
    generate_thumbnail_result(&root, &source, &quality)
}

#[tauri::command]
fn write_folder_asset_metadata(
    library_root: String,
    relative_path: String,
    metadata: FolderAssetMetadata,
) -> Result<(), String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }

    let source_path = safe_relative_path(&root, &relative_path)?;
    if !source_path.is_file() {
        return Err("素材文件不存在".to_string());
    }

    let folder_path = source_path
        .parent()
        .ok_or_else(|| "素材文件夹无效".to_string())?;
    let file_name = source_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| "素材文件名无效".to_string())?;
    let metadata_path = folder_path.join(FOLDER_METADATA_FILE_NAME);
    let mut folder_metadata = read_folder_metadata(&metadata_path)?;

    // Frontend metadata writes only carry favorite/note/tags. Preserve the
    // file-first provenance (source URL, capture time) recorded at collect time
    // so editing a tag never drops it.
    let mut next = normalize_folder_asset_metadata(metadata);
    if let Some(previous) = folder_metadata.assets.get(&file_name) {
        if next.source_url.is_none() {
            next.source_url = previous.source_url.clone();
        }
        if next.captured_at.is_none() {
            next.captured_at = previous.captured_at.clone();
        }
        for (key, value) in &previous.extra {
            next.extra
                .entry(key.clone())
                .or_insert_with(|| value.clone());
        }
    }

    folder_metadata.version = 1;
    folder_metadata.assets.insert(file_name, next);
    write_folder_metadata(&metadata_path, &folder_metadata)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectProvenance {
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Keep collected bytes verbatim for already-supported, browser-displayable
/// formats; transcode anything else (bmp/tiff/ico/...) to PNG so every
/// collected file stays a viewable, scannable asset.
fn prepare_collected_bytes(bytes: Vec<u8>) -> Result<(Vec<u8>, &'static str), String> {
    match image::guess_format(&bytes).ok() {
        Some(image::ImageFormat::Png) => Ok((bytes, "png")),
        Some(image::ImageFormat::Jpeg) => Ok((bytes, "jpg")),
        Some(image::ImageFormat::WebP) => Ok((bytes, "webp")),
        Some(image::ImageFormat::Gif) => Ok((bytes, "gif")),
        Some(image::ImageFormat::Avif) => Ok((bytes, "avif")),
        _ => {
            let image =
                image::load_from_memory(&bytes).map_err(|_| "无法识别图片格式".to_string())?;
            let mut out = Vec::new();
            image
                .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
                .map_err(|error| format!("图片转码失败：{error}"))?;
            Ok((out, "png"))
        }
    }
}

fn resolve_collect_folder(root: &Path, target_folder: &str) -> Result<PathBuf, String> {
    let trimmed = target_folder.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(root.to_path_buf());
    }

    let relative = PathBuf::from(trimmed);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            ) || component.as_os_str() == ".picman"
        })
    {
        return Err("目标文件夹无效".to_string());
    }

    let folder_dir = root.join(relative);
    fs::create_dir_all(&folder_dir).map_err(|error| format!("无法创建目标文件夹：{error}"))?;
    ensure_inside(root, &folder_dir)?;
    Ok(folder_dir)
}

fn slugify_collect_name(raw: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;

    for ch in raw.chars() {
        if ch.is_alphanumeric() {
            slug.push(ch);
            prev_dash = false;
        } else if !slug.is_empty() && !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }

    slug.trim_matches('-').chars().take(60).collect()
}

fn collect_base_name(provenance: &CollectProvenance) -> String {
    if let Some(title) = provenance.title.as_deref() {
        let slug = slugify_collect_name(title);
        if !slug.is_empty() {
            return slug;
        }
    }

    if let Some(url) = provenance.source_url.as_deref() {
        let path = url.split(['?', '#']).next().unwrap_or(url);
        let base = path.rsplit('/').next().unwrap_or("");
        let stem = base.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(base);
        let slug = slugify_collect_name(stem);
        if !slug.is_empty() {
            return slug;
        }
    }

    format!("capture-{}", Local::now().format("%Y%m%d-%H%M%S"))
}

fn unique_collect_path(folder_dir: &Path, base: &str, ext: &str) -> PathBuf {
    let first = folder_dir.join(format!("{base}.{ext}"));
    if !first.exists() {
        return first;
    }

    for suffix in 2..10000 {
        let candidate = folder_dir.join(format!("{base}-{suffix}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    folder_dir.join(format!("{base}-{}.{ext}", Local::now().format("%H%M%S%3f")))
}

fn find_collected_duplicate(folder_dir: &Path, len: u64, hash: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(folder_dir).ok()?.flatten() {
        let path = entry.path();
        if !path.is_file() || get_kind(&path).is_none() {
            continue;
        }

        match fs::metadata(&path) {
            Ok(metadata) if metadata.len() == len => {}
            _ => continue,
        }

        if fs::read(&path)
            .map(|existing| sha256_hex(&existing) == hash)
            .unwrap_or(false)
        {
            return Some(path);
        }
    }

    None
}

fn build_collected_asset(root: &Path, path: &Path) -> Result<ScannedAsset, String> {
    let mut folder_metadata = FolderMetadataCache::default();
    let cache_probe = ThumbnailCacheProbe::new(root);
    scanned_asset_from_path(root, path, 0, &mut folder_metadata, &cache_probe)
        .ok_or_else(|| "无法读取采集到的素材".to_string())
}

fn collect_image_into(
    root: &Path,
    target_folder: &str,
    bytes: Vec<u8>,
    provenance: &CollectProvenance,
) -> Result<ScannedAsset, String> {
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }

    let (data, ext) = prepare_collected_bytes(bytes)?;
    let folder_dir = resolve_collect_folder(root, target_folder)?;
    let hash = sha256_hex(&data);

    if let Some(existing) = find_collected_duplicate(&folder_dir, data.len() as u64, &hash) {
        return build_collected_asset(root, &existing);
    }

    let base = collect_base_name(provenance);
    let output_path = unique_collect_path(&folder_dir, &base, ext);
    let mut temp_os = output_path.clone().into_os_string();
    temp_os.push(".collecting");
    let temp_path = PathBuf::from(temp_os);

    fs::write(&temp_path, &data).map_err(|error| format!("无法写入采集图片：{error}"))?;
    fs::rename(&temp_path, &output_path).map_err(|error| format!("无法保存采集图片：{error}"))?;

    let file_name = output_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| "采集文件名无效".to_string())?;
    let metadata_path = folder_dir.join(FOLDER_METADATA_FILE_NAME);
    let mut folder_metadata = read_folder_metadata(&metadata_path)?;

    folder_metadata.version = 1;
    folder_metadata.assets.insert(
        file_name,
        FolderAssetMetadata {
            captured_at: Some(Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()),
            source_url: provenance.source_url.clone(),
            ..FolderAssetMetadata::default()
        },
    );
    write_folder_metadata(&metadata_path, &folder_metadata)?;

    build_collected_asset(root, &output_path)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibrarySettings {
    #[serde(default = "library_settings_version")]
    version: u32,
    #[serde(default)]
    folder_order: Vec<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

fn library_settings_version() -> u32 {
    1
}

impl Default for LibrarySettings {
    fn default() -> Self {
        Self {
            extra: BTreeMap::new(),
            version: library_settings_version(),
            folder_order: Vec::new(),
        }
    }
}

fn library_settings_path(root: &Path) -> PathBuf {
    root.join(".picman").join("settings.json")
}

#[tauri::command]
fn read_library_settings(library_root: String) -> Result<LibrarySettings, String> {
    let path = library_settings_path(&PathBuf::from(&library_root));
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<LibrarySettings>(&text)
            .map_err(|error| format!("库设置解析失败：{error}")),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(LibrarySettings::default()),
        Err(error) => Err(format!("无法读取库设置：{error}")),
    }
}

#[tauri::command]
fn write_library_settings(library_root: String, settings: LibrarySettings) -> Result<(), String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }

    let dir = root.join(".picman");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建配置目录：{error}"))?;

    let path = dir.join("settings.json");
    let temp = dir.join("settings.json.tmp");
    let mut settings = settings;
    settings.version = library_settings_version();
    let text = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("库设置序列化失败：{error}"))?;

    fs::write(&temp, format!("{text}\n"))
        .map_err(|error| format!("无法写入库设置临时文件：{error}"))?;
    fs::rename(&temp, &path).map_err(|error| format!("无法保存库设置：{error}"))
}

fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);

    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;

        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }

    out
}

/// Decode the source image, bound its size, and return a JPEG data URI. This
/// keeps the payload within OCR.space limits and produces a format the API
/// accepts, reusing the existing image pipeline (no new dependency).
#[tauri::command]
fn prepare_image_for_ocr(source_path: String) -> Result<String, String> {
    let path = PathBuf::from(&source_path);
    if !path.is_file() {
        return Err("图片文件不存在".to_string());
    }

    let decoded = image::open(&path).map_err(|error| format!("图片解码失败：{error}"))?;
    let (width, height) = decoded.dimensions();
    const MAX_EDGE: u32 = 2048;
    let prepared = if width.max(height) > MAX_EDGE {
        decoded.resize(MAX_EDGE, MAX_EDGE, FilterType::Lanczos3)
    } else {
        decoded
    };

    let mut buffer = Vec::new();
    JpegEncoder::new_with_quality(&mut buffer, 85)
        .encode_image(&prepared.to_rgb8())
        .map_err(|error| format!("图片编码失败：{error}"))?;

    Ok(format!("data:image/jpeg;base64,{}", base64_encode(&buffer)))
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("路径不存在".to_string());
    }

    let status = Command::new("open")
        .arg(&target)
        .status()
        .map_err(|error| format!("无法在 Finder 中打开：{error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err("Finder 打开失败".to_string())
    }
}

#[tauri::command]
fn collect_image(
    app: AppHandle,
    library_root: String,
    target_folder: String,
    bytes: Vec<u8>,
    provenance: CollectProvenance,
) -> Result<ScannedAsset, String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }
    allow_library_asset_scope(&app, &root)?;
    collect_image_into(&root, &target_folder, bytes, &provenance)
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashItem {
    id: String,
    name: String,
    kind: String,
    original_relative_path: String,
    trash_file_name: String,
    trash_file_path: String,
    size_kb: u64,
    deleted_at: String,
    #[serde(default)]
    metadata: FolderAssetMetadata,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashManifest {
    #[serde(default)]
    items: Vec<TrashItem>,
}

fn trash_dir(root: &Path) -> PathBuf {
    root.join(".picman").join("trash")
}

fn read_trash_manifest(root: &Path) -> Result<TrashManifest, String> {
    let path = trash_dir(root).join("trash.json");
    let mut manifest = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<TrashManifest>(&text)
            .map_err(|error| format!("回收站清单解析失败：{error}"))?,
        Err(error) if error.kind() == ErrorKind::NotFound => TrashManifest::default(),
        Err(error) => return Err(format!("无法读取回收站清单：{error}")),
    };

    // Recompute the absolute path so a moved library still resolves correctly.
    let dir = trash_dir(root);
    for item in &mut manifest.items {
        item.trash_file_path = normalize_path(&dir.join(&item.trash_file_name));
    }
    manifest
        .items
        .sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(manifest)
}

fn write_trash_manifest(root: &Path, manifest: &TrashManifest) -> Result<(), String> {
    let dir = trash_dir(root);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建回收站目录：{error}"))?;
    let path = dir.join("trash.json");
    let temp = dir.join("trash.json.tmp");
    let text = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("回收站清单序列化失败：{error}"))?;

    fs::write(&temp, format!("{text}\n"))
        .map_err(|error| format!("无法写入回收站清单临时文件：{error}"))?;
    fs::rename(&temp, &path).map_err(|error| format!("无法保存回收站清单：{error}"))
}

/// A library-relative path that does not need to exist yet (restore targets),
/// rejecting traversal and the reserved `.picman` directory.
fn safe_library_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = PathBuf::from(relative_path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            ) || component.as_os_str() == ".picman"
        })
    {
        return Err("文件路径无效".to_string());
    }
    Ok(root.join(relative))
}

fn restore_destination(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let base = safe_library_path(root, relative_path)?;
    if !base.exists() {
        return Ok(base);
    }

    let parent = base.parent().ok_or_else(|| "恢复目录无效".to_string())?;
    let stem = base
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = base
        .extension()
        .map(|value| value.to_string_lossy().to_string());

    for suffix in 1..10000 {
        let name = match &ext {
            Some(ext) => format!("{stem} (恢复{suffix}).{ext}"),
            None => format!("{stem} (恢复{suffix})"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("无法确定恢复位置".to_string())
}

#[tauri::command]
fn move_to_trash(
    library_root: String,
    relative_paths: Vec<String>,
) -> Result<Vec<TrashItem>, String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }

    let dir = trash_dir(&root);
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建回收站目录：{error}"))?;
    let mut manifest = read_trash_manifest(&root)?;
    let mut created = Vec::new();

    for relative_path in &relative_paths {
        let source = safe_relative_path(&root, relative_path)?;
        if !source.is_file() {
            continue;
        }

        let metadata = fs::metadata(&source).map_err(|error| format!("无法读取文件：{error}"))?;
        let file_name = source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .ok_or_else(|| "文件名无效".to_string())?;
        let kind = get_kind(&source).unwrap_or("png").to_string();

        // Snapshot the folder metadata into the trash entry, then drop it from
        // the source folder so the live library no longer references the file.
        let folder = source.parent().ok_or_else(|| "文件夹无效".to_string())?;
        let metadata_path = folder.join(FOLDER_METADATA_FILE_NAME);
        let mut folder_metadata = read_folder_metadata(&metadata_path)?;
        let asset_metadata = folder_metadata
            .assets
            .remove(&file_name)
            .unwrap_or_default();
        if metadata_path.exists() {
            write_folder_metadata(&metadata_path, &folder_metadata)?;
        }

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let id = format!(
            "trash_{}",
            &sha256_hex(format!("{relative_path}-{nanos}").as_bytes())[..16]
        );
        let extension = source
            .extension()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "bin".to_string());
        let trash_file_name = format!("{id}.{extension}");
        let destination = dir.join(&trash_file_name);
        fs::rename(&source, &destination).map_err(|error| format!("无法移动到回收站：{error}"))?;

        let item = TrashItem {
            id,
            name: file_name,
            kind,
            original_relative_path: relative_path.clone(),
            trash_file_name,
            trash_file_path: normalize_path(&destination),
            size_kb: std::cmp::max(1, metadata.len().div_ceil(1024)),
            deleted_at: Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
            metadata: normalize_folder_asset_metadata(asset_metadata),
        };
        created.push(item.clone());
        manifest.items.push(item);
    }

    write_trash_manifest(&root, &manifest)?;
    Ok(created)
}

#[tauri::command]
fn list_trash(library_root: String) -> Result<Vec<TrashItem>, String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }
    Ok(read_trash_manifest(&root)?.items)
}

#[tauri::command]
fn restore_from_trash(library_root: String, ids: Vec<String>) -> Result<Vec<ScannedAsset>, String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }

    let mut manifest = read_trash_manifest(&root)?;
    let wanted: HashSet<&String> = ids.iter().collect();
    let dir = trash_dir(&root);
    let mut restored = Vec::new();
    let mut remaining = Vec::new();

    for item in std::mem::take(&mut manifest.items) {
        if !wanted.contains(&item.id) {
            remaining.push(item);
            continue;
        }

        let trash_path = dir.join(&item.trash_file_name);
        if !trash_path.is_file() {
            continue;
        }

        let destination = restore_destination(&root, &item.original_relative_path)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建恢复目录：{error}"))?;
        }
        fs::rename(&trash_path, &destination).map_err(|error| format!("无法恢复文件：{error}"))?;

        if let Some(file_name) = destination
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
        {
            if let Some(folder) = destination.parent() {
                let metadata_path = folder.join(FOLDER_METADATA_FILE_NAME);
                let mut folder_metadata = read_folder_metadata(&metadata_path)?;
                folder_metadata.version = 1;
                folder_metadata
                    .assets
                    .insert(file_name, item.metadata.clone());
                write_folder_metadata(&metadata_path, &folder_metadata)?;
            }
        }

        restored.push(build_collected_asset(&root, &destination)?);
    }

    manifest.items = remaining;
    write_trash_manifest(&root, &manifest)?;
    Ok(restored)
}

#[tauri::command]
fn empty_trash(library_root: String) -> Result<(), String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }

    let dir = trash_dir(&root);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|error| format!("无法清空回收站：{error}"))?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchProcessOptions {
    #[serde(default)]
    max_edge: Option<u32>,
    #[serde(default)]
    scale_percent: Option<u32>,
    quality: u8,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessedAsset {
    previous_relative_path: String,
    previous_size_kb: u64,
    asset: ScannedAsset,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchProcessResult {
    processed: Vec<ProcessedAsset>,
    failed: usize,
}

fn batch_target_dims(width: u32, height: u32, options: &BatchProcessOptions) -> Option<(u32, u32)> {
    if let Some(edge) = options.max_edge.filter(|value| *value > 0) {
        let longest = width.max(height);
        if longest <= edge {
            return None;
        }
        let scale = edge as f64 / longest as f64;
        return Some((
            ((width as f64 * scale).round() as u32).max(1),
            ((height as f64 * scale).round() as u32).max(1),
        ));
    }

    if let Some(percent) = options
        .scale_percent
        .filter(|value| *value > 0 && *value < 100)
    {
        return Some((
            (width * percent / 100).max(1),
            (height * percent / 100).max(1),
        ));
    }

    None
}

fn encode_processed_image(
    path: &Path,
    image: &image::DynamicImage,
    ext: &str,
    quality: u8,
) -> Result<(), String> {
    match ext {
        "jpg" | "jpeg" => write_jpeg(path, image, quality),
        "png" => write_png(path, image),
        "webp" => image
            .save_with_format(path, image::ImageFormat::WebP)
            .map_err(|error| format!("WebP 编码失败：{error}")),
        other => Err(format!("不支持处理 {other} 格式")),
    }
}

fn process_single_image(
    root: &Path,
    relative_path: &str,
    options: &BatchProcessOptions,
) -> Result<ProcessedAsset, String> {
    let source = safe_relative_path(root, relative_path)?;
    let ext = source
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp") {
        return Err("不支持的格式".to_string());
    }

    let previous_size_kb = std::cmp::max(
        1,
        fs::metadata(&source)
            .map_err(|error| format!("无法读取文件：{error}"))?
            .len()
            .div_ceil(1024),
    );
    let decoded = image::open(&source).map_err(|error| format!("图片解码失败：{error}"))?;
    let (width, height) = decoded.dimensions();
    let resized = match batch_target_dims(width, height, options) {
        Some((target_width, target_height)) => {
            decoded.resize(target_width, target_height, FilterType::Lanczos3)
        }
        None => decoded,
    };

    let quality = options.quality.clamp(10, 100);
    let mut temp_os = source.clone().into_os_string();
    temp_os.push(".processing");
    let temp_path = PathBuf::from(temp_os);
    encode_processed_image(&temp_path, &resized, &ext, quality)?;
    fs::rename(&temp_path, &source).map_err(|error| format!("无法写回图片：{error}"))?;

    let asset = build_collected_asset(root, &source)?;
    Ok(ProcessedAsset {
        previous_relative_path: relative_path.to_string(),
        previous_size_kb,
        asset,
    })
}

#[tauri::command]
fn batch_process_images(
    library_root: String,
    relative_paths: Vec<String>,
    options: BatchProcessOptions,
) -> Result<BatchProcessResult, String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }

    let mut processed = Vec::new();
    let mut failed = 0;
    for relative_path in &relative_paths {
        match process_single_image(&root, relative_path, &options) {
            Ok(result) => processed.push(result),
            Err(_) => failed += 1,
        }
    }

    Ok(BatchProcessResult { processed, failed })
}

#[tauri::command]
fn copy_image_to_clipboard(app: AppHandle, source_path: String) -> Result<(), String> {
    let path = PathBuf::from(&source_path);
    if !path.is_file() {
        return Err("图片文件不存在".to_string());
    }

    let rgba = image::open(&path)
        .map_err(|error| format!("图片解码失败：{error}"))?
        .to_rgba8();
    let (width, height) = rgba.dimensions();
    let image = tauri::image::Image::new_owned(rgba.into_raw(), width, height);

    app.clipboard()
        .write_image(&image)
        .map_err(|error| format!("复制到剪贴板失败：{error}"))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MovedAsset {
    previous_relative_path: String,
    asset: ScannedAsset,
}

fn unique_dest_path(folder_dir: &Path, file_name: &str) -> PathBuf {
    let base = folder_dir.join(file_name);
    if !base.exists() {
        return base;
    }

    let name = Path::new(file_name);
    let stem = name
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = name
        .extension()
        .map(|value| value.to_string_lossy().to_string());

    for suffix in 1..10000 {
        let candidate_name = match &ext {
            Some(ext) => format!("{stem} ({suffix}).{ext}"),
            None => format!("{stem} ({suffix})"),
        };
        let candidate = folder_dir.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    base
}

#[tauri::command]
fn move_assets(
    library_root: String,
    relative_paths: Vec<String>,
    target_folder: String,
) -> Result<Vec<MovedAsset>, String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }

    let folder_dir = resolve_collect_folder(&root, &target_folder)?;
    let canonical_target = fs::canonicalize(&folder_dir).unwrap_or_else(|_| folder_dir.clone());
    let mut moved = Vec::new();

    for relative_path in &relative_paths {
        let source = safe_relative_path(&root, relative_path)?;
        if !source.is_file() {
            continue;
        }

        let source_parent = source.parent().ok_or_else(|| "文件夹无效".to_string())?;
        let canonical_source_parent =
            fs::canonicalize(source_parent).unwrap_or_else(|_| source_parent.to_path_buf());
        if canonical_source_parent == canonical_target {
            continue;
        }

        let file_name = source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .ok_or_else(|| "文件名无效".to_string())?;

        let source_meta_path = source_parent.join(FOLDER_METADATA_FILE_NAME);
        let mut source_metadata = read_folder_metadata(&source_meta_path)?;
        let asset_metadata = source_metadata.assets.remove(&file_name);
        if source_meta_path.exists() {
            write_folder_metadata(&source_meta_path, &source_metadata)?;
        }

        let destination = unique_dest_path(&folder_dir, &file_name);
        fs::rename(&source, &destination).map_err(|error| format!("无法移动文件：{error}"))?;

        if let Some(metadata) = asset_metadata {
            if let Some(dest_name) = destination
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
            {
                let dest_meta_path = folder_dir.join(FOLDER_METADATA_FILE_NAME);
                let mut dest_metadata = read_folder_metadata(&dest_meta_path)?;
                dest_metadata.version = 1;
                dest_metadata.assets.insert(dest_name, metadata);
                write_folder_metadata(&dest_meta_path, &dest_metadata)?;
            }
        }

        moved.push(MovedAsset {
            previous_relative_path: relative_path.clone(),
            asset: build_collected_asset(&root, &destination)?,
        });
    }

    Ok(moved)
}

#[tauri::command]
fn rename_asset(
    library_root: String,
    relative_path: String,
    new_name: String,
) -> Result<ScannedAsset, String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }

    let source = safe_relative_path(&root, &relative_path)?;
    if !source.is_file() {
        return Err("文件不存在".to_string());
    }

    let folder = source.parent().ok_or_else(|| "文件夹无效".to_string())?;
    let old_name = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| "文件名无效".to_string())?;
    let original_ext = source
        .extension()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();

    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("文件名不能为空".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("文件名不能包含路径分隔符".to_string());
    }

    let new_file_name = if Path::new(trimmed).extension().is_some() || original_ext.is_empty() {
        trimmed.to_string()
    } else {
        format!("{trimmed}.{original_ext}")
    };

    let destination = folder.join(&new_file_name);
    if destination == source {
        return build_collected_asset(&root, &source);
    }
    if destination.exists() {
        return Err("已存在同名文件".to_string());
    }

    fs::rename(&source, &destination).map_err(|error| format!("无法重命名文件：{error}"))?;

    let metadata_path = folder.join(FOLDER_METADATA_FILE_NAME);
    let mut folder_metadata = read_folder_metadata(&metadata_path)?;
    if let Some(asset_metadata) = folder_metadata.assets.remove(&old_name) {
        folder_metadata.version = 1;
        folder_metadata.assets.insert(new_file_name, asset_metadata);
        write_folder_metadata(&metadata_path, &folder_metadata)?;
    }

    build_collected_asset(&root, &destination)
}

#[tauri::command]
fn rename_folder(
    library_root: String,
    folder_relative_path: String,
    new_name: String,
) -> Result<Vec<MovedAsset>, String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }

    let trimmed = folder_relative_path.trim_matches('/');
    if trimmed.is_empty() {
        return Err("无法重命名库根目录".to_string());
    }

    let source = safe_library_path(&root, trimmed)?;
    if !source.is_dir() {
        return Err("文件夹不存在".to_string());
    }

    let name = new_name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == ".picman" {
        return Err("文件夹名无效".to_string());
    }

    let parent = source.parent().ok_or_else(|| "文件夹无效".to_string())?;
    let destination = parent.join(name);
    if destination == source {
        return Ok(Vec::new());
    }
    if destination.exists() {
        return Err("已存在同名文件夹".to_string());
    }

    fs::rename(&source, &destination).map_err(|error| format!("无法重命名文件夹：{error}"))?;

    // The whole directory (assets + nested .picman.folder.json) moved together;
    // re-scan it so the frontend can remap every affected asset's id/path.
    let mut folder_metadata = FolderMetadataCache::default();
    let cache_probe = ThumbnailCacheProbe::new(&root);
    let mut remaps = Vec::new();
    let mut index = 0usize;

    for entry in WalkDir::new(&destination)
        .into_iter()
        .filter_entry(|entry| entry.file_name() != ".picman")
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if get_kind(path).is_none() {
            continue;
        }

        if let Some(asset) =
            scanned_asset_from_path(&root, path, index, &mut folder_metadata, &cache_probe)
        {
            index += 1;
            let relative_to_dest = path
                .strip_prefix(&destination)
                .map(normalize_relative_path)
                .unwrap_or_default();
            remaps.push(MovedAsset {
                previous_relative_path: format!("{trimmed}/{relative_to_dest}"),
                asset,
            });
        }
    }

    Ok(remaps)
}

fn rotate_single_image(
    root: &Path,
    relative_path: &str,
    quarter_turns: u32,
) -> Result<MovedAsset, String> {
    let source = safe_relative_path(root, relative_path)?;
    let ext = source
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp") {
        return Err("不支持的格式".to_string());
    }

    let decoded = image::open(&source).map_err(|error| format!("图片解码失败：{error}"))?;
    let rotated = match quarter_turns % 4 {
        1 => decoded.rotate90(),
        2 => decoded.rotate180(),
        3 => decoded.rotate270(),
        _ => decoded,
    };

    // Re-encode at high quality to limit loss on JPEG; PNG/WebP stay lossless.
    let mut temp_os = source.clone().into_os_string();
    temp_os.push(".rotating");
    let temp_path = PathBuf::from(temp_os);
    encode_processed_image(&temp_path, &rotated, &ext, 95)?;
    fs::rename(&temp_path, &source).map_err(|error| format!("无法写回图片：{error}"))?;

    Ok(MovedAsset {
        previous_relative_path: relative_path.to_string(),
        asset: build_collected_asset(root, &source)?,
    })
}

#[tauri::command]
fn rotate_images(
    library_root: String,
    relative_paths: Vec<String>,
    quarter_turns: u32,
) -> Result<Vec<MovedAsset>, String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }
    if quarter_turns % 4 == 0 {
        return Ok(Vec::new());
    }

    let mut rotated = Vec::new();
    for relative_path in &relative_paths {
        if let Ok(item) = rotate_single_image(&root, relative_path, quarter_turns) {
            rotated.push(item);
        }
    }
    Ok(rotated)
}

fn generate_thumbnail_file(
    root: &Path,
    source: &ThumbnailSource,
    quality: &str,
    force: bool,
) -> Result<ThumbnailResult, String> {
    let source_path = PathBuf::from(&source.source_path);
    ensure_inside(root, &source_path)?;

    let metadata =
        fs::metadata(&source_path).map_err(|error| format!("无法读取源文件：{error}"))?;
    let preset = thumbnail_preset(quality);
    let hash = cache_hash(root, source, quality, &metadata);
    let cache_dir = thumbnail_cache_dir(root, quality);
    fs::create_dir_all(&cache_dir).map_err(|error| format!("无法创建缩略图缓存目录：{error}"))?;

    if !force {
        if let Some(existing) = existing_thumbnail_for_quality(root, source, quality, &metadata) {
            return Ok(existing);
        }
    }

    if source.kind == "svg"
        || source_path
            .extension()
            .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("svg"))
            .unwrap_or(false)
    {
        let output_path = cache_dir.join(format!("{hash}.svg"));
        fs::copy(&source_path, &output_path)
            .map_err(|error| format!("无法写入 SVG 缩略图缓存：{error}"))?;
        let output_metadata =
            fs::metadata(&output_path).map_err(|error| format!("无法读取缩略图缓存：{error}"))?;
        let (_, width, height) = image_dimensions(&source_path);

        return Ok(ThumbnailResult {
            format: "svg".to_string(),
            height: height.unwrap_or(preset.max_edge),
            path: normalize_path(&output_path),
            size_kb: std::cmp::max(1, output_metadata.len().div_ceil(1024)),
            width: width.unwrap_or(preset.max_edge),
        });
    }

    let decoded = image::open(&source_path).map_err(|error| format!("图片解码失败：{error}"))?;
    let source_width = decoded.width();
    let source_height = decoded.height();
    let passthrough = if source_width <= preset.max_edge
        && source_height <= preset.max_edge
        && metadata.len() <= preset.passthrough_limit_bytes
    {
        source_passthrough_format(&source_path)
    } else {
        None
    };

    if let Some((extension, format)) = passthrough {
        let output_path = cache_dir.join(format!("{hash}.{extension}"));
        fs::copy(&source_path, &output_path)
            .map_err(|error| format!("无法写入缩略图缓存：{error}"))?;
        let output_metadata =
            fs::metadata(&output_path).map_err(|error| format!("无法读取缩略图缓存：{error}"))?;

        return Ok(ThumbnailResult {
            format: format.to_string(),
            height: source_height,
            path: normalize_path(&output_path),
            size_kb: std::cmp::max(1, output_metadata.len().div_ceil(1024)),
            width: source_width,
        });
    }

    let thumbnail = if source_width <= preset.max_edge && source_height <= preset.max_edge {
        decoded
    } else {
        decoded.resize(preset.max_edge, preset.max_edge, FilterType::Lanczos3)
    };
    let (width, height) = thumbnail.dimensions();
    let alpha = has_visible_alpha(&thumbnail);
    let extension = if alpha { "png" } else { "jpg" };
    let format = if alpha { "png" } else { "jpeg" };

    let output_path = cache_dir.join(format!("{hash}.{extension}"));
    let temp_path = cache_dir.join(format!("{hash}.tmp"));

    if alpha {
        write_png(&temp_path, &thumbnail)?;
    } else {
        write_jpeg(&temp_path, &thumbnail, preset.jpeg_quality)?;
    }

    fs::rename(&temp_path, &output_path).map_err(|error| format!("无法写入缩略图缓存：{error}"))?;

    let output_metadata =
        fs::metadata(&output_path).map_err(|error| format!("无法读取缩略图缓存：{error}"))?;

    Ok(ThumbnailResult {
        format: format.to_string(),
        height,
        path: normalize_path(&output_path),
        size_kb: std::cmp::max(1, output_metadata.len().div_ceil(1024)),
        width,
    })
}

fn remove_other_thumbnail_variants(root: &Path, source: &ThumbnailSource, keep_path: &str) {
    let source_path = PathBuf::from(&source.source_path);
    let Ok(metadata) = fs::metadata(source_path) else {
        return;
    };
    let normalized_keep = normalize_path(Path::new(keep_path));

    for quality in THUMBNAIL_QUALITY_RESTORE_ORDER {
        let hash = cache_hash(root, source, quality, &metadata);
        let cache_dir = thumbnail_cache_dir(root, quality);
        for (extension, _) in cached_thumbnail_candidates(source) {
            let candidate = cache_dir.join(format!("{hash}.{extension}"));
            if normalize_path(&candidate) != normalized_keep && candidate.is_file() {
                let _ = fs::remove_file(candidate);
            }
        }
    }
}

fn generate_thumbnail_result_with_force(
    root: &Path,
    source: &ThumbnailSource,
    quality: &str,
    force: bool,
) -> Result<ThumbnailResult, String> {
    let result = generate_thumbnail_file(root, source, quality, force)?;
    remove_other_thumbnail_variants(root, source, &result.path);
    Ok(result)
}

fn generate_thumbnail_result(
    root: &Path,
    source: &ThumbnailSource,
    quality: &str,
) -> Result<ThumbnailResult, String> {
    generate_thumbnail_result_with_force(root, source, quality, false)
}

fn is_thumbnail_job_active(active_job_id: &Arc<Mutex<Option<String>>>, job_id: &str) -> bool {
    active_job_id
        .lock()
        .map(|active| active.as_deref() == Some(job_id))
        .unwrap_or(false)
}

fn clear_thumbnail_job_if_active(active_job_id: &Arc<Mutex<Option<String>>>, job_id: &str) {
    if let Ok(mut active) = active_job_id.lock() {
        if active.as_deref() == Some(job_id) {
            *active = None;
        }
    }
}

fn thumbnail_worker_count(total: usize) -> usize {
    if total == 0 {
        return 0;
    }

    let available = thread::available_parallelism()
        .map(|parallelism| parallelism.get())
        .unwrap_or(2);
    let conservative_workers = std::cmp::max(1, available / 2);

    total.min(THUMBNAIL_MAX_WORKERS.min(conservative_workers))
}

fn thumbnail_update_from_result(
    source: &ThumbnailSource,
    result: Result<ThumbnailResult, String>,
) -> (ThumbnailUpdatePayload, bool) {
    match result {
        Ok(thumbnail) => (
            ThumbnailUpdatePayload {
                asset_id: source.id.clone(),
                error: None,
                format: Some(thumbnail.format),
                height: Some(thumbnail.height),
                path: Some(thumbnail.path),
                size_kb: Some(thumbnail.size_kb),
                width: Some(thumbnail.width),
            },
            false,
        ),
        Err(error) => (
            ThumbnailUpdatePayload {
                asset_id: source.id.clone(),
                error: Some(error),
                format: None,
                height: None,
                path: None,
                size_kb: None,
                width: None,
            },
            true,
        ),
    }
}

#[tauri::command]
fn generate_thumbnails_stream(
    app: AppHandle,
    state: State<ThumbnailJobState>,
    cache_limit_bytes: u64,
    force: bool,
    library_root: String,
    sources: Vec<ThumbnailSource>,
    quality: String,
    job_id: String,
) -> Result<ThumbnailJobStartResponse, String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }
    allow_library_asset_scope(&app, &root)?;

    let total = sources.len();
    let active_job_id = state.active_job_id.clone();

    {
        let mut active = active_job_id
            .lock()
            .map_err(|_| "缩略图任务状态不可用".to_string())?;
        *active = Some(job_id.clone());
    }

    let thread_job_id = job_id.clone();

    thread::spawn(move || {
        let worker_count = thumbnail_worker_count(total);
        let mut updates = Vec::with_capacity(THUMBNAIL_BATCH_SIZE);
        let mut completed = 0usize;
        let mut failed = 0usize;
        let mut last_current_name: Option<String> = None;

        if worker_count > 0 {
            let sources = Arc::new(sources);
            let next_index = Arc::new(AtomicUsize::new(0));
            let (result_tx, result_rx) = mpsc::channel::<ThumbnailWorkerResult>();

            for _ in 0..worker_count {
                let active_job_id = active_job_id.clone();
                let result_tx = result_tx.clone();
                let root = root.clone();
                let quality = quality.clone();
                let force = force;
                let sources = sources.clone();
                let next_index = next_index.clone();
                let worker_job_id = thread_job_id.clone();

                thread::spawn(move || loop {
                    if !is_thumbnail_job_active(&active_job_id, &worker_job_id) {
                        break;
                    }

                    let index = next_index.fetch_add(1, Ordering::Relaxed);
                    if index >= sources.len() {
                        break;
                    }

                    let source = &sources[index];
                    let current_name = Path::new(&source.relative_path)
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .or_else(|| Some(source.relative_path.clone()));
                    let (update, is_failed) = thumbnail_update_from_result(
                        source,
                        generate_thumbnail_result_with_force(&root, source, &quality, force),
                    );

                    if result_tx
                        .send(ThumbnailWorkerResult {
                            current_name,
                            is_failed,
                            update,
                        })
                        .is_err()
                    {
                        break;
                    }
                });
            }

            drop(result_tx);

            for result in result_rx {
                completed += 1;
                if result.is_failed {
                    failed += 1;
                }
                last_current_name = result.current_name.clone();
                updates.push(result.update);

                if updates.len() >= THUMBNAIL_BATCH_SIZE {
                    let _ = app.emit(
                        THUMBNAIL_BATCH_EVENT,
                        ThumbnailBatchPayload {
                            completed,
                            current_name: last_current_name.clone(),
                            failed,
                            job_id: thread_job_id.clone(),
                            total,
                            updates: std::mem::take(&mut updates),
                        },
                    );
                    thread::yield_now();
                }
            }
        }

        if !updates.is_empty() {
            let _ = app.emit(
                THUMBNAIL_BATCH_EVENT,
                ThumbnailBatchPayload {
                    completed,
                    current_name: last_current_name,
                    failed,
                    job_id: thread_job_id.clone(),
                    total,
                    updates,
                },
            );
        }

        let cancelled =
            completed < total && !is_thumbnail_job_active(&active_job_id, &thread_job_id);
        let cache_result = prune_thumbnail_cache(&root, cache_limit_bytes);

        clear_thumbnail_job_if_active(&active_job_id, &thread_job_id);

        let _ = app.emit(
            THUMBNAIL_FINISHED_EVENT,
            ThumbnailFinishedPayload {
                cache_file_count: cache_result.file_count,
                cache_size_bytes: cache_result.size_bytes,
                cancelled,
                completed,
                failed,
                job_id: thread_job_id,
                pruned_paths: cache_result.removed_paths,
                total,
            },
        );
    });

    Ok(ThumbnailJobStartResponse { job_id, total })
}

#[tauri::command]
fn cancel_thumbnail_generation(
    state: State<ThumbnailJobState>,
    job_id: Option<String>,
) -> Result<(), String> {
    let mut active = state
        .active_job_id
        .lock()
        .map_err(|_| "缩略图任务状态不可用".to_string())?;

    if job_id
        .as_deref()
        .map(|id| active.as_deref() == Some(id))
        .unwrap_or(true)
    {
        *active = None;
    }

    Ok(())
}

#[tauri::command]
fn get_thumbnail_cache_stats(library_root: String) -> Result<ThumbnailCacheResult, String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }
    Ok(thumbnail_cache_result(&root))
}

#[tauri::command]
fn apply_thumbnail_cache_limit(
    library_root: String,
    max_bytes: u64,
) -> Result<ThumbnailCacheResult, String> {
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }
    Ok(prune_thumbnail_cache(&root, max_bytes))
}

#[tauri::command]
fn clear_thumbnail_cache(
    state: State<ThumbnailJobState>,
    library_root: String,
) -> Result<(), String> {
    let _ = cancel_thumbnail_generation(state, None);
    let root = PathBuf::from(&library_root);
    if !root.is_dir() {
        return Err("资源目录无效".to_string());
    }

    let cache_dir = root.join(".picman").join("cache").join("thumbnails");
    if cache_dir.exists() {
        fs::remove_dir_all(&cache_dir).map_err(|error| format!("无法清理缩略图缓存：{error}"))?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_drag::init())
        .manage(LibraryWatchState::default())
        .manage(ThumbnailJobState::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            apply_thumbnail_cache_limit,
            batch_process_images,
            cancel_thumbnail_generation,
            clear_thumbnail_cache,
            clear_library_index,
            collect_image,
            copy_image_to_clipboard,
            empty_trash,
            move_assets,
            rename_asset,
            rename_folder,
            rotate_images,
            generate_thumbnail,
            generate_thumbnails_stream,
            get_thumbnail_cache_stats,
            get_library_index_stats,
            list_trash,
            move_to_trash,
            prepare_image_for_ocr,
            read_app_settings,
            read_library_settings,
            reveal_app_settings_file,
            restore_from_trash,
            reveal_in_finder,
            scan_library_folder,
            scan_library_folder_stream,
            stop_library_watch,
            watch_library,
            write_folder_asset_metadata,
            write_app_settings,
            write_library_settings
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "picman-thumbnail-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_rgba_png(path: &Path, width: u32, height: u32, transparent: bool) {
        let image =
            image::ImageBuffer::<image::Rgba<u8>, Vec<u8>>::from_fn(width, height, |x, y| {
                let alpha = if transparent && (x + y) % 7 == 0 {
                    96
                } else {
                    255
                };
                image::Rgba([
                    ((x * 37 + y * 17) % 251) as u8,
                    ((x * 13 + y * 53) % 241) as u8,
                    ((x * 29 + y * 31) % 239) as u8,
                    alpha,
                ])
            });

        image.save(path).unwrap();
    }

    fn thumbnail_source(path: &Path, name: &str) -> ThumbnailSource {
        ThumbnailSource {
            id: format!("asset-{name}"),
            kind: "png".to_string(),
            relative_path: format!("{name}.png"),
            source_path: normalize_path(path),
        }
    }

    #[test]
    #[ignore = "需要先生成 25000 素材压力库"]
    fn stress_library_scan_from_env() {
        let root = std::env::var("PICMAN_STRESS_LIBRARY")
            .expect("请设置 PICMAN_STRESS_LIBRARY 指向压力素材库");
        let started = std::time::Instant::now();
        let response = scan_library_folder(root).expect("压力素材库扫描失败");
        let scan_elapsed = started.elapsed();

        let catalog_started = std::time::Instant::now();
        let catalog_assets = read_catalog_assets(&PathBuf::from(&response.root_path));
        let catalog_elapsed = catalog_started.elapsed();

        assert!(response.assets.len() >= 25_000);
        assert_eq!(catalog_assets.len(), response.assets.len());
        eprintln!(
            "Picman 压力扫描：{} 个素材，完整扫描 {:?}，索引恢复 {:?}",
            response.assets.len(),
            scan_elapsed,
            catalog_elapsed
        );
    }

    #[test]
    fn opaque_rgba_png_is_encoded_as_jpeg_thumbnail() {
        let root = test_root("opaque");
        let source_path = root.join("opaque.png");
        write_rgba_png(&source_path, 512, 384, false);

        let result =
            generate_thumbnail_result(&root, &thumbnail_source(&source_path, "opaque"), "standard")
                .unwrap();

        assert_eq!(result.format, "jpeg");
        assert_eq!(result.width, 240);
        assert!(Path::new(&result.path).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn transparent_png_keeps_alpha_thumbnail() {
        let root = test_root("transparent");
        let source_path = root.join("transparent.png");
        write_rgba_png(&source_path, 512, 384, true);

        let result = generate_thumbnail_result(
            &root,
            &thumbnail_source(&source_path, "transparent"),
            "standard",
        )
        .unwrap();

        assert_eq!(result.format, "png");
        assert_eq!(result.width, 240);
        assert!(Path::new(&result.path).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn small_but_heavy_opaque_png_is_reencoded_instead_of_copied() {
        let root = test_root("heavy-small");
        let source_path = root.join("heavy-small.png");
        write_rgba_png(&source_path, 160, 90, false);
        let source_size = fs::metadata(&source_path).unwrap().len();
        assert!(source_size > thumbnail_preset("standard").passthrough_limit_bytes);

        let result = generate_thumbnail_result(
            &root,
            &thumbnail_source(&source_path, "heavy-small"),
            "standard",
        )
        .unwrap();
        let thumbnail_size = fs::metadata(&result.path).unwrap().len();

        assert_eq!(result.format, "jpeg");
        assert_eq!(result.width, 160);
        assert!(thumbnail_size < source_size);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn existing_thumbnail_cache_is_reused_before_source_decode() {
        let root = test_root("reuse-existing");
        let source_path = root.join("broken.jpg");
        fs::write(&source_path, b"not a decodable image").unwrap();
        let source = ThumbnailSource {
            id: "asset-broken".to_string(),
            kind: "jpg".to_string(),
            relative_path: "broken.jpg".to_string(),
            source_path: normalize_path(&source_path),
        };
        let metadata = fs::metadata(&source_path).unwrap();
        let hash = cache_hash(&root, &source, "standard", &metadata);
        let cache_dir = thumbnail_cache_dir(&root, "standard");
        fs::create_dir_all(&cache_dir).unwrap();
        let cached_path = cache_dir.join(format!("{hash}.png"));
        write_rgba_png(&cached_path, 32, 24, false);

        let result = generate_thumbnail_result(&root, &source, "standard").unwrap();

        assert_eq!(result.format, "png");
        assert_eq!(result.height, 24);
        assert_eq!(result.path, normalize_path(&cached_path));
        assert_eq!(result.width, 32);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scan_restores_existing_thumbnail_cache() {
        let root = test_root("scan-restore");
        let source_path = root.join("scan-restore.png");
        write_rgba_png(&source_path, 512, 384, false);
        let mut metadata_cache = FolderMetadataCache::default();
        let initial_scan = scanned_asset_from_path(
            &root,
            &source_path,
            0,
            &mut metadata_cache,
            &ThumbnailCacheProbe::new(&root),
        )
        .unwrap();
        let source = ThumbnailSource {
            id: initial_scan.id,
            kind: initial_scan.kind,
            relative_path: initial_scan.relative_path,
            source_path: initial_scan.source_path,
        };
        let generated = generate_thumbnail_result(&root, &source, "standard").unwrap();

        let mut metadata_cache = FolderMetadataCache::default();
        let scanned = scanned_asset_from_path(
            &root,
            &source_path,
            0,
            &mut metadata_cache,
            &ThumbnailCacheProbe::new(&root),
        )
        .unwrap();

        assert!(scanned.thumbnail_ready);
        assert_eq!(scanned.thumbnail_format.as_deref(), Some("jpeg"));
        assert_eq!(
            scanned.thumbnail_path.as_deref(),
            Some(generated.path.as_str())
        );
        assert_eq!(scanned.thumbnail_quality.as_deref(), Some("standard"));
        assert_eq!(scanned.thumbnail_width, Some(240));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn folder_asset_metadata_is_written_and_restored_by_scan() {
        let root = test_root("folder-metadata");
        let folder_path = root.join("Icons");
        fs::create_dir_all(&folder_path).unwrap();
        let source_path = folder_path.join("home.png");
        write_rgba_png(&source_path, 128, 128, false);

        write_folder_asset_metadata(
            normalize_path(&root),
            "Icons/home.png".to_string(),
            FolderAssetMetadata {
                favorite: true,
                note: "Home icon".to_string(),
                tags: vec![" icon ".to_string(), "ui".to_string(), "icon".to_string()],
                ..FolderAssetMetadata::default()
            },
        )
        .unwrap();

        let metadata_path = folder_path.join(FOLDER_METADATA_FILE_NAME);
        assert!(metadata_path.exists());

        let mut metadata_cache = FolderMetadataCache::default();
        let scanned = scanned_asset_from_path(
            &root,
            &source_path,
            0,
            &mut metadata_cache,
            &ThumbnailCacheProbe::new(&root),
        )
        .unwrap();

        assert!(scanned.favorite);
        assert_eq!(scanned.note, "Home icon");
        assert_eq!(scanned.tags, vec!["icon".to_string(), "ui".to_string()]);

        let _ = fs::remove_dir_all(root);
    }

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let path = std::env::temp_dir().join(format!(
            "picman-collect-src-{}-{}x{}.png",
            std::process::id(),
            width,
            height
        ));
        write_rgba_png(&path, width, height, false);
        let bytes = fs::read(&path).unwrap();
        let _ = fs::remove_file(&path);
        bytes
    }

    #[test]
    fn collect_image_writes_file_metadata_and_dedups() {
        let root = test_root("collect-basic");
        let provenance = CollectProvenance {
            source_url: Some("https://example.com/path/Cool Picture.png?x=1".to_string()),
            title: Some("Cool Picture".to_string()),
        };
        let bytes = png_bytes(40, 30);

        let asset = collect_image_into(&root, "Inbox", bytes.clone(), &provenance).unwrap();

        assert_eq!(asset.folder, "/Inbox");
        assert_eq!(asset.kind, "png");
        assert!(!asset.thumbnail_ready);
        let stored_path = PathBuf::from(&asset.source_path);
        assert!(stored_path.is_file());
        assert_eq!(stored_path.file_name().unwrap(), "Cool-Picture.png");

        let metadata_path = root.join("Inbox").join(FOLDER_METADATA_FILE_NAME);
        let folder_metadata = read_folder_metadata(&metadata_path).unwrap();
        let entry = folder_metadata.assets.get("Cool-Picture.png").unwrap();
        assert_eq!(
            entry.source_url.as_deref(),
            Some("https://example.com/path/Cool Picture.png?x=1")
        );
        assert!(entry.captured_at.is_some());

        // Identical bytes into the same folder are deduplicated, not re-saved.
        let again = collect_image_into(&root, "Inbox", bytes, &provenance).unwrap();
        assert_eq!(again.source_path, asset.source_path);
        let file_count = fs::read_dir(root.join("Inbox"))
            .unwrap()
            .flatten()
            .filter(|entry| get_kind(&entry.path()).is_some())
            .count();
        assert_eq!(file_count, 1);

        // Different bytes produce a second file.
        let other = collect_image_into(&root, "Inbox", png_bytes(50, 50), &provenance).unwrap();
        assert_ne!(other.source_path, asset.source_path);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn editing_metadata_preserves_collected_provenance() {
        let root = test_root("collect-provenance");
        let provenance = CollectProvenance {
            source_url: Some("https://example.com/cat.png".to_string()),
            title: Some("cat".to_string()),
        };
        let asset = collect_image_into(&root, "Inbox", png_bytes(24, 24), &provenance).unwrap();

        // A normal tag edit from the UI carries only favorite/note/tags.
        write_folder_asset_metadata(
            normalize_path(&root),
            asset.relative_path.clone(),
            FolderAssetMetadata {
                favorite: true,
                tags: vec!["pet".to_string()],
                ..FolderAssetMetadata::default()
            },
        )
        .unwrap();

        let metadata_path = root.join("Inbox").join(FOLDER_METADATA_FILE_NAME);
        let folder_metadata = read_folder_metadata(&metadata_path).unwrap();
        let entry = folder_metadata.assets.get(&asset.name).unwrap();
        assert!(entry.favorite);
        assert_eq!(entry.tags, vec!["pet".to_string()]);
        assert_eq!(
            entry.source_url.as_deref(),
            Some("https://example.com/cat.png")
        );
        assert!(entry.captured_at.is_some());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn base64_encode_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"M"), "TQ==");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
    }

    #[test]
    fn prepare_image_for_ocr_returns_jpeg_data_uri() {
        let root = test_root("ocr-prep");
        let source_path = root.join("ocr.png");
        write_rgba_png(&source_path, 64, 48, false);

        let data_uri = prepare_image_for_ocr(normalize_path(&source_path)).unwrap();
        assert!(data_uri.starts_with("data:image/jpeg;base64,"));
        let payload = data_uri.trim_start_matches("data:image/jpeg;base64,");
        assert!(!payload.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn move_and_rename_carry_metadata() {
        let root = test_root("move-rename");
        let library = normalize_path(&root);
        let icons = root.join("Icons");
        fs::create_dir_all(&icons).unwrap();
        let file = icons.join("home.png");
        write_rgba_png(&file, 32, 32, false);
        write_folder_asset_metadata(
            library.clone(),
            "Icons/home.png".to_string(),
            FolderAssetMetadata {
                favorite: true,
                tags: vec!["icon".to_string()],
                ..FolderAssetMetadata::default()
            },
        )
        .unwrap();

        // Move into a new folder (created on demand).
        let moved = move_assets(
            library.clone(),
            vec!["Icons/home.png".to_string()],
            "Web".to_string(),
        )
        .unwrap();
        assert_eq!(moved.len(), 1);
        assert!(!file.exists());
        assert!(root.join("Web").join("home.png").is_file());
        assert_eq!(moved[0].asset.folder, "/Web");
        assert!(moved[0].asset.favorite);
        assert_eq!(moved[0].asset.tags, vec!["icon".to_string()]);

        // Rename within the new folder, preserving metadata.
        let renamed =
            rename_asset(library, "Web/home.png".to_string(), "house".to_string()).unwrap();
        assert!(root.join("Web").join("house.png").is_file());
        assert!(!root.join("Web").join("home.png").exists());
        assert_eq!(renamed.name, "house.png");
        assert!(renamed.favorite);
        assert_eq!(renamed.tags, vec!["icon".to_string()]);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rename_folder_remaps_contained_assets() {
        let root = test_root("rename-folder");
        let library = normalize_path(&root);
        let icons = root.join("Icons");
        let nested = icons.join("Web");
        fs::create_dir_all(&nested).unwrap();
        write_rgba_png(&icons.join("home.png"), 16, 16, false);
        write_rgba_png(&nested.join("cart.png"), 16, 16, false);
        write_folder_asset_metadata(
            library.clone(),
            "Icons/home.png".to_string(),
            FolderAssetMetadata {
                tags: vec!["ui".to_string()],
                ..FolderAssetMetadata::default()
            },
        )
        .unwrap();

        let remaps = rename_folder(library, "Icons".to_string(), "Symbols".to_string()).unwrap();

        assert!(!icons.exists());
        assert!(root.join("Symbols").join("home.png").is_file());
        assert!(root.join("Symbols").join("Web").join("cart.png").is_file());
        assert_eq!(remaps.len(), 2);

        let home = remaps
            .iter()
            .find(|item| item.previous_relative_path == "Icons/home.png")
            .unwrap();
        assert_eq!(home.asset.folder, "/Symbols");
        assert_eq!(home.asset.tags, vec!["ui".to_string()]);
        assert!(remaps
            .iter()
            .any(|item| item.previous_relative_path == "Icons/Web/cart.png"
                && item.asset.folder == "/Symbols/Web"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rotate_swaps_dimensions_and_keeps_metadata() {
        let root = test_root("rotate");
        let library = normalize_path(&root);
        let folder = root.join("Photos");
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join("shot.png");
        write_rgba_png(&file, 60, 40, false);
        write_folder_asset_metadata(
            library.clone(),
            "Photos/shot.png".to_string(),
            FolderAssetMetadata {
                favorite: true,
                ..FolderAssetMetadata::default()
            },
        )
        .unwrap();

        let rotated = rotate_images(library, vec!["Photos/shot.png".to_string()], 1).unwrap();
        assert_eq!(rotated.len(), 1);
        assert!(rotated[0].asset.favorite);

        let (width, height) = image::image_dimensions(&file).unwrap();
        assert_eq!((width, height), (40, 60));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn batch_process_resizes_and_recompresses() {
        let root = test_root("batch");
        let folder = root.join("Photos");
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join("big.jpg");
        let buffer = image::RgbImage::from_fn(800, 600, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        image::DynamicImage::ImageRgb8(buffer).save(&file).unwrap();

        let result = batch_process_images(
            normalize_path(&root),
            vec!["Photos/big.jpg".to_string()],
            BatchProcessOptions {
                max_edge: Some(400),
                scale_percent: None,
                quality: 70,
            },
        )
        .unwrap();

        assert_eq!(result.failed, 0);
        assert_eq!(result.processed.len(), 1);
        let (width, height) = image::image_dimensions(&file).unwrap();
        assert_eq!(width.max(height), 400);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn batch_process_handles_webp() {
        let root = test_root("batch-webp");
        let file = root.join("shot.webp");
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            300,
            200,
            image::Rgb([10, 20, 30]),
        ))
        .save_with_format(&file, image::ImageFormat::WebP)
        .unwrap();

        let result = batch_process_images(
            normalize_path(&root),
            vec!["shot.webp".to_string()],
            BatchProcessOptions {
                max_edge: Some(150),
                scale_percent: None,
                quality: 80,
            },
        )
        .unwrap();

        assert_eq!(result.failed, 0);
        let (width, _) = image::image_dimensions(&file).unwrap();
        assert_eq!(width, 150);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn trash_move_restore_and_empty_round_trip() {
        let root = test_root("trash");
        let library = normalize_path(&root);
        let folder = root.join("Icons");
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join("home.png");
        write_rgba_png(&file, 32, 32, false);

        write_folder_asset_metadata(
            library.clone(),
            "Icons/home.png".to_string(),
            FolderAssetMetadata {
                favorite: true,
                tags: vec!["icon".to_string()],
                ..FolderAssetMetadata::default()
            },
        )
        .unwrap();

        let trashed = move_to_trash(library.clone(), vec!["Icons/home.png".to_string()]).unwrap();
        assert_eq!(trashed.len(), 1);
        assert!(!file.exists());
        assert!(trashed[0].metadata.favorite);
        assert_eq!(list_trash(library.clone()).unwrap().len(), 1);

        let restored = restore_from_trash(library.clone(), vec![trashed[0].id.clone()]).unwrap();
        assert_eq!(restored.len(), 1);
        assert!(file.exists());
        assert!(restored[0].favorite);
        assert_eq!(restored[0].tags, vec!["icon".to_string()]);
        assert!(list_trash(library.clone()).unwrap().is_empty());

        move_to_trash(library.clone(), vec!["Icons/home.png".to_string()]).unwrap();
        assert!(!file.exists());
        empty_trash(library.clone()).unwrap();
        assert!(list_trash(library).unwrap().is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn collect_transcodes_unsupported_format_to_png() {
        let root = test_root("collect-transcode");
        let bmp_path =
            std::env::temp_dir().join(format!("picman-collect-{}.bmp", std::process::id()));
        image::RgbaImage::from_pixel(8, 8, image::Rgba([10, 20, 30, 255]))
            .save(&bmp_path)
            .unwrap();
        let bmp_bytes = fs::read(&bmp_path).unwrap();
        let _ = fs::remove_file(&bmp_path);

        let asset = collect_image_into(
            &root,
            "Inbox",
            bmp_bytes,
            &CollectProvenance {
                title: Some("shot".to_string()),
                ..CollectProvenance::default()
            },
        )
        .unwrap();

        assert_eq!(asset.kind, "png");
        let stored = PathBuf::from(&asset.source_path);
        assert_eq!(stored.extension().unwrap(), "png");
        assert_eq!(
            image::guess_format(&fs::read(&stored).unwrap()).unwrap(),
            image::ImageFormat::Png
        );

        let _ = fs::remove_dir_all(root);
    }
}
