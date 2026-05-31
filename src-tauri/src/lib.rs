use chrono::{DateTime, Local};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
use image::imageops::FilterType;
use image::{ColorType, GenericImageView, ImageEncoder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::ErrorKind;
use std::path::Component;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter, Manager, State};
use walkdir::WalkDir;

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
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanLibraryBatchPayload {
    assets: Vec<ScannedAsset>,
    scan_id: String,
    total: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanLibraryFinishedPayload {
    library_name: String,
    root_path: String,
    scan_id: String,
    total: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanLibraryErrorPayload {
    message: String,
    scan_id: String,
}

#[derive(Clone, Debug, Serialize)]
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
    cancelled: bool,
    completed: usize,
    failed: usize,
    job_id: String,
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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderMetadataFile {
    #[serde(default)]
    assets: BTreeMap<String, FolderAssetMetadata>,
    #[serde(default = "folder_metadata_version")]
    version: u32,
}

fn folder_metadata_version() -> u32 {
    1
}

impl Default for FolderMetadataFile {
    fn default() -> Self {
        Self {
            assets: BTreeMap::new(),
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
        Err(error) => Err(format!("无法读取文件夹元数据：{}：{error}", normalize_path(path))),
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

        metadata.assets.get(file_name).cloned().map(normalize_folder_asset_metadata)
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

fn thumbnail_cache_dir(root: &Path, quality: &str) -> PathBuf {
    root.join(".picman")
        .join("cache")
        .join("thumbnails")
        .join(quality)
}

fn cached_thumbnail_candidates(source: &ThumbnailSource) -> &'static [(&'static str, &'static str)] {
    if source.kind == "svg"
        || source
            .source_path
            .rsplit_once('.')
            .map(|(_, ext)| ext.eq_ignore_ascii_case("svg"))
            .unwrap_or(false)
    {
        &[("svg", "svg")]
    } else {
        &[("jpg", "jpeg"), ("png", "png"), ("webp", "webp"), ("jpeg", "jpeg")]
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
        return (width.unwrap_or(preset.max_edge), height.unwrap_or(preset.max_edge));
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
) -> Option<ThumbnailCacheHit> {
    for quality in THUMBNAIL_QUALITY_RESTORE_ORDER {
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
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_) | Component::RootDir))
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
    let cached_thumbnail = existing_thumbnail_cache_hit(root, &thumbnail_source, &metadata);
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

    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_entry(|entry| entry.file_name() != ".picman")
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }

        if let Some(asset) =
            scanned_asset_from_path(&root, entry.path(), assets.len(), &mut folder_metadata)
        {
            assets.push(asset);
        }
    }

    assets.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

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
) -> Result<ScanLibraryStartResponse, String> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err("请选择有效的资源目录".to_string());
    }
    allow_library_asset_scope(&app, &root)?;

    let library_name = library_name_for(&root);
    let normalized_root = normalize_path(&root);
    let thread_root = root.clone();
    let thread_library_name = library_name.clone();
    let thread_root_path = normalized_root.clone();

    thread::spawn(move || {
        let mut assets = Vec::with_capacity(SCAN_BATCH_SIZE);
        let mut folder_metadata = FolderMetadataCache::default();
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

            if let Some(asset) =
                scanned_asset_from_path(&thread_root, entry.path(), total, &mut folder_metadata)
            {
                total += 1;
                assets.push(asset);
            }

            if assets.len() >= SCAN_BATCH_SIZE {
                assets.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
                let _ = app.emit(
                    SCAN_BATCH_EVENT,
                    ScanLibraryBatchPayload {
                        assets: std::mem::take(&mut assets),
                        scan_id: scan_id.clone(),
                        total,
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
                    scan_id: scan_id.clone(),
                    total,
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
            },
        );
    });

    Ok(ScanLibraryStartResponse {
        library_name,
        root_path: normalized_root,
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

    folder_metadata.version = 1;
    folder_metadata
        .assets
        .insert(file_name, normalize_folder_asset_metadata(metadata));
    write_folder_metadata(&metadata_path, &folder_metadata)
}

fn generate_thumbnail_result(
    root: &Path,
    source: &ThumbnailSource,
    quality: &str,
) -> Result<ThumbnailResult, String> {
    let source_path = PathBuf::from(&source.source_path);
    ensure_inside(root, &source_path)?;

    let metadata =
        fs::metadata(&source_path).map_err(|error| format!("无法读取源文件：{error}"))?;
    let preset = thumbnail_preset(quality);
    let hash = cache_hash(root, source, quality, &metadata);
    let cache_dir = thumbnail_cache_dir(root, quality);
    fs::create_dir_all(&cache_dir).map_err(|error| format!("无法创建缩略图缓存目录：{error}"))?;

    if let Some(existing) = existing_thumbnail_for_quality(root, source, quality, &metadata) {
        return Ok(existing);
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
                        generate_thumbnail_result(&root, source, &quality),
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

        clear_thumbnail_job_if_active(&active_job_id, &thread_job_id);

        let _ = app.emit(
            THUMBNAIL_FINISHED_EVENT,
            ThumbnailFinishedPayload {
                cancelled,
                completed,
                failed,
                job_id: thread_job_id,
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
        .manage(ThumbnailJobState::default())
        .invoke_handler(tauri::generate_handler![
            cancel_thumbnail_generation,
            clear_thumbnail_cache,
            generate_thumbnail,
            generate_thumbnails_stream,
            scan_library_folder,
            scan_library_folder_stream,
            write_folder_asset_metadata
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
        let image = image::ImageBuffer::<image::Rgba<u8>, Vec<u8>>::from_fn(width, height, |x, y| {
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
        let initial_scan = scanned_asset_from_path(&root, &source_path, 0, &mut metadata_cache).unwrap();
        let source = ThumbnailSource {
            id: initial_scan.id,
            kind: initial_scan.kind,
            relative_path: initial_scan.relative_path,
            source_path: initial_scan.source_path,
        };
        let generated = generate_thumbnail_result(
            &root,
            &source,
            "standard",
        )
        .unwrap();

        let mut metadata_cache = FolderMetadataCache::default();
        let scanned = scanned_asset_from_path(&root, &source_path, 0, &mut metadata_cache).unwrap();

        assert!(scanned.thumbnail_ready);
        assert_eq!(scanned.thumbnail_format.as_deref(), Some("jpeg"));
        assert_eq!(scanned.thumbnail_path.as_deref(), Some(generated.path.as_str()));
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
            },
        )
        .unwrap();

        let metadata_path = folder_path.join(FOLDER_METADATA_FILE_NAME);
        assert!(metadata_path.exists());

        let mut metadata_cache = FolderMetadataCache::default();
        let scanned = scanned_asset_from_path(&root, &source_path, 0, &mut metadata_cache).unwrap();

        assert!(scanned.favorite);
        assert_eq!(scanned.note, "Home icon");
        assert_eq!(scanned.tags, vec!["icon".to_string(), "ui".to_string()]);

        let _ = fs::remove_dir_all(root);
    }
}
