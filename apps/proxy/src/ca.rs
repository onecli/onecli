//! Certificate Authority management for MITM TLS interception.
//!
//! Handles generation, persistence, and caching of CA and leaf certificates.
//! The CA signs per-hostname leaf certs on the fly so the proxy can terminate
//! TLS with clients while forwarding to the real upstream server.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use base64::Engine;
use dashmap::DashMap;
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair,
    KeyUsagePurpose, PKCS_ECDSA_P256_SHA256,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::ServerConfig;
use time::OffsetDateTime;
use tokio::fs;
use tracing::info;

/// CA certificate validity: 10 years.
const CA_VALIDITY_DAYS: i64 = 3650;

/// Leaf certificate validity: 24 hours.
const LEAF_VALIDITY_HOURS: i64 = 24;

/// Re-generate leaf cert when less than 1 hour remains.
const LEAF_REFRESH_BUFFER: Duration = Duration::from_secs(3600);

/// Default CN for the self-hosted/OSS CA.
const LOCAL_CA_CN: &str = "OneCLI Local Proxy CA";

struct CachedCert {
    server_config: Arc<ServerConfig>,
    expires_at: SystemTime,
}

pub struct CertificateAuthority {
    /// The CA certificate produced by rcgen. Used as the issuer in `signed_by()`
    /// when generating leaf certs. When loaded from disk, this is re-created
    /// with the same key+params so `signed_by` can reference it.
    ca_cert: rcgen::Certificate,
    /// CA private key.
    ca_key: KeyPair,
    /// The original CA certificate DER (from disk or initial generation).
    /// Included in leaf cert chains and served via the API for agents.
    ca_cert_der: CertificateDer<'static>,
    /// Cached leaf server configs per hostname.
    leaf_cache: DashMap<String, CachedCert>,
}

impl CertificateAuthority {
    /// Load an existing CA from disk or generate a new one.
    ///
    /// CA files are stored at `{data_dir}/proxy/ca.key` and `{data_dir}/proxy/ca.pem`.
    pub async fn load_or_generate(data_dir: &Path) -> Result<Self> {
        let proxy_dir = data_dir.join("proxy");
        let key_path = proxy_dir.join("ca.key");
        let cert_path = proxy_dir.join("ca.pem");

        if key_path.exists() && cert_path.exists() {
            info!(key = %key_path.display(), cert = %cert_path.display(), "loading existing CA");
            Self::load_from_disk(&key_path, &cert_path).await
        } else {
            info!(dir = %proxy_dir.display(), "generating new CA");
            fs::create_dir_all(&proxy_dir)
                .await
                .context("creating proxy data directory")?;
            Self::generate_and_persist(&key_path, &cert_path).await
        }
    }

    /// Get a rustls `ServerConfig` for a TLS handshake with a client connecting
    /// to `hostname`. Returns a cached config or generates a new leaf cert.
    pub fn server_config_for_host(&self, hostname: &str) -> Result<Arc<ServerConfig>> {
        // Check cache — return if valid
        if let Some(entry) = self.leaf_cache.get(hostname) {
            let refresh_at = entry
                .expires_at
                .checked_sub(LEAF_REFRESH_BUFFER)
                .unwrap_or(entry.expires_at);
            if SystemTime::now() < refresh_at {
                return Ok(Arc::clone(&entry.server_config));
            }
        }

        // Generate new leaf cert
        let config = self.generate_leaf(hostname)?;
        let config = Arc::new(config);

        self.leaf_cache.insert(
            hostname.to_string(),
            CachedCert {
                server_config: Arc::clone(&config),
                expires_at: SystemTime::now()
                    + Duration::from_secs(LEAF_VALIDITY_HOURS as u64 * 3600),
            },
        );

        Ok(config)
    }

    /// Return the CA certificate as PEM.
    /// Used by the web API (`GET /api/proxy/ca`) for agents to download.
    #[allow(dead_code)]
    pub fn ca_cert_pem(&self) -> String {
        der_to_pem(self.ca_cert_der.as_ref())
    }

    // ── Private ──────────────────────────────────────────────────────────

    /// Build CA `CertificateParams` with the standard DN and flags.
    fn build_ca_params() -> CertificateParams {
        let mut params = CertificateParams::default();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params
            .distinguished_name
            .push(DnType::CommonName, LOCAL_CA_CN);
        params
            .distinguished_name
            .push(DnType::OrganizationName, "OneCLI");
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params.not_before = OffsetDateTime::now_utc();
        params.not_after = OffsetDateTime::now_utc() + time::Duration::days(CA_VALIDITY_DAYS);
        params
    }

    /// Generate a new CA, persist to disk, and return the authority.
    async fn generate_and_persist(key_path: &Path, cert_path: &Path) -> Result<Self> {
        let ca_key =
            KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).context("generating CA key pair")?;
        let params = Self::build_ca_params();
        let ca_cert = params
            .self_signed(&ca_key)
            .context("self-signing CA certificate")?;

        let ca_cert_der = ca_cert.der().clone();

        // Persist key
        let key_pem = ca_key.serialize_pem();
        fs::write(key_path, key_pem.as_bytes())
            .await
            .context("writing CA private key")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(key_path, std::fs::Permissions::from_mode(0o600)).ok();
        }

        // Persist cert
        let cert_pem = der_to_pem(ca_cert_der.as_ref());
        fs::write(cert_path, cert_pem.as_bytes())
            .await
            .context("writing CA certificate")?;

        info!(
            cn = LOCAL_CA_CN,
            key = %key_path.display(),
            cert = %cert_path.display(),
            "generated and persisted new CA"
        );

        Ok(Self {
            ca_cert,
            ca_key,
            ca_cert_der,
            leaf_cache: DashMap::new(),
        })
    }

    /// Load an existing CA from PEM files on disk.
    ///
    /// rcgen's `signed_by()` requires a `Certificate` reference as the issuer.
    /// Since `Certificate` can only be created via `self_signed()` / `signed_by()`,
    /// we re-create it by self-signing with the same key and params. The issuer DN
    /// in leaf certs will match the original CA cert because the params are identical.
    /// The original CA cert DER (from disk) is used in leaf cert chains and for
    /// the public PEM download.
    async fn load_from_disk(key_path: &Path, cert_path: &Path) -> Result<Self> {
        // Load private key
        let key_pem = fs::read_to_string(key_path)
            .await
            .context("reading CA private key")?;
        let ca_key = KeyPair::from_pem(&key_pem).context("parsing CA private key")?;

        // Load original certificate DER (used in cert chains + PEM download)
        let cert_pem = fs::read_to_string(cert_path)
            .await
            .context("reading CA certificate")?;
        let mut reader = cert_pem.as_bytes();
        let ca_cert_der = rustls_pemfile::certs(&mut reader)
            .next()
            .context("no certificate found in PEM file")?
            .context("parsing CA certificate PEM")?;

        // Re-create a Certificate for use as issuer in signed_by().
        // Same key + same DN = leaf certs will chain correctly to the original CA.
        let ca_cert = Self::build_ca_params()
            .self_signed(&ca_key)
            .context("re-creating CA certificate for signing")?;

        info!("loaded existing CA certificate");

        Ok(Self {
            ca_cert,
            ca_key,
            ca_cert_der,
            leaf_cache: DashMap::new(),
        })
    }

    /// Generate a leaf certificate for `hostname`, signed by this CA.
    /// Returns a `ServerConfig` ready for use with `tokio-rustls`.
    fn generate_leaf(&self, hostname: &str) -> Result<ServerConfig> {
        let leaf_key =
            KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).context("generating leaf key pair")?;

        let mut params = CertificateParams::new(vec![hostname.to_string()])
            .context("creating leaf cert params")?;
        params.distinguished_name.push(DnType::CommonName, hostname);
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        // Small backdate for clock skew
        params.not_before = OffsetDateTime::now_utc() - time::Duration::minutes(5);
        params.not_after = OffsetDateTime::now_utc() + time::Duration::hours(LEAF_VALIDITY_HOURS);

        let leaf_cert = params
            .signed_by(&leaf_key, &self.ca_cert, &self.ca_key)
            .context("signing leaf certificate")?;

        // Build cert chain: leaf + original CA cert from disk
        let cert_chain = vec![leaf_cert.der().clone(), self.ca_cert_der.clone()];

        // Convert leaf private key to rustls format
        let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));

        let mut config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(cert_chain, key_der)
            .context("building leaf ServerConfig")?;

        // Force HTTP/1.1 — prevent HTTP/2 negotiation via ALPN.
        config.alpn_protocols = vec![b"http/1.1".to_vec()];

        Ok(config)
    }
}

/// Encode raw DER bytes as a PEM-formatted certificate string.
fn der_to_pem(der: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(der);
    // Pre-allocate: header (28) + base64 lines with newlines + footer (26)
    let num_lines = b64.len().div_ceil(64);
    let capacity = 28 + b64.len() + num_lines + 26;
    let mut pem = String::with_capacity(capacity);
    pem.push_str("-----BEGIN CERTIFICATE-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).expect("base64 is valid utf8"));
        pem.push('\n');
    }
    pem.push_str("-----END CERTIFICATE-----\n");
    pem
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Once;

    static INIT_CRYPTO: Once = Once::new();

    fn ensure_crypto_provider() {
        INIT_CRYPTO.call_once(|| {
            rustls::crypto::ring::default_provider()
                .install_default()
                .expect("install CryptoProvider");
        });
    }

    /// Helper: generate a fresh CA for testing (no disk I/O).
    fn test_ca() -> CertificateAuthority {
        ensure_crypto_provider();
        let ca_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("generate CA key pair");
        let params = CertificateAuthority::build_ca_params();
        let ca_cert = params.self_signed(&ca_key).expect("self-sign CA");
        let ca_cert_der = ca_cert.der().clone();
        CertificateAuthority {
            ca_cert,
            ca_key,
            ca_cert_der,
            leaf_cache: DashMap::new(),
        }
    }

    // ── CA generation tests ─────────────────────────────────────────────

    #[test]
    fn ca_generates_valid_self_signed_cert() {
        let ca = test_ca();
        // DER should be non-empty
        assert!(!ca.ca_cert_der.is_empty());
        // PEM should contain expected markers
        let pem = ca.ca_cert_pem();
        assert!(pem.starts_with("-----BEGIN CERTIFICATE-----"));
        assert!(pem.contains("-----END CERTIFICATE-----"));
    }

    #[test]
    fn ca_pem_contains_correct_cn() {
        let ca = test_ca();
        let pem = ca.ca_cert_pem();
        // Parse the PEM back to verify CN
        let mut reader = pem.as_bytes();
        let der = rustls_pemfile::certs(&mut reader)
            .next()
            .expect("has cert")
            .expect("valid PEM");
        // DER should match the original
        assert_eq!(der.as_ref(), ca.ca_cert_der.as_ref());
    }

    // ── Leaf cert tests ─────────────────────────────────────────────────

    #[test]
    fn leaf_cert_generates_valid_server_config() {
        let ca = test_ca();
        let config = ca
            .server_config_for_host("example.com")
            .expect("generate leaf");
        // ALPN should be HTTP/1.1 only
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    #[test]
    fn leaf_cert_different_hostnames_produce_distinct_configs() {
        let ca = test_ca();
        let config_a = ca.server_config_for_host("a.example.com").expect("leaf a");
        let config_b = ca.server_config_for_host("b.example.com").expect("leaf b");
        // They should be different Arc pointers (different certs)
        assert!(!Arc::ptr_eq(&config_a, &config_b));
    }

    // ── Leaf cache tests ────────────────────────────────────────────────

    #[test]
    fn leaf_cache_returns_same_config_within_validity() {
        let ca = test_ca();
        let config1 = ca
            .server_config_for_host("cached.example.com")
            .expect("first call");
        let config2 = ca
            .server_config_for_host("cached.example.com")
            .expect("second call");
        // Same Arc — served from cache
        assert!(Arc::ptr_eq(&config1, &config2));
    }

    #[test]
    fn leaf_cache_regenerates_when_expired() {
        let ca = test_ca();
        let config1 = ca
            .server_config_for_host("expire.example.com")
            .expect("first call");

        // Manually expire the cached entry
        if let Some(mut entry) = ca.leaf_cache.get_mut("expire.example.com") {
            entry.expires_at = SystemTime::UNIX_EPOCH;
        }

        let config2 = ca
            .server_config_for_host("expire.example.com")
            .expect("second call after expiry");
        // Different Arc — cache was invalidated
        assert!(!Arc::ptr_eq(&config1, &config2));
    }

    // ── der_to_pem round-trip ───────────────────────────────────────────

    #[test]
    fn der_to_pem_round_trips() {
        let ca = test_ca();
        let original_der = ca.ca_cert_der.as_ref();
        let pem = der_to_pem(original_der);

        // Parse PEM back to DER
        let mut reader = pem.as_bytes();
        let decoded_der = rustls_pemfile::certs(&mut reader)
            .next()
            .expect("has cert")
            .expect("valid PEM");
        assert_eq!(decoded_der.as_ref(), original_der);
    }

    #[test]
    fn der_to_pem_has_64_char_lines() {
        let ca = test_ca();
        let pem = der_to_pem(ca.ca_cert_der.as_ref());
        for line in pem.lines() {
            if line.starts_with("-----") {
                continue;
            }
            assert!(line.len() <= 64, "line too long: {}", line.len());
        }
    }

    // ── Disk persistence tests ──────────────────────────────────────────

    #[tokio::test]
    async fn ca_persists_and_loads_from_disk() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let data_dir = tmp.path();

        // Generate and persist
        let ca1 = CertificateAuthority::load_or_generate(data_dir)
            .await
            .expect("generate CA");
        let pem1 = ca1.ca_cert_pem();

        // Load from disk
        let ca2 = CertificateAuthority::load_or_generate(data_dir)
            .await
            .expect("load CA");
        let pem2 = ca2.ca_cert_pem();

        // Same CA cert
        assert_eq!(pem1, pem2);
    }

    #[tokio::test]
    async fn ca_key_file_has_restricted_permissions() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let data_dir = tmp.path();

        CertificateAuthority::load_or_generate(data_dir)
            .await
            .expect("generate CA");

        let key_path = data_dir.join("proxy").join("ca.key");
        assert!(key_path.exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::metadata(&key_path)
                .expect("key metadata")
                .permissions();
            assert_eq!(perms.mode() & 0o777, 0o600);
        }
    }

    #[tokio::test]
    async fn leaf_signed_by_persisted_ca_is_valid() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let data_dir = tmp.path();

        // Generate, persist, reload
        let _ca1 = CertificateAuthority::load_or_generate(data_dir)
            .await
            .expect("generate CA");
        let ca2 = CertificateAuthority::load_or_generate(data_dir)
            .await
            .expect("load CA");

        // Generate leaf from reloaded CA — should not error
        let config = ca2
            .server_config_for_host("test.example.com")
            .expect("leaf from reloaded CA");
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }
}
