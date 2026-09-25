//! Upstream name resolution, one query per address family.
//!
//! The gateway ships on musl (`docker/gateway.Dockerfile`), and musl validates
//! the A and AAAA answers as a pair before reading either: `name_from_dns`
//! loops over both replies and returns `EAI_AGAIN` the moment one carries
//! SERVFAIL, throwing away a perfectly good A answer along with the failed
//! AAAA one. A host whose nameserver SERVFAILs or times out on AAAA — a common
//! misconfiguration — is therefore unreachable, and the forward path reports it
//! as a 502 (#424).
//!
//! So resolution happens here instead of in `getaddrinfo`: a query per family,
//! and a family that fails is dropped rather than sinking the lookup. Only the
//! loss of *both* is an error.

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, OnceLock};

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use hickory_resolver::TokioResolver;
use tracing::warn;

/// A single DNS query, for a single address family.
///
/// This seam exists so the fallback below is testable without a network or a
/// nameserver: tests implement it with canned answers.
#[async_trait]
pub trait FamilyResolver: Send + Sync {
    /// Resolve `host`'s AAAA records when `v6` is set, its A records otherwise.
    async fn lookup(&self, host: &str, v6: bool) -> Result<Vec<IpAddr>>;
}

/// Resolve `host` over both families.
///
/// IPv4 leads the result: the deployment #424 was reported from has no global
/// IPv6 address, and hyper takes the head of this list as its family
/// preference, so leading with AAAA would stall every connection on an
/// unreachable address first.
pub async fn resolve_with_fallback(
    resolver: &dyn FamilyResolver,
    host: &str,
) -> Result<Vec<IpAddr>> {
    let mut addrs = Vec::new();
    for v6 in [false, true] {
        match resolver.lookup(host, v6).await {
            Ok(found) => addrs.extend(found),
            // Not fatal on its own — which is the entire point. The other
            // family may still answer, and one answer is enough to connect.
            Err(e) => warn!(host = %host, v6, error = %e, "address family did not resolve"),
        }
    }
    if addrs.is_empty() {
        return Err(anyhow!("no A or AAAA records for {host}"));
    }
    Ok(addrs)
}

/// The system resolver, querying the nameservers from `/etc/resolv.conf`
/// itself instead of going through `getaddrinfo`. Sidestepping libc is what
/// makes the per-family fallback above possible at all: `getaddrinfo` exposes
/// no way to ask for one family and keep the answer when the other fails.
#[derive(Clone)]
pub struct SystemResolver(Arc<TokioResolver>);

impl SystemResolver {
    fn from_system() -> Result<Self> {
        let resolver = TokioResolver::builder_tokio()
            .context("reading the system resolver configuration")?
            .build()
            .context("building the system resolver")?;
        Ok(Self(Arc::new(resolver)))
    }
}

#[async_trait]
impl FamilyResolver for SystemResolver {
    async fn lookup(&self, host: &str, v6: bool) -> Result<Vec<IpAddr>> {
        let answer = if v6 {
            self.0.ipv6_lookup(host).await
        } else {
            self.0.ipv4_lookup(host).await
        }?;
        Ok(answer
            .answers()
            .iter()
            .filter_map(|record| record.data.ip_addr())
            .collect())
    }
}

/// The process-wide resolver, or `None` when the system configuration could
/// not be read.
///
/// Built once: it parses the system configuration and owns both a response
/// cache and its nameserver connections, none of which survive being rebuilt
/// per request. Same shape as `vault::onepassword_api`'s client singleton.
///
/// Degrading beats refusing to start. `resolv.conf` is operator input, and a
/// nameserver hickory will not parse — a scoped link-local address such as
/// `fe80::1%eth0` is enough — must not stop the gateway from serving traffic.
/// The cost is that #424 comes back on that host, so it is logged as such.
pub fn shared() -> Option<&'static SystemResolver> {
    static RESOLVER: OnceLock<Option<SystemResolver>> = OnceLock::new();
    RESOLVER
        .get_or_init(|| match SystemResolver::from_system() {
            Ok(resolver) => Some(resolver),
            Err(e) => {
                warn!(
                    error = ?e,
                    "system resolver unavailable, falling back to getaddrinfo: \
                     a SERVFAIL on one address family will fail the whole lookup",
                );
                None
            }
        })
        .as_ref()
}

/// Dial-ready addresses for `host:port`, over whichever families resolve.
///
/// The libc arm is reached only when the resolver itself could not be built —
/// never because a lookup failed — so a host that resolves keeps the #424 fix.
pub async fn upstream_addrs(host: &str, port: u16) -> Result<Vec<SocketAddr>> {
    // An IP literal has nothing to look up, and asking a nameserver about one
    // only fails. Hyper short-circuits these before they reach a resolver at
    // all; this path is not behind hyper, so it needs its own guard.
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }

    match shared() {
        Some(resolver) => Ok(resolve_with_fallback(resolver, host)
            .await?
            .into_iter()
            .map(|ip| SocketAddr::new(ip, port))
            .collect()),
        None => Ok(tokio::net::lookup_host((host, port)).await?.collect()),
    }
}

impl reqwest::dns::Resolve for SystemResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let resolver = self.clone();
        Box::pin(async move {
            let addrs = resolve_with_fallback(&resolver, name.as_str()).await?;
            // Port 0 throughout: hyper's connector substitutes the real port,
            // exactly as it does for the `GaiResolver` this replaces.
            let addrs = addrs.into_iter().map(|ip| SocketAddr::new(ip, 0));
            Ok(Box::new(addrs) as reqwest::dns::Addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Canned per-family answers: no socket, no nameserver, no `resolv.conf`.
    struct FakeResolver {
        v4: Result<Vec<IpAddr>, &'static str>,
        v6: Result<Vec<IpAddr>, &'static str>,
    }

    #[async_trait]
    impl FamilyResolver for FakeResolver {
        async fn lookup(&self, _host: &str, v6: bool) -> Result<Vec<IpAddr>> {
            let answer = if v6 { &self.v6 } else { &self.v4 };
            answer.clone().map_err(|rcode| anyhow!("{rcode}"))
        }
    }

    /// The regression #424 is about: a nameserver that SERVFAILs on AAAA while
    /// answering A must not cost the gateway the IPv4 route.
    #[tokio::test]
    async fn aaaa_servfail_falls_back_to_ipv4() {
        let resolver = FakeResolver {
            v4: Ok(vec![IpAddr::from([93, 184, 216, 34])]),
            v6: Err("SERVFAIL"),
        };

        let addrs = resolve_with_fallback(&resolver, "yashir-agent.555.co.il")
            .await
            .expect("the A answer should still carry the lookup");

        assert_eq!(addrs, vec![IpAddr::from([93, 184, 216, 34])]);
    }

    /// A bare IP upstream must never become a DNS query. Reachable without a
    /// resolver at all, so this asserts the short-circuit, not the lookup.
    #[tokio::test]
    async fn ip_literal_upstream_skips_resolution() {
        let addrs = upstream_addrs("93.184.216.34", 443)
            .await
            .expect("an IP literal needs no nameserver");

        assert_eq!(addrs, vec![SocketAddr::from(([93, 184, 216, 34], 443))]);
    }

    /// The guard against over-correcting: tolerating the loss of one family
    /// must not tolerate the loss of both, or the forward path stops reporting
    /// a genuinely unresolvable host.
    #[tokio::test]
    async fn both_families_failing_is_still_an_error() {
        let resolver = FakeResolver {
            v4: Err("SERVFAIL"),
            v6: Err("SERVFAIL"),
        };

        assert!(resolve_with_fallback(&resolver, "nowhere.invalid")
            .await
            .is_err());
    }
}
