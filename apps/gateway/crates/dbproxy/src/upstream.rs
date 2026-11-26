//! The gateway's leg to the database server: a guarded dial, then TLS.
//!
//! Engine-agnostic. The dial goes through the same destination guard as
//! every other lane (`proxy::egress`), so a private address is refused unless
//! the operator allowed it, and the gateway's own data stores never are.
//! [`TlsMode`] decides how much of the server's certificate is checked, or,
//! for [`TlsMode::Disable`], that the engine adapter skips TLS altogether.
//! An engine adapter calls [`client_config`] with its own ALPN and runs its
//! own TLS negotiation on the returned stream.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use rustls::pki_types::CertificateDer;
use tokio::net::TcpStream;

use crate::target::{DbTarget, TlsMode};

/// Bound on the TCP dial, so a black-holed host answers in seconds.
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

/// Why the upstream could not be reached. Shown to the agent: the reason a
/// connection failed, never the stored host's resolution details.
#[derive(Debug)]
pub enum DialError {
    /// The destination guard refused the host (private, metadata, or one of
    /// the gateway's own data stores).
    Refused { host: String },
    /// Resolved and permitted, but nothing answered in time or the dial failed.
    Unreachable,
}

impl std::fmt::Display for DialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused { host } => write!(
                f,
                "the OneCLI gateway refused to connect to {host}: it resolves to a private or reserved address \
                 (an operator can allow internal destinations with {})",
                proxy::egress::ALLOW_ENV
            ),
            Self::Unreachable => f.write_str("the database server did not answer"),
        }
    }
}

impl std::error::Error for DialError {}

/// Dial the target's host and port through the destination guard.
pub async fn dial(target: &DbTarget) -> Result<TcpStream, DialError> {
    match tokio::time::timeout(
        DIAL_TIMEOUT,
        proxy::egress::connect_tcp(&target.host, target.port),
    )
    .await
    {
        Ok(Ok(stream)) => {
            // Interactive protocol: small messages, latency matters.
            let _ = stream.set_nodelay(true);
            crate::limits::enable_keepalive(&stream);
            Ok(stream)
        }
        Ok(Err(error)) => match proxy::egress::find_refusal_anyhow(&error) {
            Some(refusal) => Err(DialError::Refused {
                host: refusal.host.clone(),
            }),
            None => Err(DialError::Unreachable),
        },
        Err(_elapsed) => Err(DialError::Unreachable),
    }
}

/// The TLS client config for a target, advertising `alpn` (empty for none).
///
/// `verify-full` trusts the public web roots, or ONLY the connection's own CA
/// when it stored one (a private CA must not widen to every public one).
pub fn client_config(target: &DbTarget, alpn: &[&[u8]]) -> Result<Arc<rustls::ClientConfig>> {
    let builder = rustls::ClientConfig::builder();
    let mut config = match target.tls {
        TlsMode::Disable => bail!("this connection does not use TLS"),
        TlsMode::Require => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(ca::AcceptAnyServerCert))
            .with_no_client_auth(),
        TlsMode::VerifyFull => {
            let mut roots = rustls::RootCertStore::empty();
            match target.ca_certificate.as_deref() {
                Some(pem) => {
                    for cert in parse_pem_certificates(pem)? {
                        roots
                            .add(cert)
                            .context("the stored CA certificate is not a usable root")?;
                    }
                }
                None => roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned()),
            }
            builder.with_root_certificates(roots).with_no_client_auth()
        }
    };
    config.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
    Ok(Arc::new(config))
}

/// Every certificate in a PEM bundle; at least one.
fn parse_pem_certificates(pem: &str) -> Result<Vec<CertificateDer<'static>>> {
    let certs = rustls_pemfile::certs(&mut pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .context("the stored CA certificate is not valid PEM")?;
    anyhow::ensure!(
        !certs.is_empty(),
        "the stored CA certificate holds no certificate"
    );
    Ok(certs)
}

/// The server name TLS authenticates and sends as SNI. Managed providers
/// (Neon, Supabase poolers) route on SNI, so it is the stored host verbatim.
pub fn server_name(target: &DbTarget) -> Result<rustls::pki_types::ServerName<'static>> {
    rustls::pki_types::ServerName::try_from(target.host.clone())
        .context("the stored host is not a valid TLS server name")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(tls: TlsMode, ca: Option<&str>) -> DbTarget {
        DbTarget {
            host: "db.example.com".into(),
            port: 5432,
            database: "app".into(),
            username: "agent".into(),
            password: "pw".into(),
            tls,
            ca_certificate: ca.map(str::to_string),
        }
    }

    fn install_provider() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    #[test]
    fn every_mode_builds_with_the_requested_alpn() {
        install_provider();
        for mode in [TlsMode::VerifyFull, TlsMode::Require] {
            let config = client_config(&target(mode, None), &[b"postgresql"]).unwrap();
            assert_eq!(
                config.alpn_protocols,
                vec![b"postgresql".to_vec()],
                "{mode:?}"
            );
        }
    }

    #[test]
    fn a_stored_ca_must_be_a_certificate() {
        install_provider();
        assert!(client_config(&target(TlsMode::VerifyFull, Some("not pem")), &[]).is_err());
        assert!(client_config(
            &target(
                TlsMode::VerifyFull,
                Some("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n")
            ),
            &[]
        )
        .is_err());
    }

    #[test]
    fn ip_hosts_are_valid_server_names() {
        let mut t = target(TlsMode::Require, None);
        t.host = "10.0.0.5".into();
        assert!(server_name(&t).is_ok());
    }

    #[test]
    fn refusals_name_the_host_and_the_operator_knob() {
        let message = DialError::Refused {
            host: "10.0.0.5".into(),
        }
        .to_string();
        assert!(message.contains("10.0.0.5"));
        assert!(message.contains(proxy::egress::ALLOW_ENV));
    }
}
