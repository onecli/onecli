//! "Approve similar": one approval that also lets the agent's next updates of
//! the same kind through, for a short window and a bounded number of requests.
//!
//! An agent working through a list of records often sends one update at a
//! time, each waiting on its own approval (an API like Attio's has no bulk
//! update, and a script loop waits on each call). The reviewer then gets one
//! card per record. This lets them approve the first card for the rest.
//!
//! What counts as "similar" is decided HERE, by the gateway, from the held
//! request itself, never from anything the agent or a client claims. The
//! scope is offered only on an endpoint the vendor documents as "update one
//! existing record" ([`RECORD_UPDATES`]). It is an allowlist, so an app added
//! later never gets the scope by default. A window covers a request only when
//! ALL of these match the card the reviewer approved:
//!
//! - the workspace, the agent and the connection whose credential is used;
//! - the policy rule that held it (a policy change closes the window);
//! - the host, the app, the method and the record type (`companies`,
//!   `Contact`);
//! - a path that names one existing record by its id, with no query string.
//!
//! A window lasts [`SIMILAR_WINDOW_SECS`] and lets at most
//! [`SIMILAR_WINDOW_MAX_REQUESTS`] requests through; the next one asks again.
//! The body may differ (different fields per record): the card names the
//! scope ("Attio updates to companies") so the reviewer knows what it covers.

use cache::CacheStore;
use serde::{Deserialize, Serialize};

use crate::unix_now;

/// How long an "approve similar" window lasts.
pub const SIMILAR_WINDOW_SECS: u64 = 15 * 60;

/// How many requests one window lets through before the next one asks.
pub const SIMILAR_WINDOW_MAX_REQUESTS: u64 = 100;

/// One path segment of a documented record-update endpoint.
#[derive(Debug, Clone, Copy)]
enum Seg {
    /// Exactly this word.
    Lit(&'static str),
    /// A dotted API version (`v62.0`).
    DottedVersion,
    /// A date API version (`2026-03`).
    DateVersion,
    /// The record type (`companies`, `Contact`): part of the window's key and
    /// named on the card.
    RecordType,
    /// The record id: the one segment that may differ between the requests
    /// a window covers.
    Id(IdKind),
}

#[derive(Debug, Clone, Copy)]
enum IdKind {
    /// A UUID.
    Uuid,
    /// A decimal number.
    Digits,
    /// A 15- or 18-character Salesforce id.
    Salesforce,
}

/// A vendor-documented "update one existing record" endpoint.
struct RecordUpdate {
    app: &'static str,
    methods: &'static [&'static str],
    path: &'static [Seg],
}

use IdKind::{Digits, Salesforce, Uuid};
use Seg::{DateVersion, DottedVersion, Id, Lit, RecordType};

/// The only requests "Approve similar" is ever offered on. Each is an update
/// of one existing record that the vendor documents as such: it never
/// creates, deletes, sends or moves money.
const RECORD_UPDATES: &[RecordUpdate] = &[
    // Attio "Update a record": PUT overwrites multiselect values and PATCH
    // appends to them. `object` is a slug or a UUID; `record_id` is a UUID.
    RecordUpdate {
        app: "attio",
        methods: &["PUT", "PATCH"],
        path: &[
            Lit("v2"),
            Lit("objects"),
            RecordType,
            Lit("records"),
            Id(Uuid),
        ],
    },
    // HubSpot "Update" of a CRM object by its internal id, on the v3 path and
    // the date-versioned one. Naming the record by another property needs
    // `?idProperty=`, and a query string is never covered.
    RecordUpdate {
        app: "hubspot",
        methods: &["PATCH"],
        path: &[
            Lit("crm"),
            Lit("v3"),
            Lit("objects"),
            RecordType,
            Id(Digits),
        ],
    },
    RecordUpdate {
        app: "hubspot",
        methods: &["PATCH"],
        path: &[
            Lit("crm"),
            Lit("objects"),
            DateVersion,
            RecordType,
            Id(Digits),
        ],
    },
    // Salesforce "Update Records Using sObject Rows", by record id. An upsert
    // by external id (`…/sobjects/<type>/<field>/<value>`) may create a record
    // and has one more segment, so it never matches.
    RecordUpdate {
        app: "salesforce",
        methods: &["PATCH"],
        path: &[
            Lit("services"),
            Lit("data"),
            DottedVersion,
            Lit("sobjects"),
            RecordType,
            Id(Salesforce),
        ],
    },
];

/// The scope a held request would open if approved as "similar". Built by
/// the gateway when the request is held; stored with the pending approval so
/// the decision reads exactly what the card offered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SimilarScope {
    /// The cache key of the window. Never shown or sent to clients.
    pub key: String,
    /// What the window covers, for the card ("Attio updates to companies").
    pub label: String,
}

/// An open window: written when a reviewer approves with the scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SimilarAllowance {
    /// The approval the reviewer decided. Every request the window lets
    /// through is recorded against it.
    pub approval_id: String,
    pub approved_by: Option<String>,
    pub expires_at: u64,
}

/// What the gateway knows about a request it is about to hold.
pub struct HeldRequest<'a> {
    pub workspace_id: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    /// The connection whose credential the gateway injects.
    pub connection_id: Option<&'a str>,
    /// The policy rule that holds the request.
    pub rule_id: &'a str,
    /// The catalog app the request matched, and its display name.
    pub app: Option<(&'a str, &'a str)>,
    /// The destination host, without a port. A suffix-matched app (one host
    /// per tenant) must never carry a window to another tenant's host.
    pub host: &'a str,
    pub method: &'a str,
    pub path: &'a str,
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

/// The scope a held request offers, or `None` when it may not be approved
/// as "similar": not a documented update of one record, or nothing to pin
/// the window to (no workspace, agent, connection or rule).
#[must_use]
pub fn scope_for(req: &HeldRequest<'_>) -> Option<SimilarScope> {
    let workspace_id = non_empty(req.workspace_id)?;
    let agent_id = non_empty(req.agent_id)?;
    let connection_id = non_empty(req.connection_id)?;
    let rule_id = non_empty(Some(req.rule_id))?;
    let host = non_empty(Some(req.host))?.to_ascii_lowercase();
    if !host
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.'))
    {
        return None;
    }
    let (app, app_name) = req.app?;
    let method = req.method.to_ascii_uppercase();
    let segments = path_segments(req.path)?;
    let endpoint = RECORD_UPDATES.iter().find(|e| {
        e.app == app
            && e.methods.contains(&method.as_str())
            && e.path.len() == segments.len()
            && e.path.iter().zip(&segments).all(|(seg, s)| seg.matches(s))
    })?;
    let record_type = endpoint
        .path
        .iter()
        .zip(&segments)
        .find_map(|(seg, s)| matches!(seg, RecordType).then_some(*s))?;
    let shape = endpoint
        .path
        .iter()
        .zip(&segments)
        .map(|(seg, s)| if matches!(seg, Id(_)) { "*" } else { s })
        .collect::<Vec<_>>()
        .join("/");
    // An object named by its UUID (Attio allows it) has no readable name.
    let label = if Uuid.matches(record_type) {
        format!("{app_name} updates to one record type")
    } else {
        format!("{app_name} updates to {record_type}")
    };
    Some(SimilarScope {
        key: format!(
            "approval-similar:{workspace_id}:{agent_id}:{connection_id}:{rule_id}:{host}:{app}:{method}:/{shape}"
        ),
        label,
    })
}

/// The path's segments, when it is a plain path: no query string or
/// fragment (some APIs pick what an update does with a parameter), no empty,
/// `.` or `..` segment, and nothing percent-encoded (an encoded `/` or `?`
/// would hide a different request behind the same shape). One trailing `/`
/// is allowed: Salesforce documents its record URI with one.
fn path_segments(path: &str) -> Option<Vec<&str>> {
    if path.contains(['?', '#']) {
        return None;
    }
    let rest = path.strip_prefix('/')?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let segments: Vec<&str> = rest.split('/').collect();
    let plain = |s: &&str| {
        !s.is_empty()
            && *s != "."
            && *s != ".."
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    };
    segments.iter().all(plain).then_some(segments)
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

impl Seg {
    fn matches(self, s: &str) -> bool {
        match self {
            Lit(word) => s == word,
            DottedVersion => s
                .strip_prefix('v')
                .and_then(|v| v.split_once('.'))
                .is_some_and(|(major, minor)| all_digits(major) && all_digits(minor)),
            DateVersion => s.split_once('-').is_some_and(|(year, month)| {
                year.len() == 4 && month.len() == 2 && all_digits(year) && all_digits(month)
            }),
            RecordType => {
                (1..=64).contains(&s.len())
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
            }
            Id(kind) => kind.matches(s),
        }
    }
}

impl IdKind {
    fn matches(self, s: &str) -> bool {
        match self {
            Uuid => {
                s.len() == 36
                    && s.bytes().enumerate().all(|(i, b)| match i {
                        8 | 13 | 18 | 23 => b == b'-',
                        _ => b.is_ascii_hexdigit(),
                    })
            }
            Digits => s.len() <= 20 && all_digits(s),
            Salesforce => {
                matches!(s.len(), 15 | 18) && s.bytes().all(|b| b.is_ascii_alphanumeric())
            }
        }
    }
}

/// The counter of requests a window has let through, keyed by the approval
/// that opened it, so a new window starts from zero.
fn uses_key(approval_id: &str) -> String {
    format!("approval-similar-uses:{approval_id}")
}

/// Let one request through the open window for `scope`, if a reviewer opened
/// one that has not expired or used up its [`SIMILAR_WINDOW_MAX_REQUESTS`].
/// `None` means the request is held for a card as usual, which is also the
/// answer when the cache fails: a window never opens by accident. The cache
/// TTL bounds the window too; `expires_at` is checked so a store that keeps a
/// key a little late never extends it.
pub async fn claim(cache: &dyn CacheStore, scope: &SimilarScope) -> Option<SimilarAllowance> {
    let allowance: SimilarAllowance = cache.get(&scope.key).await?;
    let remaining = allowance
        .expires_at
        .checked_sub(unix_now())
        .filter(|secs| *secs > 0)?;
    let used = cache
        .incr(&uses_key(&allowance.approval_id), remaining)
        .await?;
    (used <= SIMILAR_WINDOW_MAX_REQUESTS).then_some(allowance)
}

/// Open (or replace) the window for `scope` after a reviewer approved the
/// card that offered it. Returns when it closes.
pub async fn open(
    cache: &dyn CacheStore,
    scope: &SimilarScope,
    approval_id: &str,
    approved_by: Option<String>,
) -> u64 {
    let expires_at = unix_now() + SIMILAR_WINDOW_SECS;
    let allowance = SimilarAllowance {
        approval_id: approval_id.to_string(),
        approved_by,
        expires_at,
    };
    cache.set(&scope.key, &allowance, SIMILAR_WINDOW_SECS).await;
    expires_at
}

#[cfg(test)]
mod tests {
    use super::*;

    const REC_A: &str = "8422b746-59d3-4cfd-98f9-3b25dc9145d3";
    const REC_B: &str = "5f765abf-99d1-4247-ba62-3a4b5597069e";

    fn held<'a>(app: (&'a str, &'a str), method: &'a str, path: &'a str) -> HeldRequest<'a> {
        HeldRequest {
            workspace_id: Some("ws"),
            agent_id: Some("agent"),
            connection_id: Some("conn"),
            rule_id: "rule",
            app: Some(app),
            host: "api.example.com",
            method,
            path,
        }
    }

    fn attio(method: &str, path: &str) -> Option<SimilarScope> {
        scope_for(&held(("attio", "Attio"), method, path))
    }

    fn companies(record: &str) -> String {
        format!("/v2/objects/companies/records/{record}")
    }

    #[test]
    fn attio_updates_of_one_record_share_a_scope_whatever_the_record() {
        for method in ["PUT", "PATCH", "patch"] {
            let a = attio(method, &companies(REC_A)).unwrap();
            let b = attio(method, &companies(REC_B)).unwrap();
            assert_eq!(a, b);
            assert_eq!(a.label, "Attio updates to companies");
        }
        assert_eq!(
            attio("PUT", &companies(REC_A)).unwrap().key,
            "approval-similar:ws:agent:conn:rule:api.example.com:attio:PUT:/v2/objects/companies/records/*"
        );
    }

    #[test]
    fn another_record_type_method_agent_connection_rule_or_host_is_another_scope() {
        let base = attio("PUT", &companies(REC_A)).unwrap();
        let people = attio("PUT", &format!("/v2/objects/people/records/{REC_A}")).unwrap();
        let patch = attio("PATCH", &companies(REC_A)).unwrap();
        assert_ne!(base.key, people.key);
        assert_ne!(base.key, patch.key);
        let path = companies(REC_A);
        for other in [
            HeldRequest {
                agent_id: Some("agent2"),
                ..held(("attio", "Attio"), "PUT", &path)
            },
            HeldRequest {
                connection_id: Some("conn2"),
                ..held(("attio", "Attio"), "PUT", &path)
            },
            HeldRequest {
                rule_id: "rule2",
                ..held(("attio", "Attio"), "PUT", &path)
            },
            HeldRequest {
                workspace_id: Some("ws2"),
                ..held(("attio", "Attio"), "PUT", &path)
            },
            // Another tenant's host of a suffix-matched app.
            HeldRequest {
                host: "other.example.com",
                ..held(("attio", "Attio"), "PUT", &path)
            },
        ] {
            assert_ne!(scope_for(&other).unwrap().key, base.key);
        }
        // A host that could collide inside the key is refused outright.
        assert!(scope_for(&HeldRequest {
            host: "a:b",
            ..held(("attio", "Attio"), "PUT", &path)
        })
        .is_none());
    }

    #[test]
    fn objects_named_by_uuid_keep_their_own_scope() {
        let one = attio("PATCH", &format!("/v2/objects/{REC_A}/records/{REC_B}")).unwrap();
        let other = attio("PATCH", &format!("/v2/objects/{REC_B}/records/{REC_B}")).unwrap();
        assert_ne!(one.key, other.key);
        assert_eq!(one.label, "Attio updates to one record type");
    }

    #[test]
    fn creates_deletes_upserts_and_reads_are_never_offered() {
        for method in ["POST", "DELETE", "GET", "HEAD"] {
            assert!(attio(method, &companies(REC_A)).is_none());
        }
        // Attio's upsert ("assert") is a PUT on the collection.
        assert!(attio("PUT", "/v2/objects/companies/records").is_none());
        // Not a UUID: Attio record ids always are.
        assert!(attio("PATCH", "/v2/objects/companies/records/12345").is_none());
        // Other Attio writes are not a record update.
        assert!(attio("PATCH", &format!("/v2/lists/sales/entries/{REC_A}")).is_none());
        assert!(attio("PATCH", &format!("/v2/webhooks/{REC_A}")).is_none());
    }

    #[test]
    fn hubspot_updates_by_internal_id_on_both_documented_paths() {
        let hubspot =
            |method: &str, path: &str| scope_for(&held(("hubspot", "HubSpot"), method, path));
        let v3 = hubspot("PATCH", "/crm/v3/objects/contacts/12345").unwrap();
        assert_eq!(v3.label, "HubSpot updates to contacts");
        assert_eq!(
            v3,
            hubspot("PATCH", "/crm/v3/objects/contacts/67890").unwrap()
        );
        let dated = hubspot("PATCH", "/crm/objects/2026-03/contacts/12345").unwrap();
        assert!(dated.key.ends_with(":/crm/objects/2026-03/contacts/*"));
        // Not documented as an update, or not by internal id.
        assert!(hubspot("PUT", "/crm/v3/objects/contacts/12345").is_none());
        assert!(hubspot("PATCH", "/crm/v3/objects/contacts/jane.example.com").is_none());
        assert!(hubspot("PATCH", "/crm/v3/objects/contacts/12345?idProperty=email").is_none());
        assert!(hubspot("POST", "/crm/v3/objects/contacts/batch/update").is_none());
        assert!(hubspot("PUT", "/crm/v4/objects/contacts/1/associations/companies/2").is_none());
    }

    #[test]
    fn salesforce_updates_by_record_id_but_never_an_upsert() {
        let sf =
            |method: &str, path: &str| scope_for(&held(("salesforce", "Salesforce"), method, path));
        let by_id = sf(
            "PATCH",
            "/services/data/v62.0/sobjects/Contact/003Ux00000AbCdEIAV",
        )
        .unwrap();
        assert_eq!(by_id.label, "Salesforce updates to Contact");
        assert!(by_id
            .key
            .ends_with(":/services/data/v62.0/sobjects/Contact/*"));
        // 15-character id, and the documented trailing slash.
        assert_eq!(
            by_id,
            sf(
                "PATCH",
                "/services/data/v62.0/sobjects/Contact/003Ux00000AbCdE/"
            )
            .unwrap()
        );
        // Upsert by external id may create a record.
        assert!(sf(
            "PATCH",
            "/services/data/v62.0/sobjects/Contact/Ext_Id__c/A-1"
        )
        .is_none());
        assert!(sf(
            "PATCH",
            "/services/data/v62.0/sobjects/Contact/Email/a1b2c3d4e5f6g7h"
        )
        .is_none());
        // Bulk and create-by-id.
        assert!(sf("PATCH", "/services/data/v62.0/composite/sobjects").is_none());
        assert!(sf(
            "POST",
            "/services/data/v62.0/sobjects/Contact/003Ux00000AbCdEIAV"
        )
        .is_none());
    }

    #[test]
    fn apps_off_the_list_are_never_offered_even_on_record_shaped_paths() {
        for (app, path) in [
            // A ticket update can post a comment to the customer.
            (("zendesk", "Zendesk"), "/api/v2/tickets/12345"),
            // A repo update can make it public.
            (("github", "GitHub"), "/repos/acme/backend2"),
            (
                ("google-admin", "Google Admin"),
                "/admin/directory/v1/users/12345",
            ),
            (
                ("cloudflare", "Cloudflare"),
                "/client/v4/zones/abc123def456/dns_records/abc123def456",
            ),
            (("stripe", "Stripe"), "/v1/customers/cus_12345678"),
            // The same path on another app is not Attio's endpoint.
            (
                ("notion", "Notion"),
                "/v2/objects/companies/records/8422b746-59d3-4cfd-98f9-3b25dc9145d3",
            ),
        ] {
            for method in ["PUT", "PATCH"] {
                assert!(
                    scope_for(&held(app, method, path)).is_none(),
                    "{app:?} {path}"
                );
            }
        }
    }

    #[test]
    fn encoded_traversing_or_odd_paths_are_never_covered() {
        for path in [
            format!("/v2/objects/companies/records/{REC_A}?x=1"),
            format!("/v2/objects/companies/records/{REC_A}#x"),
            format!("/v2/objects/companies%2Fx/records/{REC_A}"),
            format!("/v2/objects/a:b/records/{REC_A}"),
            format!("/v2/objects/../records/{REC_A}"),
            format!("/v2//objects/companies/records/{REC_A}"),
            format!("v2/objects/companies/records/{REC_A}"),
        ] {
            assert!(attio("PUT", &path).is_none(), "{path}");
        }
    }

    #[test]
    fn nothing_to_pin_the_window_to_means_no_scope() {
        let path = companies(REC_A);
        let base = held(("attio", "Attio"), "PUT", &path);
        for missing in [
            HeldRequest {
                connection_id: None,
                ..held(("attio", "Attio"), "PUT", &path)
            },
            HeldRequest {
                agent_id: Some(""),
                ..held(("attio", "Attio"), "PUT", &path)
            },
            HeldRequest {
                workspace_id: None,
                ..held(("attio", "Attio"), "PUT", &path)
            },
            HeldRequest {
                rule_id: "",
                ..held(("attio", "Attio"), "PUT", &path)
            },
            HeldRequest { app: None, ..base },
        ] {
            assert!(scope_for(&missing).is_none());
        }
    }

    #[tokio::test]
    async fn a_window_opens_for_its_scope_only() {
        let cache = cache::in_memory();
        let companies = attio("PUT", &companies(REC_A)).unwrap();
        let people = attio("PUT", &format!("/v2/objects/people/records/{REC_A}")).unwrap();
        assert!(claim(&*cache, &companies).await.is_none());
        open(&*cache, &companies, "ap-1", Some("u1".into())).await;
        let hit = claim(&*cache, &companies).await.unwrap();
        assert_eq!(hit.approval_id, "ap-1");
        assert_eq!(hit.approved_by.as_deref(), Some("u1"));
        assert!(claim(&*cache, &people).await.is_none());
    }

    #[tokio::test]
    async fn an_expired_window_is_closed() {
        let cache = cache::in_memory();
        let s = attio("PUT", &companies(REC_A)).unwrap();
        let stale = SimilarAllowance {
            approval_id: "ap-1".into(),
            approved_by: None,
            expires_at: unix_now() - 1,
        };
        cache.set(&s.key, &stale, 60).await;
        assert!(claim(&*cache, &s).await.is_none());
    }

    #[tokio::test]
    async fn a_window_lets_through_its_maximum_then_asks_until_reopened() {
        let cache = cache::in_memory();
        let s = attio("PUT", &companies(REC_A)).unwrap();
        open(&*cache, &s, "ap-1", None).await;
        for _ in 0..SIMILAR_WINDOW_MAX_REQUESTS {
            assert!(claim(&*cache, &s).await.is_some());
        }
        assert!(claim(&*cache, &s).await.is_none());
        // Approving a new card as similar opens a fresh window.
        open(&*cache, &s, "ap-2", None).await;
        assert_eq!(claim(&*cache, &s).await.unwrap().approval_id, "ap-2");
    }
}
