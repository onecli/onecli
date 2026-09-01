//! The upstream HTTP client, its response-header deadline, and the
//! generation-aware rotation that lets the gateway escape suspect pooled state.
//!
//! Two problems live together here on purpose.
//!
//! A `reqwest::Client` clone shares the underlying connection pool, so handing
//! out clones after a stall re-hands out the same suspect pool. Recovering
//! means replacing the client itself — and replacing it exactly once per bad
//! generation, however many in-flight requests trip over it. Keeping
//! [`build_http_client`] in the same module as [`UpstreamClient`] is the point:
//! a rebuild that drifted from the original TLS posture would silently turn a
//! verifying client into a non-verifying one, so the rotator owns the flag it
//! was built with rather than re-deriving it from the environment.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Default bound on the wait for upstream *response headers*.
///
/// Deliberately generous. This is a containment backstop against an operation
/// that will never make progress, not a latency budget: the gateway fronts LLM
/// and API providers whose non-streaming responses can legitimately hold
/// headers for minutes, and the same wait also covers writing a large request
/// body upstream. A tight bound here would not merely fail slow-but-healthy
/// requests, it would rotate a healthy pool underneath them.
pub const DEFAULT_HEADER_TIMEOUT: Duration = Duration::from_secs(300);

/// Environment override for [`DEFAULT_HEADER_TIMEOUT`], in whole seconds.
///
/// Read once into a `OnceLock`: the deadline is a deployment-wide property, and
/// re-reading it per request would let a mid-flight environment change apply to
/// some requests and not others.
pub fn configured_header_timeout() -> Duration {
    static TIMEOUT: OnceLock<Duration> = OnceLock::new();
    *TIMEOUT.get_or_init(|| {
        std::env::var("GATEWAY_UPSTREAM_HEADER_TIMEOUT_SECS")
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            // Zero would mean "expire immediately", which no operator means by
            // it; treat it as unset rather than as a gateway that 504s everything.
            .filter(|secs| *secs > 0)
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_HEADER_TIMEOUT)
    })
}

/// Build the HTTP client used for upstream requests.
///
/// - Redirects are disabled so 3xx responses are forwarded to the client as-is.
/// - `accept_invalid_certs` skips TLS certificate validation for upstream connections.
///
/// No request timeout is configured here on purpose. `reqwest`'s own timeout is
/// a *total* deadline that keeps running while the response body streams, so
/// setting it would cap SSE streams and long downloads at the same bound meant
/// only for response headers. The header deadline is applied at the call site
/// instead — see [`UpstreamClient::header_timeout`].
pub fn build_http_client(accept_invalid_certs: bool) -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .danger_accept_invalid_certs(accept_invalid_certs)
        .build()
        .expect("build HTTP client")
}

/// The current client and the generation number identifying it.
struct Generation {
    id: u64,
    client: reqwest::Client,
}

/// A rotatable upstream client.
///
/// Requests [`lease`](Self::lease) a `(generation, client)` pair. If a request
/// times out waiting for response headers it reports the generation it used to
/// [`rotate`](Self::rotate), which replaces the client only if that generation
/// is still current. Requests that leased an already-superseded generation
/// therefore rotate nothing, so a burst of concurrent timeouts against one bad
/// generation performs exactly one replacement.
///
/// One instance per materially distinct client configuration. The verifying and
/// skip-verification clients each own theirs, so a stall on an exempted
/// internal host cannot discard the pool serving everything else — and cannot
/// quietly promote non-verification to the general path.
pub struct UpstreamClient {
    /// Retained so a rebuild reproduces the TLS posture this client was
    /// created with, rather than whatever the environment says later.
    accept_invalid_certs: bool,
    header_timeout: Duration,
    current: Mutex<Generation>,
}

impl UpstreamClient {
    /// Build a client with the deployment's configured header deadline.
    pub fn new(accept_invalid_certs: bool) -> Self {
        Self::with_header_timeout(accept_invalid_certs, configured_header_timeout())
    }

    /// Build a client with an explicit header deadline. Tests use this to get a
    /// deterministic bound without racing on a process-wide environment variable.
    pub fn with_header_timeout(accept_invalid_certs: bool, header_timeout: Duration) -> Self {
        Self {
            accept_invalid_certs,
            header_timeout,
            current: Mutex::new(Generation {
                id: 0,
                client: build_http_client(accept_invalid_certs),
            }),
        }
    }

    /// The bound a caller must apply to its wait for response headers.
    pub fn header_timeout(&self) -> Duration {
        self.header_timeout
    }

    /// Take the current generation and a handle to its client.
    ///
    /// The clone shares the leased generation's pool, which is what makes the
    /// returned generation number meaningful as the thing to blame on a stall.
    pub fn lease(&self) -> (u64, reqwest::Client) {
        let guard = self.current.lock().expect("upstream client generation");
        (guard.id, guard.client.clone())
    }

    /// Retire `leased` if it is still the current generation, replacing it with
    /// a freshly built client of equivalent configuration.
    ///
    /// Returns whether this call performed the rotation. A `false` means some
    /// other request already retired that generation and this caller's stall was
    /// a second casualty of the same bad pool.
    ///
    /// Nothing here disturbs requests already running: they hold their own
    /// clone, and the old pool stays alive until the last of them drops it. A
    /// response whose headers already arrived keeps streaming its body from the
    /// old connection.
    pub fn rotate(&self, leased: u64) -> bool {
        let mut guard = self.current.lock().expect("upstream client generation");
        if guard.id != leased {
            return false;
        }
        guard.client = build_http_client(self.accept_invalid_certs);
        guard.id += 1;
        true
    }

    /// The current generation number. Exposed for tests and diagnostics.
    pub fn generation(&self) -> u64 {
        self.current.lock().expect("upstream client generation").id
    }
}

impl std::fmt::Debug for UpstreamClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpstreamClient")
            .field("accept_invalid_certs", &self.accept_invalid_certs)
            .field("header_timeout", &self.header_timeout)
            .field("generation", &self.generation())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A deadline short enough to keep tests fast, long enough not to fire on a
    /// loaded CI box before the client has even written its request.
    const TEST_HEADER_TIMEOUT: Duration = Duration::from_millis(150);

    /// An upstream that completes the TCP accept and reads the request, then
    /// never sends response headers — the shape of the field failure in #493.
    ///
    /// Returns the address and a counter of accepted connections, which is how
    /// the no-replay test detects a second attempt: a replay cannot reuse the
    /// connection it just abandoned, so it must show up as another accept.
    fn silent_upstream() -> (std::net::SocketAddr, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind silent upstream");
        let addr = listener.local_addr().expect("local addr");
        let accepts = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&accepts);

        std::thread::spawn(move || {
            // Held so the sockets stay open: closing them would hand the client
            // a connection error instead of the indefinite wait under test.
            let mut held: Vec<TcpStream> = Vec::new();
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                counter.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                held.push(stream);
            }
        });

        (addr, accepts)
    }

    /// An upstream that returns response headers promptly and then stalls
    /// `body_delay` before sending the body.
    fn slow_body_upstream(body_delay: Duration) -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind slow-body upstream");
        let addr = listener.local_addr().expect("local addr");

        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n");
                let _ = stream.flush();
                std::thread::sleep(body_delay);
                let _ = stream.write_all(b"hello");
            }
        });

        addr
    }

    // ── the header deadline ──────────────────────────────────────────────

    #[tokio::test]
    async fn header_deadline_bounds_a_silent_upstream() {
        let (addr, _accepts) = silent_upstream();
        let upstream = UpstreamClient::with_header_timeout(false, TEST_HEADER_TIMEOUT);
        let (_generation, client) = upstream.lease();

        let started = std::time::Instant::now();
        let outcome = tokio::time::timeout(
            upstream.header_timeout(),
            client.get(format!("http://{addr}/stalls")).send(),
        )
        .await;

        assert!(
            outcome.is_err(),
            "a silent upstream must trip the header deadline, not resolve",
        );
        // The gateway's own bound must be what stopped this, so the wait has to
        // end on roughly the configured deadline rather than run on.
        assert!(
            started.elapsed() < TEST_HEADER_TIMEOUT * 10,
            "wait ran to {:?}, far past the {:?} deadline",
            started.elapsed(),
            TEST_HEADER_TIMEOUT,
        );
    }

    #[tokio::test]
    async fn body_streams_past_the_header_deadline() {
        // Headers arrive at once; the body takes several times the header bound.
        let addr = slow_body_upstream(TEST_HEADER_TIMEOUT * 4);
        let upstream = UpstreamClient::with_header_timeout(false, TEST_HEADER_TIMEOUT);
        let (_generation, client) = upstream.lease();

        let response = tokio::time::timeout(
            upstream.header_timeout(),
            client.get(format!("http://{addr}/slow-body")).send(),
        )
        .await
        .expect("headers arrived inside the deadline")
        .expect("request succeeded");
        assert_eq!(response.status(), 200);

        // The deadline is not applied here, so a body slower than it still
        // completes — this is the SSE / long-download guarantee.
        let body = response.text().await.expect("body streamed to completion");
        assert_eq!(body, "hello");
    }

    #[tokio::test]
    async fn timed_out_request_is_not_replayed() {
        let (addr, accepts) = silent_upstream();
        let upstream = UpstreamClient::with_header_timeout(false, TEST_HEADER_TIMEOUT);
        let (generation, client) = upstream.lease();

        // A POST: the case where replaying would risk performing a
        // non-idempotent operation the upstream may already have executed.
        let outcome = tokio::time::timeout(
            upstream.header_timeout(),
            client
                .post(format!("http://{addr}/orders"))
                .body("{\"charge\":true}")
                .send(),
        )
        .await;
        assert!(outcome.is_err(), "POST must trip the deadline");

        // Rotating is the only recovery action taken; it must not resend.
        upstream.rotate(generation);

        // Long enough that a replay would have landed by now.
        tokio::time::sleep(TEST_HEADER_TIMEOUT * 4).await;
        assert_eq!(
            accepts.load(Ordering::SeqCst),
            1,
            "the timed-out POST must reach the upstream exactly once",
        );
    }

    #[tokio::test]
    async fn a_fresh_generation_serves_requests_after_a_rotation() {
        let (silent_addr, _accepts) = silent_upstream();
        let upstream = UpstreamClient::with_header_timeout(false, TEST_HEADER_TIMEOUT);

        // Generation 0 stalls and is retired.
        let (generation, stalled) = upstream.lease();
        assert!(
            tokio::time::timeout(
                upstream.header_timeout(),
                stalled.get(format!("http://{silent_addr}/stalls")).send(),
            )
            .await
            .is_err(),
            "the silent upstream must trip the deadline",
        );
        assert!(upstream.rotate(generation));

        // The replacement is a working client, not merely a new number: a real
        // request through it completes against a healthy upstream.
        let healthy_addr = slow_body_upstream(Duration::ZERO);
        let (next_generation, fresh) = upstream.lease();
        assert_eq!(next_generation, 1, "later requests lease the replacement");

        let response = tokio::time::timeout(
            upstream.header_timeout(),
            fresh.get(format!("http://{healthy_addr}/healthy")).send(),
        )
        .await
        .expect("the fresh generation must not inherit the stall")
        .expect("request succeeded");
        assert_eq!(response.status(), 200);
        assert_eq!(response.text().await.expect("body"), "hello");
    }

    // ── generation rotation ──────────────────────────────────────────────

    #[test]
    fn rotation_replaces_the_leased_generation() {
        let upstream = UpstreamClient::with_header_timeout(false, TEST_HEADER_TIMEOUT);
        let (generation, _client) = upstream.lease();
        assert_eq!(generation, 0);

        assert!(upstream.rotate(generation), "current generation rotates");
        assert_eq!(upstream.generation(), 1);

        let (next, _fresh) = upstream.lease();
        assert_eq!(next, 1, "later requests lease the new generation");
    }

    #[test]
    fn concurrent_timeouts_rotate_one_generation_once() {
        let upstream = UpstreamClient::with_header_timeout(false, TEST_HEADER_TIMEOUT);

        // Three in-flight requests all sharing one generation, as they would
        // when a whole pool goes bad at once.
        let (a, _ca) = upstream.lease();
        let (b, _cb) = upstream.lease();
        let (c, _cc) = upstream.lease();
        assert_eq!((a, b, c), (0, 0, 0));

        assert!(upstream.rotate(a), "the first timeout rotates");
        assert!(
            !upstream.rotate(b),
            "a straggler from the retired generation must not rotate again",
        );
        assert!(!upstream.rotate(c), "nor must the third");

        assert_eq!(
            upstream.generation(),
            1,
            "one bad generation must produce exactly one rotation",
        );
    }

    #[test]
    fn stale_generation_cannot_discard_a_newer_client() {
        let upstream = UpstreamClient::with_header_timeout(false, TEST_HEADER_TIMEOUT);
        let (stale, _client) = upstream.lease();
        assert!(upstream.rotate(stale));

        // A request that leased generation 0 timing out much later must not
        // take out the healthy generation 1 that replaced it.
        assert!(!upstream.rotate(stale));
        assert_eq!(upstream.generation(), 1);
    }

    #[test]
    fn verify_and_skip_verify_clients_rotate_independently() {
        let verifying = UpstreamClient::with_header_timeout(false, TEST_HEADER_TIMEOUT);
        let skip_verify = UpstreamClient::with_header_timeout(true, TEST_HEADER_TIMEOUT);

        let (generation, _client) = skip_verify.lease();
        assert!(skip_verify.rotate(generation));

        assert_eq!(skip_verify.generation(), 1);
        assert_eq!(
            verifying.generation(),
            0,
            "a stall on the skip-verify pool must not rotate the verifying one",
        );

        // And the reverse direction.
        let (generation, _client) = verifying.lease();
        assert!(verifying.rotate(generation));
        assert_eq!(verifying.generation(), 1);
        assert_eq!(skip_verify.generation(), 1);
    }

    #[test]
    fn rebuilt_client_keeps_the_original_tls_posture() {
        // The rotator holds its own flag rather than re-reading the
        // environment, so a rebuild cannot promote a verifying client to a
        // non-verifying one (or the reverse) behind the operator's back.
        let skip_verify = UpstreamClient::with_header_timeout(true, TEST_HEADER_TIMEOUT);
        assert!(skip_verify.rotate(0));
        assert!(
            format!("{skip_verify:?}").contains("accept_invalid_certs: true"),
            "rotation must preserve the configured TLS posture",
        );

        let verifying = UpstreamClient::with_header_timeout(false, TEST_HEADER_TIMEOUT);
        assert!(verifying.rotate(0));
        assert!(format!("{verifying:?}").contains("accept_invalid_certs: false"));
    }

    // ── configuration ────────────────────────────────────────────────────

    #[test]
    fn default_header_deadline_is_generous() {
        // A tight default would 504 legitimately slow upstreams (streaming LLM
        // responses, large uploads) and rotate healthy pools underneath them.
        assert!(
            DEFAULT_HEADER_TIMEOUT >= Duration::from_secs(120),
            "default header deadline must stay a containment backstop, not a latency budget",
        );
    }
}
