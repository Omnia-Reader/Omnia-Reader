use super::*;
use crate::sync_broker::Provider;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::{io::Read, io::Write, net::TcpListener, thread};

const REQUEST_ID: &str = "native-request-12345678";
const HANDOFF_ID: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

fn deep_link(provider: &str, request_id: &str, handoff_id: &str) -> tauri::Url {
    tauri::Url::parse(&format!(
        "omnia-reader://sync-auth/{provider}?handoffId={handoff_id}&requestId={request_id}"
    ))
    .unwrap()
}

#[test]
fn exact_deep_link_is_bound_and_single_use() {
    let state = NativeAuthorizationState::default();
    state.begin(Provider::Git, REQUEST_ID).unwrap();

    let redemption = state
        .take(&deep_link("github", REQUEST_ID, HANDOFF_ID))
        .unwrap();
    assert_eq!(redemption.provider, Provider::Git);
    assert_eq!(redemption.request_id, REQUEST_ID);
    assert_eq!(redemption.handoff_id, HANDOFF_ID);
    assert_eq!(
        state
            .take(&deep_link("github", REQUEST_ID, HANDOFF_ID))
            .unwrap_err()
            .code(),
        "authentication-required"
    );
}

#[test]
fn forged_and_provider_mismatched_links_are_rejected() {
    for invalid in [
        "https://sync-auth/github?handoffId=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&requestId=native-request-12345678",
        "omnia-reader://attacker/github?handoffId=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&requestId=native-request-12345678",
        "omnia-reader://sync-auth/github/extra?handoffId=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&requestId=native-request-12345678",
        "omnia-reader://sync-auth/github?handoffId=short&requestId=native-request-12345678",
        "omnia-reader://sync-auth/github?handoffId=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&requestId=native/request",
        "omnia-reader://sync-auth/github?handoffId=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&requestId=native-request-12345678#fragment",
        "omnia-reader://sync-auth/github?handoffId=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&handoffId=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB&requestId=native-request-12345678",
    ] {
        let state = NativeAuthorizationState::default();
        state.begin(Provider::Git, REQUEST_ID).unwrap();
        assert!(state.take(&tauri::Url::parse(invalid).unwrap()).is_err());
    }

    let state = NativeAuthorizationState::default();
    state.begin(Provider::Git, REQUEST_ID).unwrap();
    assert!(state
        .take(&deep_link("mega", REQUEST_ID, HANDOFF_ID))
        .is_err());
    assert!(state
        .take(&deep_link("github", REQUEST_ID, HANDOFF_ID))
        .is_err());
}

#[test]
fn expired_and_concurrent_redemptions_cannot_replay() {
    let now = Arc::new(AtomicU64::new(1_000));
    let clock = now.clone();
    let state = NativeAuthorizationState::with_now(Arc::new(move || clock.load(Ordering::Acquire)));
    state.begin(Provider::Git, REQUEST_ID).unwrap();
    now.store(
        1_000 + NATIVE_AUTHORIZATION_TTL_SECONDS + 1,
        Ordering::Release,
    );
    assert_eq!(
        state
            .take(&deep_link("github", REQUEST_ID, HANDOFF_ID))
            .unwrap_err()
            .code(),
        "authentication-required"
    );

    let state = Arc::new(NativeAuthorizationState::default());
    state.begin(Provider::Git, REQUEST_ID).unwrap();
    let url = deep_link("github", REQUEST_ID, HANDOFF_ID);
    let attempts = (0..2)
        .map(|_| {
            let state = state.clone();
            let url = url.clone();
            std::thread::spawn(move || state.take(&url).is_ok())
        })
        .collect::<Vec<_>>();
    assert_eq!(
        attempts
            .into_iter()
            .map(|attempt| attempt.join().unwrap())
            .filter(|succeeded| *succeeded)
            .count(),
        1
    );
}

#[test]
fn failure_events_are_sanitized() {
    let event =
        NativeAuthorizationEvent::failure(REQUEST_ID, Provider::Git, "transport-unavailable");
    let serialized = serde_json::to_string(&event).unwrap();
    assert_eq!(
        serialized,
        r#"{"requestId":"native-request-12345678","provider":"git","outcome":"failed","error":"transport-unavailable"}"#
    );
    assert!(!serialized.contains("https://attacker.invalid/secret"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn redemption_keeps_session_cookie_inside_the_broker() {
    const COOKIE_CANARY: &str = "native-cookie-canary-secret";
    let (origin, requests, server) = redemption_server(vec![
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: omnia_sync_github={COOKIE_CANARY}; HttpOnly; SameSite=Lax; Path=/api/sync/github\r\nContent-Length: 22\r\nConnection: close\r\n\r\n{{\"authenticated\":true}}"
        ),
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 22\r\nConnection: close\r\n\r\n{\"authenticated\":true}".to_owned(),
    ]);
    let broker = crate::sync_broker::SyncBroker::from_origin(&origin, true).unwrap();

    assert_eq!(
        broker
            .redeem_native_authorization(Provider::Git, REQUEST_ID, HANDOFF_ID)
            .await
            .unwrap(),
        crate::sync_broker::NativeAuthorizationOutcome::Authorized
    );
    assert_eq!(
        broker
            .redeem_native_authorization(
                Provider::Git,
                REQUEST_ID,
                "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            )
            .await
            .unwrap(),
        crate::sync_broker::NativeAuthorizationOutcome::Authorized
    );

    server.join().unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(!requests[0].contains(COOKIE_CANARY));
    assert!(requests[1].to_ascii_lowercase().contains(&format!(
        "cookie: omnia_sync_github={}",
        COOKIE_CANARY.to_ascii_lowercase()
    )));
    assert!(!format!(
        "{:?}",
        crate::sync_broker::NativeAuthorizationOutcome::Authorized
    )
    .contains(COOKIE_CANARY));
}

fn redemption_server(
    responses: Vec<String>,
) -> (String, Arc<Mutex<Vec<String>>>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let server = thread::spawn(move || {
        for response in responses {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            let header_end = loop {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&buffer[..read]);
                if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = std::str::from_utf8(&bytes[..header_end]).unwrap();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(str::trim)
                        .and_then(|value| value.parse::<usize>().ok())
                })
                .unwrap_or(0);
            while bytes.len() < header_end + content_length {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&buffer[..read]);
            }
            captured
                .lock()
                .unwrap()
                .push(String::from_utf8(bytes).unwrap());
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
        }
    });
    (origin, requests, server)
}
