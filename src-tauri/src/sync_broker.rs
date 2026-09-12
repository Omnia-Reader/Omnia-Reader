use reqwest::{
    header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, ORIGIN, RETRY_AFTER},
    redirect::Policy,
    Client, Method, RequestBuilder, Response, StatusCode,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    io::{Seek, SeekFrom, Write},
    net::IpAddr,
    path::PathBuf,
    pin::Pin,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, MutexGuard,
    },
    task::{Context, Poll, Waker},
    time::Duration,
};
use tauri::{
    ipc::{InvokeBody, Request},
    State,
};
use url::Url;
use uuid::Uuid;

use crate::sync_session::{SessionPersistenceStatus, SyncSession};

const MAX_ACTIVE_REQUESTS: usize = 16;
const MAX_ACTIVE_TRANSFERS: usize = 8;
const MAX_IPC_CHUNK_BYTES: usize = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_LIST_BYTES: usize = 16 * 1024 * 1024;
const MAX_OBJECT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 50_000;
const MAX_DELETE_ENTRIES: usize = 10_000;
const ERROR_BODY_BYTES: usize = 16 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
const CSRF_HEADER: &str = "x-omnia-csrf";
const SHA256_HEADER: &str = "x-omnia-sha256";
const SIZE_HEADER: &str = "x-omnia-size";
const SYNC_REQUEST_ID_HEADER: &str = "x-omnia-sync-request-id";
const SYNC_PROVIDER_HEADER: &str = "x-omnia-sync-provider";
const SYNC_TRANSFER_ID_HEADER: &str = "x-omnia-sync-transfer-id";
const SYNC_OFFSET_HEADER: &str = "x-omnia-sync-offset";
const SYNC_HEADER_PREFIX: &str = "x-omnia-sync-";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Provider {
    Git,
    Mega,
}

impl Provider {
    pub(crate) fn ipc_name(self) -> &'static str {
        match self {
            Self::Git => "git",
            Self::Mega => "mega",
        }
    }

    fn base_path(self) -> &'static str {
        match self {
            Self::Git => "/api/sync/github",
            Self::Mega => "/api/sync/mega",
        }
    }

    fn documents_key(self) -> &'static str {
        match self {
            Self::Git => "files",
            Self::Mega => "documents",
        }
    }

    fn document_path(self) -> &'static str {
        match self {
            Self::Git => "/file",
            Self::Mega => "/document",
        }
    }

    fn documents_path(self) -> &'static str {
        match self {
            Self::Git => "/files",
            Self::Mega => "/documents",
        }
    }

    fn object_path(self) -> &'static str {
        match self {
            Self::Git => "/lfs/object",
            Self::Mega => "/object",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrokerError {
    code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_seconds: Option<u64>,
}

impl BrokerError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self {
            code,
            retry_after_seconds: None,
        }
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }

    fn rate_limited(seconds: Option<u64>) -> Self {
        Self {
            code: "rate-limited",
            retry_after_seconds: seconds.filter(|value| (1..=86_400).contains(value)),
        }
    }
}

pub(crate) type BrokerResult<T> = Result<T, BrokerError>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DocumentWriteRequest {
    path: String,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_revision: Option<String>,
    message: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DocumentDeleteRequest {
    path: String,
    expected_revision: Option<String>,
    message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EntryDeleteRequest {
    path: String,
    expected_revision: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ObjectDeleteRequest {
    path: String,
    expected_revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteDocument {
    path: String,
    content: String,
    revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteEntry {
    path: String,
    revision: String,
    kind: EntryKind,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum EntryKind {
    Document,
    Object,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteObject {
    path: String,
    revision: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrokerStatus {
    gateway_origin: String,
    #[serde(flatten)]
    session_persistence: SessionPersistenceStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeHandoffResponse {
    authenticated: bool,
    outcome: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GitHubUserResponse {
    id: u64,
    login: String,
    avatar_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GitHubRepositoryResponse {
    id: u64,
    full_name: String,
    private: bool,
    default_branch: String,
    can_push: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GitHubSessionResponse {
    configured: bool,
    authenticated: bool,
    installation_url: Option<String>,
    user: Option<GitHubUserResponse>,
    repository: Option<GitHubRepositoryResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitHubRepositoriesResponse {
    repositories: Vec<GitHubRepositoryResponse>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GitHubRepositoryCreationResponse {
    repository: GitHubRepositoryResponse,
    selected: bool,
    session: GitHubSessionResponse,
    installation_settings_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MegaFolderResponse {
    handle: String,
    name: String,
    path: String,
    can_write: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MegaSessionResponse {
    authenticated: bool,
    account: Option<String>,
    folder: Option<MegaFolderResponse>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MegaFoldersResponse {
    folders: Vec<MegaFolderResponse>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeAuthorizationOutcome {
    Authorized,
    Denied,
    Invalid,
    Failed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferStart {
    transfer_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    media_type: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct DownloadChunk {
    bytes: Vec<u8>,
    done: bool,
}

#[derive(Deserialize)]
struct DocumentsEnvelope {
    #[serde(default)]
    files: Option<Vec<RemoteDocument>>,
    #[serde(default)]
    documents: Option<Vec<RemoteDocument>>,
}

#[derive(Deserialize)]
struct EntriesEnvelope {
    entries: Vec<RemoteEntry>,
}

#[derive(Deserialize)]
struct RevisionEnvelope {
    revision: String,
}

#[derive(Debug)]
struct BufferedResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

struct DownloadTransfer {
    request_id: String,
    provider: Provider,
    response: Response,
    pending: VecDeque<u8>,
    transferred: u64,
    size: u64,
}

struct UploadTransfer {
    request_id: String,
    provider: Provider,
    path: String,
    size: u64,
    sha256: String,
    media_type: String,
    file: std::fs::File,
    temp_path: PathBuf,
    written: u64,
}

struct UploadChunkMetadata {
    request_id: String,
    provider: Provider,
    transfer_id: String,
    offset: u64,
}

impl UploadTransfer {
    fn cleanup(self) {
        let path = self.temp_path.clone();
        drop(self.file);
        let _ = std::fs::remove_file(path);
    }
}

#[derive(Debug, Default)]
struct CancellationSignal {
    cancelled: AtomicBool,
    waker: Mutex<Option<Waker>>,
}

impl CancellationSignal {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(mut waker) = self.waker.lock() {
            if let Some(waker) = waker.take() {
                waker.wake();
            }
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn register(&self, waker: &Waker) {
        if let Ok(mut stored) = self.waker.lock() {
            if match stored.as_ref() {
                Some(current) => !current.will_wake(waker),
                None => true,
            } {
                *stored = Some(waker.clone());
            }
        }
    }
}

struct Cancellable<F> {
    future: Pin<Box<F>>,
    signal: Arc<CancellationSignal>,
}

impl<F> Cancellable<F> {
    fn new(future: F, signal: Arc<CancellationSignal>) -> Self {
        Self {
            future: Box::pin(future),
            signal,
        }
    }
}

impl<F: Future> Future for Cancellable<F> {
    type Output = BrokerResult<F::Output>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        if self.signal.is_cancelled() {
            return Poll::Ready(Err(BrokerError::new("cancelled")));
        }
        self.signal.register(context.waker());
        if self.signal.is_cancelled() {
            return Poll::Ready(Err(BrokerError::new("cancelled")));
        }
        self.future.as_mut().poll(context).map(Ok)
    }
}

pub(crate) struct SyncBroker {
    origin: Url,
    origin_header: HeaderValue,
    client: Mutex<Client>,
    session: SyncSession,
    requests: Mutex<HashMap<String, Arc<CancellationSignal>>>,
    downloads: Mutex<HashMap<String, DownloadTransfer>>,
    uploads: Mutex<HashMap<String, UploadTransfer>>,
    active_transfers: AtomicUsize,
    closed: AtomicBool,
}

impl SyncBroker {
    pub(crate) fn from_configured_origin() -> BrokerResult<Self> {
        let configured = option_env!("OMNIA_SYNC_GATEWAY_ORIGIN")
            .map(str::to_owned)
            .or_else(|| std::env::var("OMNIA_SYNC_GATEWAY_ORIGIN").ok())
            .ok_or_else(|| BrokerError::new("transport-unavailable"))?;
        Self::from_origin(&configured, cfg!(debug_assertions))
    }

    pub(crate) fn unavailable() -> Self {
        let broker = Self::from_origin("https://sync.invalid", false)
            .expect("the internal unavailable synchronization origin must be valid");
        broker.closed.store(true, Ordering::Release);
        broker
    }

    pub(crate) fn from_origin(value: &str, allow_insecure_loopback: bool) -> BrokerResult<Self> {
        let origin = exact_origin(value, allow_insecure_loopback)?;
        let origin_string = origin.origin().ascii_serialization();
        let origin_header = HeaderValue::from_str(&origin_string)
            .map_err(|_| BrokerError::new("origin-mismatch"))?;
        let session = SyncSession::session_only(origin.clone());
        let client = build_client(
            origin.scheme() == "https",
            session
                .jar()
                .map_err(|_| BrokerError::new("transport-unavailable"))?,
        )?;
        Ok(Self {
            origin,
            origin_header,
            client: Mutex::new(client),
            session,
            requests: Mutex::new(HashMap::new()),
            downloads: Mutex::new(HashMap::new()),
            uploads: Mutex::new(HashMap::new()),
            active_transfers: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
        })
    }

    fn status(&self) -> BrokerResult<BrokerStatus> {
        self.ensure_open()?;
        Ok(BrokerStatus {
            gateway_origin: self.origin.origin().ascii_serialization(),
            session_persistence: self
                .session
                .status()
                .map_err(|_| BrokerError::new("transport-unavailable"))?,
        })
    }

    pub(crate) fn native_authorization_url(
        &self,
        provider: Provider,
        request_id: &str,
    ) -> BrokerResult<String> {
        validate_request_id(request_id)?;
        Ok(self
            .url(provider, "/native/auth/start", &[("requestId", request_id)])?
            .to_string())
    }

    pub(crate) async fn redeem_native_authorization(
        &self,
        provider: Provider,
        request_id: &str,
        handoff_id: &str,
    ) -> BrokerResult<NativeAuthorizationOutcome> {
        validate_request_id(request_id)?;
        if handoff_id.len() != 43
            || !handoff_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(BrokerError::new("authentication-required"));
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Redemption<'a> {
            handoff_id: &'a str,
            native_request_id: &'a str,
        }

        let builder = self
            .request(Method::POST, provider, "/native/auth/redeem", &[])?
            .json(&Redemption {
                handoff_id,
                native_request_id: request_id,
            });
        let broker_request_id = format!("native-handoff-{}", Uuid::new_v4());
        let (_, response): (_, NativeHandoffResponse) = self
            .json(&broker_request_id, builder, &[], MAX_DOCUMENT_BYTES)
            .await?;
        match (response.authenticated, response.outcome.as_deref()) {
            (true, None) => Ok(NativeAuthorizationOutcome::Authorized),
            (false, Some("denied")) => Ok(NativeAuthorizationOutcome::Denied),
            (false, Some("invalid")) => Ok(NativeAuthorizationOutcome::Invalid),
            (false, Some("failed")) => Ok(NativeAuthorizationOutcome::Failed),
            _ => Err(BrokerError::new("invalid-response")),
        }
    }

    async fn github_session(&self, request_id: &str) -> BrokerResult<GitHubSessionResponse> {
        let builder = self.request(Method::GET, Provider::Git, "/session", &[])?;
        let (_, value): (_, GitHubSessionResponse) = self
            .json(request_id, builder, &[], MAX_DOCUMENT_BYTES)
            .await?;
        validate_github_session(&value)?;
        Ok(value)
    }

    async fn github_repositories(
        &self,
        request_id: &str,
    ) -> BrokerResult<Vec<GitHubRepositoryResponse>> {
        let builder = self.request(Method::GET, Provider::Git, "/repositories", &[])?;
        let (_, value): (_, GitHubRepositoriesResponse) =
            self.json(request_id, builder, &[], MAX_LIST_BYTES).await?;
        if value.repositories.len() > MAX_LIST_ENTRIES {
            return Err(BrokerError::new("invalid-response"));
        }
        for repository in &value.repositories {
            validate_github_repository(repository)?;
        }
        Ok(value.repositories)
    }

    async fn github_select_repository(
        &self,
        request_id: &str,
        repository_id: u64,
    ) -> BrokerResult<GitHubSessionResponse> {
        validate_positive_safe_integer(repository_id)?;
        let builder = self
            .request(Method::PUT, Provider::Git, "/repository", &[])?
            .json(&serde_json::json!({ "repositoryId": repository_id }));
        let (_, value): (_, GitHubSessionResponse) = self
            .json(request_id, builder, &[], MAX_DOCUMENT_BYTES)
            .await?;
        validate_github_session(&value)?;
        Ok(value)
    }

    async fn github_create_repository(
        &self,
        request_id: &str,
        name: &str,
    ) -> BrokerResult<GitHubRepositoryCreationResponse> {
        validate_repository_name(name)?;
        let builder = self
            .request(Method::POST, Provider::Git, "/repository", &[])?
            .json(&serde_json::json!({ "name": name }));
        let (_, value): (_, GitHubRepositoryCreationResponse) = self
            .json(request_id, builder, &[], MAX_DOCUMENT_BYTES)
            .await?;
        validate_github_repository(&value.repository)?;
        validate_github_session(&value.session)?;
        if let Some(url) = value.installation_settings_url.as_deref() {
            validate_external_https_url(url)?;
        }
        Ok(value)
    }

    async fn mega_session(&self, request_id: &str) -> BrokerResult<MegaSessionResponse> {
        let builder = self.request(Method::GET, Provider::Mega, "/session", &[])?;
        let (_, value): (_, MegaSessionResponse) = self
            .json(request_id, builder, &[], MAX_DOCUMENT_BYTES)
            .await?;
        validate_mega_session(&value)?;
        Ok(value)
    }

    async fn mega_folders(&self, request_id: &str) -> BrokerResult<Vec<MegaFolderResponse>> {
        let builder = self.request(Method::GET, Provider::Mega, "/folders", &[])?;
        let (_, value): (_, MegaFoldersResponse) =
            self.json(request_id, builder, &[], MAX_LIST_BYTES).await?;
        if value.folders.len() > MAX_LIST_ENTRIES {
            return Err(BrokerError::new("invalid-response"));
        }
        for folder in &value.folders {
            validate_mega_folder(folder)?;
        }
        Ok(value.folders)
    }

    async fn mega_select_folder(
        &self,
        request_id: &str,
        handle: &str,
    ) -> BrokerResult<MegaSessionResponse> {
        validate_bounded_string(handle, 1024)?;
        let builder = self
            .request(Method::PUT, Provider::Mega, "/folder", &[])?
            .json(&serde_json::json!({ "handle": handle }));
        let (_, value): (_, MegaSessionResponse) = self
            .json(request_id, builder, &[], MAX_DOCUMENT_BYTES)
            .await?;
        validate_mega_session(&value)?;
        Ok(value)
    }

    async fn disconnect_provider(&self, request_id: &str, provider: Provider) -> BrokerResult<()> {
        let builder = self.request(Method::DELETE, provider, "/session", &[])?;
        self.buffered_response(request_id, builder, &[], 0).await?;
        Ok(())
    }

    fn ensure_open(&self) -> BrokerResult<()> {
        if self.closed.load(Ordering::Acquire) {
            Err(BrokerError::new("transport-unavailable"))
        } else {
            Ok(())
        }
    }

    fn client(&self) -> BrokerResult<Client> {
        Ok(lock(&self.client)?.clone())
    }

    fn persist_session(&self) -> BrokerResult<()> {
        if self.session.persist(unix_time_ms()).is_ok() {
            return Ok(());
        }
        *lock(&self.client)? = build_client(
            self.origin.scheme() == "https",
            self.session
                .jar()
                .map_err(|_| BrokerError::new("transport-unavailable"))?,
        )?;
        Err(BrokerError::new("transport-unavailable"))
    }

    fn url(&self, provider: Provider, suffix: &str, query: &[(&str, &str)]) -> BrokerResult<Url> {
        self.ensure_open()?;
        let mut url = self.origin.clone();
        url.set_path(&format!("{}{}", provider.base_path(), suffix));
        if query.is_empty() {
            url.set_query(None);
        } else {
            let mut pairs = url.query_pairs_mut();
            pairs.clear();
            for (name, value) in query {
                pairs.append_pair(name, value);
            }
        }
        Ok(url)
    }

    fn request(
        &self,
        method: Method,
        provider: Provider,
        suffix: &str,
        query: &[(&str, &str)],
    ) -> BrokerResult<RequestBuilder> {
        let mut builder = self
            .client()?
            .request(method.clone(), self.url(provider, suffix, query)?)
            .header(ACCEPT, "application/json")
            .header(ORIGIN, self.origin_header.clone());
        if method != Method::GET && method != Method::HEAD {
            builder = builder.header(CSRF_HEADER, "1");
        }
        Ok(builder)
    }

    fn begin_request(&self, request_id: &str) -> BrokerResult<Arc<CancellationSignal>> {
        self.ensure_open()?;
        validate_request_id(request_id)?;
        let mut requests = lock(&self.requests)?;
        if requests.len() >= MAX_ACTIVE_REQUESTS || requests.contains_key(request_id) {
            return Err(BrokerError::new("transport-unavailable"));
        }
        let signal = Arc::new(CancellationSignal::default());
        requests.insert(request_id.to_owned(), signal.clone());
        Ok(signal)
    }

    fn request_signal(&self, request_id: &str) -> BrokerResult<Arc<CancellationSignal>> {
        validate_request_id(request_id)?;
        lock(&self.requests)?
            .get(request_id)
            .cloned()
            .ok_or_else(|| BrokerError::new("cancelled"))
    }

    fn finish_request(&self, request_id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(request_id);
        }
    }

    fn reserve_transfer(&self) -> BrokerResult<()> {
        self.ensure_open()?;
        self.active_transfers
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < MAX_ACTIVE_TRANSFERS).then_some(current + 1)
            })
            .map(|_| ())
            .map_err(|_| BrokerError::new("transport-unavailable"))
    }

    fn release_transfer(&self) {
        let _ =
            self.active_transfers
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                    Some(current.saturating_sub(1))
                });
    }

    async fn run<F, T>(&self, request_id: &str, future: F) -> BrokerResult<T>
    where
        F: Future<Output = BrokerResult<T>>,
    {
        let signal = self.begin_request(request_id)?;
        let result = match Cancellable::new(future, signal).await {
            Ok(result) => result,
            Err(error) => Err(error),
        };
        self.finish_request(request_id);
        result
    }

    async fn send(
        &self,
        builder: RequestBuilder,
        signal: Arc<CancellationSignal>,
        allowed: &[StatusCode],
    ) -> BrokerResult<Response> {
        let response = match Cancellable::new(builder.send(), signal).await? {
            Ok(response) => response,
            Err(error) => return Err(request_error(&error)),
        };
        if response.url().origin() != self.origin.origin() {
            return Err(BrokerError::new("redirect-denied"));
        }
        let status = response.status();
        if status.is_redirection() {
            return Err(BrokerError::new("redirect-denied"));
        }
        self.persist_session()?;
        if !status.is_success() && !allowed.contains(&status) {
            return Err(status_error(status, response.headers()));
        }
        Ok(response)
    }

    async fn buffered_response(
        &self,
        request_id: &str,
        builder: RequestBuilder,
        allowed: &[StatusCode],
        maximum: usize,
    ) -> BrokerResult<BufferedResponse> {
        self.run(request_id, async {
            let signal = self.request_signal(request_id)?;
            let response = self.send(builder, signal.clone(), allowed).await?;
            let status = response.status();
            let headers = response.headers().clone();
            let body = bounded_body(response, maximum, Some(signal)).await?;
            Ok(BufferedResponse {
                status,
                headers,
                body,
            })
        })
        .await
    }

    async fn json<T: DeserializeOwned>(
        &self,
        request_id: &str,
        builder: RequestBuilder,
        allowed: &[StatusCode],
        maximum: usize,
    ) -> BrokerResult<(StatusCode, T)> {
        let response = self
            .buffered_response(request_id, builder, allowed, maximum)
            .await?;
        ensure_json_content_type(&response.headers)?;
        let value = serde_json::from_slice(&response.body)
            .map_err(|_| BrokerError::new("invalid-response"))?;
        Ok((response.status, value))
    }

    fn cancel(&self, request_id: &str) -> BrokerResult<()> {
        validate_request_id(request_id)?;
        if let Some(signal) = lock(&self.requests)?.remove(request_id) {
            signal.cancel();
        }
        let removed_downloads = {
            let mut downloads = lock(&self.downloads)?;
            let before = downloads.len();
            downloads.retain(|_, transfer| transfer.request_id != request_id);
            before - downloads.len()
        };
        let removed = {
            let mut uploads = lock(&self.uploads)?;
            let ids = uploads
                .iter()
                .filter_map(|(id, transfer)| {
                    (transfer.request_id == request_id).then_some(id.clone())
                })
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| uploads.remove(&id))
                .collect::<Vec<_>>()
        };
        for _ in 0..removed_downloads + removed.len() {
            self.release_transfer();
        }
        for transfer in removed {
            transfer.cleanup();
        }
        Ok(())
    }

    fn teardown(&self) -> BrokerResult<()> {
        if self.closed.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let signals = std::mem::take(&mut *lock(&self.requests)?);
        for signal in signals.values() {
            signal.cancel();
        }
        lock(&self.downloads)?.clear();
        let uploads = std::mem::take(&mut *lock(&self.uploads)?);
        for transfer in uploads.into_values() {
            transfer.cleanup();
        }
        self.active_transfers.store(0, Ordering::Release);
        self.session
            .drop_process_authority()
            .map_err(|_| BrokerError::new("transport-unavailable"))?;
        *lock(&self.client)? = build_client(
            self.origin.scheme() == "https",
            self.session
                .jar()
                .map_err(|_| BrokerError::new("transport-unavailable"))?,
        )?;
        Ok(())
    }
}

impl Drop for SyncBroker {
    fn drop(&mut self) {
        if let Ok(uploads) = self.uploads.get_mut() {
            for transfer in std::mem::take(uploads).into_values() {
                transfer.cleanup();
            }
        }
    }
}

#[tauri::command]
pub(crate) fn sync_broker_status(broker: State<'_, SyncBroker>) -> BrokerResult<BrokerStatus> {
    broker.status()
}

#[tauri::command]
pub(crate) async fn sync_github_session(
    broker: State<'_, SyncBroker>,
    request_id: String,
) -> BrokerResult<GitHubSessionResponse> {
    broker.github_session(&request_id).await
}

#[tauri::command]
pub(crate) async fn sync_github_repositories(
    broker: State<'_, SyncBroker>,
    request_id: String,
) -> BrokerResult<Vec<GitHubRepositoryResponse>> {
    broker.github_repositories(&request_id).await
}

#[tauri::command]
pub(crate) async fn sync_github_select_repository(
    broker: State<'_, SyncBroker>,
    request_id: String,
    repository_id: u64,
) -> BrokerResult<GitHubSessionResponse> {
    broker
        .github_select_repository(&request_id, repository_id)
        .await
}

#[tauri::command]
pub(crate) async fn sync_github_create_repository(
    broker: State<'_, SyncBroker>,
    request_id: String,
    name: String,
) -> BrokerResult<GitHubRepositoryCreationResponse> {
    broker.github_create_repository(&request_id, &name).await
}

#[tauri::command]
pub(crate) async fn sync_github_disconnect(
    broker: State<'_, SyncBroker>,
    request_id: String,
) -> BrokerResult<()> {
    broker.disconnect_provider(&request_id, Provider::Git).await
}

#[tauri::command]
pub(crate) async fn sync_mega_session(
    broker: State<'_, SyncBroker>,
    request_id: String,
) -> BrokerResult<MegaSessionResponse> {
    broker.mega_session(&request_id).await
}

#[tauri::command]
pub(crate) async fn sync_mega_folders(
    broker: State<'_, SyncBroker>,
    request_id: String,
) -> BrokerResult<Vec<MegaFolderResponse>> {
    broker.mega_folders(&request_id).await
}

#[tauri::command]
pub(crate) async fn sync_mega_select_folder(
    broker: State<'_, SyncBroker>,
    request_id: String,
    handle: String,
) -> BrokerResult<MegaSessionResponse> {
    broker.mega_select_folder(&request_id, &handle).await
}

#[tauri::command]
pub(crate) async fn sync_mega_disconnect(
    broker: State<'_, SyncBroker>,
    request_id: String,
) -> BrokerResult<()> {
    broker
        .disconnect_provider(&request_id, Provider::Mega)
        .await
}

#[tauri::command]
pub(crate) async fn sync_destination_revision(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
) -> BrokerResult<Option<String>> {
    if provider == Provider::Mega {
        broker.ensure_open()?;
        validate_request_id(&request_id)?;
        return Ok(None);
    }
    let builder = broker.request(Method::GET, provider, "/revision", &[])?;
    let (_, value): (_, RevisionEnvelope) = broker
        .json(&request_id, builder, &[], MAX_DOCUMENT_BYTES)
        .await?;
    validate_revision(&value.revision)?;
    Ok(Some(value.revision))
}

#[tauri::command]
pub(crate) async fn sync_list_documents(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
    prefix: String,
) -> BrokerResult<Vec<RemoteDocument>> {
    validate_prefix(&prefix)?;
    let builder = broker.request(
        Method::GET,
        provider,
        provider.documents_path(),
        &[("prefix", &prefix)],
    )?;
    let (_, envelope): (_, DocumentsEnvelope) = broker
        .json(&request_id, builder, &[], MAX_LIST_BYTES)
        .await?;
    let documents = match provider.documents_key() {
        "files" => envelope.files,
        _ => envelope.documents,
    }
    .ok_or_else(|| BrokerError::new("invalid-response"))?;
    validate_documents(&documents, &prefix)?;
    Ok(documents)
}

#[tauri::command]
pub(crate) async fn sync_list_entries(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
    prefix: String,
) -> BrokerResult<Vec<RemoteEntry>> {
    validate_prefix(&prefix)?;
    let builder = broker.request(Method::GET, provider, "/entries", &[("prefix", &prefix)])?;
    let (_, envelope): (_, EntriesEnvelope) = broker
        .json(&request_id, builder, &[], MAX_LIST_BYTES)
        .await?;
    validate_entries(&envelope.entries, &prefix)?;
    Ok(envelope.entries)
}

#[tauri::command]
pub(crate) async fn sync_delete_entries(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
    requests: Vec<EntryDeleteRequest>,
) -> BrokerResult<()> {
    if requests.len() > MAX_DELETE_ENTRIES {
        return Err(BrokerError::new("invalid-response"));
    }
    for request in &requests {
        validate_path(&request.path)?;
        validate_revision(&request.expected_revision)?;
    }
    let builder = broker
        .request(Method::DELETE, provider, "/entries", &[])?
        .json(&requests);
    let response = broker
        .buffered_response(
            &request_id,
            builder,
            &[StatusCode::CONFLICT],
            ERROR_BODY_BYTES,
        )
        .await?;
    if response.status == StatusCode::CONFLICT {
        return Err(BrokerError::new("conflict"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn sync_delete_entry(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
    request: EntryDeleteRequest,
) -> BrokerResult<()> {
    validate_path(&request.path)?;
    validate_revision(&request.expected_revision)?;
    let builder = broker.request(
        Method::DELETE,
        provider,
        "/entry",
        &[
            ("path", &request.path),
            ("expectedRevision", &request.expected_revision),
        ],
    )?;
    let response = broker
        .buffered_response(
            &request_id,
            builder,
            &[StatusCode::NOT_FOUND, StatusCode::CONFLICT],
            ERROR_BODY_BYTES,
        )
        .await?;
    if response.status == StatusCode::CONFLICT {
        return Err(BrokerError::new("conflict"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn sync_read_document(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
    path: String,
) -> BrokerResult<Option<RemoteDocument>> {
    validate_path(&path)?;
    let builder = broker.request(
        Method::GET,
        provider,
        provider.document_path(),
        &[("path", &path), ("optional", "true")],
    )?;
    let response = broker
        .buffered_response(
            &request_id,
            builder,
            &[StatusCode::NOT_FOUND],
            MAX_DOCUMENT_BYTES,
        )
        .await?;
    if matches!(
        response.status,
        StatusCode::NO_CONTENT | StatusCode::NOT_FOUND
    ) {
        return Ok(None);
    }
    ensure_json_content_type(&response.headers)?;
    let document: RemoteDocument =
        serde_json::from_slice(&response.body).map_err(|_| BrokerError::new("invalid-response"))?;
    validate_document(&document)?;
    if document.path != path {
        return Err(BrokerError::new("invalid-response"));
    }
    Ok(Some(document))
}

#[tauri::command]
pub(crate) async fn sync_write_document(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
    request: DocumentWriteRequest,
) -> BrokerResult<RemoteDocument> {
    validate_document_write(&request)?;
    let builder = broker
        .request(Method::PUT, provider, provider.document_path(), &[])?
        .json(&request);
    let response = broker
        .buffered_response(
            &request_id,
            builder,
            &[StatusCode::CONFLICT],
            MAX_DOCUMENT_BYTES,
        )
        .await?;
    if response.status == StatusCode::CONFLICT {
        return Err(BrokerError::new("conflict"));
    }
    ensure_json_content_type(&response.headers)?;
    let document: RemoteDocument =
        serde_json::from_slice(&response.body).map_err(|_| BrokerError::new("invalid-response"))?;
    validate_document(&document)?;
    if document.path != request.path || document.content != request.content {
        return Err(BrokerError::new("invalid-response"));
    }
    Ok(document)
}

#[tauri::command]
pub(crate) async fn sync_delete_document(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
    request: DocumentDeleteRequest,
) -> BrokerResult<()> {
    validate_document_delete(&request)?;
    let mut query = vec![
        ("path", request.path.as_str()),
        ("message", request.message.as_str()),
    ];
    if let Some(revision) = request.expected_revision.as_deref() {
        query.push(("expectedRevision", revision));
    }
    let builder = broker.request(Method::DELETE, provider, provider.document_path(), &query)?;
    let response = broker
        .buffered_response(
            &request_id,
            builder,
            &[StatusCode::NOT_FOUND, StatusCode::CONFLICT],
            ERROR_BODY_BYTES,
        )
        .await?;
    if response.status == StatusCode::CONFLICT {
        return Err(BrokerError::new("conflict"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn sync_head_object(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
    path: String,
) -> BrokerResult<Option<RemoteObject>> {
    validate_path(&path)?;
    let suffix = format!("{}/metadata", provider.object_path());
    let builder = broker.request(
        Method::GET,
        provider,
        &suffix,
        &[("path", &path), ("optional", "true")],
    )?;
    let response = broker
        .buffered_response(
            &request_id,
            builder,
            &[StatusCode::NOT_FOUND],
            MAX_DOCUMENT_BYTES,
        )
        .await?;
    if matches!(
        response.status,
        StatusCode::NO_CONTENT | StatusCode::NOT_FOUND
    ) {
        return Ok(None);
    }
    ensure_json_content_type(&response.headers)?;
    let object: RemoteObject =
        serde_json::from_slice(&response.body).map_err(|_| BrokerError::new("invalid-response"))?;
    validate_object(&object)?;
    if object.path != path {
        return Err(BrokerError::new("invalid-response"));
    }
    Ok(Some(object))
}

#[tauri::command]
pub(crate) async fn sync_download_begin(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
    path: String,
    expected_size: Option<u64>,
) -> BrokerResult<TransferStart> {
    validate_path(&path)?;
    if expected_size.is_some_and(|size| size > MAX_OBJECT_BYTES) {
        return Err(BrokerError::new("invalid-response"));
    }
    broker.reserve_transfer()?;
    let signal = match broker.begin_request(&request_id) {
        Ok(signal) => signal,
        Err(error) => {
            broker.release_transfer();
            return Err(error);
        }
    };
    let prepared: BrokerResult<(Response, u64, String)> = async {
        let builder = broker.request(
            Method::GET,
            provider,
            provider.object_path(),
            &[("path", &path)],
        )?;
        let response = broker.send(builder, signal, &[]).await?;
        let size = response
            .content_length()
            .ok_or_else(|| BrokerError::new("invalid-response"))?;
        if size > MAX_OBJECT_BYTES || expected_size.is_some_and(|expected| expected != size) {
            return Err(BrokerError::new("invalid-response"));
        }
        validate_sha256_header(response.headers())?;
        let media_type = response_media_type(response.headers())?;
        Ok((response, size, media_type))
    }
    .await;
    let (response, size, media_type) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            broker.finish_request(&request_id);
            broker.release_transfer();
            return Err(error);
        }
    };
    let transfer_id = Uuid::new_v4().simple().to_string();
    let insertion = lock(&broker.downloads).map(|mut downloads| {
        downloads.insert(
            transfer_id.clone(),
            DownloadTransfer {
                request_id: request_id.clone(),
                provider,
                response,
                pending: VecDeque::new(),
                transferred: 0,
                size,
            },
        )
    });
    if let Err(error) = insertion {
        broker.finish_request(&request_id);
        broker.release_transfer();
        return Err(error);
    }
    Ok(TransferStart {
        transfer_id,
        size: Some(size),
        media_type: Some(media_type),
    })
}

#[tauri::command]
pub(crate) async fn sync_download_chunk(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
    transfer_id: String,
    offset: u64,
    max_bytes: usize,
) -> BrokerResult<DownloadChunk> {
    validate_transfer_id(&transfer_id)?;
    if !(1..=MAX_IPC_CHUNK_BYTES).contains(&max_bytes) {
        return Err(BrokerError::new("invalid-response"));
    }
    let mut transfer = lock(&broker.downloads)?
        .remove(&transfer_id)
        .ok_or_else(|| BrokerError::new("cancelled"))?;
    if transfer.request_id != request_id
        || transfer.provider != provider
        || transfer.transferred != offset
    {
        broker.finish_request(&transfer.request_id);
        broker.release_transfer();
        return Err(BrokerError::new("invalid-response"));
    }
    let signal = match broker.request_signal(&request_id) {
        Ok(signal) => signal,
        Err(error) => {
            broker.release_transfer();
            return Err(error);
        }
    };
    let result = download_chunk(&mut transfer, max_bytes, signal).await;
    match result {
        Ok(chunk) => {
            if let Err(error) = lock(&broker.downloads).map(|mut downloads| {
                downloads.insert(transfer_id, transfer);
            }) {
                broker.finish_request(&request_id);
                broker.release_transfer();
                return Err(error);
            }
            Ok(chunk)
        }
        Err(error) => {
            broker.finish_request(&request_id);
            broker.release_transfer();
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) fn sync_download_finish(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
    transfer_id: String,
) -> BrokerResult<()> {
    validate_transfer_id(&transfer_id)?;
    let transfer = lock(&broker.downloads)?.remove(&transfer_id);
    broker.finish_request(
        transfer
            .as_ref()
            .map(|transfer| transfer.request_id.as_str())
            .unwrap_or(&request_id),
    );
    if transfer.is_some() {
        broker.release_transfer();
    }
    match transfer {
        None => Err(BrokerError::new("invalid-response")),
        Some(transfer)
            if transfer.request_id == request_id
                && transfer.provider == provider
                && transfer.transferred == transfer.size
                && transfer.pending.is_empty() =>
        {
            Ok(())
        }
        Some(_) => Err(BrokerError::new("invalid-response")),
    }
}

#[tauri::command]
pub(crate) fn sync_upload_begin(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
    path: String,
    size: u64,
    sha256: String,
    media_type: String,
) -> BrokerResult<TransferStart> {
    validate_path(&path)?;
    validate_upload_metadata(&path, size, &sha256, &media_type)?;
    broker.reserve_transfer()?;
    if let Err(error) = broker.begin_request(&request_id) {
        broker.release_transfer();
        return Err(error);
    }
    let transfer_id = Uuid::new_v4().simple().to_string();
    let temp_path = std::env::temp_dir().join(format!("omnia-sync-{transfer_id}.part"));
    let file = match create_private_upload_file(&temp_path) {
        Ok(file) => file,
        Err(_) => {
            broker.finish_request(&request_id);
            broker.release_transfer();
            return Err(BrokerError::new("transport-unavailable"));
        }
    };
    let transfer = UploadTransfer {
        request_id: request_id.clone(),
        provider,
        path,
        size,
        sha256,
        media_type,
        file,
        temp_path,
        written: 0,
    };
    let mut uploads = match lock(&broker.uploads) {
        Ok(uploads) => uploads,
        Err(error) => {
            transfer.cleanup();
            broker.finish_request(&request_id);
            broker.release_transfer();
            return Err(error);
        }
    };
    if uploads.contains_key(&transfer_id) {
        drop(uploads);
        transfer.cleanup();
        broker.finish_request(&request_id);
        broker.release_transfer();
        return Err(BrokerError::new("transport-unavailable"));
    }
    uploads.insert(transfer_id.clone(), transfer);
    Ok(TransferStart {
        transfer_id,
        size: None,
        media_type: None,
    })
}

#[tauri::command]
pub(crate) fn sync_upload_chunk(
    request: Request<'_>,
    broker: State<'_, SyncBroker>,
) -> BrokerResult<()> {
    let metadata = upload_chunk_metadata(request.headers())?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(BrokerError::new("invalid-response"));
    };
    validate_upload_chunk_bytes(bytes)?;
    if broker.request_signal(&metadata.request_id)?.is_cancelled() {
        return Err(BrokerError::new("cancelled"));
    }
    let mut uploads = lock(&broker.uploads)?;
    let transfer = uploads
        .get_mut(&metadata.transfer_id)
        .ok_or_else(|| BrokerError::new("cancelled"))?;
    if transfer.request_id != metadata.request_id
        || transfer.provider != metadata.provider
        || transfer.written != metadata.offset
        || transfer.written + bytes.len() as u64 > transfer.size
    {
        return Err(BrokerError::new("invalid-response"));
    }
    transfer
        .file
        .write_all(bytes)
        .map_err(|_| BrokerError::new("transport-unavailable"))?;
    transfer.written += bytes.len() as u64;
    Ok(())
}

#[tauri::command]
pub(crate) async fn sync_upload_finish(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
    transfer_id: String,
) -> BrokerResult<RemoteObject> {
    validate_transfer_id(&transfer_id)?;
    let mut transfer = lock(&broker.uploads)?
        .remove(&transfer_id)
        .ok_or_else(|| BrokerError::new("cancelled"))?;
    broker.release_transfer();
    if transfer.request_id != request_id
        || transfer.provider != provider
        || transfer.written != transfer.size
    {
        transfer.cleanup();
        broker.finish_request(&request_id);
        return Err(BrokerError::new("invalid-response"));
    }
    let result: BrokerResult<RemoteObject> = async {
        transfer
            .file
            .flush()
            .and_then(|_| transfer.file.sync_all())
            .and_then(|_| transfer.file.seek(SeekFrom::Start(0)).map(|_| ()))
            .map_err(|_| BrokerError::new("transport-unavailable"))?;
        let async_file = tokio::fs::File::from_std(
            transfer
                .file
                .try_clone()
                .map_err(|_| BrokerError::new("transport-unavailable"))?,
        );
        let builder = broker
            .request(
                Method::PUT,
                provider,
                provider.object_path(),
                &[("path", &transfer.path)],
            )?
            .header(CONTENT_TYPE, transfer.media_type.as_str())
            .header(CONTENT_LENGTH, transfer.size)
            .header(SIZE_HEADER, transfer.size)
            .header(SHA256_HEADER, transfer.sha256.as_str())
            .body(reqwest::Body::from(async_file))
            .timeout(TRANSFER_TIMEOUT);
        let signal = broker.request_signal(&request_id)?;
        let response = broker
            .send(builder, signal, &[StatusCode::CONFLICT])
            .await?;
        if response.status() == StatusCode::CONFLICT {
            return Err(BrokerError::new("conflict"));
        }
        ensure_json_content_type(response.headers())?;
        let bytes = bounded_body(response, MAX_DOCUMENT_BYTES, None).await?;
        let object: RemoteObject =
            serde_json::from_slice(&bytes).map_err(|_| BrokerError::new("invalid-response"))?;
        validate_object(&object)?;
        if object.path != transfer.path
            || object.size != transfer.size
            || object.sha256 != transfer.sha256
        {
            Err(BrokerError::new("invalid-response"))
        } else {
            Ok(object)
        }
    }
    .await;
    transfer.cleanup();
    broker.finish_request(&request_id);
    result
}

#[tauri::command]
pub(crate) async fn sync_delete_object(
    broker: State<'_, SyncBroker>,
    request_id: String,
    provider: Provider,
    request: ObjectDeleteRequest,
) -> BrokerResult<()> {
    validate_path(&request.path)?;
    if let Some(revision) = request.expected_revision.as_deref() {
        validate_revision(revision)?;
    }
    let mut query = vec![("path", request.path.as_str())];
    if let Some(revision) = request.expected_revision.as_deref() {
        query.push(("expectedRevision", revision));
    }
    let builder = broker.request(Method::DELETE, provider, provider.object_path(), &query)?;
    let response = broker
        .buffered_response(
            &request_id,
            builder,
            &[StatusCode::NOT_FOUND, StatusCode::CONFLICT],
            ERROR_BODY_BYTES,
        )
        .await?;
    if response.status == StatusCode::CONFLICT {
        return Err(BrokerError::new("conflict"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn sync_cancel_request(
    broker: State<'_, SyncBroker>,
    request_id: String,
) -> BrokerResult<()> {
    broker.cancel(&request_id)
}

#[tauri::command]
pub(crate) fn sync_teardown(
    broker: State<'_, SyncBroker>,
    authorizations: State<'_, crate::native_handoff::NativeAuthorizationState>,
) -> BrokerResult<()> {
    authorizations.clear();
    broker.teardown()
}

async fn download_chunk(
    transfer: &mut DownloadTransfer,
    maximum: usize,
    signal: Arc<CancellationSignal>,
) -> BrokerResult<DownloadChunk> {
    let remaining = transfer.size.saturating_sub(transfer.transferred) as usize;
    let target = maximum.min(remaining);
    let mut output = Vec::with_capacity(target);
    while output.len() < target {
        while output.len() < target {
            let Some(byte) = transfer.pending.pop_front() else {
                break;
            };
            output.push(byte);
        }
        if output.len() == target {
            break;
        }
        let chunk = match Cancellable::new(transfer.response.chunk(), signal.clone()).await? {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => return Err(request_error(&error)),
        };
        if chunk.len() > MAX_IPC_CHUNK_BYTES
            || transfer.pending.len() + chunk.len() > MAX_IPC_CHUNK_BYTES
        {
            return Err(BrokerError::new("invalid-response"));
        }
        transfer.pending.extend(chunk);
    }
    if output.is_empty() && transfer.transferred < transfer.size {
        return Err(BrokerError::new("invalid-response"));
    }
    transfer.transferred += output.len() as u64;
    if transfer.transferred > transfer.size {
        return Err(BrokerError::new("invalid-response"));
    }
    Ok(DownloadChunk {
        bytes: output,
        done: transfer.transferred == transfer.size,
    })
}

fn build_client(https_only: bool, jar: Arc<reqwest::cookie::Jar>) -> BrokerResult<Client> {
    Client::builder()
        .cookie_provider(jar)
        .https_only(https_only)
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| BrokerError::new("transport-unavailable"))
}

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn create_private_upload_file(path: &PathBuf) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn exact_origin(value: &str, allow_insecure_loopback: bool) -> BrokerResult<Url> {
    let url = Url::parse(value).map_err(|_| BrokerError::new("origin-mismatch"))?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    let valid_scheme =
        url.scheme() == "https" || (allow_insecure_loopback && url.scheme() == "http" && loopback);
    let unsafe_literal = url
        .host_str()
        .and_then(|host| IpAddr::from_str(host.trim_matches(['[', ']'])).ok())
        .is_some_and(unsafe_literal_address);
    let canonical = url.origin().ascii_serialization();
    if !valid_scheme
        || (!allow_insecure_loopback && unsafe_literal)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || value != canonical
    {
        return Err(BrokerError::new("origin-mismatch"));
    }
    Ok(url)
}

fn unsafe_literal_address(address: IpAddr) -> bool {
    if address.is_loopback() || address.is_unspecified() {
        return true;
    }
    match address {
        IpAddr::V4(value) => value.is_private() || value.is_link_local(),
        IpAddr::V6(value) => {
            value.is_unique_local()
                || value.is_unicast_link_local()
                || value
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| mapped.is_private() || mapped.is_loopback())
        }
    }
}

fn validate_github_session(value: &GitHubSessionResponse) -> BrokerResult<()> {
    match (value.configured, value.authenticated) {
        (false, false) => {
            if value.installation_url.is_some()
                || value.user.is_some()
                || value.repository.is_some()
            {
                return Err(BrokerError::new("invalid-response"));
            }
        }
        (true, false) => {
            validate_external_https_url(
                value
                    .installation_url
                    .as_deref()
                    .ok_or_else(|| BrokerError::new("invalid-response"))?,
            )?;
            if value.user.is_some() || value.repository.is_some() {
                return Err(BrokerError::new("invalid-response"));
            }
        }
        (true, true) => {
            validate_external_https_url(
                value
                    .installation_url
                    .as_deref()
                    .ok_or_else(|| BrokerError::new("invalid-response"))?,
            )?;
            let user = value
                .user
                .as_ref()
                .ok_or_else(|| BrokerError::new("invalid-response"))?;
            validate_positive_safe_integer(user.id)?;
            validate_bounded_string(&user.login, 256)?;
            validate_external_https_url(&user.avatar_url)?;
            if let Some(repository) = &value.repository {
                validate_github_repository(repository)?;
            }
        }
        (false, true) => return Err(BrokerError::new("invalid-response")),
    }
    Ok(())
}

fn validate_github_repository(value: &GitHubRepositoryResponse) -> BrokerResult<()> {
    validate_positive_safe_integer(value.id)?;
    validate_bounded_string(&value.full_name, 512)?;
    let mut parts = value.full_name.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if parts.next().is_some() || !github_name_part(owner) || !github_name_part(name) {
        return Err(BrokerError::new("invalid-response"));
    }
    validate_bounded_string(&value.default_branch, 256)?;
    if value.default_branch.contains(['\0', '/', '\\']) {
        return Err(BrokerError::new("invalid-response"));
    }
    let _ = value.private;
    let _ = value.can_push;
    Ok(())
}

fn validate_mega_session(value: &MegaSessionResponse) -> BrokerResult<()> {
    if !value.authenticated {
        return if value.account.is_none() && value.folder.is_none() {
            Ok(())
        } else {
            Err(BrokerError::new("invalid-response"))
        };
    }
    validate_bounded_string(
        value
            .account
            .as_deref()
            .ok_or_else(|| BrokerError::new("invalid-response"))?,
        320,
    )?;
    if let Some(folder) = &value.folder {
        validate_mega_folder(folder)?;
    }
    Ok(())
}

fn validate_mega_folder(value: &MegaFolderResponse) -> BrokerResult<()> {
    validate_bounded_string(&value.handle, 1024)?;
    validate_bounded_string(&value.name, 1024)?;
    validate_bounded_string(&value.path, 4096)?;
    if value.path.contains('\0') {
        return Err(BrokerError::new("invalid-response"));
    }
    let _ = value.can_write;
    Ok(())
}

fn validate_repository_name(value: &str) -> BrokerResult<()> {
    if value.is_empty()
        || value.len() > 100
        || matches!(value, "." | "..")
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(BrokerError::new("invalid-response"));
    }
    Ok(())
}

fn github_name_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn validate_external_https_url(value: &str) -> BrokerResult<()> {
    let url = Url::parse(value).map_err(|_| BrokerError::new("invalid-response"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.fragment().is_some()
    {
        return Err(BrokerError::new("invalid-response"));
    }
    Ok(())
}

fn validate_positive_safe_integer(value: u64) -> BrokerResult<()> {
    if value == 0 || value > 9_007_199_254_740_991 {
        return Err(BrokerError::new("invalid-response"));
    }
    Ok(())
}

fn validate_bounded_string(value: &str, maximum: usize) -> BrokerResult<()> {
    if value.is_empty() || value.len() > maximum || value.contains('\0') {
        return Err(BrokerError::new("invalid-response"));
    }
    Ok(())
}

fn lock<T>(mutex: &Mutex<T>) -> BrokerResult<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| BrokerError::new("transport-unavailable"))
}

fn validate_request_id(value: &str) -> BrokerResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(BrokerError::new("invalid-response"));
    }
    Ok(())
}

fn validate_transfer_id(value: &str) -> BrokerResult<()> {
    if !(16..=128).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(BrokerError::new("invalid-response"));
    }
    Ok(())
}

fn upload_chunk_metadata(headers: &HeaderMap) -> BrokerResult<UploadChunkMetadata> {
    let allowed = [
        SYNC_REQUEST_ID_HEADER,
        SYNC_PROVIDER_HEADER,
        SYNC_TRANSFER_ID_HEADER,
        SYNC_OFFSET_HEADER,
    ];
    if headers.keys().any(|name| {
        name.as_str().starts_with(SYNC_HEADER_PREFIX) && !allowed.contains(&name.as_str())
    }) {
        return Err(BrokerError::new("invalid-response"));
    }

    let value = |name| {
        headers
            .get(name)
            .ok_or_else(|| BrokerError::new("invalid-response"))?
            .to_str()
            .map_err(|_| BrokerError::new("invalid-response"))
    };
    let request_id = value(SYNC_REQUEST_ID_HEADER)?.to_owned();
    let provider = match value(SYNC_PROVIDER_HEADER)? {
        "git" => Provider::Git,
        "mega" => Provider::Mega,
        _ => return Err(BrokerError::new("invalid-response")),
    };
    let transfer_id = value(SYNC_TRANSFER_ID_HEADER)?.to_owned();
    let offset_value = value(SYNC_OFFSET_HEADER)?;
    let offset = offset_value
        .parse::<u64>()
        .map_err(|_| BrokerError::new("invalid-response"))?;
    if offset.to_string() != offset_value {
        return Err(BrokerError::new("invalid-response"));
    }
    validate_request_id(&request_id)?;
    validate_transfer_id(&transfer_id)?;
    Ok(UploadChunkMetadata {
        request_id,
        provider,
        transfer_id,
        offset,
    })
}

fn validate_upload_chunk_bytes(bytes: &[u8]) -> BrokerResult<()> {
    if bytes.is_empty() || bytes.len() > MAX_IPC_CHUNK_BYTES {
        Err(BrokerError::new("invalid-response"))
    } else {
        Ok(())
    }
}

fn validate_prefix(value: &str) -> BrokerResult<()> {
    if value == ".omnia-reader" {
        Ok(())
    } else {
        validate_path(value)
    }
}

fn validate_path(value: &str) -> BrokerResult<()> {
    if value.is_empty()
        || value.len() > 1024
        || !value.starts_with(".omnia-reader/")
        || value.contains(['\\', '\0'])
        || value.split('/').any(|segment| {
            segment.is_empty()
                || matches!(segment, "." | "..")
                || contains_unsafe_percent_encoding(segment)
        })
    {
        return Err(BrokerError::new("invalid-response"));
    }
    Ok(())
}

fn contains_unsafe_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len() {
            return true;
        }
        let Some(high) = hex_value(bytes[index + 1]) else {
            return true;
        };
        let Some(low) = hex_value(bytes[index + 2]) else {
            return true;
        };
        if matches!((high << 4) | low, 0 | b'%' | b'/' | b'\\') {
            return true;
        }
        index += 3;
    }
    false
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn validate_revision(value: &str) -> BrokerResult<()> {
    validate_text(value, 1024)
}

fn validate_text(value: &str, maximum: usize) -> BrokerResult<()> {
    if value.is_empty() || value.len() > maximum || value.contains('\0') {
        return Err(BrokerError::new("invalid-response"));
    }
    Ok(())
}

fn validate_document(document: &RemoteDocument) -> BrokerResult<()> {
    validate_path(&document.path)?;
    validate_text(&document.content, MAX_DOCUMENT_BYTES)?;
    validate_revision(&document.revision)
}

fn validate_document_write(request: &DocumentWriteRequest) -> BrokerResult<()> {
    validate_path(&request.path)?;
    validate_text(&request.content, MAX_DOCUMENT_BYTES)?;
    validate_text(&request.message, 512)?;
    if let Some(revision) = request.expected_revision.as_deref() {
        validate_revision(revision)?;
    }
    Ok(())
}

fn validate_document_delete(request: &DocumentDeleteRequest) -> BrokerResult<()> {
    validate_path(&request.path)?;
    validate_text(&request.message, 512)?;
    if let Some(revision) = request.expected_revision.as_deref() {
        validate_revision(revision)?;
    }
    Ok(())
}

fn validate_documents(documents: &[RemoteDocument], prefix: &str) -> BrokerResult<()> {
    if documents.len() > MAX_LIST_ENTRIES {
        return Err(BrokerError::new("invalid-response"));
    }
    let mut bytes = 0usize;
    let mut paths = std::collections::HashSet::new();
    for document in documents {
        validate_document(document)?;
        if !within_prefix(&document.path, prefix) || !paths.insert(&document.path) {
            return Err(BrokerError::new("invalid-response"));
        }
        bytes = bytes
            .checked_add(document.path.len() + document.content.len() + document.revision.len())
            .ok_or_else(|| BrokerError::new("invalid-response"))?;
        if bytes > MAX_LIST_BYTES {
            return Err(BrokerError::new("invalid-response"));
        }
    }
    Ok(())
}

fn validate_entries(entries: &[RemoteEntry], prefix: &str) -> BrokerResult<()> {
    if entries.len() > MAX_LIST_ENTRIES {
        return Err(BrokerError::new("invalid-response"));
    }
    let mut bytes = 0usize;
    let mut paths = std::collections::HashSet::new();
    for entry in entries {
        validate_path(&entry.path)?;
        validate_revision(&entry.revision)?;
        if !within_prefix(&entry.path, prefix) || !paths.insert(&entry.path) {
            return Err(BrokerError::new("invalid-response"));
        }
        bytes = bytes
            .checked_add(entry.path.len() + entry.revision.len())
            .ok_or_else(|| BrokerError::new("invalid-response"))?;
        if bytes > MAX_LIST_BYTES {
            return Err(BrokerError::new("invalid-response"));
        }
    }
    Ok(())
}

fn within_prefix(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|remainder| remainder.starts_with('/'))
}

fn validate_object(object: &RemoteObject) -> BrokerResult<()> {
    validate_path(&object.path)?;
    validate_revision(&object.revision)?;
    if object.size > MAX_OBJECT_BYTES || !valid_sha256(&object.sha256) {
        return Err(BrokerError::new("invalid-response"));
    }
    Ok(())
}

fn validate_upload_metadata(
    path: &str,
    size: u64,
    sha256: &str,
    media_type: &str,
) -> BrokerResult<()> {
    if size > MAX_OBJECT_BYTES
        || !valid_sha256(sha256)
        || !matches!(media_type, "application/pdf" | "application/epub+zip")
        || (media_type == "application/pdf" && !path.ends_with(".pdf"))
        || (media_type == "application/epub+zip" && !path.ends_with(".epub"))
    {
        return Err(BrokerError::new("invalid-response"));
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_sha256_header(headers: &HeaderMap) -> BrokerResult<()> {
    let value = headers
        .get(SHA256_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| BrokerError::new("invalid-response"))?;
    if valid_sha256(value) {
        Ok(())
    } else {
        Err(BrokerError::new("invalid-response"))
    }
}

fn response_media_type(headers: &HeaderMap) -> BrokerResult<String> {
    let media_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| matches!(*value, "application/pdf" | "application/epub+zip"))
        .ok_or_else(|| BrokerError::new("invalid-response"))?;
    Ok(media_type.to_owned())
}

fn ensure_json_content_type(headers: &HeaderMap) -> BrokerResult<()> {
    let valid = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"));
    if valid {
        Ok(())
    } else {
        Err(BrokerError::new("invalid-response"))
    }
}

async fn bounded_body(
    mut response: Response,
    maximum: usize,
    signal: Option<Arc<CancellationSignal>>,
) -> BrokerResult<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err(BrokerError::new("invalid-response"));
    }
    let mut bytes = Vec::new();
    loop {
        let next = if let Some(signal) = signal.clone() {
            match Cancellable::new(response.chunk(), signal).await? {
                Ok(value) => value,
                Err(error) => return Err(request_error(&error)),
            }
        } else {
            response
                .chunk()
                .await
                .map_err(|error| request_error(&error))?
        };
        let Some(chunk) = next else {
            break;
        };
        if bytes.len().saturating_add(chunk.len()) > maximum {
            return Err(BrokerError::new("invalid-response"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn request_error(error: &reqwest::Error) -> BrokerError {
    if error.is_redirect() {
        BrokerError::new("redirect-denied")
    } else {
        BrokerError::new("transport-unavailable")
    }
}

fn status_error(status: StatusCode, headers: &HeaderMap) -> BrokerError {
    match status {
        StatusCode::UNAUTHORIZED => BrokerError::new("authentication-required"),
        StatusCode::FORBIDDEN => BrokerError::new("permission-denied"),
        StatusCode::CONFLICT => BrokerError::new("conflict"),
        StatusCode::TOO_MANY_REQUESTS => BrokerError::rate_limited(
            headers
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse().ok()),
        ),
        status if status.is_redirection() => BrokerError::new("redirect-denied"),
        status if status.is_server_error() => BrokerError::new("transport-unavailable"),
        _ => BrokerError::new("invalid-response"),
    }
}

#[cfg(test)]
mod tests;
