use reqwest::cookie::{CookieStore, Jar};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, MutexGuard};
use url::Url;

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use keyring::{credential::CredentialPersistence, Entry};

const PERSISTENCE_VERSION: u16 = 1;
const MAX_COOKIE_HEADER_BYTES: usize = 16 * 1024;
const MAX_PERSISTED_LIFETIME_MS: u64 = 12 * 60 * 60 * 1_000;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
const SESSION_KEYRING_SERVICE: &str = "io.github.omniareader.reader.sync-session";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SessionPersistenceMode {
    Protected,
    SessionOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionPersistenceStatus {
    pub(crate) persistence_mode: SessionPersistenceMode,
    pub(crate) persistence_version: Option<u16>,
    pub(crate) restart_requires_reauthentication: bool,
}

#[derive(Debug)]
pub(crate) struct SessionPersistenceError;

pub(crate) trait ProtectedSessionStore: Send + Sync {
    fn is_os_protected(&self) -> bool;
    fn load(&self) -> Result<Option<Vec<u8>>, SessionPersistenceError>;
    fn store(&self, value: &[u8]) -> Result<(), SessionPersistenceError>;
    fn clear(&self) -> Result<(), SessionPersistenceError>;
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
struct OsProtectedSessionStore {
    entry: Entry,
    persists_until_delete: bool,
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
impl OsProtectedSessionStore {
    fn for_origin(origin: &Url) -> Result<Self, SessionPersistenceError> {
        let persists_until_delete = matches!(
            keyring::default::default_credential_builder().persistence(),
            CredentialPersistence::UntilDelete
        );
        let entry = Entry::new(
            SESSION_KEYRING_SERVICE,
            &origin.origin().ascii_serialization(),
        )
        .map_err(|_| SessionPersistenceError)?;
        Ok(Self {
            entry,
            persists_until_delete,
        })
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
impl ProtectedSessionStore for OsProtectedSessionStore {
    fn is_os_protected(&self) -> bool {
        self.persists_until_delete
    }

    fn load(&self) -> Result<Option<Vec<u8>>, SessionPersistenceError> {
        match self.entry.get_secret() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(SessionPersistenceError),
        }
    }

    fn store(&self, value: &[u8]) -> Result<(), SessionPersistenceError> {
        self.entry
            .set_secret(value)
            .map_err(|_| SessionPersistenceError)
    }

    fn clear(&self) -> Result<(), SessionPersistenceError> {
        match self.entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(SessionPersistenceError),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedSession {
    version: u16,
    gateway_origin: String,
    cookie_header: String,
    created_at_ms: u64,
    expires_at_ms: u64,
}

enum Persistence {
    Protected {
        store: Arc<dyn ProtectedSessionStore>,
        created_at_ms: Option<u64>,
        expires_at_ms: Option<u64>,
    },
    SessionOnly,
}

struct SessionState {
    jar: Arc<Jar>,
    persistence: Persistence,
}

pub(crate) struct SyncSession {
    origin: Url,
    state: Mutex<SessionState>,
}

impl SyncSession {
    #[cfg(test)]
    pub(crate) fn for_origin(origin: Url, _now_ms: u64) -> Self {
        Self::session_only(origin)
    }

    #[cfg(all(
        not(test),
        any(target_os = "linux", target_os = "macos", target_os = "windows")
    ))]
    pub(crate) fn for_origin(origin: Url, now_ms: u64) -> Self {
        if let Ok(store) = OsProtectedSessionStore::for_origin(&origin) {
            return Self::with_protected_store(origin, Arc::new(store), now_ms);
        }
        Self::session_only(origin)
    }

    #[cfg(all(
        not(test),
        not(any(target_os = "linux", target_os = "macos", target_os = "windows"))
    ))]
    pub(crate) fn for_origin(origin: Url, _now_ms: u64) -> Self {
        Self::session_only(origin)
    }

    pub(crate) fn session_only(origin: Url) -> Self {
        Self {
            origin,
            state: Mutex::new(SessionState {
                jar: Arc::new(Jar::default()),
                persistence: Persistence::SessionOnly,
            }),
        }
    }

    pub(crate) fn with_protected_store(
        origin: Url,
        store: Arc<dyn ProtectedSessionStore>,
        now_ms: u64,
    ) -> Self {
        if !store.is_os_protected() {
            return Self::session_only(origin);
        }
        let mut state = SessionState {
            jar: Arc::new(Jar::default()),
            persistence: Persistence::Protected {
                store: store.clone(),
                created_at_ms: None,
                expires_at_ms: None,
            },
        };
        match store.load() {
            Ok(value) => {
                if restore(value, &origin, now_ms, &mut state).is_err() && store.clear().is_err() {
                    fail_closed(&mut state);
                }
            }
            Err(_) => fail_closed(&mut state),
        }
        Self {
            origin,
            state: Mutex::new(state),
        }
    }

    pub(crate) fn jar(&self) -> Result<Arc<Jar>, SessionPersistenceError> {
        Ok(self.lock()?.jar.clone())
    }

    pub(crate) fn status(&self) -> Result<SessionPersistenceStatus, SessionPersistenceError> {
        let state = self.lock()?;
        Ok(match state.persistence {
            Persistence::Protected { .. } => SessionPersistenceStatus {
                persistence_mode: SessionPersistenceMode::Protected,
                persistence_version: Some(PERSISTENCE_VERSION),
                restart_requires_reauthentication: false,
            },
            Persistence::SessionOnly => SessionPersistenceStatus {
                persistence_mode: SessionPersistenceMode::SessionOnly,
                persistence_version: None,
                restart_requires_reauthentication: true,
            },
        })
    }

    pub(crate) fn persist(&self, now_ms: u64) -> Result<(), SessionPersistenceError> {
        let mut state = self.lock()?;
        if matches!(state.persistence, Persistence::SessionOnly) {
            return Ok(());
        }
        let header = match state
            .jar
            .cookies(&self.origin)
            .map(|value| value.to_str().map(str::to_owned))
            .transpose()
        {
            Ok(header) => header,
            Err(_) => {
                fail_closed(&mut state);
                return Err(SessionPersistenceError);
            }
        };
        let Persistence::Protected {
            store,
            created_at_ms,
            expires_at_ms,
        } = &state.persistence
        else {
            unreachable!("session-only persistence returned before cookie access");
        };
        let store = store.clone();
        let created_at_ms = *created_at_ms;
        let expires_at_ms = *expires_at_ms;
        let result = match header {
            None => store.clear().map(|()| (None, None)),
            Some(cookie_header) => validate_cookie_header(&cookie_header).and_then(|()| {
                let created_at_ms = created_at_ms.unwrap_or(now_ms);
                let expires_at_ms = expires_at_ms
                    .unwrap_or_else(|| now_ms.saturating_add(MAX_PERSISTED_LIFETIME_MS));
                if expires_at_ms <= now_ms {
                    store.clear().map(|()| (None, None))
                } else {
                    let record = PersistedSession {
                        version: PERSISTENCE_VERSION,
                        gateway_origin: self.origin.origin().ascii_serialization(),
                        cookie_header,
                        created_at_ms,
                        expires_at_ms,
                    };
                    serde_json::to_vec(&record)
                        .map_err(|_| SessionPersistenceError)
                        .and_then(|value| store.store(&value))
                        .map(|()| (Some(created_at_ms), Some(expires_at_ms)))
                }
            }),
        };
        match result {
            Ok((created_at_ms, expires_at_ms)) => {
                if let Persistence::Protected {
                    created_at_ms: current_created,
                    expires_at_ms: current_expires,
                    ..
                } = &mut state.persistence
                {
                    *current_created = created_at_ms;
                    *current_expires = expires_at_ms;
                }
                if expires_at_ms.is_none() {
                    state.jar = Arc::new(Jar::default());
                }
                Ok(())
            }
            Err(error) => {
                fail_closed(&mut state);
                Err(error)
            }
        }
    }

    pub(crate) fn drop_process_authority(&self) -> Result<(), SessionPersistenceError> {
        self.lock()?.jar = Arc::new(Jar::default());
        Ok(())
    }

    fn lock(&self) -> Result<MutexGuard<'_, SessionState>, SessionPersistenceError> {
        self.state.lock().map_err(|_| SessionPersistenceError)
    }
}

fn restore(
    value: Option<Vec<u8>>,
    origin: &Url,
    now_ms: u64,
    state: &mut SessionState,
) -> Result<(), SessionPersistenceError> {
    let Some(value) = value else {
        return Ok(());
    };
    let record: PersistedSession =
        serde_json::from_slice(&value).map_err(|_| SessionPersistenceError)?;
    validate_cookie_header(&record.cookie_header)?;
    if record.version != PERSISTENCE_VERSION
        || record.gateway_origin != origin.origin().ascii_serialization()
        || record.created_at_ms > now_ms
        || record.expires_at_ms <= now_ms
        || record.expires_at_ms.saturating_sub(record.created_at_ms) > MAX_PERSISTED_LIFETIME_MS
    {
        return Err(SessionPersistenceError);
    }
    let remaining_seconds = record.expires_at_ms.saturating_sub(now_ms) / 1_000;
    if remaining_seconds == 0 {
        return Err(SessionPersistenceError);
    }
    for cookie in record.cookie_header.split("; ") {
        state.jar.add_cookie_str(
            &format!(
                "{cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age={remaining_seconds}"
            ),
            origin,
        );
    }
    if let Persistence::Protected {
        created_at_ms,
        expires_at_ms,
        ..
    } = &mut state.persistence
    {
        *created_at_ms = Some(record.created_at_ms);
        *expires_at_ms = Some(record.expires_at_ms);
    }
    Ok(())
}

fn validate_cookie_header(value: &str) -> Result<(), SessionPersistenceError> {
    if value.is_empty()
        || value.len() > MAX_COOKIE_HEADER_BYTES
        || !value.is_ascii()
        || value.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
        || value.split("; ").any(|cookie| {
            let Some((name, _)) = cookie.split_once('=') else {
                return true;
            };
            name.is_empty()
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
    {
        return Err(SessionPersistenceError);
    }
    Ok(())
}

fn fail_closed(state: &mut SessionState) {
    state.jar = Arc::new(Jar::default());
    state.persistence = Persistence::SessionOnly;
}

#[cfg(test)]
#[path = "sync_session/tests.rs"]
mod tests;
