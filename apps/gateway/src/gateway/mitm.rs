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
use std::fmt;
use tokio_rustls::TlsAcceptor;
use tracing::warn;

use crate::approval::ApprovalStore;
use crate::ca::CertificateAuthority;
use crate::cache::CacheStore;
use crate::connect::{self, AppConnectionResult, ConnectionChoice, PolicyEngine};
use crate::db;
use crate::inject::InjectionRule;

use super::forward;
use super::response;
use super::ProxyContext;

/// Typed error context for TLS handshake failures with the client.
#[derive(Debug)]
struct TlsHandshakeWithClient;

impl fmt::Display for TlsHandshakeWithClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TLS handshake with client")
    }
}

impl std::error::Error for TlsHandshakeWithClient {}

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
        .context(TlsHandshakeWithClient)?;

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
                    let connection_id = connect::extract_connection_id(req.headers());

                    // Re-resolve rules from cache on each request so that
                    // secret/rule changes take effect without a reconnect.
                    let hostname = super::strip_port(&host);
                    match resolve_rules(
                        &ctx,
                        hostname,
                        &engine,
                        &*cache,
                        &vault_rules,
                        connection_id.as_deref(),
                    )
                    .await
                    {
                        Ok(ResolveResult::Resolved {
                            rules,
                            app_connections,
                        }) => {
                            match forward::forward_request(
                                req, &host, "https", client, &rules, &*cache, &ctx, &approvals,
                            )
                            .await
                            {
                                Ok(mut resp) => {
                                    connect::inject_connections_header(&mut resp, &app_connections);
                                    Ok(resp)
                                }
                                Err(e) => Err(e),
                            }
                        }
                        Ok(ResolveResult::Ambiguous(connections)) => {
                            Ok(response::multiple_connections(&connections))
                        }
                        Ok(ResolveResult::NotFound {
                            connection_id: cid,
                            connections,
                        }) => Ok(response::connection_not_found(&cid, &connections)),
                        Err(e) => {
                            warn!(host = %host, error = ?e, "rule resolution failed mid-session");
                            Ok(response::resolution_failed())
                        }
                    }
                }
            }),
        )
        .await
        .context("serving MITM connection")
}

/// Per-request resolved rules, bundled for passing to `forward_request`.
#[derive(Debug)]
pub(crate) struct ResolvedRules {
    pub injection_rules: Vec<InjectionRule>,
    pub policy_rules: Vec<crate::policy::PolicyRule>,
    pub access_restricted: bool,
}

/// Result of per-request rule resolution including app connection disambiguation.
enum ResolveResult {
    /// Rules resolved successfully, with the raw app connections for the response header.
    Resolved {
        rules: ResolvedRules,
        app_connections: Vec<db::AppConnectionRow>,
    },
    /// Multiple connections exist and no header was provided.
    Ambiguous(Vec<ConnectionChoice>),
    /// The requested connection ID was not found.
    NotFound {
        connection_id: String,
        connections: Vec<ConnectionChoice>,
    },
}

/// Resolve injection + policy rules from cache, with per-request app connection
/// disambiguation. Falls back to vault rules if no DB secrets or app connections
/// are configured for this host.
async fn resolve_rules(
    ctx: &ProxyContext,
    hostname: &str,
    engine: &PolicyEngine,
    cache: &dyn CacheStore,
    vault_rules: &[InjectionRule],
    connection_id: Option<&str>,
) -> Result<ResolveResult, crate::connect::ConnectError> {
    let account_id = ctx.account_id.as_deref().unwrap_or("");
    let agent_token = ctx.agent_token.as_deref().unwrap_or("");

    let resp =
        connect::resolve_from_cache(account_id, agent_token, hostname, engine, cache).await?;

    let mut injection_rules = resp.injection_rules; // from secrets

    // If no secret rules, try app connections (per-request disambiguation)
    if injection_rules.is_empty() && !resp.app_connections.is_empty() {
        match engine
            .resolve_app_injection_for_request(
                &resp.app_connections,
                hostname,
                connection_id,
                account_id,
                cache,
            )
            .await?
        {
            AppConnectionResult::Rules(rules) => injection_rules = rules,
            AppConnectionResult::Ambiguous { connections } => {
                return Ok(ResolveResult::Ambiguous(connections));
            }
            AppConnectionResult::NotFound { connections } => {
                return Ok(ResolveResult::NotFound {
                    connection_id: connection_id.unwrap_or("").to_string(),
                    connections,
                });
            }
            AppConnectionResult::NoConnections => {}
        }
    }

    // Vault fallback
    if injection_rules.is_empty() && !vault_rules.is_empty() {
        injection_rules = vault_rules.to_vec();
    }

    Ok(ResolveResult::Resolved {
        rules: ResolvedRules {
            injection_rules,
            policy_rules: resp.policy_rules,
            access_restricted: resp.access_restricted,
        },
        app_connections: resp.app_connections,
    })
}
