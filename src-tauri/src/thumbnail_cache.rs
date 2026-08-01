use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThumbnailCacheResult {
    pub(crate) file_count: usize,
    pub(crate) removed_paths: Vec<String>,
    pub(crate) size_bytes: u64,
}

pub(crate) fn thumbnail_cache_dir(root: &Path, quality: &str) -> PathBuf {
    root.join(".picman")
        .join("cache")
        .join("thumbnails")
        .join(quality)
}

#[derive(Debug)]
struct ThumbnailCacheFile {
    size: u64,
}

pub(crate) fn thumbnail_cache_root(root: &Path) -> PathBuf {
    root.join(".picman").join("cache").join("thumbnails")
}

fn collect_thumbnail_cache_files(root: &Path) -> Vec<ThumbnailCacheFile> {
    let cache_root = thumbnail_cache_root(root);
    if !cache_root.is_dir() {
        return Vec::new();
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(cache_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file()
            || entry
                .path()
                .extension()
                .map(|extension| extension.to_string_lossy().eq_ignore_ascii_case("tmp"))
                .unwrap_or(false)
        {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        files.push(ThumbnailCacheFile {
            size: metadata.len(),
        });
    }
    files
}

pub(crate) fn thumbnail_cache_result(root: &Path) -> ThumbnailCacheResult {
    let files = collect_thumbnail_cache_files(root);
    ThumbnailCacheResult {
        file_count: files.len(),
        removed_paths: Vec::new(),
        size_bytes: files.iter().map(|file| file.size).sum(),
    }
}

#[cfg(test)]
mod tests {
    use super::{thumbnail_cache_dir, thumbnail_cache_result};
    use std::fs;

    #[test]
    fn reports_real_cache_files_and_ignores_in_flight_files() {
        let root =
            std::env::temp_dir().join(format!("picman-cache-limit-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let cache = thumbnail_cache_dir(&root, "standard");
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("a.webp"), [0_u8; 8]).unwrap();
        fs::write(cache.join("b.webp"), [1_u8; 8]).unwrap();
        let in_flight = cache.join("in-flight.tmp");
        fs::write(&in_flight, [2_u8; 64]).unwrap();

        let before = thumbnail_cache_result(&root);
        assert_eq!(before.file_count, 2);
        assert_eq!(before.size_bytes, 16);

        assert!(in_flight.is_file());

        let _ = fs::remove_dir_all(root);
    }
}
