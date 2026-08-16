//! Shared upstream HTTP clients and transport limits.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};

/// Upstream TCP/TLS connect timeout in seconds; defaults to 10 seconds.
pub(crate) const CONNECT_TIMEOUT_SECS_ENV: &str = "GATEWAY_UPSTREAM_CONNECT_TIMEOUT_SECS";
/// Upstream `RequestBuilder::send()` timeout in seconds; defaults to 120
/// seconds. Request upload time counts against this budget, and response bodies
/// after headers are not bounded by it.
pub(crate) const RESPONSE_HEADER_TIMEOUT_SECS_ENV: &str =
    "GATEWAY_UPSTREAM_RESPONSE_HEADER_TIMEOUT_SECS";

const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_RESPONSE_HEADER_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct UpstreamTransportConfig {
    pub connect_timeout: Duration,
    pub response_header_timeout: Duration,
}

impl UpstreamTransportConfig {
    pub(crate) fn from_env() -> Result<Self> {
        Self::from_env_values(
            std::env::var(CONNECT_TIMEOUT_SECS_ENV).ok(),
            std::env::var(RESPONSE_HEADER_TIMEOUT_SECS_ENV).ok(),
        )
    }

    pub(crate) fn from_env_values(
        connect_timeout_secs: Option<String>,
        response_header_timeout_secs: Option<String>,
    ) -> Result<Self> {
        Ok(Self {
            connect_timeout: parse_positive_secs(
                CONNECT_TIMEOUT_SECS_ENV,
                connect_timeout_secs.as_deref(),
                DEFAULT_CONNECT_TIMEOUT,
            )?,
            response_header_timeout: parse_positive_secs(
                RESPONSE_HEADER_TIMEOUT_SECS_ENV,
                response_header_timeout_secs.as_deref(),
                DEFAULT_RESPONSE_HEADER_TIMEOUT,
            )?,
        })
    }
}

impl Default for UpstreamTransportConfig {
    fn default() -> Self {
        Self {
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            response_header_timeout: DEFAULT_RESPONSE_HEADER_TIMEOUT,
        }
    }
}

fn parse_positive_secs(name: &str, raw: Option<&str>, default: Duration) -> Result<Duration> {
    let Some(raw) = raw else {
        return Ok(default);
    };
    let secs: u64 = raw
        .trim()
        .parse()
        .with_context(|| format!("{name} must be a positive integer number of seconds"))?;
    if secs == 0 {
        bail!("{name} must be greater than zero");
    }
    Ok(Duration::from_secs(secs))
}

/// Whether an upstream client verifies server certificates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UpstreamTlsPolicy {
    Verify,
    NoVerify,
}

/// Pair of reqwest client slots. The slots are intentionally independent so a
/// timeout in the no-verify pool cannot change the verified pool, or vice versa.
#[derive(Clone)]
pub(crate) struct UpstreamClients {
    verify: Arc<UpstreamClientSlot>,
    no_verify: Arc<UpstreamClientSlot>,
}

impl UpstreamClients {
    pub(crate) fn new(
        config: UpstreamTransportConfig,
        verify_slot_accepts_invalid_certs: bool,
    ) -> Result<Self> {
        Ok(Self {
            verify: Arc::new(UpstreamClientSlot::new(
                verify_slot_accepts_invalid_certs,
                config,
            )?),
            no_verify: Arc::new(UpstreamClientSlot::new(true, config)?),
        })
    }

    pub(crate) fn lease(&self, policy: UpstreamTlsPolicy) -> UpstreamClientLease {
        match policy {
            UpstreamTlsPolicy::Verify => self.verify.lease(policy),
            UpstreamTlsPolicy::NoVerify => self.no_verify.lease(policy),
        }
    }

    #[cfg(test)]
    pub(crate) fn generation(&self, policy: UpstreamTlsPolicy) -> u64 {
        match policy {
            UpstreamTlsPolicy::Verify => self.verify.generation(),
            UpstreamTlsPolicy::NoVerify => self.no_verify.generation(),
        }
    }
}

struct UpstreamClientSlot {
    accept_invalid_certs: bool,
    config: UpstreamTransportConfig,
    inner: Mutex<ClientGeneration>,
}

impl UpstreamClientSlot {
    fn new(accept_invalid_certs: bool, config: UpstreamTransportConfig) -> Result<Self> {
        Ok(Self {
            accept_invalid_certs,
            config,
            inner: Mutex::new(ClientGeneration {
                generation: 0,
                client: build_http_client(accept_invalid_certs, config)?,
            }),
        })
    }

    fn lease(self: &Arc<Self>, policy: UpstreamTlsPolicy) -> UpstreamClientLease {
        let inner = self.inner.lock().expect("upstream client slot poisoned");
        UpstreamClientLease {
            policy,
            generation: inner.generation,
            client: inner.client.clone(),
            response_header_timeout: self.config.response_header_timeout,
            slot: Arc::clone(self),
        }
    }

    #[cfg(test)]
    fn generation(&self) -> u64 {
        self.inner
            .lock()
            .expect("upstream client slot poisoned")
            .generation
    }

    fn rotate_if_generation(&self, observed_generation: u64) -> Result<bool> {
        let mut inner = self.inner.lock().expect("upstream client slot poisoned");
        if inner.generation != observed_generation {
            return Ok(false);
        }
        inner.client = build_http_client(self.accept_invalid_certs, self.config)?;
        inner.generation = inner.generation.saturating_add(1);
        Ok(true)
    }
}

struct ClientGeneration {
    generation: u64,
    client: reqwest::Client,
}

#[derive(Clone)]
pub(crate) struct UpstreamClientLease {
    policy: UpstreamTlsPolicy,
    generation: u64,
    client: reqwest::Client,
    response_header_timeout: Duration,
    slot: Arc<UpstreamClientSlot>,
}

impl UpstreamClientLease {
    pub(crate) fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub(crate) fn policy(&self) -> UpstreamTlsPolicy {
        self.policy
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn response_header_timeout(&self) -> Duration {
        self.response_header_timeout
    }

    pub(crate) fn rotate_after_timeout(&self) -> Result<bool> {
        self.slot.rotate_if_generation(self.generation)
    }
}

pub(super) fn build_http_client(
    accept_invalid_certs: bool,
    config: UpstreamTransportConfig,
) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(config.connect_timeout)
        .danger_accept_invalid_certs(accept_invalid_certs)
        .build()
        .context("building upstream HTTP client")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_config_uses_safe_defaults() {
        let config = UpstreamTransportConfig::from_env_values(None, None).unwrap();
        assert_eq!(config.connect_timeout, Duration::from_secs(10));
        assert_eq!(config.response_header_timeout, Duration::from_secs(120));
    }

    #[test]
    fn transport_config_parses_positive_second_values() {
        let config =
            UpstreamTransportConfig::from_env_values(Some("3".into()), Some("7".into())).unwrap();
        assert_eq!(config.connect_timeout, Duration::from_secs(3));
        assert_eq!(config.response_header_timeout, Duration::from_secs(7));
    }

    #[test]
    fn transport_config_rejects_zero_values() {
        let err = UpstreamTransportConfig::from_env_values(Some("0".into()), None).unwrap_err();
        assert!(err.to_string().contains(CONNECT_TIMEOUT_SECS_ENV));

        let err = UpstreamTransportConfig::from_env_values(None, Some("0".into())).unwrap_err();
        assert!(err.to_string().contains(RESPONSE_HEADER_TIMEOUT_SECS_ENV));
    }

    #[test]
    fn transport_config_rejects_invalid_values() {
        let err = UpstreamTransportConfig::from_env_values(Some("ten".into()), None).unwrap_err();
        assert!(err.to_string().contains(CONNECT_TIMEOUT_SECS_ENV));
    }

    #[test]
    fn stale_generation_rotates_only_once() {
        let clients = UpstreamClients::new(UpstreamTransportConfig::default(), false).unwrap();
        let first = clients.lease(UpstreamTlsPolicy::Verify);
        let second = clients.lease(UpstreamTlsPolicy::Verify);

        assert!(first.rotate_after_timeout().unwrap());
        assert!(!second.rotate_after_timeout().unwrap());
        assert_eq!(clients.generation(UpstreamTlsPolicy::Verify), 1);
    }

    #[test]
    fn verified_and_no_verify_generations_are_independent() {
        let clients = UpstreamClients::new(UpstreamTransportConfig::default(), false).unwrap();
        let no_verify = clients.lease(UpstreamTlsPolicy::NoVerify);

        assert!(no_verify.rotate_after_timeout().unwrap());
        assert_eq!(clients.generation(UpstreamTlsPolicy::NoVerify), 1);
        assert_eq!(clients.generation(UpstreamTlsPolicy::Verify), 0);
    }
}
