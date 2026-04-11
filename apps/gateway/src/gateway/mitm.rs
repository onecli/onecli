//! MITM TLS interception: terminate TLS with the client using a generated
//! leaf certificate, then forward HTTP requests to the real upstream server.
//!
//! Rules (injection + policy) are re-resolved from cache on each HTTP request
//! so that changes (e.g., adding a secret) take effect immediately without
//! requiring the agent to reconnect.

use std::sync::Arc;

use anyhow::{Context, Result};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio_rustls::TlsAcceptor;
use tracing::warn;

use crate::approval::ApprovalStore;
use crate::ca::CertificateAuthority;
use crate::cache::CacheStore;
use crate::connect::{self, PolicyEngine};
use crate::inject::InjectionRule;

use super::forward;
use super::response;
use super::ProxyContext;

/// Terminate TLS with the client, then forward each HTTP request through
/// [`forward::forward_request`] with freshly resolved rules from cache.
#[allow(clippy::too_many_arguments)]
pub(super) async fn mitm(
    upgraded: hyper::upgrade::Upgraded,
    host: &str,
    ca: &CertificateAuthority,
    http_client: reqwest::Client,
    vault_injection_rules: Vec<InjectionRule>,
    cache: Arc<dyn CacheStore>,
    proxy_ctx: Arc<ProxyContext>,
    approval_store: Arc<dyn ApprovalStore>,
    policy_engine: Arc<PolicyEngine>,
) -> Result<()> {
    let hostname = super::strip_port(host);

    let server_config = ca.server_config_for_host(hostname)?;
    let acceptor = TlsAcceptor::from(server_config);

    let client_io = TokioIo::new(upgraded);
    let tls_stream = acceptor
        .accept(client_io)
        .await
        .context("TLS handshake with client")?;

    let host_owned = host.to_string();
    let vault_injection_rules = Arc::new(vault_injection_rules);
    let io = TokioIo::new(tls_stream);

    http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(
            io,
            service_fn(move |req| {
                let host = host_owned.clone();
                let client = http_client.clone();
                let cache = Arc::clone(&cache);
                let ctx = Arc::clone(&proxy_ctx);
                let approvals = Arc::clone(&approval_store);
                let engine = Arc::clone(&policy_engine);
                let vault_rules = Arc::clone(&vault_injection_rules);
                async move {
                    // Re-resolve rules from cache on each request so that
                    // secret/rule changes take effect without a reconnect.
                    let hostname = super::strip_port(&host);
                    let (inj_rules, pol_rules) = match resolve_rules(
                        &ctx,
                        hostname,
                        &engine,
                        &*cache,
                        &vault_rules,
                    )
                    .await
                    {
                        Ok(rules) => rules,
                        Err(e) => {
                            warn!(host = %host, error = ?e, "rule resolution failed mid-session");
                            return Ok(response::resolution_failed());
                        }
                    };

                    forward::forward_request(
                        req, &host, "https", client, &inj_rules, &pol_rules, &*cache, &ctx,
                        &approvals,
                    )
                    .await
                }
            }),
        )
        .await
        .context("serving MITM connection")
}

/// Resolve injection + policy rules from cache, falling back to vault rules
/// if no DB secrets or app connections are configured for this host.
async fn resolve_rules(
    ctx: &ProxyContext,
    hostname: &str,
    engine: &PolicyEngine,
    cache: &dyn CacheStore,
    vault_rules: &[InjectionRule],
) -> Result<(Vec<InjectionRule>, Vec<crate::policy::PolicyRule>), crate::connect::ConnectError> {
    let account_id = ctx.account_id.as_deref().unwrap_or("");
    let agent_token = ctx.agent_token.as_deref().unwrap_or("");

    let resp =
        connect::resolve_from_cache(account_id, agent_token, hostname, engine, cache).await?;

    let injection_rules = if resp.injection_rules.is_empty() && !vault_rules.is_empty() {
        vault_rules.to_vec()
    } else {
        resp.injection_rules
    };

    Ok((injection_rules, resp.policy_rules))
}
