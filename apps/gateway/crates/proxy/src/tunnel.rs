//! The open lane: a CONNECT the gateway relays instead of terminating.
//!
//! Selected by the proxy username `open` ([`inject::OPEN_LANE_USER`]) on an
//! otherwise ordinary tokened CONNECT. The MITM lane cannot carry a browser
//! session: terminating TLS makes the origin see rustls and HTTP/1.1 under a
//! Chrome User-Agent, which bot defences (Cloudflare's challenge, TLS
//! fingerprinting) refuse, and a browser without the gateway CA refuses the
//! minted certificate anyway. This lane hands the origin the client's own TLS,
//! so the client is whatever it says it is.
//!
//! What it gives up is per-request visibility. What it keeps:
//!
//! - **the token**: no token, no tunnel, the same 407 as every CONNECT;
//! - **host-level policy**: a block rule, an approval requirement, a rate
//!   limit or an app-availability denial on the host refuses the CONNECT
//!   (there is no later request to hold or answer, so approval is a refusal);
//! - **the destination guard**: the host is resolved and judged *before* the
//!   200, so a private address is a 403 and never a dial;
//! - **one audit row per tunnel**, with its byte counts, written when it
//!   closes ([`RequestDecision::Tunneled`]).
//!
//! What it never does is inject: nothing on this lane can reach a credential,
//! which is why sending the username costs nothing and gains nothing beyond
//! the relay. A client that wants a credential needs the MITM lane.
//!
//! Two things this lane does not judge, by the same law as the MITM lane.
//! The deny-by-default posture gates only credentialed traffic
//! (`enforce_deny`), and a tunnel injects nothing, so it is never
//! deny-defaulted, exactly as an un-injected MITM request is not. And the
//! per-request guards (granular resource scope, budgets, the free-plan quota)
//! govern credentialed requests; with none here they have nothing to govern.

use std::time::Duration;

use hyper::{Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;
use tracing::{info, warn};

use cache::CacheStore;
use policy::PolicyDecision;
use telemetry::core::RequestDecision;

use super::egress;
use super::hooks::{self, ForwardResponseBody};
use super::relay;
use super::response;
use context::ProxyContext;

/// The method a tunnel's rows and log lines carry. CONNECT is the one
/// request the gateway actually saw.
const METHOD: &str = "CONNECT";

/// The path a tunnel's rows carry: a tunnel has no path, and `/` is what the
/// rules match against (a host rule's default `*` matches it; a path-scoped
/// rule written for a specific endpoint does not, correctly: it cannot know
/// what the tunnel will carry).
const PATH: &str = "/";

/// Bound on the upstream dial, so a black-holed host answers the client with
/// a 502 instead of holding its CONNECT until the kernel gives up.
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

/// Why a tunnel was refused. The row is already written by the time this is
/// returned; [`refusal_response`] renders it.
pub enum Refusal {
    /// Policy answered: a block, a rate limit, an approval requirement, or
    /// an app-availability denial. Carries the response those lanes give.
    /// Boxed, as `materialize_injections` boxes its response: the `Err` arm
    /// must not dwarf the `Ok(TcpStream)` the hot path returns
    /// (`clippy::result_large_err`).
    Policy(Box<Response<ForwardResponseBody>>),
    /// The destination guard refused the host.
    Destination { host: String },
    /// The host resolved to a permitted address that could not be dialed.
    Unreachable,
}

/// Decide a tunnel (host-level policy, then a guarded dial) and return the
/// connected upstream, ready to be relayed once the client's upgrade lands.
///
/// Decided BEFORE the 200: a refusal is a real HTTP answer the client can
/// read, where a tunnel closed right after a 200 is indistinguishable from a
/// flaky network. Every refusal leaves its row.
pub async fn open(
    proxy_ctx: &ProxyContext,
    host: &str,
    policy_rules_v2: &db::PolicyV2Rules,
    available_apps: &db::AvailableApps,
    cache: &dyn CacheStore,
) -> Result<TcpStream, Refusal> {
    let (hostname, port) = split_authority(host);
    let start = std::time::Instant::now();

    // The app-availability gate (step 7): a restricted workspace reaches
    // only the providers it was granted, on any lane.
    if let Some(provider) = ee::principals::app_availability_block(hostname, PATH, available_apps) {
        warn!(host = %hostname, provider = %provider, "tunnel refused: app unavailable to workspace");
        record_refusal(
            proxy_ctx,
            host,
            StatusCode::FORBIDDEN,
            RequestDecision::Blocked {
                rule_name: format!("App unavailable: {provider}"),
            },
            None,
            start,
        );
        return Err(Refusal::Policy(Box::new(ee::response::app_unavailable(
            &provider, METHOD, PATH, hostname,
        ))));
    }

    // The same first-match engine as every request, asked about the host.
    // `has_injections` is false by construction (nothing injects here) and
    // there is no winning connection, so connection-bound rules never match:
    // a tunnel is not any connection's traffic.
    let (decision, matched_rule) = policy_engine::evaluate(
        proxy_ctx,
        hostname,
        METHOD,
        PATH,
        policy::ConditionBody::None,
        false,
        policy::is_llm_host(host),
        None,
        cache,
        policy_rules_v2,
    )
    .await;

    let workspace_id = proxy_ctx.workspace_id.as_deref();
    let refused: Option<(StatusCode, RequestDecision, Response<ForwardResponseBody>)> =
        match decision {
            PolicyDecision::Allow => None,
            PolicyDecision::Blocked { rule_name } => {
                warn!(host = %hostname, rule = %rule_name, "tunnel BLOCKED by policy rule");
                let resp = response::blocked_by_policy(METHOD, PATH, &rule_name, workspace_id);
                Some((
                    StatusCode::FORBIDDEN,
                    RequestDecision::Blocked { rule_name },
                    resp,
                ))
            }
            // No request will ever arrive for a reviewer to see, so there is
            // nothing to hold: an approval requirement on the host is a
            // refusal, exactly as it is for a WebSocket upgrade.
            PolicyDecision::ManualApproval { .. } => {
                const RULE: &str = "Manual approval required";
                warn!(host = %hostname, "tunnel refused: the host requires approval, which a tunnel cannot hold");
                Some((
                    StatusCode::FORBIDDEN,
                    RequestDecision::Blocked {
                        rule_name: RULE.to_string(),
                    },
                    response::blocked_by_policy(METHOD, PATH, RULE, workspace_id),
                ))
            }
            PolicyDecision::RateLimited {
                rule_name,
                limit,
                window,
                retry_after_secs,
            } => {
                warn!(host = %hostname, rule = %rule_name, limit, window, "tunnel RATE LIMITED by policy rule");
                Some((
                    StatusCode::TOO_MANY_REQUESTS,
                    RequestDecision::RateLimited { rule_name },
                    response::rate_limited(limit, window, retry_after_secs),
                ))
            }
            // Unreachable while the deny-default carve spares un-injected
            // traffic; if the carve ever moves, this is the right answer.
            PolicyDecision::BlockedByDefaultPolicy => {
                warn!(host = %hostname, "tunnel BLOCKED by default deny policy");
                Some((
                    StatusCode::FORBIDDEN,
                    RequestDecision::BlockedByDefaultPolicy,
                    response::blocked_by_default_policy(METHOD, PATH, host, workspace_id),
                ))
            }
        };
    if let Some((status, decision, resp)) = refused {
        record_refusal(proxy_ctx, host, status, decision, matched_rule, start);
        return Err(Refusal::Policy(Box::new(resp)));
    }

    // Guarded dial: resolves, drops non-public addresses, connects to a
    // checked one. The guard's refusal is told apart from a plain dial
    // failure so the client learns which it was.
    match tokio::time::timeout(DIAL_TIMEOUT, egress::connect_tcp(hostname, port)).await {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(e)) => {
            if let Some(refusal) = egress::find_refusal_anyhow(&e) {
                warn!(host = %hostname, "egress guard: refused non-public tunnel destination");
                hooks::record_destination_refused(proxy_ctx, host, METHOD, PATH);
                return Err(Refusal::Destination {
                    host: refusal.host.clone(),
                });
            }
            warn!(host = %hostname, port, error = %e, "tunnel: upstream dial failed");
            Err(Refusal::Unreachable)
        }
        Err(_elapsed) => {
            warn!(host = %hostname, port, "tunnel: upstream dial timed out");
            Err(Refusal::Unreachable)
        }
    }
}

/// The CONNECT answer for a refused tunnel, shaped like the same refusal on
/// the other lanes so a client that handles one handles both.
#[must_use]
pub fn refusal_response(refusal: Refusal) -> Response<axum::body::Body> {
    match refusal {
        Refusal::Policy(resp) => resp.map(axum::body::Body::new),
        Refusal::Destination { host } => {
            let resp: Response<ForwardResponseBody> = response::destination_not_allowed(&host);
            resp.map(axum::body::Body::new)
        }
        Refusal::Unreachable => response::bad_gateway(),
    }
}

/// Relay the upgraded client connection and the dialed upstream until both
/// sides end, one fails, the pipe goes idle, or shutdown is signalled; then
/// write the tunnel's one row.
///
/// Runs under the caller's shutdown guard, and ends itself on the signal: a
/// tunnel is a pipe with no completion to wait for, so holding the drain to
/// its deadline would only make every restart take the full budget and lose
/// this row when the runtime exits. Whatever grace a tunnel gets comes from
/// in front of the gateway (a load balancer's deregistration delay), before
/// the signal is ever sent. The guard is what makes the row deterministic:
/// the drain waits for this task to see the signal and write it.
pub async fn serve(
    upgraded: hyper::upgrade::Upgraded,
    mut upstream: TcpStream,
    proxy_ctx: &ProxyContext,
    host: &str,
) {
    let start = std::time::Instant::now();
    let mut client = TokioIo::new(upgraded);
    let meter = relay::Meter::default();
    let mut shutdown_signal = shutdown::subscribe();

    tokio::select! {
        outcome = relay::relay(&mut client, &mut upstream, relay::IDLE_TIMEOUT, &meter) => {
            match outcome {
                Ok(()) => info!(
                    host = %host,
                    bytes_up = meter.to_server(),
                    bytes_down = meter.to_client(),
                    "tunnel closed"
                ),
                Err(e) => info!(
                    host = %host,
                    bytes_up = meter.to_server(),
                    bytes_down = meter.to_client(),
                    error = %e,
                    "tunnel ended"
                ),
            }
        }
        _ = shutdown_signal.wait() => {
            info!(
                host = %host,
                bytes_up = meter.to_server(),
                bytes_down = meter.to_client(),
                "tunnel cut by shutdown"
            );
        }
    }

    // 200 is the status the client got; the latency is the tunnel's whole
    // life, which is what an operator reading the row wants to know.
    let Some(mut meta) = hooks::request_meta(
        proxy_ctx,
        host,
        METHOD,
        PATH,
        StatusCode::OK.as_u16(),
        elapsed_ms(start),
    ) else {
        return;
    };
    meta.decision = Some(RequestDecision::Tunneled {
        bytes_up: meter.to_server(),
        bytes_down: meter.to_client(),
    });
    telemetry::on_request(meta.into_event(None));
}

/// The row for a tunnel refused before anything was dialed.
fn record_refusal(
    proxy_ctx: &ProxyContext,
    host: &str,
    status: StatusCode,
    decision: RequestDecision,
    matched_rule: Option<policy::MatchedRule>,
    start: std::time::Instant,
) {
    let Some(mut meta) = hooks::request_meta(
        proxy_ctx,
        host,
        METHOD,
        PATH,
        status.as_u16(),
        elapsed_ms(start),
    ) else {
        return;
    };
    meta.decision = Some(decision);
    meta.matched_rule = matched_rule;
    telemetry::on_request(meta.into_event(None));
}

/// Saturating: a tunnel can outlive u32 milliseconds (49 days), and a
/// wrapped latency would be a lie in the row.
fn elapsed_ms(start: std::time::Instant) -> u32 {
    u32::try_from(start.elapsed().as_millis()).unwrap_or(u32::MAX)
}

/// The host and port a CONNECT authority names.
///
/// Bracket-aware, unlike `strip_port`: `[::1]:443` is the IPv6 loopback on
/// 443, not a host called `[`, and the destination guard can only refuse an
/// address it is shown (its `normalize_host` strips the brackets itself).
/// 443 when no port is named: every browser names one, but the proxy
/// protocol does not require it.
#[must_use]
fn split_authority(authority: &str) -> (&str, u16) {
    let (host, port) = match authority.rsplit_once(':') {
        // `[v6]:port` or `host:port`. A bare `v6` has colons too but no
        // brackets, and must not lose its last group to a port.
        Some((host, port)) if host.ends_with(']') || !host.contains(':') => {
            (host, port.parse().ok())
        }
        _ => (authority, None),
    };
    (host, port.unwrap_or(443))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_splits_host_and_port_with_443_as_the_default() {
        assert_eq!(split_authority("example.com"), ("example.com", 443));
        assert_eq!(split_authority("example.com:443"), ("example.com", 443));
        assert_eq!(split_authority("example.com:8443"), ("example.com", 8443));
        assert_eq!(split_authority("example.com:nope"), ("example.com", 443));
        assert_eq!(split_authority("10.0.0.5:80"), ("10.0.0.5", 80));
    }

    /// The shape `strip_port` gets wrong: the guard must be shown `[::1]`,
    /// not `[`, or a loopback tunnel becomes a lookup failure instead of a
    /// refusal.
    #[test]
    fn authority_keeps_a_bracketed_ipv6_literal_whole() {
        assert_eq!(split_authority("[::1]:443"), ("[::1]", 443));
        assert_eq!(split_authority("[::1]"), ("[::1]", 443));
        assert_eq!(
            split_authority("[::ffff:127.0.0.1]:8443"),
            ("[::ffff:127.0.0.1]", 8443)
        );
        // Unbracketed: no port can be told apart from a group, so none is.
        assert_eq!(split_authority("::1"), ("::1", 443));
    }
}
