//! App-availability enforcement (#29): the licensed resolution of a
//! workspace's allowed-app set and the per-request block predicate. The
//! admin surface (routes + rule CRUD) lives in `packages/api/src/ee`; the
//! shared request path calls the predicate with the set resolved here at
//! connect time, so per-request enforcement stays DB-free.

use sqlx::PgPool;
use tracing::warn;

use apps::provider_for_host_and_path;
use db::AvailableApps;

use super::resolve::{find_app_availability_mode, find_available_providers};

/// The licensed arm of `crate::policy_engine::load_available_apps` (which
/// early-returns the unrestricted default for unlicensed deployments before
/// calling here). "Open" orgs (the default) and any resolution error fail
/// OPEN (all apps available) — availability is a provisioning gate (policy
/// still governs use), so over-blocking would needlessly cut legitimate app
/// traffic (and the LLM/un-managed carve already spares raw + LLM hosts
/// regardless).
pub async fn load_available_apps(pool: &PgPool, org_id: &str, workspace_id: &str) -> AvailableApps {
    // Read the org posture first (cheap); only the "restricted" minority pays for
    // the grant derivation.
    match find_app_availability_mode(pool, org_id).await {
        Ok(mode) if mode == "restricted" => {}
        Ok(_) => return AvailableApps::default(), // "open" → all apps available
        Err(e) => {
            warn!(error = %e, "app availability: mode load failed at resolution, treating as open");
            return AvailableApps::default();
        }
    }
    match find_available_providers(pool, workspace_id, org_id).await {
        Ok(providers) => AvailableApps {
            restricted: true,
            providers,
        },
        Err(e) => {
            warn!(error = %e, "app availability: provider resolution failed, treating as open this cycle");
            AvailableApps::default()
        }
    }
}

/// The app-availability pre-check (step 7). Returns `Some(provider)` when the
/// request targets a known app provider that is NOT available to the connection's
/// workspace — the caller refuses it. Returns `None` (allowed) when availability is
/// unrestricted (the common case / OSS / enforcement off), when the request does
/// not target an identifiable app provider (a raw/unknown host, or an ambiguous
/// shared host — so the LLM host and un-managed traffic are structurally never
/// blocked), or when the targeted provider IS available. Pure + DB-free — the
/// available set was resolved once at connection resolution.
#[must_use]
pub fn app_availability_block(
    host: &str,
    path: &str,
    available: &db::AvailableApps,
) -> Option<String> {
    if !available.restricted {
        return None;
    }
    // Normalize the host (strip port + lowercase) before provider identification.
    // Registry matching is exact + port-less, so a port-bearing CONNECT authority
    // (`gmail.googleapis.com:443`) or a mixed-case Host (`Gmail.Googleapis.Com`)
    // would otherwise identify no provider and silently slip past the gate. This
    // is a security gate, so it normalizes here even though provider matching
    // elsewhere (credential injection) is case-sensitive — there a miss just
    // fails safe (no creds → 401). Only restricted orgs reach this (the common
    // `restricted: false` path returned above), so the allocation is off the
    // prod/OSS hot path. (The port strip is a hard-won regression lesson.)
    let host = common::util::strip_port(host).to_ascii_lowercase();
    match provider_for_host_and_path(&host, path) {
        Some((provider, _)) if !available.providers.iter().any(|p| p == provider) => {
            Some(provider.to_string())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── app_availability_block (step 7) ────────────────────────────────

    /// Build an `AvailableApps` allowlist for tests.
    fn available(restricted: bool, providers: &[&str]) -> db::AvailableApps {
        db::AvailableApps {
            restricted,
            providers: providers.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    #[test]
    fn app_availability_block_open_allows_everything() {
        // "open" org (the default / OSS / enforcement off): never blocks, even a
        // provider absent from the (empty) list.
        let open = available(false, &[]);
        assert_eq!(
            app_availability_block("gmail.googleapis.com", "/gmail/v1/users/me", &open),
            None
        );
        assert_eq!(
            app_availability_block("api.github.com", "/user", &open),
            None
        );
    }

    #[test]
    fn app_availability_block_restricted_allows_granted_provider() {
        let restricted = available(true, &["gmail", "github"]);
        assert_eq!(
            app_availability_block("gmail.googleapis.com", "/gmail/v1/users/me", &restricted),
            None
        );
        assert_eq!(
            app_availability_block("api.github.com", "/user", &restricted),
            None
        );
    }

    #[test]
    fn app_availability_block_restricted_blocks_ungranted_provider() {
        let restricted = available(true, &["slack"]);
        assert_eq!(
            app_availability_block("gmail.googleapis.com", "/gmail/v1/users/me", &restricted),
            Some("gmail".to_string())
        );
        assert_eq!(
            app_availability_block("api.github.com", "/user", &restricted),
            Some("github".to_string())
        );
    }

    #[test]
    fn app_availability_block_never_blocks_raw_or_llm_hosts() {
        // Restricted with an empty allowlist: even so, un-managed raw hosts and the
        // LLM host resolve to no provider, so they are structurally never blocked
        // (the enforce-deny / lifeline carve, for free).
        let restricted = available(true, &[]);
        assert_eq!(
            app_availability_block("api.openai.com", "/v1/chat/completions", &restricted),
            None
        );
        assert_eq!(
            app_availability_block("api.anthropic.com", "/v1/messages", &restricted),
            None
        );
        assert_eq!(
            app_availability_block("example.com", "/anything", &restricted),
            None
        );
    }

    #[test]
    fn app_availability_block_shared_host_disambiguates_by_path() {
        // A shared host (www.googleapis.com) is governed per-provider by path.
        let restricted = available(true, &["gmail"]);
        // Granted provider on its path → allowed.
        assert_eq!(
            app_availability_block("www.googleapis.com", "/gmail/v1/users/me", &restricted),
            None
        );
        // Ungranted provider on its path → blocked.
        assert_eq!(
            app_availability_block("www.googleapis.com", "/calendar/v3/calendars", &restricted),
            Some("google-calendar".to_string())
        );
    }

    #[test]
    fn app_availability_block_shared_host_unknown_path_fails_open() {
        // An ambiguous shared-host path resolves to no provider → not blocked
        // (deliberate fail-open on ambiguity; policy + enforce-deny still govern).
        let restricted = available(true, &[]);
        assert_eq!(
            app_availability_block(
                "www.googleapis.com",
                "/some-unknown-api/v1/resource",
                &restricted
            ),
            None
        );
    }

    #[test]
    fn app_availability_block_strips_port_before_matching() {
        // The real call site passes a host that carries the CONNECT-authority
        // port (`:443`); the registry hosts are port-less, so the block must
        // strip the port first or it would identify NO provider and silently
        // never block. Regression guard for that class of port-handling bugs.
        let restricted = available(true, &["slack"]);
        assert_eq!(
            app_availability_block(
                "gmail.googleapis.com:443",
                "/gmail/v1/users/me",
                &restricted
            ),
            Some("gmail".to_string())
        );
        // ...and a granted provider on a port-bearing host is still allowed.
        let granted = available(true, &["gmail"]);
        assert_eq!(
            app_availability_block("gmail.googleapis.com:443", "/gmail/v1/users/me", &granted),
            None
        );
    }

    #[test]
    fn app_availability_block_is_case_insensitive_on_host() {
        // A mixed-case Host must not slip past the gate — it normalizes to lower
        // before matching, else `Gmail.Googleapis.Com` identifies no provider.
        let restricted = available(true, &["slack"]);
        assert_eq!(
            app_availability_block(
                "Gmail.Googleapis.Com:443",
                "/gmail/v1/users/me",
                &restricted
            ),
            Some("gmail".to_string())
        );
    }
}
