use crate::sync_broker::{
    BrokerError, BrokerResult, NativeAuthorizationOutcome, Provider, SyncBroker,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) const NATIVE_AUTHORIZATION_TTL_SECONDS: u64 = 10 * 60;
const MAX_PENDING_NATIVE_AUTHORIZATIONS: usize = 8;

#[derive(Clone, Debug)]
struct PendingAuthorization {
    provider: Provider,
    expires_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct NativeHandoffRedemption {
    pub(crate) provider: Provider,
    pub(crate) request_id: String,
    pub(crate) handoff_id: String,
}

pub(crate) struct NativeAuthorizationState {
    pending: Mutex<HashMap<String, PendingAuthorization>>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl Default for NativeAuthorizationState {
    fn default() -> Self {
        Self::with_now(Arc::new(current_epoch_seconds))
    }
}

impl NativeAuthorizationState {
    pub(crate) fn with_now(now: Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            now,
        }
    }

    pub(crate) fn begin(&self, provider: Provider, request_id: &str) -> BrokerResult<()> {
        validate_native_request_id(request_id)?;
        let now = (self.now)();
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| BrokerError::new("transport-unavailable"))?;
        pending.retain(|_, entry| entry.expires_at > now);
        if pending.len() >= MAX_PENDING_NATIVE_AUTHORIZATIONS || pending.contains_key(request_id) {
            return Err(BrokerError::new("transport-unavailable"));
        }
        pending.insert(
            request_id.to_owned(),
            PendingAuthorization {
                provider,
                expires_at: now + NATIVE_AUTHORIZATION_TTL_SECONDS,
            },
        );
        Ok(())
    }

    pub(crate) fn cancel(&self, request_id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(request_id);
        }
    }

    pub(crate) fn take(&self, url: &tauri::Url) -> BrokerResult<NativeHandoffRedemption> {
        let redemption = parse_deep_link(url)?;
        let now = (self.now)();
        let pending = self
            .pending
            .lock()
            .map_err(|_| BrokerError::new("transport-unavailable"))?
            .remove(&redemption.request_id)
            .ok_or_else(|| BrokerError::new("authentication-required"))?;
        if pending.provider != redemption.provider || pending.expires_at <= now {
            return Err(BrokerError::new("authentication-required"));
        }
        Ok(redemption)
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeAuthorizationEvent {
    request_id: String,
    provider: &'static str,
    outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

impl NativeAuthorizationEvent {
    pub(crate) fn success(request_id: &str, provider: Provider) -> Self {
        Self {
            request_id: request_id.to_owned(),
            provider: provider.ipc_name(),
            outcome: "authorized",
            error: None,
        }
    }

    pub(crate) fn failure(request_id: &str, provider: Provider, error: &'static str) -> Self {
        Self {
            request_id: request_id.to_owned(),
            provider: provider.ipc_name(),
            outcome: "failed",
            error: Some(error),
        }
    }

    fn outcome(request_id: &str, provider: Provider, outcome: NativeAuthorizationOutcome) -> Self {
        match outcome {
            NativeAuthorizationOutcome::Authorized => Self::success(request_id, provider),
            NativeAuthorizationOutcome::Denied => Self {
                request_id: request_id.to_owned(),
                provider: provider.ipc_name(),
                outcome: "denied",
                error: Some("authentication-required"),
            },
            NativeAuthorizationOutcome::Invalid => Self {
                request_id: request_id.to_owned(),
                provider: provider.ipc_name(),
                outcome: "invalid",
                error: Some("authentication-required"),
            },
            NativeAuthorizationOutcome::Failed => {
                Self::failure(request_id, provider, "transport-unavailable")
            }
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeAuthorizationStart {
    authorization_url: String,
}

#[tauri::command]
pub(crate) fn sync_authorization_begin(
    broker: State<'_, SyncBroker>,
    authorizations: State<'_, NativeAuthorizationState>,
    request_id: String,
    provider: Provider,
) -> BrokerResult<NativeAuthorizationStart> {
    authorizations.begin(provider, &request_id)?;
    match broker.native_authorization_url(provider, &request_id) {
        Ok(authorization_url) => Ok(NativeAuthorizationStart { authorization_url }),
        Err(error) => {
            authorizations.cancel(&request_id);
            Err(error)
        }
    }
}

pub(crate) fn emit_native_authorization_deep_links(
    app: &AppHandle,
    urls: impl IntoIterator<Item = tauri::Url>,
) {
    for url in urls {
        if url.scheme() != "omnia-reader" || url.host_str() != Some("sync-auth") {
            continue;
        }
        let redemption = {
            let authorizations = app.state::<NativeAuthorizationState>();
            authorizations.take(&url)
        };
        let Ok(redemption) = redemption else {
            continue;
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let result = {
                let broker = app.state::<SyncBroker>();
                broker
                    .redeem_native_authorization(
                        redemption.provider,
                        &redemption.request_id,
                        &redemption.handoff_id,
                    )
                    .await
            };
            let event = match result {
                Ok(outcome) => NativeAuthorizationEvent::outcome(
                    &redemption.request_id,
                    redemption.provider,
                    outcome,
                ),
                Err(error) => NativeAuthorizationEvent::failure(
                    &redemption.request_id,
                    redemption.provider,
                    error.code(),
                ),
            };
            let _ = app.emit("sync-authorization-completed", event);
        });
    }
}

fn parse_deep_link(url: &tauri::Url) -> BrokerResult<NativeHandoffRedemption> {
    if url.scheme() != "omnia-reader"
        || url.host_str() != Some("sync-auth")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err(BrokerError::new("authentication-required"));
    }
    let provider = match url.path() {
        "/github" => Provider::Git,
        "/mega" => Provider::Mega,
        _ => return Err(BrokerError::new("authentication-required")),
    };
    let mut handoff_id = None;
    let mut request_id = None;
    for (name, value) in url.query_pairs() {
        let destination = match name.as_ref() {
            "handoffId" => &mut handoff_id,
            "requestId" => &mut request_id,
            _ => return Err(BrokerError::new("authentication-required")),
        };
        if destination.replace(value.into_owned()).is_some() {
            return Err(BrokerError::new("authentication-required"));
        }
    }
    let handoff_id = handoff_id.ok_or_else(|| BrokerError::new("authentication-required"))?;
    let request_id = request_id.ok_or_else(|| BrokerError::new("authentication-required"))?;
    if handoff_id.len() != 43
        || !handoff_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(BrokerError::new("authentication-required"));
    }
    validate_native_request_id(&request_id)?;
    Ok(NativeHandoffRedemption {
        provider,
        request_id,
        handoff_id,
    })
}

fn validate_native_request_id(value: &str) -> BrokerResult<()> {
    if !(16..=128).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(BrokerError::new("authentication-required"));
    }
    Ok(())
}

fn current_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
