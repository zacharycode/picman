use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const LIBRARY_CHANGED_EVENT: &str = "picman-library-changed";

#[derive(Default)]
pub(crate) struct LibraryWatchState {
    session: Mutex<Option<LibraryWatchSession>>,
}

struct LibraryWatchSession {
    _watcher: RecommendedWatcher,
    _worker: thread::JoinHandle<()>,
    _watch_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryChangedPayload {
    content_changed: bool,
    root_path: String,
    settings_changed: bool,
    watch_id: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct LibraryChange {
    content_changed: bool,
    settings_changed: bool,
}

impl LibraryChange {
    fn merge(&mut self, next: Self) {
        self.content_changed |= next.content_changed;
        self.settings_changed |= next.settings_changed;
    }
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn classify_library_watch_path(root: &Path, path: &Path) -> LibraryChange {
    let Ok(relative) = path.strip_prefix(root) else {
        return LibraryChange::default();
    };
    let mut components = relative.components();
    if !matches!(components.next(), Some(Component::Normal(name)) if name == ".picman") {
        return LibraryChange {
            content_changed: true,
            settings_changed: false,
        };
    }

    LibraryChange {
        content_changed: false,
        settings_changed: matches!(components.next(), Some(Component::Normal(name)) if name == "settings.json"),
    }
}

#[tauri::command]
pub(crate) fn watch_library(
    app: AppHandle,
    state: State<LibraryWatchState>,
    root_path: String,
    watch_id: String,
) -> Result<(), String> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err("请选择有效的资源目录".to_string());
    }
    let normalized_root = normalize_path(&root);
    let callback_root = root.clone();
    let (change_tx, change_rx) = mpsc::channel::<LibraryChange>();
    let worker_root = normalized_root.clone();
    let worker_watch_id = watch_id.clone();
    let worker = thread::spawn(move || {
        while let Ok(mut pending) = change_rx.recv() {
            loop {
                match change_rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(next) => pending.merge(next),
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            let _ = app.emit(
                LIBRARY_CHANGED_EVENT,
                LibraryChangedPayload {
                    content_changed: pending.content_changed,
                    root_path: worker_root.clone(),
                    settings_changed: pending.settings_changed,
                    watch_id: worker_watch_id.clone(),
                },
            );
        }
    });

    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else {
            return;
        };
        let mut change = LibraryChange::default();
        for path in &event.paths {
            change.merge(classify_library_watch_path(&callback_root, path));
        }
        if change != LibraryChange::default() {
            let _ = change_tx.send(change);
        }
    })
    .map_err(|error| format!("无法创建资源目录监听：{error}"))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| format!("无法监听资源目录：{error}"))?;
    let mut session = state
        .session
        .lock()
        .map_err(|_| "资源目录监听状态不可用".to_string())?;
    *session = Some(LibraryWatchSession {
        _watcher: watcher,
        _worker: worker,
        _watch_id: watch_id,
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn stop_library_watch(state: State<LibraryWatchState>) -> Result<(), String> {
    let mut session = state
        .session
        .lock()
        .map_err(|_| "资源目录监听状态不可用".to_string())?;
    *session = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{classify_library_watch_path, LibraryChange};
    use std::path::Path;

    #[test]
    fn ignores_local_cache_but_keeps_source_and_folder_metadata() {
        let root = Path::new("/tmp/picman-library");
        assert_eq!(
            classify_library_watch_path(
                root,
                Path::new("/tmp/picman-library/.picman/cache/catalog.jsonl")
            ),
            LibraryChange::default()
        );
        assert_eq!(
            classify_library_watch_path(
                root,
                Path::new("/tmp/picman-library/.picman/settings.json")
            ),
            LibraryChange {
                content_changed: false,
                settings_changed: true,
            }
        );
        assert!(
            classify_library_watch_path(root, Path::new("/tmp/picman-library/Icons/home.png"))
                .content_changed
        );
        assert!(
            classify_library_watch_path(
                root,
                Path::new("/tmp/picman-library/Icons/.picman.folder.json")
            )
            .content_changed
        );
    }
}
