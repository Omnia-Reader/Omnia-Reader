use super::*;
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    thread,
    time::Duration,
};

const SECRET_CANARY: &str = "omnia-native-secret-canary-4c197a";

#[derive(Debug)]
struct CapturedRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Clone)]
struct TestResponse {
    status: &'static str,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    delay: Duration,
}

impl TestResponse {
    fn json(body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: "200 OK",
            headers: vec![("Content-Type".to_owned(), "application/json".to_owned())],
            body: body.into(),
            delay: Duration::ZERO,
        }
    }
}

#[test]
fn origins_are_exact_and_production_safe() {
    let broker = SyncBroker::from_origin("https://sync.example.test", false).unwrap();
    assert_eq!(
        serde_json::to_value(broker.status().unwrap()).unwrap(),
        serde_json::json!({
            "gatewayOrigin": "https://sync.example.test",
            "persistenceMode": "session-only",
            "persistenceVersion": null,
            "restartRequiresReauthentication": true,
        })
    );
    for invalid in [
        "http://sync.example.test",
        "https://sync.example.test/",
        "https://user@sync.example.test",
        "https://sync.example.test/path",
        "https://sync.example.test?query=1",
        "https://sync.example.test#fragment",
        "https://127.0.0.1",
        "https://10.0.0.1",
    ] {
        assert!(
            SyncBroker::from_origin(invalid, false).is_err(),
            "accepted {invalid}"
        );
    }
    assert!(SyncBroker::from_origin("http://127.0.0.1:43123", true).is_ok());

    let unavailable = SyncBroker::unavailable();
    assert_eq!(
        unavailable.status().unwrap_err().code,
        "transport-unavailable"
    );
}

#[test]
fn paths_and_request_identifiers_are_confined() {
    assert!(validate_prefix(".omnia-reader").is_ok());
    assert!(validate_path(".omnia-reader/books/book.pdf").is_ok());
    assert!(validate_request_id("webview-1").is_ok());
    for invalid in [
        "../secret",
        ".omnia-reader/../secret",
        ".omnia-reader//book.pdf",
        ".omnia-reader/%2fsecret",
        ".omnia-reader/book\\name.pdf",
    ] {
        assert!(validate_path(invalid).is_err(), "accepted {invalid}");
    }
    assert!(validate_request_id("request/other").is_err());
}

#[test]
fn raw_upload_chunk_metadata_is_narrow_and_canonical() {
    let mut headers = HeaderMap::new();
    headers.insert(
        SYNC_REQUEST_ID_HEADER,
        HeaderValue::from_static("webview-1"),
    );
    headers.insert(SYNC_PROVIDER_HEADER, HeaderValue::from_static("git"));
    headers.insert(
        SYNC_TRANSFER_ID_HEADER,
        HeaderValue::from_static("transfer-12345678"),
    );
    headers.insert(SYNC_OFFSET_HEADER, HeaderValue::from_static("16384"));

    let metadata = upload_chunk_metadata(&headers).unwrap();
    assert_eq!(metadata.request_id, "webview-1");
    assert_eq!(metadata.provider, Provider::Git);
    assert_eq!(metadata.transfer_id, "transfer-12345678");
    assert_eq!(metadata.offset, 16_384);

    headers.insert(SYNC_OFFSET_HEADER, HeaderValue::from_static("016384"));
    assert!(upload_chunk_metadata(&headers).is_err());
    headers.insert(SYNC_OFFSET_HEADER, HeaderValue::from_static("16384"));
    headers.insert(
        "x-omnia-sync-forwarded-host",
        HeaderValue::from_static("attacker.invalid"),
    );
    assert!(upload_chunk_metadata(&headers).is_err());
}

#[test]
fn raw_upload_chunks_are_bounded_before_transfer_lookup() {
    assert!(validate_upload_chunk_bytes(&[1]).is_ok());
    assert!(validate_upload_chunk_bytes(&[]).is_err());
    assert!(validate_upload_chunk_bytes(&vec![0; MAX_IPC_CHUNK_BYTES + 1]).is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cookies_stay_opaque_and_request_headers_are_broker_owned() {
    let document = serde_json::json!({
        "path": ".omnia-reader/manifest.json",
        "content": "{}",
        "revision": "revision-1"
    });
    let (origin, requests, server) = spawn_server(2, move |index, _request| {
        if index == 0 {
            let mut response = TestResponse::json(serde_json::to_vec(&document).unwrap());
            response.headers.push((
                "Set-Cookie".to_owned(),
                format!("omnia_session={SECRET_CANARY}; HttpOnly; SameSite=Strict; Path=/"),
            ));
            response
        } else {
            TestResponse {
                status: "401 Unauthorized",
                headers: vec![("Content-Type".to_owned(), "application/json".to_owned())],
                body: format!(r#"{{"message":"{SECRET_CANARY}"}}"#).into_bytes(),
                delay: Duration::ZERO,
            }
        }
    });
    let broker = SyncBroker::from_origin(&origin, true).unwrap();
    let write = DocumentWriteRequest {
        path: ".omnia-reader/manifest.json".to_owned(),
        content: "{}".to_owned(),
        expected_revision: None,
        message: "Update manifest".to_owned(),
    };
    let builder = broker
        .request(Method::PUT, Provider::Git, "/file", &[])
        .unwrap()
        .json(&write);
    let (_, returned): (_, RemoteDocument) = broker
        .json("headers-1", builder, &[], MAX_DOCUMENT_BYTES)
        .await
        .unwrap();
    assert!(!serde_json::to_string(&returned)
        .unwrap()
        .contains(SECRET_CANARY));

    let builder = broker
        .request(Method::GET, Provider::Git, "/revision", &[])
        .unwrap();
    let error = broker
        .buffered_response("headers-2", builder, &[], ERROR_BODY_BYTES)
        .await
        .unwrap_err();
    assert_eq!(error.code, "authentication-required");
    assert!(!serde_json::to_string(&error)
        .unwrap()
        .contains(SECRET_CANARY));

    server.join().unwrap();
    let requests = requests.lock().unwrap();
    let mutation = &requests[0];
    assert_eq!(mutation.method, "PUT");
    assert_eq!(mutation.path, "/api/sync/github/file");
    assert_eq!(mutation.headers.get("x-omnia-csrf").unwrap(), "1");
    assert_eq!(mutation.headers.get("origin").unwrap(), &origin);
    assert_eq!(mutation.headers.get("accept").unwrap(), "application/json");
    assert!(mutation.headers.get("authorization").is_none());
    assert!(mutation.headers.get("x-forwarded-host").is_none());
    assert_eq!(mutation.body, serde_json::to_vec(&write).unwrap());
    assert!(requests[1]
        .headers
        .get("cookie")
        .is_some_and(|value| value.contains(SECRET_CANARY)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_operations_are_provider_scoped_typed_and_cookie_owned() {
    let repository = serde_json::json!({
        "id": 7,
        "fullName": "reader/library",
        "private": true,
        "defaultBranch": "main",
        "canPush": true
    });
    let github_session = serde_json::json!({
        "configured": true,
        "authenticated": true,
        "installationUrl": "https://github.test/apps/omnia-reader",
        "user": {
            "id": 42,
            "login": "reader",
            "avatarUrl": "https://avatars.test/reader.png"
        },
        "repository": null
    });
    let selected_github_session = serde_json::json!({
        "configured": true,
        "authenticated": true,
        "installationUrl": "https://github.test/apps/omnia-reader",
        "user": {
            "id": 42,
            "login": "reader",
            "avatarUrl": "https://avatars.test/reader.png"
        },
        "repository": repository.clone()
    });
    let mega_folder = serde_json::json!({
        "handle": "folder-1",
        "name": "Omnia Reader",
        "path": "/Omnia Reader",
        "canWrite": true
    });
    let responses = vec![
        TestResponse {
            status: "200 OK",
            headers: vec![
                ("Content-Type".to_owned(), "application/json".to_owned()),
                (
                    "Set-Cookie".to_owned(),
                    format!("omnia_sync_github={SECRET_CANARY}; HttpOnly; Path=/"),
                ),
            ],
            body: serde_json::to_vec(&github_session).unwrap(),
            delay: Duration::ZERO,
        },
        TestResponse::json(
            serde_json::to_vec(&serde_json::json!({ "repositories": [repository.clone()] }))
                .unwrap(),
        ),
        TestResponse::json(serde_json::to_vec(&selected_github_session).unwrap()),
        TestResponse::json(
            serde_json::to_vec(&serde_json::json!({
                "repository": repository,
                "selected": true,
                "session": selected_github_session.clone(),
                "installationSettingsUrl": null
            }))
            .unwrap(),
        ),
        TestResponse {
            status: "204 No Content",
            headers: Vec::new(),
            body: Vec::new(),
            delay: Duration::ZERO,
        },
        TestResponse::json(
            serde_json::to_vec(&serde_json::json!({
                "authenticated": true,
                "account": "reader@example.test",
                "folder": null
            }))
            .unwrap(),
        ),
        TestResponse::json(
            serde_json::to_vec(&serde_json::json!({ "folders": [mega_folder.clone()] })).unwrap(),
        ),
        TestResponse::json(
            serde_json::to_vec(&serde_json::json!({
                "authenticated": true,
                "account": "reader@example.test",
                "folder": mega_folder
            }))
            .unwrap(),
        ),
        TestResponse {
            status: "204 No Content",
            headers: Vec::new(),
            body: Vec::new(),
            delay: Duration::ZERO,
        },
    ];
    let (origin, requests, server) =
        spawn_server(9, move |index, _request| responses[index].clone());
    let broker = SyncBroker::from_origin(&origin, true).unwrap();

    assert!(
        broker
            .github_session("settings-1")
            .await
            .unwrap()
            .authenticated
    );
    assert_eq!(
        broker.github_repositories("settings-2").await.unwrap()[0].id,
        7
    );
    assert!(broker
        .github_select_repository("settings-3", 7)
        .await
        .unwrap()
        .repository
        .is_some());
    assert!(
        broker
            .github_create_repository("settings-4", "omnia-reader-library")
            .await
            .unwrap()
            .selected
    );
    broker
        .disconnect_provider("settings-5", Provider::Git)
        .await
        .unwrap();
    assert!(
        broker
            .mega_session("settings-6")
            .await
            .unwrap()
            .authenticated
    );
    assert_eq!(broker.mega_folders("settings-7").await.unwrap().len(), 1);
    assert!(broker
        .mega_select_folder("settings-8", "folder-1")
        .await
        .unwrap()
        .folder
        .is_some());
    broker
        .disconnect_provider("settings-9", Provider::Mega)
        .await
        .unwrap();

    server.join().unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .map(|request| (request.method.as_str(), request.path.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("GET", "/api/sync/github/session"),
            ("GET", "/api/sync/github/repositories"),
            ("PUT", "/api/sync/github/repository"),
            ("POST", "/api/sync/github/repository"),
            ("DELETE", "/api/sync/github/session"),
            ("GET", "/api/sync/mega/session"),
            ("GET", "/api/sync/mega/folders"),
            ("PUT", "/api/sync/mega/folder"),
            ("DELETE", "/api/sync/mega/session"),
        ]
    );
    assert_eq!(requests[2].body, br#"{"repositoryId":7}"#.to_vec());
    assert_eq!(
        requests[3].body,
        br#"{"name":"omnia-reader-library"}"#.to_vec()
    );
    assert_eq!(requests[7].body, br#"{"handle":"folder-1"}"#.to_vec());
    for request in requests.iter().filter(|request| request.method != "GET") {
        assert_eq!(request.headers.get("x-omnia-csrf").unwrap(), "1");
    }
    assert!(requests[1]
        .headers
        .get("cookie")
        .is_some_and(|value| value.contains(SECRET_CANARY)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_responses_are_validated_before_crossing_ipc() {
    let (origin, _requests, server) = spawn_server(1, |_index, _request| {
        TestResponse::json(
            format!(
                r#"{{"configured":true,"authenticated":false,"installationUrl":"https://user:{SECRET_CANARY}@github.test/apps/omnia-reader"}}"#
            )
            .into_bytes(),
        )
    });
    let broker = SyncBroker::from_origin(&origin, true).unwrap();
    let error = broker.github_session("settings-invalid").await.unwrap_err();
    assert_eq!(error.code, "invalid-response");
    assert!(!serde_json::to_string(&error)
        .unwrap()
        .contains(SECRET_CANARY));
    server.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redirects_are_denied_without_exposing_locations() {
    let (origin, _requests, server) = spawn_server(1, |_index, _request| TestResponse {
        status: "302 Found",
        headers: vec![(
            "Location".to_owned(),
            format!("https://attacker.invalid/{SECRET_CANARY}"),
        )],
        body: Vec::new(),
        delay: Duration::ZERO,
    });
    let broker = SyncBroker::from_origin(&origin, true).unwrap();
    let builder = broker
        .request(Method::GET, Provider::Git, "/revision", &[])
        .unwrap();
    let error = broker
        .buffered_response("redirect-1", builder, &[], ERROR_BODY_BYTES)
        .await
        .unwrap_err();
    assert_eq!(error.code, "redirect-denied");
    assert!(!serde_json::to_string(&error)
        .unwrap()
        .contains(SECRET_CANARY));
    server.join().unwrap();
}

#[test]
fn active_request_queue_is_bounded_and_reusable_after_cancellation() {
    let broker = SyncBroker::from_origin("http://127.0.0.1:43123", true).unwrap();
    for index in 0..MAX_ACTIVE_REQUESTS {
        broker.begin_request(&format!("bounded-{index}")).unwrap();
    }
    assert_eq!(
        broker.begin_request("bounded-overflow").unwrap_err().code,
        "transport-unavailable"
    );
    broker.cancel("bounded-0").unwrap();
    broker.begin_request("bounded-replacement").unwrap();
    broker.teardown().unwrap();
    assert!(broker.requests.lock().unwrap().is_empty());
}

#[test]
fn active_transfer_slots_are_atomic_and_bounded() {
    let broker = SyncBroker::from_origin("http://127.0.0.1:43123", true).unwrap();
    for _ in 0..MAX_ACTIVE_TRANSFERS {
        broker.reserve_transfer().unwrap();
    }
    assert_eq!(
        broker.reserve_transfer().unwrap_err().code,
        "transport-unavailable"
    );
    broker.release_transfer();
    broker.reserve_transfer().unwrap();
    assert_eq!(
        broker.active_transfers.load(Ordering::Acquire),
        MAX_ACTIVE_TRANSFERS
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn download_chunks_are_bounded_and_progress_is_monotonic() {
    let body = (0..(MAX_IPC_CHUNK_BYTES + 257))
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    let body_size = body.len() as u64;
    let (origin, _requests, server) = spawn_server(1, move |_index, _request| TestResponse {
        status: "200 OK",
        headers: vec![
            ("Content-Type".to_owned(), "application/pdf".to_owned()),
            ("X-Omnia-SHA256".to_owned(), "a".repeat(64)),
        ],
        body: body.clone(),
        delay: Duration::ZERO,
    });
    let broker = SyncBroker::from_origin(&origin, true).unwrap();
    let signal = broker.begin_request("stream-1").unwrap();
    let builder = broker
        .request(
            Method::GET,
            Provider::Git,
            Provider::Git.object_path(),
            &[("path", ".omnia-reader/books/book.pdf")],
        )
        .unwrap();
    let response = broker.send(builder, signal.clone(), &[]).await.unwrap();
    assert_eq!(response.content_length(), Some(body_size));
    let mut transfer = DownloadTransfer {
        request_id: "stream-1".to_owned(),
        provider: Provider::Git,
        response,
        pending: VecDeque::new(),
        transferred: 0,
        size: body_size,
    };
    let mut offsets = Vec::new();
    let mut collected = Vec::new();
    while transfer.transferred < transfer.size {
        let chunk = download_chunk(&mut transfer, 512 * 1024, signal.clone())
            .await
            .unwrap();
        assert!(!chunk.bytes.is_empty());
        assert!(chunk.bytes.len() <= 512 * 1024);
        collected.extend_from_slice(&chunk.bytes);
        offsets.push(transfer.transferred);
        assert_eq!(chunk.done, transfer.transferred == transfer.size);
        assert!(transfer.pending.len() <= MAX_IPC_CHUNK_BYTES);
    }
    assert!(offsets.windows(2).all(|values| values[0] < values[1]));
    assert_eq!(collected.len() as u64, body_size);
    broker.finish_request("stream-1");
    server.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn uploads_stream_from_private_files_with_only_allowlisted_headers() {
    let body = (0..(1024 * 1024 + 257))
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    let size = body.len() as u64;
    let sha256 = "b".repeat(64);
    let returned_sha256 = sha256.clone();
    let (origin, requests, server) = spawn_server(1, move |_index, _request| {
        TestResponse::json(
            serde_json::to_vec(&serde_json::json!({
                "path": ".omnia-reader/books/book.pdf",
                "revision": "uploaded-1",
                "size": size,
                "sha256": returned_sha256
            }))
            .unwrap(),
        )
    });
    let broker = SyncBroker::from_origin(&origin, true).unwrap();
    let signal = broker.begin_request("upload-http-1").unwrap();
    let file_id = Uuid::new_v4().simple().to_string();
    let path = std::env::temp_dir().join(format!("omnia-sync-test-{file_id}.part"));
    let mut file = create_private_upload_file(&path).unwrap();
    file.write_all(&body).unwrap();
    file.flush().unwrap();
    file.seek(SeekFrom::Start(0)).unwrap();
    let async_file = tokio::fs::File::from_std(file.try_clone().unwrap());
    let builder = broker
        .request(
            Method::PUT,
            Provider::Git,
            Provider::Git.object_path(),
            &[("path", ".omnia-reader/books/book.pdf")],
        )
        .unwrap()
        .header(CONTENT_TYPE, "application/pdf")
        .header(CONTENT_LENGTH, size)
        .header(SIZE_HEADER, size)
        .header(SHA256_HEADER, sha256.as_str())
        .body(reqwest::Body::from(async_file));
    let response = broker.send(builder, signal, &[]).await.unwrap();
    let response_body = bounded_body(response, MAX_DOCUMENT_BYTES, None)
        .await
        .unwrap();
    let object: RemoteObject = serde_json::from_slice(&response_body).unwrap();
    validate_object(&object).unwrap();
    broker.finish_request("upload-http-1");
    drop(file);
    std::fs::remove_file(path).unwrap();
    server.join().unwrap();

    let requests = requests.lock().unwrap();
    assert_eq!(requests[0].method, "PUT");
    assert_eq!(requests[0].body, body);
    assert_eq!(
        requests[0].headers.get("content-type").unwrap(),
        "application/pdf"
    );
    assert_eq!(
        requests[0].headers.get("x-omnia-size").unwrap(),
        &size.to_string()
    );
    assert_eq!(requests[0].headers.get("x-omnia-sha256").unwrap(), &sha256);
    assert!(requests[0].headers.get("authorization").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_drops_an_in_flight_http_request() {
    let (origin, received, server) = spawn_server(1, |_index, _request| TestResponse {
        status: "200 OK",
        headers: vec![("Content-Type".to_owned(), "application/json".to_owned())],
        body: br#"{"revision":"too-late"}"#.to_vec(),
        delay: Duration::from_millis(500),
    });
    let broker = Arc::new(SyncBroker::from_origin(&origin, true).unwrap());
    let operation_broker = broker.clone();
    let operation = tokio::spawn(async move {
        let builder = operation_broker
            .request(Method::GET, Provider::Git, "/revision", &[])
            .unwrap();
        operation_broker
            .buffered_response("cancel-1", builder, &[], ERROR_BODY_BYTES)
            .await
    });
    for _ in 0..100 {
        if !received.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    broker.cancel("cancel-1").unwrap();
    let error = operation.await.unwrap().unwrap_err();
    assert_eq!(error.code, "cancelled");
    assert!(broker.requests.lock().unwrap().is_empty());
    server.join().unwrap();
}

#[test]
fn cancellation_and_teardown_remove_temporary_uploads() {
    let broker = SyncBroker::from_origin("http://127.0.0.1:43123", true).unwrap();
    let first = insert_test_upload(&broker, "cleanup-1");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&first).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    broker.cancel("cleanup-1").unwrap();
    assert!(!first.exists());

    let second = insert_test_upload(&broker, "cleanup-2");
    broker.teardown().unwrap();
    assert!(!second.exists());
    assert!(broker.uploads.lock().unwrap().is_empty());
    assert!(broker.downloads.lock().unwrap().is_empty());
    assert!(broker.requests.lock().unwrap().is_empty());
    assert_eq!(broker.active_transfers.load(Ordering::Acquire), 0);
    assert_eq!(broker.status().unwrap_err().code, "transport-unavailable");
}

fn insert_test_upload(broker: &SyncBroker, request_id: &str) -> PathBuf {
    broker.reserve_transfer().unwrap();
    broker.begin_request(request_id).unwrap();
    let transfer_id = Uuid::new_v4().simple().to_string();
    let path = std::env::temp_dir().join(format!("omnia-sync-test-{transfer_id}.part"));
    let file = create_private_upload_file(&path).unwrap();
    broker.uploads.lock().unwrap().insert(
        transfer_id,
        UploadTransfer {
            request_id: request_id.to_owned(),
            provider: Provider::Git,
            path: ".omnia-reader/books/book.pdf".to_owned(),
            size: 1,
            sha256: "a".repeat(64),
            media_type: "application/pdf".to_owned(),
            file,
            temp_path: path.clone(),
            written: 0,
        },
    );
    path
}

fn spawn_server<F>(
    expected_requests: usize,
    handler: F,
) -> (
    String,
    Arc<Mutex<Vec<CapturedRequest>>>,
    thread::JoinHandle<()>,
)
where
    F: Fn(usize, &CapturedRequest) -> TestResponse + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let thread = thread::spawn(move || {
        for index in 0..expected_requests {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let request = read_request(&mut stream);
            let response = handler(index, &request);
            captured.lock().unwrap().push(request);
            if !response.delay.is_zero() {
                thread::sleep(response.delay);
            }
            write_response(&mut stream, response);
        }
    });
    (origin, requests, thread)
}

fn read_request(stream: &mut TcpStream) -> CapturedRequest {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    let header_end = loop {
        let read = stream.read(&mut buffer).unwrap();
        assert!(read > 0, "connection closed before HTTP headers");
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        assert!(bytes.len() <= 64 * 1024, "request headers were unbounded");
    };
    let header_text = std::str::from_utf8(&bytes[..header_end]).unwrap();
    let mut lines = header_text.split("\r\n");
    let mut request_line = lines.next().unwrap().split_whitespace();
    let method = request_line.next().unwrap().to_owned();
    let path = request_line.next().unwrap().to_owned();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
        .collect::<HashMap<_, _>>();
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    while bytes.len() - header_end < content_length {
        let read = stream.read(&mut buffer).unwrap();
        assert!(read > 0, "connection closed before HTTP body");
        bytes.extend_from_slice(&buffer[..read]);
    }
    CapturedRequest {
        method,
        path,
        headers,
        body: bytes[header_end..header_end + content_length].to_vec(),
    }
}

fn write_response(stream: &mut TcpStream, response: TestResponse) {
    let mut head = format!(
        "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.status,
        response.body.len()
    );
    for (name, value) in response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    if let Err(error) = stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(&response.body))
        .and_then(|_| stream.flush())
    {
        assert!(
            matches!(
                error.kind(),
                std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
            ),
            "unexpected test-server write failure: {error}"
        );
    }
}
