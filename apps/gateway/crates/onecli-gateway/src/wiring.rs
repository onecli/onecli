//! Composition root: runtime backend selection.
//!
//! The one place shared infrastructure is wired to its licensed backends.
//! Selection is by config presence (`REDIS_HOST`), never per-request — the
//! shared modules (`cache`, `approval`) define the traits and the in-memory
//! implementations and never reach into `ee/`; this module makes the choice
//! on behalf of `main`.

use std::sync::Arc;

use anyhow::Result;

use approval::ApprovalStore;
use cache::CacheStore;
use crypto::CryptoService;

/// Create the cache store for this deployment.
///
/// With `REDIS_HOST` set, connects to Redis via `REDIS_HOST`, `REDIS_PORT`,
/// `REDIS_PASSWORD`. Uses `rediss://` (TLS) by default; set `REDIS_TLS=false`
/// for local dev (plain Docker Redis without TLS). Without `REDIS_HOST`, falls
/// back to the in-memory store (single-instance deployments, unit tests). The
/// Redis backend is licensed multi-instance operation and lives in
/// `crate::ee::ha`; unlicensed deployments never reach it — a Redis-configured
/// unlicensed gateway refuses to start (`crate::ee::ha::check_ha_entitlement`).
pub(crate) async fn create_cache_store() -> anyhow::Result<Arc<dyn CacheStore>> {
    // A blank REDIS_HOST counts as unset, matching check_ha_entitlement and
    // check_cloud_startup_env — `REDIS_HOST=` in an env file must not select
    // a Redis store pointed at an empty hostname.
    if !cache::redis_host_configured() {
        return Ok(cache::in_memory());
    }
    crate::ee::ha::redis_cache_store().await
}

/// Create the approval store for this deployment: Redis (+BLPOP delivery) when
/// `REDIS_HOST` is set, else the in-memory store with its cleanup task. Same
/// selection rule and licensing note as [`create_cache_store`].
pub(crate) async fn create_approval_store() -> anyhow::Result<Arc<dyn ApprovalStore>> {
    if cache::redis_host_configured() {
        return crate::ee::ha::redis_approval_store().await;
    }
    Ok(approval::in_memory())
}

/// Create the crypto service from the environment.
///
/// `SECRET_ENCRYPTION_KEY` set → local AES-256-GCM. Otherwise the KMS envelope
/// backend (licensed hosted-platform plumbing in `crate::ee::kms_crypto`):
/// AWS credentials and region come from the standard SDK chain (env vars,
/// instance metadata, ECS task role), and `KMS_KEY_ARN` is read at encrypt
/// time. Construction is either/or, never both; decrypt still dispatches per
/// ciphertext shape inside `CryptoService`.
pub(crate) async fn create_crypto_service() -> Result<CryptoService> {
    if let Ok(key_b64) = std::env::var("SECRET_ENCRYPTION_KEY") {
        return CryptoService::from_base64_key(&key_b64);
    }
    Ok(CryptoService::from_envelope_backend(Box::new(
        crate::ee::kms_crypto::KmsEnvelopeCrypto::from_env().await,
    )))
}

/// Install the cloud session validator when the edition + config select it.
///
/// The decision is [`crate::auth::use_cognito_sessions`]: `EDITION=cloud` AND
/// a non-blank `COGNITO_USER_POOL_ID`. Deliberately edition-gated — auth mode
/// must not switch on env residue (a stray pool id in a shared dev `.env`
/// must not flip a self-host onto Cognito). Installed once at startup; every
/// other configuration leaves the self-hosted session-cookie arm in place.
pub(crate) fn install_session_validator() {
    if crate::auth::use_cognito_sessions(
        crate::edition::edition(),
        crate::ee::cognito::configured(),
    ) {
        crate::auth::install_session_validator(Box::new(
            crate::ee::cognito::CognitoSessionValidator,
        ));
    }
}

/// Install the licensed role resolver when the edition + entitlement select
/// key-recheck enforcement (cloud, or a licensed self-host) — the decision is
/// [`crate::auth::enforce_key_rechecks`], unchanged and still table-tested.
/// With no resolver installed the role layer stands down (unlicensed onprem:
/// every active member of the org is trusted); LIVENESS stays unconditional
/// inside `auth` either way.
pub(crate) fn install_role_resolver() {
    if crate::auth::enforce_key_rechecks(crate::edition::edition(), crate::edition::entitled()) {
        crate::auth::install_role_resolver(Box::new(crate::ee::rbac::RbacRoleResolver));
    }
}

/// Install the budget spend sink. Unconditional: the licensed budget module
/// compiles into every edition and is inert without budget bindings, so the
/// sink is always present and a metered charge can never be dropped by a
/// missing installation.
pub(crate) fn install_spend_sink() {
    crate::telemetry::install_spend_sink(Box::new(crate::ee::budget::BudgetSpendSink));
}
