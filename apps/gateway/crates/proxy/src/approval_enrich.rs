//! Approval-card enrichment: link the records a held request names, and show
//! them by name, before the card is stored, so an approver reads "Account:
//! Initech (001QO…)" instead of a bare id.
//!
//! Provider-agnostic: what a record id means, how its name is read and where
//! its page lives is the provider's [`summary::RecordResolver`]. This module
//! owns the I/O and the guards, the same for every provider. Over https only:
//! a plain-http request gets neither links nor a read. The name read is a
//! gateway-internal READ on the agent's behalf, held to the agent's own
//! bounds; every guard fails soft to "show the id":
//!
//! - **The agent could make this read itself.** It runs only when the agent's
//!   rules PLAINLY allow the exact read (no approval, no rate limit, no block,
//!   no deny-default), via the side-effect-free [`policy_engine::would_allow`].
//!   The probe gates the cache too, so a name another agent's read cached
//!   never reaches a card for an agent that could not read it.
//! - **Same connection, same host, same credential.** Only for a request whose
//!   winning connection injected its credential; the read goes to the held
//!   request's own host carrying only its `authorization` header. Nothing is
//!   minted; no other host is contacted.
//! - **No injection.** Object types come from the resolver's id table and ids
//!   are re-validated by it; nothing from the request body reaches the read
//!   as text.
//! - **Bounded.** One read per object type, at most `MAX_TYPES` types and
//!   `MAX_IDS` ids, all inside `BUDGET`. A timeout or any error keeps the ids.
//! - **Cached** per connection for `CACHE_TTL_SECS`, so a burst of approvals
//!   against one account does one read.
//!
//! Record links need no read: each is the resolver's page for a validated id
//! on the held request's own host, so a record row links even when its name
//! can't be read.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use cache::CacheStore;
use summary::{ApprovalSummary, RecordResolver};
use tracing::debug;

/// Total wall time the name read may add before the card is stored.
const BUDGET: Duration = Duration::from_millis(1500);
/// Distinct object types resolved per card.
const MAX_TYPES: usize = 3;
/// Distinct ids resolved per card.
const MAX_IDS: usize = 10;
/// How long a resolved name is reused for the same connection.
const CACHE_TTL_SECS: u64 = 300;

/// The held request, as the enrichment may use it.
pub struct EnrichContext<'a> {
    pub http: &'a reqwest::Client,
    pub scheme: &'a str,
    /// The held request's host (and port, if any).
    pub host: &'a str,
    /// Headers of the held request AFTER injection (carry the credential).
    pub headers: &'a reqwest::header::HeaderMap,
    /// The app connection whose credential those headers carry. `None`
    /// (nothing injected, or a secret / vault credential): no name read.
    pub connection_id: Option<&'a str>,
    pub cache: &'a dyn CacheStore,
    /// `true` iff the agent's own rules plainly allow `GET <path>` here.
    pub may_get: &'a (dyn Fn(&str) -> bool + Sync),
}

/// Link and name the records `summary` shows, through the resolver of the
/// catalog app the request matched (`app`; never a guess from the host),
/// then fold the record the action is about into the title. Never fails: on
/// any problem a record keeps its id.
pub async fn enrich(summary: &mut ApprovalSummary, app: Option<&str>, ctx: &EnrichContext<'_>) {
    let resolver = app.and_then(summary::record_resolver);
    if let (Some(resolver), "https") = (resolver, ctx.scheme) {
        let host = common::util::strip_port(ctx.host);
        summary.link_refs(|id| resolver.record_url(host, id));
        resolve_names(summary, resolver, ctx, &format!("https://{}", ctx.host)).await;
    }
    summary.finalize_title();
}

/// Show each record the agent may read by name, reading from `origin`.
async fn resolve_names(
    summary: &mut ApprovalSummary,
    resolver: &dyn RecordResolver,
    ctx: &EnrichContext<'_>,
    origin: &str,
) {
    let Some(connection) = ctx.connection_id else {
        return;
    };
    let read = read_names(summary, resolver, ctx, origin, connection);
    match tokio::time::timeout(BUDGET, read).await {
        Ok(names) => {
            summary.name_refs(|id| names.get(resolver.canonical_id(id)).map(String::as_str));
        }
        Err(_) => debug!("approval enrichment timed out; card keeps record ids"),
    }
}

/// Canonical id → display name: per object type, the policy probe FIRST,
/// then the cache, then one read for what's missing.
async fn read_names(
    summary: &ApprovalSummary,
    resolver: &dyn RecordResolver,
    ctx: &EnrichContext<'_>,
    origin: &str,
    connection: &str,
) -> HashMap<String, String> {
    let mut by_type: BTreeMap<&'static str, Vec<&str>> = BTreeMap::new();
    for id in summary.ref_ids().take(MAX_IDS) {
        if let Some(object) = resolver.object_of(id) {
            let ids = by_type.entry(object).or_default();
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    let canonical = |id: &str| resolver.canonical_id(id).to_string();
    let cache_key = |id: &str| format!("approval-name:{connection}:{}", canonical(id));

    let mut names = HashMap::new();
    for (object, ids) in by_type.into_iter().take(MAX_TYPES) {
        if !(ctx.may_get)(&resolver.names_read(object, &ids)) {
            debug!(
                object,
                "approval enrichment skipped: the agent may not read it"
            );
            continue;
        }
        let mut missing = Vec::new();
        for id in ids {
            match ctx.cache.get::<String>(&cache_key(id)).await {
                Some(name) => {
                    names.insert(canonical(id), name);
                }
                None => missing.push(id),
            }
        }
        if missing.is_empty() {
            continue;
        }
        let path = resolver.names_read(object, &missing);
        let Some(body) = fetch(ctx, origin, &path).await else {
            debug!(object, "approval enrichment read failed; keeping ids");
            continue;
        };
        // Only the records asked for: an answer can't fill the cache with
        // names for ids no card named.
        let asked: Vec<String> = missing.iter().map(|id| canonical(id)).collect();
        for (id, name) in resolver.parse_names(&body) {
            if !asked.contains(&canonical(&id)) {
                continue;
            }
            ctx.cache.set(&cache_key(&id), &name, CACHE_TTL_SECS).await;
            names.insert(canonical(&id), name);
        }
    }
    names
}

/// `GET <origin><path>` with the held request's credential and nothing else
/// from it (no content headers, no agent-supplied extras).
async fn fetch(ctx: &EnrichContext<'_>, origin: &str, path: &str) -> Option<Vec<u8>> {
    let auth = ctx.headers.get(reqwest::header::AUTHORIZATION)?.clone();
    let resp = ctx
        .http
        .get(format!("{origin}{path}"))
        .header(reqwest::header::AUTHORIZATION, auth)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        // Status only: the body can quote the read, never the credential.
        debug!(status = %resp.status(), "approval enrichment read refused");
        return None;
    }
    resp.bytes().await.ok().map(Vec::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const ACCOUNT: &str = "001QO000010eH0cYAF";
    const OWNER: &str = "005QO00000AbCdEfGh";

    /// The engine's guards, pinned through the one registered resolver
    /// (Salesforce's read and parse are tested in `summary`).
    fn resolver() -> &'static dyn RecordResolver {
        summary::record_resolver("salesforce").unwrap()
    }

    fn contact_create(account: &str) -> ApprovalSummary {
        summary::summarize_request(
            "salesforce",
            "POST",
            "/services/data/v59.0/sobjects/Contact",
            Some("application/json"),
            Some(
                format!(r#"{{"AccountId":"{account}","OwnerId":"{OWNER}","LastName":"P"}}"#)
                    .as_bytes(),
            ),
        )
    }

    fn row<'a>(s: &'a ApprovalSummary, label: &str) -> &'a summary::ApprovalDetail {
        s.details.iter().find(|d| d.label == label).unwrap()
    }

    const NAMES: &[(&str, &str)] = &[(ACCOUNT, "Initech"), (OWNER, "Alex")];

    /// A plain-TCP upstream answering the name read with each of [`NAMES`]
    /// the request mentions (by its 15-char prefix), plus every `extra`
    /// record unasked; counts hits and keeps the last request.
    struct Upstream {
        origin: String,
        hits: Arc<AtomicUsize>,
        last: Arc<Mutex<String>>,
    }

    async fn upstream_with(
        status: &'static str,
        delay: Duration,
        extra: &'static [(&'static str, &'static str)],
    ) -> Upstream {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let last = Arc::new(Mutex::new(String::new()));
        let (h, l) = (hits.clone(), last.clone());
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let (h, l) = (h.clone(), l.clone());
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    h.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(delay).await;
                    let records: Vec<String> = NAMES
                        .iter()
                        .filter(|(id, _)| req.contains(&id[..15]))
                        .chain(extra)
                        .map(|(id, name)| format!(r#"{{"Id":"{id}","Name":"{name}"}}"#))
                        .collect();
                    let body = format!(r#"{{"records":[{}]}}"#, records.join(","));
                    *l.lock().unwrap() = req.to_ascii_lowercase();
                    let resp = format!(
                        "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        Upstream { origin, hits, last }
    }

    async fn upstream(status: &'static str, delay: Duration) -> Upstream {
        upstream_with(status, delay, &[]).await
    }

    struct Fixture {
        http: reqwest::Client,
        headers: reqwest::header::HeaderMap,
        cache: Arc<dyn CacheStore>,
    }

    impl Fixture {
        fn new() -> Self {
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert("authorization", "Bearer sf-token".parse().unwrap());
            headers.insert("content-length", "212".parse().unwrap());
            headers.insert("x-agent-extra", "leak".parse().unwrap());
            Self {
                http: reqwest::Client::new(),
                headers,
                cache: cache::in_memory(),
            }
        }

        fn ctx<'a>(
            &'a self,
            scheme: &'a str,
            connection_id: Option<&'a str>,
            may_get: &'a (dyn Fn(&str) -> bool + Sync),
        ) -> EnrichContext<'a> {
            EnrichContext {
                http: &self.http,
                scheme,
                host: "acme.my.salesforce.com",
                headers: &self.headers,
                connection_id,
                cache: &*self.cache,
                may_get,
            }
        }
    }

    const ALLOW: &(dyn Fn(&str) -> bool + Sync) = &|_| true;
    const DENY: &(dyn Fn(&str) -> bool + Sync) = &|_| false;

    #[tokio::test]
    async fn names_are_read_once_per_type_with_only_the_credential_then_cached() {
        let up = upstream("200 OK", Duration::ZERO).await;
        let fx = Fixture::new();
        let ctx = fx.ctx("https", Some("conn1"), ALLOW);

        let mut s = contact_create(ACCOUNT);
        resolve_names(&mut s, resolver(), &ctx, &up.origin).await;
        assert_eq!(row(&s, "Account").value, format!("Initech ({ACCOUNT})"));
        assert_eq!(row(&s, "Owner").value, format!("Alex ({OWNER})"));
        assert_eq!(up.hits.load(Ordering::SeqCst), 2, "one read per type");
        let req = up.last.lock().unwrap().clone();
        assert!(
            req.starts_with("get /services/data/v60.0/query?q="),
            "{req}"
        );
        assert!(req.contains("authorization: bearer sf-token"));
        assert!(!req.contains("x-agent-extra") && !req.contains("content-length: 212"));

        let mut again = contact_create(ACCOUNT);
        resolve_names(&mut again, resolver(), &ctx, &up.origin).await;
        assert_eq!(up.hits.load(Ordering::SeqCst), 2, "served from the cache");
        assert_eq!(row(&again, "Account").value, format!("Initech ({ACCOUNT})"));
    }

    /// A request may carry the 15-char spelling; the answer is 18-char.
    #[tokio::test]
    async fn a_short_id_resolves_from_the_long_answer() {
        let up = upstream("200 OK", Duration::ZERO).await;
        let fx = Fixture::new();
        let short = &ACCOUNT[..15];
        let mut s = contact_create(short);
        resolve_names(
            &mut s,
            resolver(),
            &fx.ctx("https", Some("c"), ALLOW),
            &up.origin,
        )
        .await;
        assert_eq!(row(&s, "Account").value, format!("Initech ({short})"));
    }

    /// An answer can't plant names for records no card asked about: they
    /// neither reach this card nor the shared per-connection cache.
    #[tokio::test]
    async fn an_answer_only_names_the_records_asked_for() {
        const PLANTED: &str = "001QO000099zzzzAAA";
        let up = upstream_with("200 OK", Duration::ZERO, &[(PLANTED, "Planted")]).await;
        let fx = Fixture::new();
        let mut s = contact_create(ACCOUNT);
        resolve_names(
            &mut s,
            resolver(),
            &fx.ctx("https", Some("c"), ALLOW),
            &up.origin,
        )
        .await;
        assert_eq!(row(&s, "Account").value, format!("Initech ({ACCOUNT})"));
        let planted = format!("approval-name:c:{}", &PLANTED[..15]);
        assert_eq!(fx.cache.get::<String>(&planted).await, None);
    }

    /// Another agent's read cached this name for the connection: the probe
    /// gates the cache, not just the upstream read.
    #[tokio::test]
    async fn the_policy_probe_gates_the_read_and_the_cache() {
        let up = upstream("200 OK", Duration::ZERO).await;
        let fx = Fixture::new();
        let key = format!("approval-name:conn1:{}", &ACCOUNT[..15]);
        fx.cache.set(&key, &"Initech".to_string(), 60).await;
        let mut s = contact_create(ACCOUNT);
        resolve_names(
            &mut s,
            resolver(),
            &fx.ctx("https", Some("conn1"), DENY),
            &up.origin,
        )
        .await;
        assert_eq!(
            up.hits.load(Ordering::SeqCst),
            0,
            "no read may reach upstream"
        );
        assert_eq!(row(&s, "Account").value, format!("Account · {ACCOUNT}"));
    }

    /// Nothing the connection injected (a secret, a vault item, nothing at
    /// all): no read, and no cache to share.
    #[tokio::test]
    async fn no_injecting_connection_means_no_read() {
        let up = upstream("200 OK", Duration::ZERO).await;
        let fx = Fixture::new();
        let mut s = contact_create(ACCOUNT);
        resolve_names(
            &mut s,
            resolver(),
            &fx.ctx("https", None, ALLOW),
            &up.origin,
        )
        .await;
        assert_eq!(up.hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_slow_or_failing_upstream_keeps_ids_within_the_budget() {
        for (status, delay) in [
            ("200 OK", Duration::from_secs(5)),
            ("401 Unauthorized", Duration::ZERO),
        ] {
            let up = upstream(status, delay).await;
            let fx = Fixture::new();
            let mut s = contact_create(ACCOUNT);
            let started = std::time::Instant::now();
            resolve_names(
                &mut s,
                resolver(),
                &fx.ctx("https", Some("c"), ALLOW),
                &up.origin,
            )
            .await;
            assert!(started.elapsed() < BUDGET + Duration::from_millis(300));
            assert_eq!(
                row(&s, "Account").value,
                format!("Account · {ACCOUNT}"),
                "{status}"
            );
        }
    }

    /// Links need no read: over https every record row opens its record on
    /// the held request's own host, and the title names the record by id.
    #[tokio::test]
    async fn https_links_records_and_titles_them_without_a_read() {
        let fx = Fixture::new();
        let mut s = contact_create(ACCOUNT);
        enrich(&mut s, Some("salesforce"), &fx.ctx("https", None, ALLOW)).await;
        let url = format!("https://acme.my.salesforce.com/{ACCOUNT}");
        assert_eq!(row(&s, "Account").url.as_deref(), Some(&*url));
        assert_eq!(s.action, format!("Create Contact in Account {ACCOUNT}"));
        assert_eq!(s.subject.unwrap().url.as_deref(), Some(&*url));
    }

    /// Plain http: the credential never travels on an internal read, and no
    /// link is built; the title still says which record.
    #[tokio::test]
    async fn plain_http_gets_no_read_and_no_link() {
        let fx = Fixture::new();
        let mut s = contact_create(ACCOUNT);
        enrich(
            &mut s,
            Some("salesforce"),
            &fx.ctx("http", Some("conn1"), ALLOW),
        )
        .await;
        assert!(s.details.iter().all(|d| d.url.is_none()));
        assert_eq!(s.action, format!("Create Contact in Account {ACCOUNT}"));
    }

    /// A host no catalog app claims gets no resolver, even one literally
    /// named like a provider: links and reads follow the catalog match only.
    #[tokio::test]
    async fn no_catalog_app_means_no_links_and_no_read() {
        let fx = Fixture::new();
        let mut s = contact_create(ACCOUNT);
        enrich(&mut s, None, &fx.ctx("https", Some("conn1"), ALLOW)).await;
        assert!(s.details.iter().all(|d| d.url.is_none()));
        assert_eq!(s.action, format!("Create Contact in Account {ACCOUNT}"));
    }

    #[tokio::test]
    async fn a_provider_without_a_resolver_is_shown_as_summarized() {
        let fx = Fixture::new();
        let mut s = summary::summarize_request("gmail", "POST", "/x", None, None);
        let before = s.clone();
        enrich(&mut s, Some("gmail"), &fx.ctx("https", Some("c"), ALLOW)).await;
        assert_eq!(s, before);
    }
}
