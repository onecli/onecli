//! Optional, env-gated override of the Anthropic upstream.
//!
//! Some self-host installs must reach Claude through an organization proxy
//! (e.g. Azure API Management fronting Azure AI Foundry) that speaks the
//! NATIVE Anthropic Messages API on a different host, often under a path
//! prefix, and requires extra attribution headers. The harness inside a
//! sandbox hardcodes `api.anthropic.com`, and the gateway already MITMs that
//! traffic — so this is the one seam where the upstream can be swapped
//! without the agent knowing.
//!
//! Configuration (the feature is OFF unless the URL is set):
//! - `ANTHROPIC_UPSTREAM_URL` — absolute `https://host[/path-prefix]` base.
//!   Request paths are appended to the prefix (`/v1/messages` becomes
//!   `<prefix>/v1/messages`).
//! - `ANTHROPIC_UPSTREAM_EXTRA_HEADERS` — comma-separated `name:value` pairs
//!   added to every overridden request (e.g. APIM policy attribution
//!   headers). Invalid pairs are dropped with a warning.
//!
//! Scope: the override applies ONLY to requests whose effective host is
//! `api.anthropic.com`. Policy evaluation, telemetry, budgets and logging
//! all still see the original host — the swap happens at the final
//! upstream-URL construction, after every decision has been made.
//! Credential injection is unchanged: whatever secret the agent is granted
//! is spliced into `x-api-key` as always, so the stored "Anthropic" secret
//! should hold the proxy's key when this override is active.

use std::sync::LazyLock;

use hyper::header::{HeaderName, HeaderValue};
use tracing::warn;

/// The host whose traffic the override applies to.
pub const ANTHROPIC_HOST: &str = "api.anthropic.com";

#[derive(Debug)]
pub struct AnthropicUpstream {
    /// Upstream authority, e.g. `proxy.example.com`.
    pub host: String,
    /// Path prefix joined ahead of the request path; empty or `/…` with no
    /// trailing slash (e.g. `/aifoundry-sdk`).
    pub path_prefix: String,
    /// Extra headers added to every overridden request.
    pub extra_headers: Vec<(HeaderName, HeaderValue)>,
}

/// Parse `https://host[/prefix]` into (host, prefix). Only https is accepted:
/// this carries credentials to an external network.
fn parse_base_url(raw: &str) -> Option<(String, String)> {
    let rest = raw.trim().strip_prefix("https://")?;
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if host.is_empty() {
        return None;
    }
    let prefix = path.trim_end_matches('/');
    Some((host.to_string(), prefix.to_string()))
}

/// Parse `name:value,name:value` into typed header pairs, dropping (and
/// warning about) anything that is not a valid header name/value.
fn parse_extra_headers(raw: &str) -> Vec<(HeaderName, HeaderValue)> {
    raw.split(',')
        .filter_map(|pair| {
            let pair = pair.trim();
            if pair.is_empty() {
                return None;
            }
            let (name, value) = match pair.split_once(':') {
                Some(nv) => nv,
                None => {
                    warn!(
                        pair,
                        "ANTHROPIC_UPSTREAM_EXTRA_HEADERS entry has no ':' — dropped"
                    );
                    return None;
                }
            };
            let name = match HeaderName::from_bytes(name.trim().as_bytes()) {
                Ok(n) => n,
                Err(_) => {
                    warn!(
                        pair,
                        "invalid header name in ANTHROPIC_UPSTREAM_EXTRA_HEADERS — dropped"
                    );
                    return None;
                }
            };
            let value = match HeaderValue::from_str(value.trim()) {
                Ok(v) => v,
                Err(_) => {
                    warn!(
                        pair,
                        "invalid header value in ANTHROPIC_UPSTREAM_EXTRA_HEADERS — dropped"
                    );
                    return None;
                }
            };
            Some((name, value))
        })
        .collect()
}

fn from_env() -> Option<AnthropicUpstream> {
    let raw = std::env::var("ANTHROPIC_UPSTREAM_URL").ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    let Some((host, path_prefix)) = parse_base_url(&raw) else {
        warn!(
            url = raw,
            "ANTHROPIC_UPSTREAM_URL is not an absolute https:// URL — override disabled"
        );
        return None;
    };
    let extra_headers = std::env::var("ANTHROPIC_UPSTREAM_EXTRA_HEADERS")
        .map(|raw| parse_extra_headers(&raw))
        .unwrap_or_default();
    Some(AnthropicUpstream {
        host,
        path_prefix,
        extra_headers,
    })
}

static OVERRIDE: LazyLock<Option<AnthropicUpstream>> = LazyLock::new(from_env);

/// The override to apply for `host`, or `None` — for any other host, or when
/// the feature is unconfigured (the default).
pub fn override_for(host: &str) -> Option<&'static AnthropicUpstream> {
    if host != ANTHROPIC_HOST {
        return None;
    }
    OVERRIDE.as_ref()
}

/// Extra headers for traffic addressed DIRECTLY to the override host — a
/// sandbox whose harness was pointed at the proxy via `ANTHROPIC_BASE_URL`
/// instead of relying on the transparent rewrite. The upstream URL is left
/// alone (the client already targets the proxy, path prefix included), but
/// the proxy's attribution headers are still required on every request.
pub fn direct_extra_headers(host: &str) -> Option<&'static [(HeaderName, HeaderValue)]> {
    direct_headers_in(OVERRIDE.as_ref(), host)
}

fn direct_headers_in<'a>(
    ov: Option<&'a AnthropicUpstream>,
    host: &str,
) -> Option<&'a [(HeaderName, HeaderValue)]> {
    let ov = ov?;
    if host != ov.host {
        return None;
    }
    Some(&ov.extra_headers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_base_url_host_only() {
        assert_eq!(
            parse_base_url("https://proxy.example.com"),
            Some(("proxy.example.com".to_string(), String::new()))
        );
    }

    #[test]
    fn parse_base_url_with_prefix_strips_trailing_slash() {
        assert_eq!(
            parse_base_url("https://proxy.example.com/aifoundry-sdk/"),
            Some((
                "proxy.example.com".to_string(),
                "/aifoundry-sdk".to_string()
            ))
        );
    }

    #[test]
    fn parse_base_url_rejects_http_and_garbage() {
        // http would send credentials over cleartext; anything else is a typo.
        assert_eq!(parse_base_url("http://proxy.example.com"), None);
        assert_eq!(parse_base_url("proxy.example.com"), None);
        assert_eq!(parse_base_url("https://"), None);
        assert_eq!(parse_base_url(""), None);
    }

    #[test]
    fn parse_extra_headers_typed_pairs() {
        let headers = parse_extra_headers("serviceName:onecli, env:dev,team:automation");
        assert_eq!(headers.len(), 3);
        assert_eq!(headers[0].0.as_str(), "servicename");
        assert_eq!(headers[0].1.to_str().unwrap(), "onecli");
        assert_eq!(headers[2].1.to_str().unwrap(), "automation");
    }

    #[test]
    fn parse_extra_headers_drops_invalid_entries() {
        let headers = parse_extra_headers("good:v, no-colon-entry, bad name:v,,");
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].0.as_str(), "good");
    }

    #[test]
    fn override_for_ignores_other_hosts() {
        // Regardless of env, a non-Anthropic host never gets the override.
        assert!(override_for("api.openai.com").is_none());
        assert!(override_for("example.com").is_none());
    }

    fn test_upstream() -> AnthropicUpstream {
        AnthropicUpstream {
            host: "proxy.example.com".to_string(),
            path_prefix: "/aifoundry-sdk".to_string(),
            extra_headers: parse_extra_headers("serviceName:onecli,team:automation"),
        }
    }

    #[test]
    fn direct_headers_match_the_override_host_only() {
        let ov = test_upstream();
        let headers = direct_headers_in(Some(&ov), "proxy.example.com").unwrap();
        assert_eq!(headers.len(), 2);
        assert_eq!(headers[0].0.as_str(), "servicename");
        // The Anthropic host itself takes the full override path, not this one.
        assert!(direct_headers_in(Some(&ov), ANTHROPIC_HOST).is_none());
        assert!(direct_headers_in(Some(&ov), "other.example.com").is_none());
    }

    #[test]
    fn direct_headers_none_when_unconfigured() {
        assert!(direct_headers_in(None, "proxy.example.com").is_none());
    }
}
