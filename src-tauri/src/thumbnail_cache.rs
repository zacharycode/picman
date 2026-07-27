use super::{modified_seconds, normalize_path};
use serde::Serialize;
use std::fs;
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
    modified: u64,
    path: PathBuf,
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
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        files.push(ThumbnailCacheFile {
            modified: modified_seconds(&metadata),
            path: entry.path().to_path_buf(),
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

pub(crate) fn prune_thumbnail_cache(root: &Path, max_bytes: u64) -> ThumbnailCacheResult {
    let mut files = collect_thumbnail_cache_files(root);
    let mut size_bytes = files.iter().map(|file| file.size).sum::<u64>();
    if size_bytes <= max_bytes {
        return ThumbnailCacheResult {
            file_count: files.len(),
            removed_paths: Vec::new(),
            size_bytes,
        };
    }

    files.sort_unstable_by(|left, right| {
        left.modified
            .cmp(&right.modified)
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut removed_paths = Vec::new();
    let mut removed_count = 0usize;
    for file in &files {
        if size_bytes <= max_bytes {
            break;
        }
        if fs::remove_file(&file.path).is_ok() {
            size_bytes = size_bytes.saturating_sub(file.size);
            removed_count += 1;
            removed_paths.push(normalize_path(&file.path));
        }
    }

    ThumbnailCacheResult {
        file_count: files.len().saturating_sub(removed_count),
        removed_paths,
        size_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::{prune_thumbnail_cache, thumbnail_cache_dir, thumbnail_cache_result};
    use std::fs;

    #[test]
    fn reports_and_prunes_cache_files_to_the_real_byte_limit() {
        let root =
            std::env::temp_dir().join(format!("picman-cache-limit-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let cache = thumbnail_cache_dir(&root, "standard");
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("a.webp"), [0_u8; 8]).unwrap();
        fs::write(cache.join("b.webp"), [1_u8; 8]).unwrap();

        let before = thumbnail_cache_result(&root);
        assert_eq!(before.file_count, 2);
        assert_eq!(before.size_bytes, 16);

        let after = prune_thumbnail_cache(&root, 10);
        assert_eq!(after.file_count, 1);
        assert_eq!(after.size_bytes, 8);
        assert_eq!(after.removed_paths.len(), 1);

        let _ = fs::remove_dir_all(root);
    }
}
