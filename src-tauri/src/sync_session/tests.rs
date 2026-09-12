use super::*;
use std::sync::Mutex;

const NOW_MS: u64 = 1_800_000_000_000;
const COOKIE: &str = "omnia_git=secret-canary; Path=/; Secure; HttpOnly";

#[derive(Default)]
struct MemoryProtectedStore {
    protected: bool,
    fail_load: bool,
    fail_store: bool,
    fail_clear: bool,
    value: Mutex<Option<Vec<u8>>>,
}

impl ProtectedSessionStore for MemoryProtectedStore {
    fn is_os_protected(&self) -> bool {
        self.protected
    }

    fn load(&self) -> Result<Option<Vec<u8>>, SessionPersistenceError> {
        if self.fail_load {
            return Err(SessionPersistenceError);
        }
        Ok(self
            .value
            .lock()
            .map_err(|_| SessionPersistenceError)?
            .clone())
    }

    fn store(&self, value: &[u8]) -> Result<(), SessionPersistenceError> {
        if self.fail_store {
            return Err(SessionPersistenceError);
        }
        *self.value.lock().map_err(|_| SessionPersistenceError)? = Some(value.to_vec());
        Ok(())
    }

    fn clear(&self) -> Result<(), SessionPersistenceError> {
        if self.fail_clear {
            return Err(SessionPersistenceError);
        }
        *self.value.lock().map_err(|_| SessionPersistenceError)? = None;
        Ok(())
    }
}

#[test]
fn session_only_mode_discards_authority_across_restart() {
    let origin = Url::parse("https://sync.test").unwrap();
    let session = SyncSession::session_only(origin.clone());
    session.jar().unwrap().add_cookie_str(COOKIE, &origin);
    session.persist(NOW_MS).unwrap();
    assert!(cookie_header(&session, &origin).contains("secret-canary"));
    assert_eq!(
        session.status().unwrap(),
        SessionPersistenceStatus {
            persistence_mode: SessionPersistenceMode::SessionOnly,
            persistence_version: None,
            restart_requires_reauthentication: true,
        }
    );

    let restarted = SyncSession::session_only(origin.clone());
    assert_eq!(cookie_header(&restarted, &origin), "");
}

#[test]
fn proven_store_restores_only_the_exact_origin_and_version() {
    let origin = Url::parse("https://sync.test").unwrap();
    let store = Arc::new(MemoryProtectedStore {
        protected: true,
        ..Default::default()
    });
    let session = SyncSession::with_protected_store(origin.clone(), store.clone(), NOW_MS);
    session.jar().unwrap().add_cookie_str(COOKIE, &origin);
    session.persist(NOW_MS).unwrap();
    assert_eq!(
        session.status().unwrap(),
        SessionPersistenceStatus {
            persistence_mode: SessionPersistenceMode::Protected,
            persistence_version: Some(PERSISTENCE_VERSION),
            restart_requires_reauthentication: false,
        }
    );

    let restarted = SyncSession::with_protected_store(origin.clone(), store, NOW_MS + 1_000);
    assert!(cookie_header(&restarted, &origin).contains("secret-canary"));
}

#[test]
fn unproven_or_unavailable_protection_downgrades_without_loading_authority() {
    let origin = Url::parse("https://sync.test").unwrap();
    let unproven = Arc::new(MemoryProtectedStore {
        protected: false,
        value: Mutex::new(Some(b"secret-canary".to_vec())),
        ..Default::default()
    });
    let session = SyncSession::with_protected_store(origin.clone(), unproven, NOW_MS);
    assert_eq!(
        session.status().unwrap().persistence_mode,
        SessionPersistenceMode::SessionOnly
    );
    assert_eq!(cookie_header(&session, &origin), "");

    let unavailable = Arc::new(MemoryProtectedStore {
        protected: true,
        fail_load: true,
        value: Mutex::new(Some(b"secret-canary".to_vec())),
        ..Default::default()
    });
    let session = SyncSession::with_protected_store(origin.clone(), unavailable, NOW_MS);
    assert_eq!(
        session.status().unwrap().persistence_mode,
        SessionPersistenceMode::SessionOnly
    );
    assert_eq!(cookie_header(&session, &origin), "");

    let uncleared = Arc::new(MemoryProtectedStore {
        protected: true,
        fail_clear: true,
        value: Mutex::new(Some(b"malformed-secret-canary".to_vec())),
        ..Default::default()
    });
    let session = SyncSession::with_protected_store(origin.clone(), uncleared, NOW_MS);
    assert_eq!(
        session.status().unwrap().persistence_mode,
        SessionPersistenceMode::SessionOnly
    );
    assert_eq!(cookie_header(&session, &origin), "");
}

#[test]
fn protected_store_failure_clears_process_authority_and_downgrades() {
    let origin = Url::parse("https://sync.test").unwrap();
    let store = Arc::new(MemoryProtectedStore {
        protected: true,
        fail_store: true,
        ..Default::default()
    });
    let session = SyncSession::with_protected_store(origin.clone(), store, NOW_MS);
    session.jar().unwrap().add_cookie_str(COOKIE, &origin);

    assert!(session.persist(NOW_MS).is_err());
    assert_eq!(cookie_header(&session, &origin), "");
    assert_eq!(
        session.status().unwrap().persistence_mode,
        SessionPersistenceMode::SessionOnly
    );
}

#[test]
fn malformed_or_expired_records_never_restore() {
    let origin = Url::parse("https://sync.test").unwrap();
    for value in [
        b"secret-canary".to_vec(),
        serde_json::to_vec(&PersistedSession {
            version: PERSISTENCE_VERSION + 1,
            gateway_origin: origin.origin().ascii_serialization(),
            cookie_header: "omnia_git=secret-canary".to_owned(),
            created_at_ms: NOW_MS - 1_000,
            expires_at_ms: NOW_MS + 1_000,
        })
        .unwrap(),
        serde_json::to_vec(&PersistedSession {
            version: PERSISTENCE_VERSION,
            gateway_origin: "https://other.test".to_owned(),
            cookie_header: "omnia_git=secret-canary".to_owned(),
            created_at_ms: NOW_MS - 1_000,
            expires_at_ms: NOW_MS + 1_000,
        })
        .unwrap(),
        serde_json::to_vec(&PersistedSession {
            version: PERSISTENCE_VERSION,
            gateway_origin: origin.origin().ascii_serialization(),
            cookie_header: "omnia_git=secret-canary".to_owned(),
            created_at_ms: NOW_MS - 2_000,
            expires_at_ms: NOW_MS,
        })
        .unwrap(),
    ] {
        let store = Arc::new(MemoryProtectedStore {
            protected: true,
            value: Mutex::new(Some(value)),
            ..Default::default()
        });
        let session = SyncSession::with_protected_store(origin.clone(), store.clone(), NOW_MS);
        assert_eq!(cookie_header(&session, &origin), "");
        assert_eq!(
            session.status().unwrap().persistence_mode,
            SessionPersistenceMode::Protected
        );
        assert!(store.value.lock().unwrap().is_none());
    }
}

fn cookie_header(session: &SyncSession, origin: &Url) -> String {
    session
        .jar()
        .unwrap()
        .cookies(origin)
        .and_then(|value| value.to_str().ok().map(str::to_owned))
        .unwrap_or_default()
}
