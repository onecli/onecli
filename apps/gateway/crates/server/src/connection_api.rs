//! Dashboard connection checks. No client-supplied target or credential is accepted.
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use context::auth::{can_test_connection, AuthUser, OrgAuthUser};
use context::GatewayState;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

const TIMEOUT: Duration = Duration::from_secs(15);
const WINDOW: Duration = Duration::from_secs(60);
static SLOTS: Semaphore = Semaphore::const_new(8);
static RATES: OnceLock<Mutex<HashMap<String, (Instant, u8)>>> = OnceLock::new();

type Failure = (StatusCode, &'static str, &'static str);
const INTERNAL: Failure = (
    StatusCode::INTERNAL_SERVER_ERROR,
    "INTERNAL_ERROR",
    "The connection could not be checked. Retry shortly.",
);
const FAILED: Failure = (StatusCode::UNPROCESSABLE_ENTITY, "CONNECTION_FAILED", "The stored connection could not log in securely. Check its credentials, destination and TLS settings.");
const LIMITED: Failure = (
    StatusCode::TOO_MANY_REQUESTS,
    "RATE_LIMITED",
    "Too many connection checks. Retry shortly.",
);

const NO_TLS: Failure = (
    StatusCode::UNPROCESSABLE_ENTITY,
    "SERVER_NO_TLS",
    "This server doesn't accept SSL. Turn on SSL on the server (recommended), or change TLS to No encryption (not recommended).",
);
const TLS_HANDSHAKE: Failure = (
    StatusCode::UNPROCESSABLE_ENTITY,
    "TLS_HANDSHAKE_FAILED",
    "The database server accepts SSL, but the secure connection could not be set up. With Verify, check the server's certificate or upload its CA, or switch to Encrypt only.",
);
const LOGIN_REJECTED: Failure = (
    StatusCode::UNPROCESSABLE_ENTITY,
    "LOGIN_REJECTED",
    "The database server refused the username, password or database name.",
);
const UNREACHABLE: Failure = (
    StatusCode::UNPROCESSABLE_ENTITY,
    "SERVER_UNREACHABLE",
    "The database server did not answer. Check the host and port, and that it accepts connections from OneCLI.",
);

const WEAK_LOGIN: Failure = (
    StatusCode::UNPROCESSABLE_ENTITY,
    "WEAK_LOGIN_WITHOUT_TLS",
    "Without SSL, OneCLI only logs in with SCRAM-SHA-256, so the password itself is never sent. Set this user's password again with password_encryption = 'scram-sha-256', and use scram-sha-256 (not password or trust) for it in pg_hba.conf.",
);

const PRIVATE_HOST: Failure = (
    StatusCode::UNPROCESSABLE_ENTITY,
    "PRIVATE_DESTINATION",
    "The host resolves to a private or reserved address, which this OneCLI gateway does not connect to. Use the server's public address, or ask your OneCLI administrator to allow it.",
);

/// Which step of the login failed, in words a user can act on. Only the
/// variant is read: the server's own text never reaches the response.
fn login_failure(error: &dbproxy_postgres::server::UpstreamError) -> Failure {
    use dbproxy_postgres::server::UpstreamError;
    match error {
        UpstreamError::NoTls => NO_TLS,
        UpstreamError::WeakLoginWithoutTls => WEAK_LOGIN,
        UpstreamError::Tls(_) => TLS_HANDSHAKE,
        UpstreamError::Rejected(_) => LOGIN_REJECTED,
        UpstreamError::Dial(dbproxy::upstream::DialError::Unreachable) => UNREACHABLE,
        UpstreamError::Dial(dbproxy::upstream::DialError::Refused { .. }) => PRIVATE_HOST,
        UpstreamError::Unsupported(_) => FAILED,
    }
}

fn failure((status, code, message): Failure) -> Response {
    (
        status,
        Json(serde_json::json!({"error":{"code":code,"message":message,"details":[]}})),
    )
        .into_response()
}

fn claim_rate(user: &str, now: Instant) -> Result<(), Failure> {
    let mut rates = RATES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| INTERNAL)?;
    rates.retain(|_, (start, _)| now.duration_since(*start) < WINDOW);
    // Cap memory even under a flood of distinct authenticated principals.
    if !rates.contains_key(user) && rates.len() >= 10_000 {
        return Err(LIMITED);
    }
    let (_, count) = rates.entry(user.to_owned()).or_insert((now, 0));
    if *count >= 5 {
        return Err(LIMITED);
    }
    *count += 1;
    Ok(())
}

struct ConnectionUser {
    user_id: String,
    workspace_id: Option<String>,
    organization_id: Option<String>,
}

pub async fn test_connection(
    State(state): State<GatewayState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    // Bound auth DB/JWKS, membership, decryption, login, role query and write
    // together. No queued work or request body is retained.
    let Ok(_slot) = SLOTS.try_acquire() else {
        return failure(LIMITED);
    };
    let (mut parts, _body) = request.into_parts();
    let operation = async {
        let unauthorized = || {
            (
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "Authentication and a valid scope are required.",
            )
        };
        let invalid_scope = || {
            (
                StatusCode::BAD_REQUEST,
                "INVALID_SCOPE",
                "Specify exactly one workspace or organization scope.",
            )
        };
        let auth = if parts.headers.contains_key("x-organization-id") {
            if parts.headers.contains_key("x-workspace-id")
                || parts.headers.contains_key("x-project-id")
            {
                return Err(invalid_scope());
            }
            let organization_id = parts
                .headers
                .get("x-organization-id")
                .and_then(|header| header.to_str().ok())
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(invalid_scope)?
                .to_owned();
            let auth = OrgAuthUser::from_request_parts(&mut parts, &state)
                .await
                .map_err(|_| unauthorized())?;
            claim_rate(&auth.user_id, Instant::now())?;
            if auth.auth_method.starts_with("api_key:")
                || auth
                    .organization_id
                    .as_ref()
                    .is_some_and(|id| *id != organization_id)
            {
                return Err((StatusCode::NOT_FOUND, "NOT_FOUND", "Connection not found."));
            }
            ConnectionUser {
                user_id: auth.user_id,
                workspace_id: None,
                organization_id: Some(organization_id),
            }
        } else {
            let auth = AuthUser::from_request_parts(&mut parts, &state)
                .await
                .map_err(|_| unauthorized())?;
            claim_rate(&auth.user_id, Instant::now())?;
            ConnectionUser {
                user_id: auth.user_id,
                workspace_id: Some(auth.workspace_id),
                organization_id: None,
            }
        };
        check(&state, &auth, &id).await
    };
    match tokio::time::timeout(TIMEOUT, operation).await {
        Ok(Ok(superuser)) => {
            Json(serde_json::json!({"ok":true,"superuser":superuser})).into_response()
        }
        Ok(Err(error)) => failure(error),
        Err(_) => failure((
            StatusCode::GATEWAY_TIMEOUT,
            "TEST_TIMEOUT",
            "The connection check timed out.",
        )),
    }
}

async fn check(state: &GatewayState, auth: &ConnectionUser, id: &str) -> Result<bool, Failure> {
    let pool = &state.policy_engine.pool;
    let row = db::find_testable_connection(
        pool,
        &auth.user_id,
        auth.workspace_id.as_deref(),
        auth.organization_id.as_deref(),
        id,
    )
    .await
    .map_err(|_| INTERNAL)?
    .ok_or((StatusCode::NOT_FOUND, "NOT_FOUND", "Connection not found."))?;
    if !can_test_connection(
        pool,
        &auth.user_id,
        auth.workspace_id.as_deref(),
        &row.organization_id,
    )
    .await
    .map_err(|_| INTERNAL)?
    {
        return Err((
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "Connection management permission is required.",
        ));
    }
    let decrypted = state
        .policy_engine
        .crypto
        .decrypt(&row.credentials)
        .await
        .map_err(|_| INTERNAL)?;
    let target = dbproxy::target::DbTarget::from_credentials(&decrypted).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            "INVALID_CONNECTION",
            "The stored PostgreSQL connection settings are invalid.",
        )
    })?;
    // connect uses the shared guarded dial, the stored TLS mode and the
    // protocol login (SCRAM-only when TLS is off).
    // Never format an upstream error: PostgreSQL can put secrets in its text.
    // The variant alone says which step failed, so the dashboard can say
    // what to fix without echoing anything the server sent.
    let mut session = dbproxy_postgres::server::connect(&target, &[])
        .await
        .map_err(|error| login_failure(&error))?;
    let powers = dbproxy_postgres::server::role_powers(&mut session.conn)
        .await
        .map_err(|_| FAILED)?;
    drop(session);
    db::record_connection_test(
        pool,
        &auth.user_id,
        auth.workspace_id.as_deref(),
        &row,
        powers.superuser,
    )
    .await
    .map_err(|_| INTERNAL)?;
    Ok(powers.superuser)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_login_step_has_its_own_code_and_never_echoes_the_server() {
        use dbproxy::upstream::DialError;
        use dbproxy_postgres::server::UpstreamError;
        let secret = "upstream-echoed-password-marker";
        for (error, code) in [
            (UpstreamError::NoTls, "SERVER_NO_TLS"),
            (UpstreamError::WeakLoginWithoutTls, "WEAK_LOGIN_WITHOUT_TLS"),
            (UpstreamError::Tls(secret.into()), "TLS_HANDSHAKE_FAILED"),
            (UpstreamError::Rejected(secret.into()), "LOGIN_REJECTED"),
            (
                UpstreamError::Dial(DialError::Unreachable),
                "SERVER_UNREACHABLE",
            ),
            (
                UpstreamError::Dial(DialError::Refused {
                    host: secret.into(),
                }),
                "PRIVATE_DESTINATION",
            ),
            (
                UpstreamError::Unsupported(secret.into()),
                "CONNECTION_FAILED",
            ),
        ] {
            let (_, got, message) = login_failure(&error);
            assert_eq!(got, code);
            assert!(!message.contains(secret));
        }
    }
    #[test]
    fn per_user_rate_is_bounded_and_expires() {
        let now = Instant::now();
        for _ in 0..5 {
            assert!(claim_rate("rate-test", now).is_ok());
        }
        assert_eq!(claim_rate("rate-test", now).unwrap_err().1, "RATE_LIMITED");
        assert!(claim_rate("other-user", now).is_ok());
        assert!(claim_rate("rate-test", now + WINDOW).is_ok());
    }
    #[tokio::test]
    async fn error_contract_is_nested_and_safe() {
        let response = failure(FAILED);
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["error"]["code"], "CONNECTION_FAILED");
        assert_eq!(value["error"]["details"], serde_json::json!([]));
    }
}
