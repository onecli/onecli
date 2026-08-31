//! Shared utility functions.

use base64::Engine;

/// Parse the `exp` claim from a JWT token without full validation.
pub fn parse_jwt_exp(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    json.get("exp")?.as_i64()
}

/// Check if a requested hostname matches a secret or policy host pattern.
///
/// Supports an exact match, or a single `*` wildcard anywhere in the pattern:
/// - leading — `*.example.com` matches `api.example.com` (but not the apex
///   `example.com`),
/// - mid-string — `s3.*.amazonaws.com` matches `s3.us-east-1.amazonaws.com`
///   (the region label).
///
/// The length guard keeps the prefix and suffix from overlapping, so the `*`
/// must stand in for at least one character: the apex is still excluded for
/// `*.example.com`, and a region is still required for `s3.*.amazonaws.com`.
///
/// Matching is case-insensitive, since DNS host names are.
///
/// `pub(crate)` so the policy engine reuses the exact host matcher for its
/// network targets. Behavior is unchanged.
pub fn host_matches(request_host: &str, pattern: &str) -> bool {
    // TWO REGIMES, split on wildcard count.
    //
    // A pattern with 0 or 1 `*` takes the original path below, byte for byte.
    // That is deliberate and load-bearing: the single-`*` form is a
    // prefix/suffix split that spans label boundaries, so `*.example.com`
    // matches `a.b.example.com`. Live secrets rely on exactly that reach, and
    // narrowing it would silently stop injecting credentials that work today.
    //
    // A pattern with 2+ `*` cannot be expressed that way at all — the split
    // treats everything after the first `*` as literal, so the pattern matches
    // NOTHING. Those patterns get the label-bounded matcher instead, mirroring
    // `inject::path_matches`' segment model with `.` labels in place of `/`
    // segments. See `multi_wildcard_matches` for the fail-closed rules.
    if pattern.bytes().filter(|b| *b == b'*').count() >= 2 {
        return multi_wildcard_matches(request_host, pattern);
    }
    match pattern.split_once('*') {
        None => request_host.eq_ignore_ascii_case(pattern),
        Some((prefix, suffix)) => {
            // `get(..)` keeps the slices on char boundaries, so a non-ASCII
            // host can never panic — it just won't match an ASCII pattern.
            request_host.len() >= prefix.len() + suffix.len()
                && request_host
                    .get(..prefix.len())
                    .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
                && request_host
                    .get(request_host.len() - suffix.len()..)
                    .is_some_and(|s| s.eq_ignore_ascii_case(suffix))
        }
    }
}

/// Label-bounded matching for a pattern carrying 2+ wildcards, e.g.
/// `*.s3.*.amazonaws.com` (a virtual-hosted S3 bucket in any region).
///
/// One AWS service legitimately answers on host shapes that need two
/// independent blanks — a bucket AND a region — which no single-`*` pattern can
/// express without also swallowing sibling services.
///
/// Every rule here fails CLOSED, because a host pattern decides where a
/// credential is injected:
///
/// - **Label counts must be equal.** A `*` stands for exactly one label, never
///   a run of them, so `*.s3.*.amazonaws.com` cannot match
///   `a.b.s3.us-east-1.amazonaws.com`. This is what keeps a pattern anchored to
///   a fixed depth.
/// - **Every `*` consumes at least one character**, and an empty label never
///   matches — `.s3.x.amazonaws.com` and `s3..amazonaws.com` are refused.
/// - **At most one `*` per label.** A label like `**` has no useful meaning and
///   would only widen the surface, so it matches nothing.
///
/// The trailing-label question (a pattern ending in `*`, e.g. `*.notion.*`,
/// which would span every TLD including attacker-registrable ones) is settled
/// EARLIER, at write time: `hostPatternSchema` refuses to store such a pattern.
/// This matcher stays purely mechanical and makes no policy judgement of its
/// own, so both ports can be compared literally.
fn multi_wildcard_matches(request_host: &str, pattern: &str) -> bool {
    // Single pass: `zip` stops at the shorter side, so an equal-length check
    // has to ride along rather than be a separate `count()` walk — this runs on
    // the request path, once per candidate pattern.
    let mut host_labels = request_host.split('.');
    let mut pattern_labels = pattern.split('.');
    loop {
        match (host_labels.next(), pattern_labels.next()) {
            (Some(host_label), Some(pattern_label)) => {
                if !label_matches(host_label, pattern_label) {
                    return false;
                }
            }
            // Both ran out together: every label matched.
            (None, None) => return true,
            // One side is longer — a `*` is exactly ONE label, so differing
            // depths never match.
            _ => return false,
        }
    }
}

/// One host label against one pattern label: literal, or a single `*` standing
/// in for 1+ characters within THIS label only.
fn label_matches(host_label: &str, pattern_label: &str) -> bool {
    if host_label.is_empty() {
        return false;
    }
    match pattern_label.split_once('*') {
        None => host_label.eq_ignore_ascii_case(pattern_label),
        // A second `*` in the same label buys nothing and only widens — refuse.
        Some((_, suffix)) if suffix.contains('*') => false,
        Some((prefix, suffix)) => {
            // `> ` (not `>=`) forces the `*` to consume at least one character.
            host_label.len() > prefix.len() + suffix.len()
                && host_label
                    .get(..prefix.len())
                    .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
                && host_label
                    .get(host_label.len() - suffix.len()..)
                    .is_some_and(|s| s.eq_ignore_ascii_case(suffix))
        }
    }
}

/// Strip port from a `host:port` string, returning just the hostname.
pub fn strip_port(host: &str) -> &str {
    host.split(':').next().unwrap_or(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_jwt_exp_extracts_expiry() {
        // JWT with payload {"exp": 1700000000}
        let token = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3MDAwMDAwMDB9.signature";
        assert_eq!(parse_jwt_exp(token), Some(1700000000));
    }

    #[test]
    fn parse_jwt_exp_returns_none_for_invalid_token() {
        assert_eq!(parse_jwt_exp("not-a-jwt"), None);
        assert_eq!(parse_jwt_exp(""), None);
        assert_eq!(parse_jwt_exp("a.!!!.c"), None);
    }

    // ── host_matches ────────────────────────────────────────────────────

    #[test]
    fn host_exact_match() {
        assert!(host_matches("api.anthropic.com", "api.anthropic.com"));
        assert!(!host_matches("api.anthropic.com", "other.com"));
    }

    #[test]
    fn host_wildcard_match() {
        assert!(host_matches("api.example.com", "*.example.com"));
        assert!(host_matches("sub.example.com", "*.example.com"));
        assert!(!host_matches("example.com", "*.example.com"));
        assert!(!host_matches("api.other.com", "*.example.com"));
    }

    #[test]
    fn host_wildcard_no_match_without_dot() {
        assert!(!host_matches("notexample.com", "*.example.com"));
    }

    #[test]
    fn host_midstring_wildcard() {
        // Mid-string wildcard: the region label in AWS regional endpoints.
        assert!(host_matches(
            "s3.us-east-1.amazonaws.com",
            "s3.*.amazonaws.com"
        ));
        assert!(host_matches(
            "lambda.eu-west-1.amazonaws.com",
            "lambda.*.amazonaws.com"
        ));
        // Wrong service prefix, or the apex with no region label, must not match.
        assert!(!host_matches(
            "ec2.us-east-1.amazonaws.com",
            "s3.*.amazonaws.com"
        ));
        assert!(!host_matches("s3.amazonaws.com", "s3.*.amazonaws.com"));
        // Exact patterns (no wildcard) still match only themselves.
        assert!(host_matches("iam.amazonaws.com", "iam.amazonaws.com"));
        assert!(!host_matches("s3.amazonaws.com", "iam.amazonaws.com"));
    }

    #[test]
    fn host_matching_is_case_insensitive() {
        // DNS host names are case-insensitive; a mixed-case CONNECT authority
        // must still match a lowercase rule (exact, leading-*, and mid-string).
        assert!(host_matches("API.GitHub.com", "api.github.com"));
        assert!(host_matches("Api.Example.com", "*.example.com"));
        assert!(host_matches(
            "S3.US-EAST-1.AMAZONAWS.COM",
            "s3.*.amazonaws.com"
        ));
        assert!(!host_matches("api.evil.com", "api.github.com"));
    }

    // ── Multi-wildcard (2+ `*`) — the label-bounded regime ──────────────

    #[test]
    fn label_matching_never_panics_on_arbitrary_utf8() {
        // Slicing is per-label in the multi-wildcard regime, so the char-boundary
        // guarantee `get(..)` gives the single-`*` path has to hold there too.
        let hosts = [
            "日本.s3.東京.amazonaws.com",
            "é.s3.ü.amazonaws.com",
            "..",
            "",
            "*",
            "\u{0}.s3.x.amazonaws.com",
        ];
        let patterns = ["*.s3.*.amazonaws.com", "*.日本.*.com", "**", "*.*", "*"];
        for host in hosts {
            for pattern in patterns {
                let _ = host_matches(host, pattern);
            }
        }
    }

    /// The SHARED parity corpus, mirrored verbatim in the TypeScript port
    /// (`packages/api/src/lib/host-match-parity.test.ts`). Both ports decide
    /// the same requests — the gateway enforces, the API explains — so a
    /// divergence here means the dashboard would describe access the gateway
    /// does not actually grant. Keep the two lists identical.
    #[test]
    fn parity_corpus_matches_the_typescript_port() {
        const CASES: &[(&str, &str, bool)] = &[
            (
                "example.s3.us-east-1.amazonaws.com",
                "*.s3.*.amazonaws.com",
                true,
            ),
            (
                "my-bucket.s3.eu-west-2.amazonaws.com",
                "*.s3.*.amazonaws.com",
                true,
            ),
            (
                "123456789012.ddb.us-east-1.amazonaws.com",
                "*.ddb.*.amazonaws.com",
                true,
            ),
            (
                "EXAMPLE.S3.US-EAST-1.AMAZONAWS.COM",
                "*.s3.*.amazonaws.com",
                true,
            ),
            (
                "a.b.s3.us-east-1.amazonaws.com",
                "*.s3.*.amazonaws.com",
                false,
            ),
            ("s3.us-east-1.amazonaws.com", "*.s3.*.amazonaws.com", false),
            (
                "s3tables.us-east-1.amazonaws.com",
                "*.s3.*.amazonaws.com",
                false,
            ),
            (
                "x.s3.y.amazonaws.com.evil.test",
                "*.s3.*.amazonaws.com",
                false,
            ),
            (".s3.x.amazonaws.com", "*.s3.*.amazonaws.com", false),
            ("s3..amazonaws.com", "*.s3.*.amazonaws.com", false),
            ("a.example.com", "**.example.com", false),
            // regime 1 — must be untouched
            ("a.b.example.com", "*.example.com", true),
            (
                "s3.dualstack.us-east-1.amazonaws.com",
                "s3.*.amazonaws.com",
                true,
            ),
            ("anything.at.all", "*", true),
            ("example.com", "*.example.com", false),
            (
                "us-central1-aiplatform.googleapis.com",
                "*-aiplatform.googleapis.com",
                true,
            ),
        ];
        for (host, pattern, want) in CASES {
            assert_eq!(
                host_matches(host, pattern),
                *want,
                "parity: {host} vs {pattern}"
            );
        }
    }

    #[test]
    fn multi_wildcard_matches_virtual_hosted_aws_shapes() {
        // The shapes that motivated the regime: a bucket AND a region, which
        // no single-`*` pattern can express without swallowing siblings.
        assert!(host_matches(
            "example.s3.us-east-1.amazonaws.com",
            "*.s3.*.amazonaws.com"
        ));
        assert!(host_matches(
            "my-bucket.s3.eu-west-2.amazonaws.com",
            "*.s3.*.amazonaws.com"
        ));
        assert!(host_matches(
            "123456789012.ddb.us-east-1.amazonaws.com",
            "*.ddb.*.amazonaws.com"
        ));
        // Case-insensitive, like every other host comparison.
        assert!(host_matches(
            "EXAMPLE.S3.US-EAST-1.AMAZONAWS.COM",
            "*.s3.*.amazonaws.com"
        ));
    }

    #[test]
    fn multi_wildcard_is_anchored_to_a_fixed_label_depth() {
        // A `*` stands for exactly ONE label. Without this, a pattern would
        // creep down the tree and match hosts a grant never intended.
        assert!(!host_matches(
            "a.b.s3.us-east-1.amazonaws.com",
            "*.s3.*.amazonaws.com"
        ));
        // …and cannot contract either: the bucket label is required.
        assert!(!host_matches(
            "s3.us-east-1.amazonaws.com",
            "*.s3.*.amazonaws.com"
        ));
    }

    #[test]
    fn multi_wildcard_never_crosses_a_sibling_service_or_registrable_suffix() {
        // s3tables / s3-control are DIFFERENT AWS services with their own IAM
        // actions — the leak a loose `s3*.amazonaws.com` glob would open.
        for host in [
            "s3tables.us-east-1.amazonaws.com",
            "s3-control.us-east-1.amazonaws.com",
            "ec2.us-east-1.amazonaws.com",
        ] {
            assert!(
                !host_matches(host, "*.s3.*.amazonaws.com"),
                "{host} must not match the S3 pattern"
            );
        }
        // A look-alike registrable domain must never satisfy the pattern.
        assert!(!host_matches(
            "x.s3.y.amazonaws.com.evil.test",
            "*.s3.*.amazonaws.com"
        ));
    }

    #[test]
    fn multi_wildcard_fails_closed_on_degenerate_input() {
        // Empty labels never match — a `*` must stand for real characters.
        assert!(!host_matches(".s3.x.amazonaws.com", "*.s3.*.amazonaws.com"));
        assert!(!host_matches("s3..amazonaws.com", "*.s3.*.amazonaws.com"));
        // Two `*` inside ONE label buys nothing and only widens: refused.
        assert!(!host_matches("a.example.com", "**.example.com"));
        assert!(!host_matches("ab.example.com", "**.example.com"));
    }

    #[test]
    fn single_wildcard_behavior_is_untouched_by_the_new_regime() {
        // The regime split is on wildcard COUNT, so every 0/1-`*` pattern must
        // behave exactly as before — including the label-crossing reach that
        // live secrets depend on (`*.example.com` covering `a.b.example.com`).
        assert!(host_matches("a.b.example.com", "*.example.com"));
        assert!(host_matches(
            "s3.dualstack.us-east-1.amazonaws.com",
            "s3.*.amazonaws.com"
        ));
        assert!(host_matches("anything.at.all", "*"));
        assert!(!host_matches("example.com", "*.example.com"));
    }

    // ── strip_port ──────────────────────────────────────────────────────

    #[test]
    fn strip_port_removes_port() {
        assert_eq!(strip_port("example.com:443"), "example.com");
        assert_eq!(strip_port("api.anthropic.com:8080"), "api.anthropic.com");
    }

    #[test]
    fn strip_port_handles_bare_hostname() {
        assert_eq!(strip_port("example.com"), "example.com");
        assert_eq!(strip_port("localhost"), "localhost");
    }

    #[test]
    fn strip_port_handles_ipv6_no_brackets() {
        // IPv6 with port typically uses brackets, but strip_port just splits on ':'
        // For bracket-wrapped IPv6 like [::1]:443, it returns "[" — this is acceptable
        // since hyper always sends host:port format for CONNECT
        assert_eq!(strip_port("[::1]:443"), "[");
    }

    #[test]
    fn strip_port_handles_empty() {
        assert_eq!(strip_port(""), "");
    }
}
