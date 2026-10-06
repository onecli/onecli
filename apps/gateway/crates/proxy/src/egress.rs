//! Destination guard: the gateway never dials a non-public address on an
//! agent's behalf unless the operator explicitly allowed it.
//!
//! Host-pattern block rules match the host *string* an agent sends, which is
//! not where the connection goes: a DNS name can resolve to loopback, and the
//! same address has many spellings (`127.1`, `2130706433`, `[::ffff:127.0.0.1]`).
//! Without this guard any agent holding its own proxy token could reach
//! whatever the gateway can reach — the api-server, the dashboard, Postgres,
//! Redis, cloud metadata, the operator's LAN.
//!
//! So the check runs on the **resolved address**, at connect time:
//!
//! - HTTP/MITM: [`GuardedResolver`] is the `reqwest` DNS resolver. It drops
//!   refused addresses, and hyper dials only what it returns, so the checked
//!   address is the connected address (no DNS-rebinding window). IP-literal
//!   hosts skip resolvers entirely, so [`check_url`] covers them before send.
//! - WebSocket: [`connect_tcp`] resolves, filters, and dials the survivor.
//!
//! Addresses that embed an IPv4 inside IPv6 (mapped, compatible, NAT64, 6to4)
//! are judged by the embedded IPv4.
//!
//! Operators reach internal services with `GATEWAY_ALLOW_PRIVATE_DESTINATIONS`
//! (CIDRs, IPs, hostnames, `*.suffix`). Cloud-metadata addresses are never
//! opened by a CIDR or hostname entry — only by naming the exact IP.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, OnceLock};

use tokio::net::TcpStream;
use tracing::{info, warn};

/// The environment variable operators set to allow internal destinations.
pub const ALLOW_ENV: &str = "GATEWAY_ALLOW_PRIVATE_DESTINATIONS";

/// Why an address is not public.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restricted {
    /// Loopback, unspecified, private, CGNAT, ULA, multicast, reserved…
    /// Opened by any matching allowlist entry.
    Internal,
    /// Link-local and cloud instance-metadata ranges. Opened only by an
    /// allowlist entry naming the exact address.
    Metadata,
}

/// The error the guard raises when it refuses a destination. Detected up the
/// error chain with [`find_refusal`] so callers can answer with a clear 403
/// that names the refused host.
#[derive(Debug)]
pub struct DestinationNotAllowed {
    pub host: String,
}

impl fmt::Display for DestinationNotAllowed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "destination {} is not a public address (allow it with {ALLOW_ENV})",
            self.host
        )
    }
}

impl std::error::Error for DestinationNotAllowed {}

/// The guard refusal in `err` or its source chain, if any. `reqwest` wraps
/// the resolver's error several layers deep, so the chain walk is what lets
/// the forward path tell "refused" from "unreachable".
pub fn find_refusal<'a>(
    err: &'a (dyn std::error::Error + 'static),
) -> Option<&'a DestinationNotAllowed> {
    let mut cur = Some(err);
    while let Some(e) = cur {
        if let Some(refusal) = e.downcast_ref::<DestinationNotAllowed>() {
            return Some(refusal);
        }
        cur = e.source();
    }
    None
}

/// [`find_refusal`] for an `anyhow` chain.
pub fn find_refusal_anyhow(err: &anyhow::Error) -> Option<&DestinationNotAllowed> {
    err.chain()
        .find_map(|e| e.downcast_ref::<DestinationNotAllowed>())
}

// ── Classification ──────────────────────────────────────────────────────

/// If `v6` carries an IPv4 address (mapped, compatible, NAT64, 6to4), return
/// it — that is the address the traffic effectively reaches.
fn embedded_v4(v6: &Ipv6Addr) -> Option<Ipv4Addr> {
    let s = v6.segments();
    let tail = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
    // ::ffff:a.b.c.d (mapped)
    if s[..5] == [0, 0, 0, 0, 0] && s[5] == 0xffff {
        return Some(tail);
    }
    // ::a.b.c.d (deprecated compatible) — but `::` and `::1` are their own thing.
    if s[..6] == [0, 0, 0, 0, 0, 0] && (s[6] != 0 || s[7] > 1) {
        return Some(tail);
    }
    // 64:ff9b::/96 (well-known NAT64 prefix)
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return Some(tail);
    }
    // 2002::/16 (6to4): the IPv4 sits in bits 16..48.
    if s[0] == 0x2002 {
        return Some(Ipv4Addr::new(
            (s[1] >> 8) as u8,
            s[1] as u8,
            (s[2] >> 8) as u8,
            s[2] as u8,
        ));
    }
    None
}

/// Normalize: an IPv6 that embeds an IPv4 becomes that IPv4.
pub fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => embedded_v4(&v6).map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

fn in_v4(ip: Ipv4Addr, net: [u8; 4], prefix: u8) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    (u32::from(ip) & mask) == (u32::from(Ipv4Addr::from(net)) & mask)
}

fn in_v6(ip: Ipv6Addr, net: Ipv6Addr, prefix: u8) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    };
    (u128::from(ip) & mask) == (u128::from(net) & mask)
}

fn classify_v4(ip: Ipv4Addr) -> Option<Restricted> {
    if in_v4(ip, [169, 254, 0, 0], 16) {
        return Some(Restricted::Metadata);
    }
    const INTERNAL: &[([u8; 4], u8)] = &[
        ([0, 0, 0, 0], 8),       // "this network" / unspecified
        ([10, 0, 0, 0], 8),      // private
        ([100, 64, 0, 0], 10),   // CGNAT
        ([127, 0, 0, 0], 8),     // loopback
        ([172, 16, 0, 0], 12),   // private
        ([192, 0, 0, 0], 24),    // IETF protocol assignments
        ([192, 0, 2, 0], 24),    // documentation
        ([192, 88, 99, 0], 24),  // deprecated 6to4 relay anycast
        ([192, 168, 0, 0], 16),  // private
        ([198, 18, 0, 0], 15),   // benchmarking
        ([198, 51, 100, 0], 24), // documentation
        ([203, 0, 113, 0], 24),  // documentation
        ([224, 0, 0, 0], 4),     // multicast
        ([240, 0, 0, 0], 4),     // reserved + broadcast
    ];
    INTERNAL
        .iter()
        .any(|(net, p)| in_v4(ip, *net, *p))
        .then_some(Restricted::Internal)
}

fn classify_v6(ip: Ipv6Addr) -> Option<Restricted> {
    // Link-local, and AWS's IPv6 metadata / pod-identity endpoints.
    const METADATA: [(Ipv6Addr, u8); 2] = [
        (Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10),
        (Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0), 32),
    ];
    if METADATA.iter().any(|(n, p)| in_v6(ip, *n, *p)) {
        return Some(Restricted::Metadata);
    }
    if ip.is_unspecified() || ip.is_loopback() {
        return Some(Restricted::Internal);
    }
    // (IPv4-embedding forms never reach here: `classify` canonicalizes them.)
    const INTERNAL: [(Ipv6Addr, u8); 8] = [
        (Ipv6Addr::new(0x100, 0, 0, 0, 0, 0, 0, 0), 64), // discard-only
        (Ipv6Addr::new(0x64, 0xff9b, 1, 0, 0, 0, 0, 0), 48), // local-use NAT64
        (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 32), // Teredo
        (Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32), // documentation
        (Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20), // documentation
        (Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7), // unique local
        (Ipv6Addr::new(0xfec0, 0, 0, 0, 0, 0, 0, 0), 10), // deprecated site-local
        (Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8), // multicast
    ];
    INTERNAL
        .iter()
        .any(|(n, p)| in_v6(ip, *n, *p))
        .then_some(Restricted::Internal)
}

/// `None` when the address is public; otherwise why it is restricted.
pub fn classify(ip: IpAddr) -> Option<Restricted> {
    match canonical(ip) {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => classify_v6(v6),
    }
}

// ── Operator allowlist ──────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
enum AllowEntry {
    Net { addr: IpAddr, prefix: u8 },
    Host(String),
    HostSuffix(String),
}

/// The effective destination policy: the fixed classifier plus the
/// operator's allowlist.
#[derive(Debug, Clone, Default)]
pub struct EgressPolicy {
    allow: Vec<AllowEntry>,
}

fn normalize_host(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

impl EgressPolicy {
    /// Parse a comma-separated allowlist. Invalid entries are skipped and
    /// returned so the caller can warn about them.
    pub fn parse(raw: &str) -> (Self, Vec<String>) {
        let mut allow = Vec::new();
        let mut invalid = Vec::new();
        for entry in raw.split(',').map(str::trim).filter(|e| !e.is_empty()) {
            match Self::parse_entry(entry) {
                Some(e) => allow.push(e),
                None => invalid.push(entry.to_string()),
            }
        }
        (Self { allow }, invalid)
    }

    fn parse_entry(entry: &str) -> Option<AllowEntry> {
        if let Some((addr, prefix)) = entry.split_once('/') {
            let addr = canonical(normalize_host(addr).parse::<IpAddr>().ok()?);
            let mut prefix: u8 = prefix.trim().parse().ok()?;
            // A mapped-IPv6 CIDR (::ffff:10.0.0.0/104) canonicalizes to IPv4.
            if addr.is_ipv4() && prefix > 32 {
                prefix = prefix.checked_sub(96)?;
            }
            let max = if addr.is_ipv4() { 32 } else { 128 };
            return (prefix <= max).then_some(AllowEntry::Net { addr, prefix });
        }
        let host = normalize_host(entry);
        if let Ok(ip) = host.parse::<IpAddr>() {
            let addr = canonical(ip);
            let prefix = if addr.is_ipv4() { 32 } else { 128 };
            return Some(AllowEntry::Net { addr, prefix });
        }
        if let Some(suffix) = host.strip_prefix("*.") {
            let valid = !suffix.is_empty() && !suffix.contains('*');
            return valid.then(|| AllowEntry::HostSuffix(format!(".{suffix}")));
        }
        let valid = !host.is_empty()
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_');
        valid.then_some(AllowEntry::Host(host))
    }

    /// The operator's policy, read from [`ALLOW_ENV`]. Logs what it loaded:
    /// the allowlist is a security boundary, so the boot line says whether
    /// one is in force and which entries it ignored.
    pub fn from_env() -> Self {
        let raw = std::env::var(ALLOW_ENV).unwrap_or_default();
        let (policy, invalid) = Self::parse(&raw);
        for entry in &invalid {
            warn!(entry = %entry, "{ALLOW_ENV}: ignoring invalid entry");
        }
        if policy.allow.is_empty() {
            info!("egress guard: non-public destinations are refused ({ALLOW_ENV} unset)");
        } else {
            info!(allow = ?policy.allow, "egress guard: operator allowlist loaded ({ALLOW_ENV})");
        }
        policy
    }

    fn host_allowed(&self, host: &str) -> bool {
        let host = normalize_host(host);
        self.allow.iter().any(|e| match e {
            AllowEntry::Host(h) => *h == host,
            AllowEntry::HostSuffix(s) => host.ends_with(s.as_str()) && host.len() > s.len(),
            AllowEntry::Net { .. } => false,
        })
    }

    fn net_allows(&self, ip: IpAddr, exact_only: bool) -> bool {
        self.allow.iter().any(|e| match (e, ip) {
            (
                AllowEntry::Net {
                    addr: IpAddr::V4(n),
                    prefix,
                },
                IpAddr::V4(ip),
            ) => (!exact_only || *prefix == 32) && in_v4(ip, n.octets(), *prefix),
            (
                AllowEntry::Net {
                    addr: IpAddr::V6(n),
                    prefix,
                },
                IpAddr::V6(ip),
            ) => (!exact_only || *prefix == 128) && in_v6(ip, *n, *prefix),
            _ => false,
        })
    }

    /// May the gateway dial `ip`, reached by asking for `host`?
    pub fn permits(&self, host: &str, ip: IpAddr) -> bool {
        let ip = canonical(ip);
        match classify(ip) {
            None => true,
            Some(Restricted::Internal) => self.host_allowed(host) || self.net_allows(ip, false),
            Some(Restricted::Metadata) => self.net_allows(ip, true),
        }
    }
}

/// The process-wide policy, read once from [`ALLOW_ENV`]. Call it at boot so
/// a malformed allowlist is reported before the first proxied request.
pub fn policy() -> &'static EgressPolicy {
    static POLICY: OnceLock<EgressPolicy> = OnceLock::new();
    POLICY.get_or_init(load_policy)
}

/// Production loader: the environment decides.
#[cfg(not(test))]
fn load_policy() -> EgressPolicy {
    EgressPolicy::from_env()
}

/// Test loader: this crate's unit tests forward to `127.0.0.1` stubs through
/// the production call sites, so loopback is allowed. Tests of the guard
/// itself build an explicit [`EgressPolicy`] instead of going through here.
#[cfg(test)]
fn load_policy() -> EgressPolicy {
    EgressPolicy::parse("127.0.0.0/8").0
}

// ── Environment proxy ───────────────────────────────────────────────────

/// The proxies `reqwest` picks up from the environment by default
/// (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, each in both cases). Two things
/// follow for the guard:
///
/// - The PROXY resolves the target, so [`GuardedResolver`] never sees the
///   target's name: the target has to be judged before send
///   ([`check_host_via_proxy`]).
/// - The proxy's own authority DOES go through [`GuardedResolver`] (reqwest
///   dials it with the same connector), and a corporate proxy usually sits on
///   a private address. It is the operator's chosen egress, not an agent's
///   destination, so the resolver exempts exactly those hosts.
#[derive(Debug, Default)]
struct EnvProxy {
    /// Lower-cased hostnames of the configured proxies, without port.
    hosts: Vec<String>,
}

impl EnvProxy {
    const VARS: [&'static str; 6] = [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ];

    fn from_env() -> Self {
        let hosts = Self::VARS
            .iter()
            .filter_map(|k| std::env::var(k).ok())
            .filter_map(|v| Self::host_of(&v))
            .collect();
        Self { hosts }
    }

    /// The host of a proxy URL as the environment spells it: with or without
    /// a scheme, with optional credentials and port. Mirrors how `hyper-util`
    /// reads the same variables (scheme-less values get `http://`).
    fn host_of(value: &str) -> Option<String> {
        let value = value.trim();
        if value.is_empty() {
            return None;
        }
        let with_scheme = if value.contains("://") {
            value.to_string()
        } else {
            format!("http://{value}")
        };
        let url = reqwest::Url::parse(&with_scheme).ok()?;
        url.host_str().map(normalize_host)
    }

    fn configured(&self) -> bool {
        !self.hosts.is_empty()
    }

    fn is_proxy_host(&self, host: &str) -> bool {
        self.hosts.contains(&normalize_host(host))
    }
}

fn env_proxy() -> &'static EnvProxy {
    static PROXY: OnceLock<EnvProxy> = OnceLock::new();
    PROXY.get_or_init(EnvProxy::from_env)
}

/// Whether the process routes upstream traffic through an environment proxy.
pub fn env_proxy_configured() -> bool {
    env_proxy().configured()
}

// ── Enforcement points ──────────────────────────────────────────────────

/// Pre-send check for IP-literal URLs, which bypass DNS resolvers. Uses the
/// WHATWG parse `reqwest` itself uses, so `2130706433` / `0x7f000001` / `127.1`
/// are judged as the `127.0.0.1` they become. Domain hosts pass here; the
/// resolver judges them.
pub fn check_url(policy: &EgressPolicy, url: &str) -> Result<(), DestinationNotAllowed> {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return Ok(());
    };
    // `host_str` is already WHATWG-normalized: `2130706433` reads back as
    // `127.0.0.1`, an IPv6 literal as `[…]`.
    let host = parsed.host_str().unwrap_or_default();
    let Ok(ip) = normalize_host(host).parse::<IpAddr>() else {
        return Ok(());
    };
    if policy.permits(host, ip) {
        Ok(())
    } else {
        Err(DestinationNotAllowed {
            host: host.to_string(),
        })
    }
}

/// Why [`resolve_checked`] produced no address to dial.
#[derive(Debug)]
pub enum ResolveError {
    /// Every address `host` resolved to is one the policy refuses.
    Refused(DestinationNotAllowed),
    /// The lookup itself failed (NXDOMAIN, resolver down…).
    Lookup(std::io::Error),
}

impl fmt::Display for ResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(refusal) => refusal.fmt(f),
            Self::Lookup(err) => write!(f, "resolving the upstream host: {err}"),
        }
    }
}

impl std::error::Error for ResolveError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            // The refusal stays in the chain so `find_refusal` sees it from
            // under reqwest's own wrapping.
            Self::Refused(refusal) => Some(refusal),
            Self::Lookup(err) => Some(err),
        }
    }
}

/// Resolve `host` and keep only addresses the policy permits. Refuses when
/// nothing survives. The returned addresses are the ones to dial.
pub async fn resolve_checked(
    policy: &EgressPolicy,
    host: &str,
    port: u16,
) -> Result<Vec<SocketAddr>, ResolveError> {
    let bare = normalize_host(host);
    let resolved: Vec<SocketAddr> = match bare.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => tokio::net::lookup_host((bare.as_str(), port))
            .await
            .map_err(ResolveError::Lookup)?
            .collect(),
    };
    let permitted: Vec<SocketAddr> = resolved
        .iter()
        .copied()
        .filter(|a| policy.permits(&bare, a.ip()))
        .collect();
    if permitted.is_empty() && !resolved.is_empty() {
        warn!(host = %bare, "egress guard: refused non-public destination");
        return Err(ResolveError::Refused(DestinationNotAllowed { host: bare }));
    }
    Ok(permitted)
}

/// `reqwest` DNS resolver that applies the guard. Every name the upstream
/// clients resolve passes through here, so hyper only ever dials a checked
/// address. The one name it does not judge is the operator's own environment
/// proxy (see [`EnvProxy`]).
#[derive(Debug, Default, Clone)]
pub struct GuardedResolver;

impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addrs = if env_proxy().is_proxy_host(&host) {
                tokio::net::lookup_host((host.as_str(), 0))
                    .await
                    .map_err(ResolveError::Lookup)?
                    .collect()
            } else {
                resolve_checked(policy(), &host, 0).await?
            };
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// The resolver as `reqwest::ClientBuilder::dns_resolver` wants it.
pub fn resolver() -> Arc<GuardedResolver> {
    Arc::new(GuardedResolver)
}

/// Pre-send check of a named host for the environment-proxy case. Not pinned
/// (the proxy re-resolves), so it narrows rather than closes the rebinding
/// window — the price of an operator-chosen upstream proxy.
pub async fn check_host_via_proxy(host: &str) -> Result<(), DestinationNotAllowed> {
    // IP literals (incl. every `[v6]` form) were already judged by `check_url`.
    if host.starts_with('[') {
        return Ok(());
    }
    let name = common::util::strip_port(host);
    match resolve_checked(policy(), name, 0).await {
        Err(ResolveError::Refused(refusal)) => Err(refusal),
        // Resolution failures are the proxy's to report.
        Err(ResolveError::Lookup(_)) | Ok(_) => Ok(()),
    }
}

/// Guarded replacement for `TcpStream::connect((host, port))`.
pub async fn connect_tcp(host: &str, port: u16) -> anyhow::Result<TcpStream> {
    let addrs = resolve_checked(policy(), host, port).await?;
    let mut last_err = None;
    for addr in addrs {
        match TcpStream::connect(addr).await {
            Ok(stream) => return Ok(stream),
            Err(e) => last_err = Some(e),
        }
    }
    Err(match last_err {
        Some(e) => anyhow::Error::new(e),
        None => anyhow::anyhow!("no addresses resolved for {host}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn strict() -> EgressPolicy {
        EgressPolicy::default()
    }

    #[test]
    fn public_addresses_pass() {
        for a in [
            "8.8.8.8",
            "1.1.1.1",
            "140.82.112.3",
            "2606:4700::1111",
            "2a00:1450::1",
        ] {
            assert_eq!(classify(ip(a)), None, "{a}");
            assert!(strict().permits("example.com", ip(a)), "{a}");
        }
    }

    #[test]
    fn loopback_and_internal_v4_are_refused() {
        for a in [
            "127.0.0.1",
            "127.0.0.2",
            "127.255.255.254",
            "0.0.0.0",
            "0.1.2.3",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "100.64.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "240.0.0.1",
            "198.18.0.1",
            "192.0.0.8",
        ] {
            assert_eq!(classify(ip(a)), Some(Restricted::Internal), "{a}");
            assert!(!strict().permits("x", ip(a)), "{a}");
        }
        // Boundaries just outside the private ranges stay public.
        for a in [
            "172.15.255.255",
            "172.32.0.0",
            "100.63.255.255",
            "100.128.0.0",
            "11.0.0.0",
        ] {
            assert_eq!(classify(ip(a)), None, "{a}");
        }
    }

    #[test]
    fn metadata_ranges_are_their_own_class() {
        for a in [
            "169.254.169.254",
            "169.254.170.2",
            "169.254.0.1",
            "fe80::1",
            "fd00:ec2::254",
        ] {
            assert_eq!(classify(ip(a)), Some(Restricted::Metadata), "{a}");
        }
    }

    #[test]
    fn internal_v6_is_refused() {
        for a in [
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "ff02::1",
            "2001:db8::1",
            "fec0::1",
        ] {
            assert!(classify(ip(a)).is_some(), "{a}");
        }
    }

    #[test]
    fn ipv6_embeddings_are_judged_by_their_ipv4() {
        // The report's bypass: IPv4-mapped loopback.
        for a in [
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
            "::127.0.0.1",
            "64:ff9b::127.0.0.1",
            "2002:7f00:1::",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
        ] {
            assert!(classify(ip(a)).is_some(), "{a}");
            assert!(!strict().permits("x", ip(a)), "{a}");
        }
        assert_eq!(
            classify(ip("::ffff:169.254.169.254")),
            Some(Restricted::Metadata)
        );
        // An embedded PUBLIC address is public.
        assert_eq!(classify(ip("::ffff:8.8.8.8")), None);
        assert_eq!(classify(ip("64:ff9b::8.8.8.8")), None);
    }

    #[test]
    fn allowlist_opens_cidrs_ips_and_hosts() {
        let (p, invalid) =
            EgressPolicy::parse(" 10.0.0.0/8 , 127.0.0.1, jira.corp., *.internal.example ");
        assert!(invalid.is_empty());
        assert!(p.permits("x", ip("10.20.30.40")));
        assert!(
            p.permits("x", ip("::ffff:10.20.30.40")),
            "mapped form of an allowed IP"
        );
        assert!(p.permits("x", ip("127.0.0.1")));
        assert!(!p.permits("x", ip("127.0.0.2")), "a bare IP is exact");
        assert!(p.permits("JIRA.corp", ip("192.168.1.5")));
        assert!(p.permits("jira.corp.", ip("192.168.1.5")));
        assert!(p.permits("wiki.internal.example", ip("172.20.0.3")));
        assert!(
            !p.permits("internal.example", ip("172.20.0.3")),
            "suffix needs a label"
        );
        assert!(!p.permits("other.corp", ip("192.168.1.5")));
    }

    #[test]
    fn metadata_needs_an_exact_ip_entry() {
        let (broad, _) = EgressPolicy::parse("169.254.0.0/16,fe80::/10,0.0.0.0/0,*.aws,imds.aws");
        assert!(!broad.permits("imds.aws", ip("169.254.169.254")));
        assert!(!broad.permits("x", ip("169.254.170.2")));
        assert!(!broad.permits("x", ip("fe80::1")));
        let (exact, _) = EgressPolicy::parse("169.254.169.254");
        assert!(exact.permits("x", ip("169.254.169.254")));
        assert!(!exact.permits("x", ip("169.254.170.2")));
    }

    #[test]
    fn invalid_entries_are_reported_not_applied() {
        let (p, invalid) = EgressPolicy::parse("10.0.0.0/33,not a host,*,*.,ok.host,::1/129");
        assert_eq!(
            invalid,
            vec!["10.0.0.0/33", "not a host", "*", "*.", "::1/129"]
        );
        assert!(p.permits("ok.host", ip("10.0.0.1")));
        assert!(!p.permits("x", ip("10.0.0.1")));
    }

    #[test]
    fn check_url_catches_every_loopback_spelling() {
        for url in [
            "http://127.0.0.1:10254/api/agents",
            "http://127.1/",
            "http://0177.0.0.1/",
            "http://127.0.1/",
            "http://2130706433/",
            "http://0x7f000001/",
            "http://0xa9fea9fe/",
            "http://0251.0376.0251.0376/",
            "http://0.0.0.0:10256/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]:10254/api/health",
            "http://[::ffff:7f00:1]/",
            "http://[0:0:0:0:0:ffff:169.254.169.254]/",
            "http://169.254.169.254/latest/meta-data/",
            "https://10.0.0.5:5432/",
        ] {
            assert!(check_url(&strict(), url).is_err(), "{url}");
        }
        assert!(check_url(&strict(), "https://8.8.8.8/").is_ok());
        // Domains are left to the resolver.
        assert!(check_url(&strict(), "http://localhost/").is_ok());
    }

    #[tokio::test]
    async fn resolver_refuses_names_that_resolve_internally() {
        for host in ["localhost", "localhost.", "127.0.0.1", "[::ffff:127.0.0.1]"] {
            let err = resolve_checked(&strict(), host, 80).await.unwrap_err();
            assert!(matches!(err, ResolveError::Refused(_)), "{host}: {err}");
            // The refused host is the normalized name, usable in the 403 body.
            assert!(find_refusal(&err).is_some(), "{host}: {err}");
        }
        let (p, _) = EgressPolicy::parse("localhost");
        assert!(!resolve_checked(&p, "localhost", 80)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn refusal_survives_reqwest_error_wrapping() {
        let client = reqwest::Client::builder()
            .dns_resolver(Arc::new(StrictResolver))
            .build()
            .unwrap();
        let err = client.get("http://localhost:9/").send().await.unwrap_err();
        let refusal = find_refusal(&err).unwrap_or_else(|| panic!("refusal lost in: {err:?}"));
        assert_eq!(refusal.host, "localhost");
    }

    #[test]
    fn env_proxy_host_is_read_the_way_reqwest_reads_it() {
        for (value, host) in [
            ("http://proxy.corp:3128", Some("proxy.corp")),
            ("https://user:pw@10.1.2.3:8080", Some("10.1.2.3")),
            ("proxy.corp:3128", Some("proxy.corp")),
            ("  Proxy.Corp  ", Some("proxy.corp")),
            ("socks5h://[fd00::1]:1080", Some("fd00::1")),
            ("", None),
            ("   ", None),
        ] {
            assert_eq!(EnvProxy::host_of(value).as_deref(), host, "{value:?}");
        }
        let proxy = EnvProxy {
            hosts: vec!["proxy.corp".to_string()],
        };
        assert!(proxy.configured());
        assert!(proxy.is_proxy_host("PROXY.corp"));
        assert!(!proxy.is_proxy_host("api.corp"));
        assert!(!EnvProxy::default().configured());
    }

    /// [`GuardedResolver`] with the production (strict) policy, which this
    /// crate's test loader deliberately relaxes for loopback.
    struct StrictResolver;
    impl reqwest::dns::Resolve for StrictResolver {
        fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
            let host = name.as_str().to_owned();
            Box::pin(async move {
                let addrs = resolve_checked(&EgressPolicy::default(), &host, 0).await?;
                Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
            })
        }
    }
}
