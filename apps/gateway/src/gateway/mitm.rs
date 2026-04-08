//! MITM TLS interception: terminate TLS with the client using a generated
//! leaf certificate, then forward HTTP requests to the real upstream server.

use std::sync::Arc;

use anyhow::{Context, Result};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio_rustls::TlsAcceptor;

use crate::ca::CertificateAuthority;
use crate::cache::CacheStore;
use crate::inject::InjectionRule;
use crate::policy::PolicyRule;

use super::forward;

/// Terminate TLS with the client, then forward each HTTP request through
/// [`forward::forward_request`] which applies injection and policy rules.
#[allow(clippy::too_many_arguments)]
pub(super) async fn mitm(
    upgraded: hyper::upgrade::Upgraded,
    host: &str,
    ca: &CertificateAuthority,
    http_client: reqwest::Client,
    injection_rules: Vec<InjectionRule>,
    policy_rules: Vec<PolicyRule>,
    cache: Arc<dyn CacheStore>,
    agent_token: String,
) -> Result<()> {
    let hostname = super::strip_port(host);

    let server_config = ca.server_config_for_host(hostname)?;
    let acceptor = TlsAcceptor::from(server_config);

    // Upgraded → TokioIo (hyper→tokio) → TLS accept → TokioIo (tokio→hyper)
    let client_io = TokioIo::new(upgraded);
    let tls_stream = acceptor
        .accept(client_io)
        .await
        .context("TLS handshake with client")?;

    // Serve HTTP/1.1 on the decrypted TLS stream.
    // The client thinks it's talking to the real server.
    let host_owned = host.to_string();
    let injection_rules = Arc::new(injection_rules);
    let policy_rules = Arc::new(policy_rules);
    let agent_token = Arc::new(agent_token);
    let io = TokioIo::new(tls_stream);

    http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(
            io,
            service_fn(move |req| {
                let host = host_owned.clone();
                let client = http_client.clone();
                let inj_rules = Arc::clone(&injection_rules);
                let pol_rules = Arc::clone(&policy_rules);
                let cache = Arc::clone(&cache);
                let token = Arc::clone(&agent_token);
                async move {
                    forward::forward_request(
                        req, &host, "https", client, &inj_rules, &pol_rules, &*cache, &token,
                    )
                    .await
                }
            }),
        )
        .await
        .context("serving MITM connection")
}
