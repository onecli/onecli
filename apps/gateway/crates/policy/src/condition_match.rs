//! Body-condition matching and the request-body buffer that feeds it.
//!
//! FAIL-CLOSED LAW (#999): a body larger than the buffer cap is evaluated on
//! a truncated prefix, so a `body contains` check whose value sits past the
//! cap is UNKNOWN, not false. Unknown resolves by the rule's polarity:
//! a restrictive rule (Block / ManualApproval / RateLimit) treats the
//! condition as MATCHED (the restriction applies), a permissive rule (Allow)
//! treats it as NOT matched (nothing is granted on unseen bytes). Either way
//! the doubtful request can only be treated more strictly, never less.
//!
//! Truncation is a gateway-runtime concern only: the TS twin
//! (`packages/api/src/services/policy-translation/endpoint-match.ts`)
//! simulates on complete bodies and can never see a truncated one, so the
//! shared corpus pins parity for the `Full`/`None` arms and this module alone
//! owns the `Truncated` arm.

use std::sync::OnceLock;

use futures_util::{Stream, StreamExt};
use http_body_util::BodyDataStream;
use tracing::warn;

use crate::{PolicyAction, PolicyRule};

/// Default cap on the buffered body prefix. Sized above typical LLM request
/// bodies (the traffic #985 pulled into this path peaks around 32 KB; agent
/// prompts run larger) so the fail-closed truncation arm is rare, not routine.
const DEFAULT_CONDITION_BODY_BUFFER: usize = 256 * 1024; // 256 KB

/// Operator override for the buffer cap, clamped to [`MIN_CONDITION_BODY_BUFFER`,
/// `MAX_CONDITION_BODY_BUFFER`]. The buffer is per in-flight request, so the
/// ceiling bounds worst-case gateway memory.
const CONDITION_BODY_BUFFER_ENV: &str = "ONECLI_CONDITION_BODY_BUFFER_BYTES";
const MIN_CONDITION_BODY_BUFFER: usize = 4 * 1024; // 4 KB
const MAX_CONDITION_BODY_BUFFER: usize = 8 * 1024 * 1024; // 8 MB

/// The effective buffer cap: `ONECLI_CONDITION_BODY_BUFFER_BYTES` clamped to
/// the [4 KB, 8 MB] window, else the 256 KB default. Read once (`OnceLock`),
/// like the gateway's other env-derived config.
fn condition_body_buffer_limit() -> usize {
    static LIMIT: OnceLock<usize> = OnceLock::new();
    *LIMIT.get_or_init(|| resolve_buffer_limit(std::env::var(CONDITION_BODY_BUFFER_ENV).ok()))
}

/// Pure resolver behind [`condition_body_buffer_limit`], split out so the
/// clamp law is unit-testable without touching process env. Unparsable or
/// absent → the default; out-of-window → clamped (with a warn), so a
/// misconfigured operator value can neither disable buffering (a 0 would
/// truncate everything → mass fail-closed blocking) nor balloon per-request
/// memory unboundedly.
fn resolve_buffer_limit(raw: Option<String>) -> usize {
    match raw.and_then(|v| v.trim().parse::<usize>().ok()) {
        Some(v) => {
            let clamped = v.clamp(MIN_CONDITION_BODY_BUFFER, MAX_CONDITION_BODY_BUFFER);
            if clamped != v {
                warn!(
                    requested = v,
                    clamped,
                    "{CONDITION_BODY_BUFFER_ENV} outside [{MIN_CONDITION_BODY_BUFFER}, {MAX_CONDITION_BODY_BUFFER}]; clamped"
                );
            }
            clamped
        }
        None => DEFAULT_CONDITION_BODY_BUFFER,
    }
}

/// The request body as condition matching sees it. `Truncated` carries only a
/// prefix — bytes past the buffer cap were never observed, and every consumer
/// must resolve that doubt fail-closed (restrictive rules match, permissive
/// rules don't, GraphQL classifies as mutation).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionBody<'a> {
    /// No body was buffered: either the request has no body-needing rule
    /// (`needs_body_buffer` returned false — its contract is to be a strict
    /// superset of "some rule inspects this body") or the transport carries no
    /// body (e.g. a WebSocket upgrade).
    None,
    /// The complete request body (possibly empty).
    Full(&'a [u8]),
    /// A prefix of the body; the rest exceeded the buffer cap.
    Truncated(&'a [u8]),
}

impl<'a> ConditionBody<'a> {
    /// The observed bytes, if any — the full body or the truncated prefix.
    pub fn bytes(&self) -> Option<&'a [u8]> {
        match self {
            ConditionBody::None => None,
            ConditionBody::Full(b) | ConditionBody::Truncated(b) => Some(b),
        }
    }

    pub fn is_truncated(&self) -> bool {
        matches!(self, ConditionBody::Truncated(_))
    }

    /// View a buffered body (or its absence) as a `ConditionBody`.
    pub fn from_buffered(buffered: Option<&'a BufferedBody>) -> Self {
        match buffered {
            None => ConditionBody::None,
            Some(b) if b.truncated => ConditionBody::Truncated(&b.bytes),
            Some(b) => ConditionBody::Full(&b.bytes),
        }
    }
}

/// A buffered request-body prefix plus whether the body outran the cap.
/// Produced by [`prepare_body`]; viewed by the matchers via
/// [`ConditionBody::from_buffered`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BufferedBody {
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

#[derive(serde::Deserialize)]
struct RawCondition {
    target: String,
    operator: String,
    value: String,
}

struct ParsedCondition {
    target: String,
    operator: String,
    value_lower: String,
}

fn parse_conditions(raw: &serde_json::Value) -> Option<Vec<ParsedCondition>> {
    let raw_conditions: Vec<RawCondition> = serde_json::from_value(raw.clone())
        .map_err(|e| warn!(error = %e, "failed to parse policy rule conditions"))
        .ok()?;
    if raw_conditions.is_empty() {
        return None;
    }
    Some(
        raw_conditions
            .into_iter()
            .map(|c| ParsedCondition {
                target: c.target,
                operator: c.operator,
                value_lower: c.value.to_ascii_lowercase(),
            })
            .collect(),
    )
}

pub fn matches(rule: &PolicyRule, body: ConditionBody<'_>) -> bool {
    let conditions = match rule.conditions_raw.as_ref().and_then(parse_conditions) {
        Some(c) => c,
        None => return true,
    };

    // The polarity that resolves an UNKNOWN condition result (value not found
    // in a truncated prefix). A restrictive rule assumes the worst and
    // matches; a permissive rule refuses to grant on unseen bytes. Callers
    // that thread conditions through throwaway rules (`pseudo_rule`,
    // `variant_rule`) must set `action` to the REAL rule's polarity.
    let restrictive = !matches!(rule.action, PolicyAction::Allow);

    conditions
        .iter()
        .all(|c| condition_matches(c, body, restrictive))
}

fn condition_matches(
    condition: &ParsedCondition,
    body: ConditionBody<'_>,
    restrictive: bool,
) -> bool {
    match (condition.target.as_str(), condition.operator.as_str()) {
        ("body", "contains") => match body {
            // No body to inspect: nothing can contain the value. Safe only
            // because `needs_body_buffer` guarantees a buffer whenever a
            // body-inspecting rule could match the request.
            ConditionBody::None => false,
            ConditionBody::Full(bytes) => contains_value(bytes, &condition.value_lower),
            // Found in the prefix → a definite match. Not found → UNKNOWN
            // (the value may sit past the cap) → resolve by polarity.
            ConditionBody::Truncated(bytes) => {
                contains_value(bytes, &condition.value_lower) || restrictive
            }
        },
        _ => true,
    }
}

fn contains_value(bytes: &[u8], value_lower: &str) -> bool {
    let haystack = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    haystack.contains(value_lower)
}

pub async fn prepare_body(
    body: hyper::body::Incoming,
    method: &str,
    url: &str,
) -> anyhow::Result<(BufferedBody, reqwest::Body)> {
    let stream = Box::pin(BodyDataStream::new(body));
    let limit = condition_body_buffer_limit();
    let (buffered, observed_len, reassembled) = buffer_prefix(stream, limit).await?;

    if buffered.truncated {
        warn!(
            method = %method,
            url = %url,
            buffered = observed_len,
            limit,
            "request body exceeds condition buffer limit — restrictive body conditions treated as matched (fail closed)"
        );
    }

    Ok((buffered, reassembled))
}

/// Buffer up to `limit` bytes of `stream` and reassemble a pass-through body
/// that forwards the ORIGINAL bytes untouched. Also returns the total bytes
/// observed (≥ the buffered prefix; a lower bound on the body size, for the
/// truncation warn). `truncated` is exact: it is set only when the body
/// really has bytes past `limit` (a body of exactly `limit` bytes reads to
/// EOF and is `Full`), so the fail-closed arm never fires on a complete body.
async fn buffer_prefix<S, E>(
    mut stream: std::pin::Pin<Box<S>>,
    limit: usize,
) -> anyhow::Result<(BufferedBody, usize, reqwest::Body)>
where
    S: Stream<Item = Result<hyper::body::Bytes, E>> + Send + 'static,
    E: std::fmt::Display + Send + Sync + 'static,
{
    let mut chunks: Vec<hyper::body::Bytes> = Vec::with_capacity(4);
    let mut total_len: usize = 0;

    // Read until the body ends or PROVABLY exceeds the limit (strictly
    // greater), so an exactly-limit-sized body is recognized as complete.
    while total_len <= limit {
        match stream.next().await {
            Some(Ok(data)) => {
                total_len += data.len();
                chunks.push(data);
            }
            Some(Err(e)) => {
                return Err(anyhow::anyhow!(
                    "reading request body for condition check: {e}"
                ));
            }
            None => break,
        }
    }
    let truncated = total_len > limit;

    let mut buf = Vec::with_capacity(total_len.min(limit));
    for chunk in &chunks {
        let remaining = limit - buf.len();
        let take = remaining.min(chunk.len());
        buf.extend_from_slice(&chunk[..take]);
        if buf.len() >= limit {
            break;
        }
    }

    let peeked_stream = futures_util::stream::iter(chunks.into_iter().map(Ok::<_, std::io::Error>));
    let remaining_stream = stream.map(|r| r.map_err(|e| std::io::Error::other(e.to_string())));
    let reassembled = reqwest::Body::wrap_stream(peeked_stream.chain(remaining_stream));

    Ok((
        BufferedBody {
            bytes: buf,
            truncated,
        },
        total_len,
        reassembled,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_rule(conditions_json: Option<serde_json::Value>) -> PolicyRule {
        rule_with_action(conditions_json, crate::PolicyAction::Block)
    }

    fn rule_with_action(
        conditions_json: Option<serde_json::Value>,
        action: crate::PolicyAction,
    ) -> PolicyRule {
        PolicyRule {
            name: "test".to_string(),
            path_pattern: "*".to_string(),
            method: None,
            action,
            conditions_raw: conditions_json,
        }
    }

    fn contains_condition(value: &str) -> serde_json::Value {
        serde_json::json!([
            {"target": "body", "operator": "contains", "value": value}
        ])
    }

    #[test]
    fn body_contains_match_case_insensitive() {
        let rule = make_rule(Some(contains_condition("DELETE")));
        assert!(matches(
            &rule,
            ConditionBody::Full(b"please delete this item")
        ));
        assert!(matches(&rule, ConditionBody::Full(b"DELETE everything")));
    }

    #[test]
    fn body_contains_no_match() {
        let rule = make_rule(Some(contains_condition("secret")));
        assert!(!matches(&rule, ConditionBody::Full(b"nothing here")));
    }

    #[test]
    fn empty_body_does_not_match() {
        let rule = make_rule(Some(contains_condition("test")));
        assert!(!matches(&rule, ConditionBody::Full(b"")));
        assert!(!matches(&rule, ConditionBody::None));
    }

    #[test]
    fn no_conditions_always_matches() {
        let rule = make_rule(None);
        assert!(matches(&rule, ConditionBody::None));
        assert!(matches(&rule, ConditionBody::Full(b"anything")));

        let rule2 = make_rule(Some(serde_json::json!([])));
        assert!(matches(&rule2, ConditionBody::None));
    }

    #[test]
    fn multiple_conditions_and_semantics() {
        let rule = make_rule(Some(serde_json::json!([
            {"target": "body", "operator": "contains", "value": "foo"},
            {"target": "body", "operator": "contains", "value": "bar"}
        ])));
        assert!(matches(&rule, ConditionBody::Full(b"foo and bar")));
        assert!(!matches(&rule, ConditionBody::Full(b"only foo here")));
        assert!(!matches(&rule, ConditionBody::Full(b"only bar here")));
    }

    #[test]
    fn unknown_target_or_operator_matches() {
        let rule = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "equals", "value": "x"}
        ])));
        assert!(matches(&rule, ConditionBody::Full(b"anything")));
    }

    #[test]
    fn malformed_conditions_json_matches() {
        let rule = make_rule(Some(serde_json::json!("not an array")));
        assert!(matches(&rule, ConditionBody::Full(b"anything")));
    }

    // ── Truncation fail-closed law (#999) ────────────────────────────────

    #[test]
    fn truncated_prefix_hit_matches_for_both_polarities() {
        // The value inside the observed prefix is a DEFINITE match — polarity
        // is irrelevant.
        let block = rule_with_action(
            Some(contains_condition("delete")),
            crate::PolicyAction::Block,
        );
        let allow = rule_with_action(
            Some(contains_condition("delete")),
            crate::PolicyAction::Allow,
        );
        assert!(matches(
            &block,
            ConditionBody::Truncated(b"please delete it")
        ));
        assert!(matches(
            &allow,
            ConditionBody::Truncated(b"please delete it")
        ));
    }

    #[test]
    fn truncated_miss_matches_restrictive_rules() {
        // The regression #999: the value may sit past the cap, so a
        // restrictive rule must treat the unknown as matched (fail closed).
        let conditions = Some(contains_condition("wire-transfer"));
        let prefix = ConditionBody::Truncated(b"an innocuous prefix");
        for action in [
            crate::PolicyAction::Block,
            crate::PolicyAction::ManualApproval {
                rule_id: "r".to_string(),
            },
            crate::PolicyAction::RateLimit {
                rule_id: "r".to_string(),
                max_requests: 1,
                window_secs: 60,
            },
        ] {
            let rule = rule_with_action(conditions.clone(), action);
            assert!(
                matches(&rule, prefix),
                "restrictive rule must match on a truncated miss"
            );
        }
    }

    #[test]
    fn truncated_miss_does_not_match_permissive_rules() {
        // An Allow must never be granted on bytes it did not see.
        let rule = rule_with_action(
            Some(contains_condition("wire-transfer")),
            crate::PolicyAction::Allow,
        );
        assert!(!matches(
            &rule,
            ConditionBody::Truncated(b"an innocuous prefix")
        ));
    }

    #[test]
    fn truncated_multi_condition_uses_polarity_per_condition() {
        // AND semantics with one definite hit and one unknown: the unknown
        // resolves by polarity, so the restrictive rule matches and the
        // permissive one does not.
        let conditions = Some(serde_json::json!([
            {"target": "body", "operator": "contains", "value": "seen"},
            {"target": "body", "operator": "contains", "value": "unseen"}
        ]));
        let prefix = ConditionBody::Truncated(b"the seen value only");
        assert!(matches(
            &rule_with_action(conditions.clone(), crate::PolicyAction::Block),
            prefix
        ));
        assert!(!matches(
            &rule_with_action(conditions, crate::PolicyAction::Allow),
            prefix
        ));
    }

    #[test]
    fn condition_body_from_buffered() {
        let full = BufferedBody {
            bytes: b"abc".to_vec(),
            truncated: false,
        };
        let cut = BufferedBody {
            bytes: b"abc".to_vec(),
            truncated: true,
        };
        assert_eq!(
            ConditionBody::from_buffered(Some(&full)),
            ConditionBody::Full(b"abc")
        );
        assert_eq!(
            ConditionBody::from_buffered(Some(&cut)),
            ConditionBody::Truncated(b"abc")
        );
        assert_eq!(ConditionBody::from_buffered(None), ConditionBody::None);
    }

    // ── buffer_prefix: exact truncation detection + byte-perfect relay ──

    fn chunk_stream(
        chunks: Vec<&'static [u8]>,
    ) -> std::pin::Pin<Box<impl Stream<Item = Result<hyper::body::Bytes, std::io::Error>>>> {
        Box::pin(futures_util::stream::iter(
            chunks
                .into_iter()
                .map(|c| Ok(hyper::body::Bytes::from_static(c))),
        ))
    }

    async fn collect_body(body: reqwest::Body) -> Vec<u8> {
        use http_body_util::BodyExt;
        body.collect().await.expect("body").to_bytes().to_vec()
    }

    #[tokio::test]
    async fn buffer_prefix_complete_body_is_not_truncated() {
        let (buffered, observed, relay) =
            buffer_prefix(chunk_stream(vec![b"hello ", b"world"]), 64)
                .await
                .expect("buffer");
        assert!(!buffered.truncated);
        assert_eq!(observed, 11);
        assert_eq!(buffered.bytes, b"hello world");
        assert_eq!(collect_body(relay).await, b"hello world");
    }

    #[tokio::test]
    async fn buffer_prefix_exactly_limit_sized_body_is_full() {
        // A body of exactly `limit` bytes must read to EOF and count as
        // complete — the old `>=` check would have flagged it truncated.
        let (buffered, _, relay) = buffer_prefix(chunk_stream(vec![b"12345678"]), 8)
            .await
            .expect("buffer");
        assert!(!buffered.truncated);
        assert_eq!(buffered.bytes, b"12345678");
        assert_eq!(collect_body(relay).await, b"12345678");
    }

    #[tokio::test]
    async fn buffer_prefix_oversized_body_truncates_and_relays_all_bytes() {
        let (buffered, observed, relay) =
            buffer_prefix(chunk_stream(vec![b"12345678", b"9abcdef"]), 8)
                .await
                .expect("buffer");
        assert!(buffered.truncated);
        assert_eq!(observed, 15);
        assert_eq!(buffered.bytes, b"12345678");
        // Buffering must never corrupt the forwarded body.
        assert_eq!(collect_body(relay).await, b"123456789abcdef");
    }

    #[tokio::test]
    async fn buffer_prefix_empty_body() {
        let (buffered, _, relay) = buffer_prefix(chunk_stream(vec![]), 8)
            .await
            .expect("buffer");
        assert!(!buffered.truncated);
        assert!(buffered.bytes.is_empty());
        assert!(collect_body(relay).await.is_empty());
    }

    // ── buffer-limit resolution: default, override, clamp ────────────────

    #[test]
    fn buffer_limit_defaults_and_rejects_garbage() {
        assert_eq!(resolve_buffer_limit(None), DEFAULT_CONDITION_BODY_BUFFER);
        assert_eq!(
            resolve_buffer_limit(Some("not a number".to_string())),
            DEFAULT_CONDITION_BODY_BUFFER
        );
        assert_eq!(
            resolve_buffer_limit(Some("-1".to_string())),
            DEFAULT_CONDITION_BODY_BUFFER
        );
    }

    #[test]
    fn buffer_limit_honors_in_window_overrides_and_clamps_extremes() {
        assert_eq!(resolve_buffer_limit(Some(" 65536 ".to_string())), 65_536);
        // 0 would truncate EVERY body → mass fail-closed blocking; the floor
        // keeps a bad value from weaponizing the fail-closed law.
        assert_eq!(
            resolve_buffer_limit(Some("0".to_string())),
            MIN_CONDITION_BODY_BUFFER
        );
        // The ceiling bounds worst-case per-request memory.
        assert_eq!(
            resolve_buffer_limit(Some(usize::MAX.to_string())),
            MAX_CONDITION_BODY_BUFFER
        );
    }
}
