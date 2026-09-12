use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{File, OpenOptions as StdOpenOptions},
    io::{copy, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::Mutex,
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_fs::{FsExt, OpenOptions};
use uuid::Uuid;

mod native_handoff;
mod sync_broker;

#[cfg(desktop)]
use std::path::Path;

#[derive(Default)]
struct PublicationSources {
    selected: Mutex<HashMap<String, FilePath>>,
    opened: Mutex<Vec<PublicationDescriptor>>,
}

#[derive(Default)]
struct BackupExports {
    pending: Mutex<HashMap<String, PendingBackupExport>>,
}

#[derive(Default)]
struct BookDeepLinks {
    opened: Mutex<Vec<String>>,
}

struct PendingBackupExport {
    target: FilePath,
    temp_path: PathBuf,
    file: File,
}

const BACKUP_EXPORT_ID_HEADER: &str = "x-omnia-export-id";
const MAX_BACKUP_CHUNK_SIZE: usize = 1024 * 1024;
const MAX_PENDING_BOOK_DEEP_LINKS: usize = 32;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationDescriptor {
    source_id: String,
    name: String,
    media_type: &'static str,
    size: u64,
}

#[derive(Clone, Copy)]
enum PublicationKind {
    Epub,
    Pdf,
}

impl PublicationKind {
    fn extension(self) -> &'static str {
        match self {
            Self::Epub => "epub",
            Self::Pdf => "pdf",
        }
    }

    fn media_type(self) -> &'static str {
        match self {
            Self::Epub => "application/epub+zip",
            Self::Pdf => "application/pdf",
        }
    }
}

#[tauri::command]
async fn pick_publications(
    app: AppHandle,
    sources: State<'_, PublicationSources>,
) -> Result<Vec<PublicationDescriptor>, String> {
    let selected = app
        .dialog()
        .file()
        .add_filter("EPUB and PDF books", &["epub", "pdf"])
        .blocking_pick_files()
        .unwrap_or_default();

    let mut descriptors = Vec::with_capacity(selected.len());
    let mut pending = sources
        .selected
        .lock()
        .map_err(|_| "The native publication registry is unavailable".to_owned())?;

    for path in selected {
        let (kind, size) = inspect_publication(&app, &path)?;
        let source_id = Uuid::new_v4().to_string();
        let name = publication_name(&path, kind);
        pending.insert(source_id.clone(), path);
        descriptors.push(PublicationDescriptor {
            source_id,
            name,
            media_type: kind.media_type(),
            size,
        });
    }

    Ok(descriptors)
}

#[tauri::command]
fn take_opened_publications(
    sources: State<'_, PublicationSources>,
) -> Result<Vec<PublicationDescriptor>, String> {
    let mut opened = sources
        .opened
        .lock()
        .map_err(|_| "The native publication queue is unavailable".to_owned())?;
    let publications = std::mem::take(&mut *opened);
    #[cfg(feature = "native-e2e")]
    eprintln!(
        "native-e2e: frontend drained {} publication(s)",
        publications.len()
    );
    Ok(publications)
}

#[tauri::command]
fn take_opened_book_deep_links(links: State<'_, BookDeepLinks>) -> Result<Vec<String>, String> {
    let mut opened = links
        .opened
        .lock()
        .map_err(|_| "The native book-link queue is unavailable".to_owned())?;
    Ok(std::mem::take(&mut *opened))
}

#[tauri::command]
async fn read_publication(
    app: AppHandle,
    sources: State<'_, PublicationSources>,
    source_id: String,
) -> Result<Response, String> {
    let path = sources
        .selected
        .lock()
        .map_err(|_| "The native publication registry is unavailable".to_owned())?
        .remove(&source_id)
        .ok_or_else(|| "This publication selection has expired".to_owned())?;
    let bytes = app
        .fs()
        .read(path)
        .map_err(|error| format!("Unable to read the selected publication: {error}"))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
async fn begin_backup_export(
    app: AppHandle,
    exports: State<'_, BackupExports>,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let file_name = safe_backup_file_name(&suggested_name)?;
    let Some(target) = app
        .dialog()
        .file()
        .add_filter("Omnia Reader backup", &["omnia-backup"])
        .set_file_name(file_name)
        .blocking_save_file()
    else {
        return Ok(None);
    };

    let export_id = Uuid::new_v4().to_string();
    let temp_path = app
        .path()
        .temp_dir()
        .map_err(|error| format!("Unable to prepare the backup destination: {error}"))?
        .join(format!(".omnia-reader-backup-{export_id}.part"));
    let file = StdOpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&temp_path)
        .map_err(|error| format!("Unable to prepare the backup destination: {error}"))?;
    exports
        .pending
        .lock()
        .map_err(|_| "The native backup registry is unavailable".to_owned())?
        .insert(
            export_id.clone(),
            PendingBackupExport {
                target,
                temp_path,
                file,
            },
        );
    Ok(Some(export_id))
}

#[tauri::command]
fn write_backup_chunk(request: Request, exports: State<'_, BackupExports>) -> Result<(), String> {
    let export_id = backup_export_id(&request)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The native backup chunk must be binary".to_owned());
    };
    if bytes.is_empty() || bytes.len() > MAX_BACKUP_CHUNK_SIZE {
        return Err("The native backup chunk has an invalid size".to_owned());
    }

    let mut pending = exports
        .pending
        .lock()
        .map_err(|_| "The native backup registry is unavailable".to_owned())?;
    let export = pending
        .get_mut(export_id)
        .ok_or_else(|| "This backup export has expired".to_owned())?;
    export
        .file
        .write_all(bytes)
        .map_err(|error| format!("Unable to write the backup: {error}"))
}

#[tauri::command]
async fn commit_backup_export(
    app: AppHandle,
    exports: State<'_, BackupExports>,
    export_id: String,
) -> Result<(), String> {
    let pending = take_backup_export(&exports, &export_id)?;
    tauri::async_runtime::spawn_blocking(move || finalize_backup_export(&app, pending))
        .await
        .map_err(|error| format!("Unable to finish the backup: {error}"))?
}

#[tauri::command]
fn cancel_backup_export(
    exports: State<'_, BackupExports>,
    export_id: String,
) -> Result<(), String> {
    let pending = take_backup_export(&exports, &export_id)?;
    let temp_path = pending.temp_path.clone();
    drop(pending);
    std::fs::remove_file(temp_path)
        .or_else(|error| {
            (error.kind() == std::io::ErrorKind::NotFound)
                .then_some(())
                .ok_or(error)
        })
        .map_err(|error| format!("Unable to cancel the backup cleanly: {error}"))
}

fn safe_backup_file_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > 180
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        return Err("The backup file name is invalid".to_owned());
    }
    Ok(if value.to_ascii_lowercase().ends_with(".omnia-backup") {
        value.to_owned()
    } else {
        format!("{value}.omnia-backup")
    })
}

fn backup_export_id<'a>(request: &'a Request<'a>) -> Result<&'a str, String> {
    request
        .headers()
        .get(BACKUP_EXPORT_ID_HEADER)
        .ok_or_else(|| "The native backup export ID is missing".to_owned())?
        .to_str()
        .map_err(|_| "The native backup export ID is invalid".to_owned())
}

fn take_backup_export(
    exports: &State<'_, BackupExports>,
    export_id: &str,
) -> Result<PendingBackupExport, String> {
    exports
        .pending
        .lock()
        .map_err(|_| "The native backup registry is unavailable".to_owned())?
        .remove(export_id)
        .ok_or_else(|| "This backup export has expired".to_owned())
}

fn finalize_backup_export(app: &AppHandle, mut pending: PendingBackupExport) -> Result<(), String> {
    let result = (|| {
        pending
            .file
            .flush()
            .and_then(|_| pending.file.sync_all())
            .and_then(|_| pending.file.seek(SeekFrom::Start(0)).map(|_| ()))
            .map_err(|error| format!("Unable to finish the backup: {error}"))?;
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        let mut target = app
            .fs()
            .open(pending.target.clone(), options)
            .map_err(|error| format!("Unable to open the backup destination: {error}"))?;
        copy(&mut pending.file, &mut target)
            .and_then(|_| target.flush())
            .and_then(|_| target.sync_all())
            .map_err(|error| format!("Unable to save the backup: {error}"))
    })();
    drop(pending.file);
    let _ = std::fs::remove_file(pending.temp_path);
    result
}

fn register_opened_publications(
    app: &AppHandle,
    paths: impl IntoIterator<Item = FilePath>,
) -> Result<usize, String> {
    let mut inspected = Vec::new();
    for path in paths {
        if let Ok((kind, size)) = inspect_publication(app, &path) {
            inspected.push((path, kind, size));
        }
    }
    if inspected.is_empty() {
        return Ok(0);
    }
    let added = inspected.len();

    let sources = app.state::<PublicationSources>();
    let mut selected = sources
        .selected
        .lock()
        .map_err(|_| "The native publication registry is unavailable".to_owned())?;
    let mut opened = sources
        .opened
        .lock()
        .map_err(|_| "The native publication queue is unavailable".to_owned())?;
    for (path, kind, size) in inspected {
        let source_id = Uuid::new_v4().to_string();
        let descriptor = PublicationDescriptor {
            source_id: source_id.clone(),
            name: publication_name(&path, kind),
            media_type: kind.media_type(),
            size,
        };
        selected.insert(source_id, path);
        opened.push(descriptor);
    }
    Ok(added)
}

fn emit_opened_publications(app: &AppHandle, paths: impl IntoIterator<Item = FilePath>) {
    match register_opened_publications(app, paths) {
        Ok(count) if count > 0 => {
            #[cfg(feature = "native-e2e")]
            eprintln!("native-e2e: queued {count} forwarded publication(s)");
            let _ = app.emit("publications-opened", ());
        }
        #[cfg(feature = "native-e2e")]
        Ok(_) => eprintln!("native-e2e: forwarded arguments contained no publications"),
        #[cfg(feature = "native-e2e")]
        Err(error) => eprintln!("native-e2e: failed to queue forwarded publications: {error}"),
        #[cfg(not(feature = "native-e2e"))]
        _ => {}
    }
}

fn deep_link_book_id(url: &tauri::Url) -> Option<String> {
    if url.scheme() != "omnia-reader"
        || url.host_str() != Some("reader")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let mut segments = url.path_segments()?;
    let book_id = segments.next()?;
    if segments.next().is_some()
        || book_id.len() != 64
        || !book_id.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some(format!("sha256:{}", book_id.to_ascii_lowercase()))
}

fn register_book_deep_links(
    app: &AppHandle,
    urls: impl IntoIterator<Item = tauri::Url>,
) -> Result<usize, String> {
    let links = app.state::<BookDeepLinks>();
    let mut opened = links
        .opened
        .lock()
        .map_err(|_| "The native book-link queue is unavailable".to_owned())?;
    let mut added = 0;
    for book_id in urls.into_iter().filter_map(|url| deep_link_book_id(&url)) {
        if opened.len() >= MAX_PENDING_BOOK_DEEP_LINKS {
            break;
        }
        if !opened.contains(&book_id) {
            opened.push(book_id);
            added += 1;
        }
    }
    Ok(added)
}

fn emit_opened_book_deep_links(app: &AppHandle, urls: impl IntoIterator<Item = tauri::Url>) {
    if matches!(register_book_deep_links(app, urls), Ok(count) if count > 0) {
        let _ = app.emit("book-deep-link-opened", ());
    }
}

#[cfg(desktop)]
fn desktop_argument_paths(
    arguments: impl IntoIterator<Item = PathBuf>,
    current_directory: &Path,
) -> Vec<FilePath> {
    arguments
        .into_iter()
        .filter_map(|argument| {
            if let Some(argument) = argument.to_str() {
                if let Ok(url) = tauri::Url::parse(argument) {
                    if url.scheme() == "file" {
                        return url
                            .to_file_path()
                            .ok()
                            .filter(|path| path.is_file())
                            .map(FilePath::Path);
                    }
                    return None;
                }
            }
            let path = if argument.is_absolute() {
                argument
            } else {
                current_directory.join(argument)
            };
            path.is_file().then_some(FilePath::Path(path))
        })
        .collect()
}

#[cfg(desktop)]
fn startup_publication_paths() -> Vec<FilePath> {
    let current_directory = std::env::current_dir().unwrap_or_default();
    desktop_argument_paths(
        std::env::args_os().skip(1).map(PathBuf::from),
        &current_directory,
    )
}

#[cfg(desktop)]
fn startup_book_deep_links() -> Vec<tauri::Url> {
    std::env::args()
        .skip(1)
        .filter_map(|argument| tauri::Url::parse(&argument).ok())
        .collect()
}

fn inspect_publication(app: &AppHandle, path: &FilePath) -> Result<(PublicationKind, u64), String> {
    let mut options = OpenOptions::new();
    options.read(true);
    let mut file = app
        .fs()
        .open(path.clone(), options)
        .map_err(|error| format!("Unable to inspect the selected publication: {error}"))?;
    let size = file
        .metadata()
        .map_err(|error| format!("Unable to inspect the selected publication: {error}"))?
        .len();
    let mut header = [0_u8; 1024];
    let header_size = file
        .read(&mut header)
        .map_err(|error| format!("Unable to inspect the selected publication: {error}"))?;
    let header = &header[..header_size];

    if header.starts_with(b"PK\x03\x04") {
        return Ok((PublicationKind::Epub, size));
    }
    if header.windows(5).any(|window| window == b"%PDF-") {
        return Ok((PublicationKind::Pdf, size));
    }

    Err("The selected file is not a valid EPUB or PDF publication".to_owned())
}

fn publication_name(path: &FilePath, kind: PublicationKind) -> String {
    let candidate = match path {
        FilePath::Path(path) => path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()),
        FilePath::Url(url) => url
            .path_segments()
            .and_then(|mut segments| segments.next_back())
            .filter(|name| !name.is_empty())
            .map(str::to_owned),
    };
    let fallback = format!("Imported publication.{}", kind.extension());
    let candidate = candidate.unwrap_or(fallback);

    if candidate
        .to_ascii_lowercase()
        .ends_with(&format!(".{}", kind.extension()))
    {
        candidate
    } else {
        format!("{candidate}.{}", kind.extension())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sync_broker = sync_broker::SyncBroker::from_configured_origin()
        .unwrap_or_else(|_| sync_broker::SyncBroker::unavailable());
    let builder = tauri::Builder::default();
    // Tauri requires the single-instance plugin to be registered first so a
    // second process cannot initialize another window before forwarding its
    // publication arguments to the existing application.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        let arguments = args.into_iter().skip(1).collect::<Vec<_>>();
        let paths = desktop_argument_paths(arguments.iter().map(PathBuf::from), Path::new(&cwd));
        let urls = arguments
            .iter()
            .filter_map(|argument| tauri::Url::parse(argument).ok())
            .collect::<Vec<_>>();
        emit_opened_publications(app, paths);
        emit_opened_book_deep_links(app, urls.iter().cloned());
        native_handoff::emit_native_authorization_deep_links(app, urls);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PublicationSources::default())
        .manage(BookDeepLinks::default())
        .manage(BackupExports::default())
        .manage(native_handoff::NativeAuthorizationState::default())
        .manage(sync_broker);
    #[cfg(all(desktop, feature = "native-e2e"))]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    let builder = builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                let paths = startup_publication_paths();
                let _ = register_opened_publications(app.handle(), paths);
                let urls = startup_book_deep_links();
                let _ = register_book_deep_links(app.handle(), urls.iter().cloned());
                native_handoff::emit_native_authorization_deep_links(app.handle(), urls);
            }
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            app.deep_link().register_all()?;
            if let Some(urls) = app.deep_link().get_current()? {
                let _ = register_book_deep_links(app.handle(), urls.iter().cloned());
                native_handoff::emit_native_authorization_deep_links(app.handle(), urls);
            }
            let deep_link_app = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                emit_opened_book_deep_links(&deep_link_app, urls.iter().cloned());
                native_handoff::emit_native_authorization_deep_links(
                    &deep_link_app,
                    urls.iter().cloned(),
                );
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                emit_opened_publications(
                    window.app_handle(),
                    paths.iter().cloned().map(FilePath::Path),
                );
            }
        })
        .invoke_handler(tauri::generate_handler![
            begin_backup_export,
            cancel_backup_export,
            commit_backup_export,
            pick_publications,
            read_publication,
            native_handoff::sync_authorization_begin,
            native_handoff::sync_authorization_cancel,
            sync_broker::sync_broker_status,
            sync_broker::sync_cancel_request,
            sync_broker::sync_delete_document,
            sync_broker::sync_delete_entries,
            sync_broker::sync_delete_entry,
            sync_broker::sync_delete_object,
            sync_broker::sync_destination_revision,
            sync_broker::sync_download_begin,
            sync_broker::sync_download_chunk,
            sync_broker::sync_download_finish,
            sync_broker::sync_github_create_repository,
            sync_broker::sync_github_disconnect,
            sync_broker::sync_github_repositories,
            sync_broker::sync_github_select_repository,
            sync_broker::sync_github_session,
            sync_broker::sync_head_object,
            sync_broker::sync_list_documents,
            sync_broker::sync_list_entries,
            sync_broker::sync_mega_disconnect,
            sync_broker::sync_mega_folders,
            sync_broker::sync_mega_select_folder,
            sync_broker::sync_mega_session,
            sync_broker::sync_read_document,
            sync_broker::sync_teardown,
            sync_broker::sync_upload_begin,
            sync_broker::sync_upload_chunk,
            sync_broker::sync_upload_finish,
            sync_broker::sync_write_document,
            take_opened_book_deep_links,
            take_opened_publications,
            write_backup_chunk
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Omnia Reader");

    builder.run(|_app, _event| {
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        if let tauri::RunEvent::Opened { urls } = _event {
            emit_opened_book_deep_links(_app, urls.iter().cloned());
            native_handoff::emit_native_authorization_deep_links(_app, urls.iter().cloned());
            emit_opened_publications(_app, urls.into_iter().map(FilePath::Url));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{deep_link_book_id, desktop_argument_paths, safe_backup_file_name, FilePath, Uuid};
    use std::fs::{create_dir_all, remove_dir_all, write};
    use std::path::PathBuf;

    #[test]
    fn backup_file_names_are_confined_and_normalized() {
        assert_eq!(
            safe_backup_file_name("library").unwrap(),
            "library.omnia-backup"
        );
        assert_eq!(
            safe_backup_file_name("library.omnia-backup").unwrap(),
            "library.omnia-backup"
        );
        assert!(safe_backup_file_name("../library").is_err());
        assert!(safe_backup_file_name("folder\\library").is_err());
        assert!(safe_backup_file_name("\n").is_err());
    }

    #[test]
    fn book_deep_links_accept_only_exact_local_edition_routes() {
        let uppercase_id = "A".repeat(64);
        let valid = tauri::Url::parse(&format!("omnia-reader://reader/{uppercase_id}")).unwrap();
        assert_eq!(
            deep_link_book_id(&valid),
            Some(format!("sha256:{}", "a".repeat(64)))
        );

        for invalid in [
            "https://reader/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "omnia-reader://settings/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "omnia-reader://reader/not-a-sha256",
            "omnia-reader://reader/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/extra",
            "omnia-reader://reader/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?locator=1",
            "omnia-reader://reader/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#fragment",
        ] {
            assert_eq!(
                deep_link_book_id(&tauri::Url::parse(invalid).unwrap()),
                None
            );
        }
    }

    #[test]
    fn desktop_publication_arguments_accept_paths_and_file_urls_only() {
        let fixture_directory =
            std::env::temp_dir().join(format!("omnia-reader-arguments-{}", Uuid::new_v4()));
        create_dir_all(&fixture_directory).unwrap();
        let fixture = fixture_directory.join("publication with spaces.epub");
        write(&fixture, b"PK\x03\x04").unwrap();
        let file_url = tauri::Url::from_file_path(&fixture).unwrap();

        let resolved = desktop_argument_paths(
            [
                PathBuf::from("publication with spaces.epub"),
                PathBuf::from(file_url.as_str()),
                PathBuf::from("https://example.com/publication.epub"),
                PathBuf::from("missing.pdf"),
            ],
            &fixture_directory,
        );

        assert_eq!(resolved.len(), 2);
        for path in resolved {
            match path {
                FilePath::Path(path) => assert_eq!(path, fixture),
                FilePath::Url(_) => panic!("desktop arguments must resolve to local paths"),
            }
        }
        remove_dir_all(fixture_directory).unwrap();
    }
}
