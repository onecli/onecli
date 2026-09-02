//! Runtime edition identity for the gateway.
//!
//! One binary serves both editions; the `EDITION` env var selects at startup:
//! `cloud` → Cloud, anything else or unset → Onprem (the self-hosted default —
//! the legacy `oss` value also lands here). Read once into a `OnceLock` so the
//! value cannot change mid-process, the same pattern as the auth secret
//! (`auth.rs`). Code with an edition branch should take `Edition` as a
//! parameter (table-testable) and read `edition()` only at the call site.

use std::sync::OnceLock;

/// The distribution edition this process is running as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edition {
    /// Self-hosted (the default for any `EDITION` value other than `cloud`).
    Onprem,
    Cloud,
}

fn parse(raw: Option<&str>) -> Edition {
    match raw.map(str::trim) {
        Some(v) if v.eq_ignore_ascii_case("cloud") => Edition::Cloud,
        _ => Edition::Onprem,
    }
}

/// The edition selected by the `EDITION` env var, read once at first use.
pub fn edition() -> Edition {
    static EDITION: OnceLock<Edition> = OnceLock::new();
    *EDITION.get_or_init(|| parse(std::env::var("EDITION").ok().as_deref()))
}

/// Whether this deployment may run enterprise features. Cloud is always
/// entitled (billing plans gate there); self-host opts in with
/// `ENTERPRISE_ENABLED=true` under the OneCLI Enterprise License. Forcing
/// cloud inside the parser (not at call sites) keeps every `EDITION=cloud`
/// path — including the whole e2e suite — behaviorally identical with or
/// without the flag.
fn parse_entitled(raw: Option<&str>, edition: Edition) -> bool {
    match edition {
        Edition::Cloud => true,
        Edition::Onprem => matches!(
            raw.map(str::trim),
            Some(v) if v.eq_ignore_ascii_case("true") || v == "1"
        ),
    }
}

/// The entitlement for this process, read once at first use. Code with an
/// entitlement branch should take `entitled: bool` as a parameter
/// (table-testable) and read `entitled()` only at the call site — never on
/// the per-request path; every gate sits at load/startup.
pub fn entitled() -> bool {
    static ENTITLED: OnceLock<bool> = OnceLock::new();
    *ENTITLED.get_or_init(|| {
        parse_entitled(
            std::env::var("ENTERPRISE_ENABLED").ok().as_deref(),
            edition(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_parses_case_insensitively_and_trimmed() {
        assert_eq!(parse(Some("cloud")), Edition::Cloud);
        assert_eq!(parse(Some("  CLOUD ")), Edition::Cloud);
    }

    #[test]
    fn everything_else_is_onprem() {
        assert_eq!(parse(None), Edition::Onprem);
        assert_eq!(parse(Some("")), Edition::Onprem);
        assert_eq!(parse(Some("oss")), Edition::Onprem); // legacy value
        assert_eq!(parse(Some("garbage")), Edition::Onprem);
    }

    #[test]
    fn cloud_is_always_entitled_regardless_of_flag() {
        assert!(parse_entitled(None, Edition::Cloud));
        assert!(parse_entitled(Some("false"), Edition::Cloud));
        assert!(parse_entitled(Some("garbage"), Edition::Cloud));
    }

    #[test]
    fn onprem_requires_the_explicit_opt_in() {
        assert!(parse_entitled(Some("true"), Edition::Onprem));
        assert!(parse_entitled(Some(" TRUE "), Edition::Onprem));
        assert!(parse_entitled(Some("1"), Edition::Onprem));

        assert!(!parse_entitled(None, Edition::Onprem));
        assert!(!parse_entitled(Some(""), Edition::Onprem));
        assert!(!parse_entitled(Some("false"), Edition::Onprem));
        assert!(!parse_entitled(Some("yes"), Edition::Onprem));
        assert!(!parse_entitled(Some("0"), Edition::Onprem));
    }
}
