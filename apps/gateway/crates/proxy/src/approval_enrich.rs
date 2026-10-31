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
//!   request's own host carrying only the headers injection set on it
//!   (`authorization`, or an app's own key header such as `X-API-KEY`).
//!   Nothing is minted; no other host is contacted.
//! - **No injection.** Object types come from the resolver's id table and ids
//!   are re-validated by it; nothing from the request body reaches the read
//!   as text.
//! - **Bounded.** One read per object type, at most `MAX_TYPES` types and
//!   `MAX_IDS` ids, all inside `BUDGET`. A timeout or any error keeps the ids.
//! - **Cached** per connection and record type for `CACHE_TTL_SECS`, so a
//!   burst of approvals against one account does one read.
//!
//! Record links need no read: each is the resolver's page for a validated id
//! on the held request's own host, so a record row links even when its name
//! can't be read. A change to an existing record the request's path names (a
//! GitHub issue, a Drive file) leads with a link to it, built by
//! `summary`'s per-app template for the matched app.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use cache::CacheStore;
use summary::bulk::{BulkField, BulkKind, CellOp};
use summary::{ApprovalSummary, CurrentRecord, RecordResolver};
use tracing::debug;

/// Total wall time the name read may add before the card is stored.
const BUDGET: Duration = Duration::from_millis(1500);
/// Distinct object types resolved per card.
const MAX_TYPES: usize = 3;
/// Distinct ids resolved per card.
const MAX_IDS: usize = 10;
/// How long the cache is reused for the same connection.
const CACHE_TTL_SECS: u64 = 300;
/// Wall time the bulk read (names, current values and context columns of
/// up to 200 records; once more without the context if that read is
/// refused) may add before the card is stored.
const BULK_BUDGET: Duration = Duration::from_millis(4000);

/// Largest answer any enrichment read takes. The read stops here: an
/// answer this big is not the shape a card reads (200 records with their
/// fields, or a Flow's metadata, are well under it).
const MAX_READ_BYTES: usize = 2 * 1024 * 1024;

/// Who the gateway's own reads say they are: some APIs refuse a request
/// that carries no `User-Agent` (GitHub answers it 403).
fn user_agent() -> String {
    format!("onecli-gateway/{}", common::version::app_version())
}

/// The held request, as the enrichment may use it.
pub struct EnrichContext<'a> {
    pub http: &'a reqwest::Client,
    pub scheme: &'a str,
    /// The held request's host (and port, if any).
    pub host: &'a str,
    pub method: &'a str,
    /// The held request's path, with its query if any.
    pub path: &'a str,
    /// Headers of the held request AFTER injection (carry the credential).
    pub headers: &'a reqwest::header::HeaderMap,
    /// The headers injection set on the held request: its credential. A read
    /// carries these and nothing else from `headers`.
    pub credential_headers: &'a [reqwest::header::HeaderName],
    /// The app connection whose credential those headers carry. `None`
    /// (nothing injected, or a secret / vault credential): no name read.
    pub connection_id: Option<&'a str>,
    pub cache: &'a dyn CacheStore,
    /// `true` iff the agent's own rules plainly allow `GET <path>` here.
    pub may_get: &'a (dyn Fn(&str) -> bool + Sync),
    /// The gateway's bounded peek of the held request's body, which the
    /// before → after compares against what stands now. `None`: no body.
    pub body: Option<&'a [u8]>,
}

/// Link and name the records `summary` shows, for the catalog app the
/// request matched (`app`; never a guess from the host), then fold the
/// record the action is about into the title. Never fails: on any problem a
/// record keeps its id.
pub async fn enrich(summary: &mut ApprovalSummary, app: Option<&str>, ctx: &EnrichContext<'_>) {
    if let (Some(app), "https") = (app, ctx.scheme) {
        let host = common::util::strip_port(ctx.host);
        summary.link_path_record(app, host, ctx.method, ctx.path);
        if let Some(resolver) = summary::record_resolver(app) {
            summary.link_refs(|id| resolver.record_url(host, id));
            resolve_names(summary, resolver, ctx, &format!("https://{}", ctx.host)).await;
            resolve_bulk(
                summary,
                resolver,
                ctx,
                &format!("https://{}", ctx.host),
                host,
            )
            .await;
            summary.name_refs_from_bulk();
            summary.name_change_values();
        }
        resolve_current(summary, ctx, &format!("https://{}", ctx.host)).await;
    }
    summary.finalize_title();
}

/// An edit of something that already exists: read it as it stands, so the
/// card can lead with before → after. Same guards as the name read: only a
/// read the agent's own rules plainly allow, only with the credential the
/// winning connection injected, only on the held request's own host, a
/// server-built path (the summarizer's [`summary::ChangeHint`]), one call
/// inside [`BULK_BUDGET`], at most [`MAX_READ_BYTES`]. Any failure keeps the
/// card as summarized. Not cached: a stale "before" would misstate the
/// change.
async fn resolve_current(summary: &mut ApprovalSummary, ctx: &EnrichContext<'_>, origin: &str) {
    let Some(hint) = summary.change_hint().cloned() else {
        return;
    };
    let Some(body) = ctx.body.filter(|b| !b.is_empty()) else {
        return;
    };
    if ctx.connection_id.is_none() || !(ctx.may_get)(&hint.read_path) {
        debug!("approval before/after skipped: the agent may not read it");
        return;
    }
    // A provider's "as it stands" read can be slow (a Salesforce Tooling
    // query with Flow metadata takes seconds): the bulk read's budget.
    match tokio::time::timeout(BULK_BUDGET, fetch(ctx, origin, &hint.read_path)).await {
        Ok(Some(current)) => summary.apply_current(body, &current),
        Ok(None) => debug!("approval before/after read failed; card keeps its rows"),
        Err(_) => debug!("approval before/after read timed out; card keeps its rows"),
    }
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
        Ok(names) => summary.name_refs(|id| {
            let key = (
                resolver.object_of(id)?,
                resolver.canonical_id(id).to_string(),
            );
            names.get(&key).map(String::as_str)
        }),
        Err(_) => debug!("approval enrichment timed out; card keeps record ids"),
    }
}

/// A bulk change: link every record, and — where the agent may read them —
/// show each by name with the CURRENT value of every field it changes, so
/// the card can flag the rows that overwrite an existing value, plus the
/// read-only context columns that say which record each row is. Same
/// guards as the name read: the agent's own plain read permission, the held
/// request's own credential and host, a server-built read, at most two
/// calls (once more without the context if Salesforce refuses it) inside
/// one budget. On any failure the card shows new values only.
async fn resolve_bulk(
    summary: &mut ApprovalSummary,
    resolver: &dyn RecordResolver,
    ctx: &EnrichContext<'_>,
    origin: &str,
    host: &str,
) {
    let Some(bulk) = summary.bulk.as_mut() else {
        return;
    };
    // A create's rows are new records: no page to link, nothing to read.
    if bulk.kind == BulkKind::Create {
        return;
    }
    for row in &mut bulk.rows {
        row.url = resolver.record_url(host, &row.id);
    }
    if ctx.connection_id.is_none() {
        return;
    }
    let fields: Vec<&str> = bulk.fields.iter().map(|f| f.api.as_str()).collect();
    let ids: Vec<&str> = bulk.rows.iter().map(|r| r.id.as_str()).collect();
    // Read-only columns that say which record each row is, for a table of
    // several (a one-record card names its record in the title).
    let context = if bulk.rows.len() > 1 {
        resolver.context_fields(&bulk.object, &fields)
    } else {
        Vec::new()
    };
    let context_api: Vec<&str> = context.iter().map(|c| c.api).collect();
    // With the context first; if that read is refused (a field this org
    // hides from the agent's user, say), once more without it, so the card
    // never loses its names and current values over a column it only shows
    // for context. Each read is server-built and held to the agent's own
    // read permission, and both share one budget.
    let both: [&[&str]; 2] = [&context_api, &[]];
    let attempts = if context_api.is_empty() {
        &both[1..]
    } else {
        &both[..]
    };
    let deadline = tokio::time::Instant::now() + BULK_BUDGET;
    let mut read = None;
    for &with in attempts {
        let Some(path) = resolver.current_values_read(&bulk.object, &fields, with, &ids) else {
            continue;
        };
        if !(ctx.may_get)(&path) {
            debug!("bulk enrichment skipped: the agent may not read the records");
            continue;
        }
        match tokio::time::timeout_at(deadline, fetch(ctx, origin, &path)).await {
            Ok(Some(body)) => {
                read = Some((body, with));
                break;
            }
            Ok(None) => {}
            Err(_) => break,
        }
    }
    let Some((body, context_read)) = read else {
        debug!("bulk enrichment read failed or timed out; card shows new values only");
        return;
    };
    let answered: HashMap<String, CurrentRecord> = resolver
        .parse_current_values(&bulk.object, &body, &fields, context_read)
        .into_iter()
        .map(|r| (resolver.canonical_id(&r.id).to_string(), r))
        .collect();
    let field_count = fields.len();
    let index: HashMap<String, usize> = fields
        .iter()
        .enumerate()
        .map(|(i, f)| ((*f).to_string(), i))
        .collect();
    // Only the records asked for count: an answer can't add rows.
    for row in &mut bulk.rows {
        if let Some(r) = answered.get(resolver.canonical_id(&row.id)) {
            row.name.clone_from(&r.name);
        }
    }
    // A context column shows only when some record has a value in it.
    let shown: Vec<usize> = (0..context_read.len())
        .filter(|&i| {
            bulk.rows.iter().any(|row| {
                answered
                    .get(resolver.canonical_id(&row.id))
                    .and_then(|r| r.context.get(i))
                    .is_some_and(Option::is_some)
            })
        })
        .collect();
    bulk.context = shown
        .iter()
        .map(|&i| BulkField {
            api: context[i].api.to_string(),
            label: context[i].label.to_string(),
        })
        .collect();
    if !shown.is_empty() {
        for row in &mut bulk.rows {
            let r = answered.get(resolver.canonical_id(&row.id));
            row.context = shown
                .iter()
                .map(|&i| r.and_then(|r| r.context.get(i).cloned().flatten()))
                .collect();
        }
    }
    if bulk.kind == BulkKind::Delete {
        // What each record holds now is what goes; every shown cell is lost.
        let mut any = false;
        for row in &mut bulk.rows {
            if let Some(r) = answered.get(resolver.canonical_id(&row.id)) {
                any = true;
                row.old = r.values.iter().take(field_count).cloned().collect();
            }
            row.ops = vec![CellOp::Clear; field_count];
        }
        bulk.old_values_read = any;
        return;
    }
    bulk.apply_current(|id, field| {
        let r = answered.get(resolver.canonical_id(id))?;
        Some(r.values.get(*index.get(field)?).cloned().flatten())
    });
}

/// (Object type, canonical id) → display name: per object type, the policy
/// probe FIRST, then the cache, then one read for what's missing. Keyed by
/// type too: two types' ids may share a spelling (a Drive file and a
/// permission), and one must never take the other's name.
async fn read_names(
    summary: &ApprovalSummary,
    resolver: &dyn RecordResolver,
    ctx: &EnrichContext<'_>,
    origin: &str,
    connection: &str,
) -> HashMap<(&'static str, String), String> {
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
    let cache_key =
        |object: &str, id: &str| format!("approval-name:{connection}:{object}:{}", canonical(id));

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
            match ctx.cache.get::<String>(&cache_key(object, id)).await {
                Some(name) => {
                    names.insert((object, canonical(id)), name);
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
        for (id, name) in resolver.parse_names(object, &body) {
            if !asked.contains(&canonical(&id)) {
                continue;
            }
            ctx.cache
                .set(&cache_key(object, &id), &name, CACHE_TTL_SECS)
                .await;
            names.insert((object, canonical(&id)), name);
        }
    }
    names
}

/// `GET <origin><path>` with the held request's credential (the headers
/// injection set on it) and nothing else from it: no content headers, no
/// agent-supplied extras. Read up to [`MAX_READ_BYTES`]: a longer answer is
/// dropped as it streams, never held. No credential, no read.
async fn fetch(ctx: &EnrichContext<'_>, origin: &str, path: &str) -> Option<Vec<u8>> {
    let mut req = ctx
        .http
        .get(format!("{origin}{path}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, user_agent());
    let mut carried = false;
    for name in ctx.credential_headers {
        for value in ctx.headers.get_all(name) {
            req = req.header(name, value.clone());
            carried = true;
        }
    }
    if !carried {
        return None;
    }
    let mut resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        // Status only: the body can quote the read, never the credential.
        debug!(status = %resp.status(), "approval enrichment read refused");
        return None;
    }
    if resp
        .content_length()
        .is_some_and(|n| n > MAX_READ_BYTES as u64)
    {
        debug!("approval enrichment answer too large; dropped");
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.ok()? {
        if body.len() + chunk.len() > MAX_READ_BYTES {
            debug!("approval enrichment answer too large; dropped");
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    Some(body)
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

    /// A plain-TCP upstream: `answer` turns each request (its raw text) into
    /// a status and a body, after `delay`. Counts hits and keeps the last
    /// request (lowercased).
    struct Upstream {
        origin: String,
        hits: Arc<AtomicUsize>,
        last: Arc<Mutex<String>>,
    }

    async fn serve(
        delay: Duration,
        answer: impl Fn(&str) -> (&'static str, String) + Send + Sync + 'static,
    ) -> Upstream {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let last = Arc::new(Mutex::new(String::new()));
        let (h, l, answer) = (hits.clone(), last.clone(), Arc::new(answer));
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let (h, l, answer) = (h.clone(), l.clone(), answer.clone());
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    h.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(delay).await;
                    let (status, body) = answer(&req);
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

    /// Salesforce's name read: each of [`NAMES`] the request mentions (by
    /// its 15-char prefix), plus every `extra` record unasked.
    async fn upstream_with(
        status: &'static str,
        delay: Duration,
        extra: &'static [(&'static str, &'static str)],
    ) -> Upstream {
        serve(delay, move |req| {
            let records: Vec<String> = NAMES
                .iter()
                .filter(|(id, _)| req.contains(&id[..15]))
                .chain(extra)
                .map(|(id, name)| format!(r#"{{"Id":"{id}","Name":"{name}"}}"#))
                .collect();
            (status, format!(r#"{{"records":[{}]}}"#, records.join(",")))
        })
        .await
    }

    async fn upstream(status: &'static str, delay: Duration) -> Upstream {
        upstream_with(status, delay, &[]).await
    }

    /// Every read answered `200` with `body`.
    async fn upstream_body(body: &'static str) -> Upstream {
        serve(Duration::ZERO, move |_| ("200 OK", body.to_string())).await
    }

    /// Each read answered by the first `(path prefix, body)` it starts
    /// with; anything else is a `404`.
    async fn upstream_paths(answers: &'static [(&'static str, &'static str)]) -> Upstream {
        serve(Duration::ZERO, move |req| {
            let path = req.split(' ').nth(1).unwrap_or("");
            answers
                .iter()
                .find(|(prefix, _)| path.starts_with(prefix))
                .map_or(("404 Not Found", "{}".into()), |(_, body)| {
                    ("200 OK", (*body).to_string())
                })
        })
        .await
    }

    struct Fixture {
        http: reqwest::Client,
        headers: reqwest::header::HeaderMap,
        credential_headers: Vec<reqwest::header::HeaderName>,
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
                credential_headers: vec![reqwest::header::AUTHORIZATION],
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
                method: "POST",
                path: "/services/data/v59.0/sobjects/Contact",
                headers: &self.headers,
                credential_headers: &self.credential_headers,
                connection_id,
                cache: &*self.cache,
                may_get,
                body: None,
            }
        }
    }

    const ALLOW: &(dyn Fn(&str) -> bool + Sync) = &|_| true;
    const DENY: &(dyn Fn(&str) -> bool + Sync) = &|_| false;

    #[tokio::test]
    async fn new_provider_names_never_cross_policy_or_connection_boundaries() {
        for (provider, method, path, label, object, id, answer) in [
            (
                "microsoft-word",
                "DELETE",
                "/v1.0/me/drive/items/01TESTFOLDER00001",
                "Item",
                "Item",
                "01TESTFOLDER00001",
                r#"{"id":"01TESTFOLDER00001","name":"Private folder"}"#,
            ),
            (
                "salesforce",
                "GET",
                "/services/data/v60.0/analytics/reports/00O000000000001AAA/describe",
                "Report",
                "Report",
                "00O000000000001AAA",
                r#"{"records":[{"Id":"00O000000000001AAA","Name":"Private report"}]}"#,
            ),
        ] {
            let up = upstream_body(answer).await;
            let fx = Fixture::new();
            let resolver = summary::record_resolver(provider).unwrap();
            let card = || summary::summarize_request(provider, method, path, None, None);
            let mut allowed = card();
            resolve_names(
                &mut allowed,
                resolver,
                &fx.ctx("https", Some("owner-connection"), ALLOW),
                &up.origin,
            )
            .await;
            assert!(row(&allowed, label).value.contains("Private"), "{provider}");
            assert_eq!(up.hits.load(Ordering::SeqCst), 1);
            let sent = up.last.lock().unwrap().clone();
            assert!(sent.contains("authorization: bearer sf-token"));
            assert!(!sent.contains("x-agent-extra"));
            if provider == "microsoft-word" {
                assert!(
                    sent.starts_with("get /v1.0/me/drive/items/01testfolder00001?$select=id,name ")
                );
            }

            // A cached name from an allowed agent is not a grant to a denied one.
            let mut denied = card();
            resolve_names(
                &mut denied,
                resolver,
                &fx.ctx("https", Some("owner-connection"), DENY),
                &up.origin,
            )
            .await;
            assert!(!row(&denied, label).value.contains("Private"));
            assert_eq!(up.hits.load(Ordering::SeqCst), 1);

            // Even an allowed read on another connection cannot reuse that name.
            let refused = upstream_body("{}").await;
            let mut foreign = card();
            resolve_names(
                &mut foreign,
                resolver,
                &fx.ctx("https", Some("foreign-connection"), ALLOW),
                &refused.origin,
            )
            .await;
            assert!(!row(&foreign, label).value.contains("Private"));
            assert_eq!(refused.hits.load(Ordering::SeqCst), 1);

            let key = format!(
                "approval-name:foreign-connection:{object}:{}",
                resolver.canonical_id(id)
            );
            assert_eq!(fx.cache.get::<String>(&key).await, None);
        }
    }

    #[tokio::test]
    async fn a_drive_answer_cannot_name_or_cache_an_unrequested_item() {
        let up = upstream_body(r#"{"id":"01FOREIGNITEM0001","name":"Unrequested"}"#).await;
        let fx = Fixture::new();
        let mut s = summary::summarize_request(
            "microsoft-word",
            "DELETE",
            "/v1.0/me/drive/items/01TESTFOLDER00001",
            None,
            None,
        );
        let resolver = summary::record_resolver("microsoft-word").unwrap();
        resolve_names(
            &mut s,
            resolver,
            &fx.ctx("https", Some("conn"), ALLOW),
            &up.origin,
        )
        .await;
        assert_eq!(row(&s, "Item").value, "01TESTFOLDER00001");
        assert_eq!(
            fx.cache
                .get::<String>("approval-name:conn:Item:01FOREIGNITEM0001")
                .await,
            None
        );
    }

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

    /// A custom lookup (`SDR__c`) naming the same user as `OwnerId`: one
    /// read, and both rows read as the person.
    #[tokio::test]
    async fn one_record_in_two_rows_is_read_once_and_named_in_both() {
        let up = upstream("200 OK", Duration::ZERO).await;
        let fx = Fixture::new();
        let mut s = summary::summarize_request(
            "salesforce",
            "PATCH",
            "/services/data/v59.0/sobjects/Contact/003QO00000XyZaBcDe",
            Some("application/json"),
            Some(format!(r#"{{"OwnerId":"{OWNER}","SDR__c":"{OWNER}"}}"#).as_bytes()),
        );
        resolve_names(
            &mut s,
            resolver(),
            &fx.ctx("https", Some("conn1"), ALLOW),
            &up.origin,
        )
        .await;
        assert_eq!(row(&s, "Owner").value, format!("Alex ({OWNER})"));
        assert_eq!(row(&s, "SDR").value, format!("Alex ({OWNER})"));
        // One read per type (the Contact, then the user), the user asked once.
        assert_eq!(up.hits.load(Ordering::SeqCst), 2);
        let user_read = up.last.lock().unwrap().clone();
        assert_eq!(user_read.matches(&OWNER.to_ascii_lowercase()).count(), 1);
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
        let planted = format!("approval-name:c:Account:{}", &PLANTED[..15]);
        assert_eq!(fx.cache.get::<String>(&planted).await, None);
    }

    /// Another agent's read cached this name for the connection: the probe
    /// gates the cache, not just the upstream read.
    #[tokio::test]
    async fn the_policy_probe_gates_the_read_and_the_cache() {
        let up = upstream("200 OK", Duration::ZERO).await;
        let fx = Fixture::new();
        let key = format!("approval-name:conn1:Account:{}", &ACCOUNT[..15]);
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

    /// A change to an existing record the path names leads with a link to
    /// it: for the matched app, over https only.
    #[tokio::test]
    async fn the_record_a_path_changes_leads_the_card_over_https_only() {
        const ISSUE: &str = "/repos/acme/web/issues/42";
        let fx = Fixture::new();
        let github = |scheme| EnrichContext {
            host: "api.github.com:443",
            method: "PATCH",
            path: ISSUE,
            ..fx.ctx(scheme, None, ALLOW)
        };
        let issue = || summary::summarize_request("github", "PATCH", ISSUE, None, None);

        let mut s = issue();
        enrich(&mut s, Some("github"), &github("https")).await;
        assert_eq!(
            s.details[0].url.as_deref(),
            Some("https://github.com/acme/web/issues/42")
        );
        for (scheme, app) in [("http", Some("github")), ("https", None)] {
            let mut s = issue();
            enrich(&mut s, app, &github(scheme)).await;
            assert!(
                s.details.iter().all(|d| d.url.is_none()),
                "{scheme} {app:?}"
            );
        }
    }

    // ── Bulk changes ─────────────────────────────────────────────────────

    const C1: &str = "003QO0000001AbCAAA";
    const C2: &str = "003QO0000002AbCAAA";
    const PLANTED: &str = "003QO0000099ZzZAAA";

    fn bulk_update() -> ApprovalSummary {
        let body = format!(
            r#"{{"records":[{{"attributes":{{"type":"Contact"}},"id":"{C1}","Title":"VP"}},{{"attributes":{{"type":"Contact"}},"id":"{C2}","Title":"VP"}}]}}"#
        );
        summary::summarize_request(
            "salesforce",
            "PATCH",
            "/services/data/v62.0/composite/sobjects",
            Some("application/json"),
            Some(body.as_bytes()),
        )
    }

    /// One read fills each record's name and current value, and the ops
    /// follow; an answer naming a record the card never asked about adds
    /// nothing.
    #[tokio::test]
    async fn a_bulk_change_reads_current_values_once_for_the_records_asked() {
        let up = upstream_body(
            r#"{"records":[{"Id":"003QO0000001AbCAAA","Name":"Ada","Title":"CTO"},{"Id":"003QO0000002AbCAAA","Name":"Bo","Title":null},{"Id":"003QO0000099ZzZAAA","Name":"Planted","Title":"x"}]}"#,
        )
        .await;
        let fx = Fixture::new();
        let mut s = bulk_update();
        resolve_bulk(
            &mut s,
            resolver(),
            &fx.ctx("https", Some("c"), ALLOW),
            &up.origin,
            "acme.my.salesforce.com",
        )
        .await;
        assert_eq!(up.hits.load(Ordering::SeqCst), 1, "one read");
        let b = s.bulk.as_ref().unwrap();
        assert!(b.old_values_read);
        assert_eq!(b.rows.len(), 2, "an answer can't add rows");
        assert!(!b.rows.iter().any(|r| r.id == PLANTED));
        let by = |id: &str| b.rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!(by(C1).name.as_deref(), Some("Ada"));
        assert_eq!(by(C1).op, Some(summary::bulk::CellOp::Overwrite));
        assert_eq!(by(C2).op, Some(summary::bulk::CellOp::Fill));
        assert_eq!(
            by(C1).url.as_deref(),
            Some(&*format!("https://acme.my.salesforce.com/{C1}"))
        );
        // The read carried only the credential, nothing else from the request.
        let req = up.last.lock().unwrap().clone();
        assert!(req.contains("authorization: bearer sf-token"));
        assert!(!req.contains("x-agent-extra"));
        assert!(req.contains("select+id%2c+name%2c+title%2c+account.name+from+contact"));
    }

    /// The agent may not read the records, or nothing injected a credential:
    /// no read, and the card claims nothing about what it replaces.
    #[tokio::test]
    async fn a_bulk_change_reads_nothing_the_agent_could_not() {
        for (connection, may_get) in [(Some("c"), DENY), (None, ALLOW)] {
            let up = upstream_body(r#"{"records":[]}"#).await;
            let fx = Fixture::new();
            let mut s = bulk_update();
            resolve_bulk(
                &mut s,
                resolver(),
                &fx.ctx("https", connection, may_get),
                &up.origin,
                "acme.my.salesforce.com",
            )
            .await;
            assert_eq!(up.hits.load(Ordering::SeqCst), 0, "{connection:?}");
            let b = s.bulk.as_ref().unwrap();
            assert!(!b.old_values_read);
            assert!(b.rows.iter().all(|r| r.old.is_empty() && r.name.is_none()));
            assert!(b.context.is_empty());
        }
    }

    /// The same one read carries who each contact is: its account and title,
    /// read-only columns beside the change. A column with no value on any
    /// record is left off.
    #[tokio::test]
    async fn a_bulk_change_shows_each_records_account_beside_it() {
        let up = upstream_body(
            r#"{"records":[{"Id":"003QO0000001AbCAAA","Name":"Ada","Title":"CTO","Account":{"Name":"Acme"}},{"Id":"003QO0000002AbCAAA","Name":"Bo","Title":null,"Account":null}]}"#,
        )
        .await;
        let fx = Fixture::new();
        let mut s = bulk_update();
        resolve_bulk(
            &mut s,
            resolver(),
            &fx.ctx("https", Some("c"), ALLOW),
            &up.origin,
            "acme.my.salesforce.com",
        )
        .await;
        assert_eq!(up.hits.load(Ordering::SeqCst), 1, "still one read");
        let req = up.last.lock().unwrap().clone();
        assert!(req.contains("select+id%2c+name%2c+title%2c+account.name+from+contact"));
        let b = s.bulk.as_ref().unwrap();
        // Title is the change itself, so Account is the one context column.
        assert_eq!(
            b.context
                .iter()
                .map(|c| c.label.as_str())
                .collect::<Vec<_>>(),
            ["Account"]
        );
        let by = |id: &str| b.rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!(by(C1).context, [Some("Acme".to_string())]);
        assert_eq!(by(C2).context, [None]);
        assert_eq!(
            by(C1).op,
            Some(summary::bulk::CellOp::Overwrite),
            "ops unchanged"
        );
    }

    /// Salesforce refuses the read with the context (a field hidden from the
    /// agent's user): once more without it, so the card keeps its names and
    /// current values and simply has no context columns.
    #[tokio::test]
    async fn a_refused_context_read_falls_back_to_the_plain_one() {
        let up = serve(Duration::ZERO, |req| {
            if req.to_ascii_lowercase().contains("account.name") {
                ("400 Bad Request", "[]".into())
            } else {
                (
                    "200 OK",
                    r#"{"records":[{"Id":"003QO0000001AbCAAA","Name":"Ada","Title":"CTO"}]}"#
                        .into(),
                )
            }
        })
        .await;
        let fx = Fixture::new();
        let mut s = bulk_update();
        resolve_bulk(
            &mut s,
            resolver(),
            &fx.ctx("https", Some("c"), ALLOW),
            &up.origin,
            "acme.my.salesforce.com",
        )
        .await;
        assert_eq!(
            up.hits.load(Ordering::SeqCst),
            2,
            "the context read, then the plain one"
        );
        assert!(!up.last.lock().unwrap().contains("account.name"));
        let b = s.bulk.as_ref().unwrap();
        assert!(b.old_values_read, "names and current values kept");
        assert!(b.context.is_empty());
        assert!(b.rows.iter().all(|r| r.context.is_empty()));
        let ada = b.rows.iter().find(|r| r.id == C1).unwrap();
        assert_eq!(ada.name.as_deref(), Some("Ada"));
    }

    /// A column the change covers is not read: a reassignment of each
    /// contact's account shows the new account as the change, never the old
    /// one beside it as context.
    #[tokio::test]
    async fn a_lookup_the_change_sets_is_never_read_as_context() {
        let up = upstream_body(r#"{"records":[]}"#).await;
        let fx = Fixture::new();
        let body = format!(
            r#"{{"records":[{{"attributes":{{"type":"Contact"}},"id":"{C1}","AccountId":"{ACCOUNT}"}},{{"attributes":{{"type":"Contact"}},"id":"{C2}","AccountId":"{ACCOUNT}"}}]}}"#
        );
        let mut s = summary::summarize_request(
            "salesforce",
            "PATCH",
            "/services/data/v62.0/composite/sobjects",
            Some("application/json"),
            Some(body.as_bytes()),
        );
        resolve_bulk(
            &mut s,
            resolver(),
            &fx.ctx("https", Some("c"), ALLOW),
            &up.origin,
            "acme.my.salesforce.com",
        )
        .await;
        let req = up.last.lock().unwrap().clone();
        assert!(
            req.contains("select+id%2c+name%2c+accountid%2c+title+from+contact"),
            "{req}"
        );
    }

    /// A one-record card names its record in the title and shows no context
    /// columns, so its read carries none.
    #[tokio::test]
    async fn a_one_record_change_reads_no_context() {
        let up = upstream_body(r#"{"records":[]}"#).await;
        let fx = Fixture::new();
        let mut s = summary::summarize_request(
            "salesforce",
            "PATCH",
            &format!("/services/data/v62.0/sobjects/Contact/{C1}"),
            Some("application/json"),
            Some(br#"{"Department":"Ops"}"#),
        );
        resolve_bulk(
            &mut s,
            resolver(),
            &fx.ctx("https", Some("c"), ALLOW),
            &up.origin,
            "acme.my.salesforce.com",
        )
        .await;
        assert_eq!(up.hits.load(Ordering::SeqCst), 1);
        let req = up.last.lock().unwrap().clone();
        assert!(
            req.contains("select+id%2c+name%2c+department+from+contact"),
            "{req}"
        );
    }

    #[tokio::test]
    async fn a_custom_record_is_named_through_enrich_with_one_guarded_read() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        const ID: &str = "a0BAA00000AbCdEFGH";
        let dir = std::env::temp_dir().join(format!("approval-name-{}", uuid::Uuid::new_v4()));
        let authority = ca::CertificateAuthority::load_or_generate(&dir)
            .await
            .unwrap();
        let tls =
            tokio_rustls::TlsAcceptor::from(authority.server_config_for_host("localhost").unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = tls.accept(socket).await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            while !request.ends_with(b"\r\n\r\n") {
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0 && request.len() + n <= 8192);
                request.extend_from_slice(&buf[..n]);
            }
            let request = String::from_utf8(request).unwrap();
            let body = r#"{"records":[{"Id":"a0BAA00000AbCdEFGH","Name":"Current project"},{"Id":"a0BAA00000XyZaBAAA","Name":"Unasked"}]}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            request
        });
        let mut fx = Fixture::new();
        fx.http = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .add_root_certificate(
                reqwest::Certificate::from_pem(authority.ca_cert_pem().as_bytes()).unwrap(),
            )
            .build()
            .unwrap();
        let host = format!("localhost:{}", addr.port());
        let path = format!("/services/data/v62.0/sobjects/Project__c/{ID}");
        let build = || {
            summary::summarize_request(
                "salesforce",
                "PATCH",
                &path,
                Some("application/json"),
                Some(br#"{"Name":"Next project"}"#),
            )
        };
        let ctx = EnrichContext {
            host: &host,
            method: "PATCH",
            path: &path,
            ..fx.ctx("https", Some("c"), ALLOW)
        };
        let mut s = build();
        enrich(&mut s, Some("salesforce"), &ctx).await;
        assert_eq!(s.action, "Update Project Current project");
        let subject = s.subject.as_ref().unwrap();
        assert_eq!(
            s.details[subject.row].value,
            format!("Current project ({ID})")
        );
        assert_eq!(subject.url, Some(format!("https://localhost/{ID}")));
        assert_eq!(s.bulk.as_ref().unwrap().rows.len(), 1);
        let request = tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap()
            .to_ascii_lowercase();
        assert!(
            request
                .starts_with("get /services/data/v60.0/query?q=select+id%2c+name+from+project__c"),
            "{request}"
        );
        assert!(request.contains("authorization: bearer sf-token"));
        assert!(!request.contains("x-agent-extra"));
        // No upstream remains: denied reads and missing connections must
        // still keep the id, not reuse a name from the earlier card.
        for ctx in [
            EnrichContext {
                may_get: DENY,
                ..ctx
            },
            EnrichContext {
                connection_id: None,
                ..ctx
            },
        ] {
            let mut s = build();
            enrich(&mut s, Some("salesforce"), &ctx).await;
            assert_eq!(s.action, format!("Update Project {ID}"));
        }
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    // ── Google Drive and Sheets ──────────────────────────────────────────────────────

    const DRIVE_FILE: &str = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    const DRIVE_PERM: &str = "01234567890123456789";
    const DRIVE_FILE_READ: (&str, &str) = (
        "/drive/v3/files/1AbCdEfGhIjKlMnOpQrStUvWxYz012345?",
        r#"{"id":"1AbCdEfGhIjKlMnOpQrStUvWxYz012345","name":"Plan.docx"}"#,
    );

    fn drive_card(method: &str, path: &str) -> ApprovalSummary {
        summary::summarize_request("google-drive", method, path, None, None)
    }

    fn drive() -> &'static dyn RecordResolver {
        summary::record_resolver("google-drive").unwrap()
    }

    /// Removing someone's access reads as WHO loses WHICH file: both named
    /// through the agent's own credential, in one read each.
    #[tokio::test]
    async fn a_drive_unshare_names_the_file_and_the_person() {
        let up = upstream_paths(&[
            (
                "/drive/v3/files/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/permissions/",
                r#"{"id":"01234567890123456789","type":"user","displayName":"Dana Reyes","emailAddress":"dana@example.com"}"#,
            ),
            DRIVE_FILE_READ,
        ])
        .await;
        let fx = Fixture::new();
        let mut s = drive_card(
            "DELETE",
            &format!("/drive/v3/files/{DRIVE_FILE}/permissions/{DRIVE_PERM}"),
        );
        resolve_names(
            &mut s,
            drive(),
            &fx.ctx("https", Some("d"), ALLOW),
            &up.origin,
        )
        .await;
        s.finalize_title();
        assert_eq!(s.action, "Remove access to file Plan.docx");
        assert_eq!(row(&s, "File").value, format!("Plan.docx ({DRIVE_FILE})"));
        assert_eq!(row(&s, "Who").value, "Dana Reyes <dana@example.com>");
        assert_eq!(up.hits.load(Ordering::SeqCst), 2, "one read per record");
        let req = up.last.lock().unwrap().clone();
        assert!(req.contains("authorization: bearer sf-token"));
        assert!(!req.contains("x-agent-extra"));
    }

    /// The probe runs before any read or cache hit; allowed, one read, then
    /// the cache serves the next card.
    #[tokio::test]
    async fn the_drive_names_are_policy_probed_and_cached() {
        let up = upstream_paths(&[DRIVE_FILE_READ]).await;
        let fx = Fixture::new();
        let path = format!("/drive/v3/files/{DRIVE_FILE}");
        let mut s = drive_card("DELETE", &path);
        resolve_names(
            &mut s,
            drive(),
            &fx.ctx("https", Some("d"), DENY),
            &up.origin,
        )
        .await;
        assert_eq!(up.hits.load(Ordering::SeqCst), 0);
        assert_eq!(row(&s, "File").value, DRIVE_FILE);
        for _ in 0..2 {
            let mut s = drive_card("DELETE", &path);
            resolve_names(
                &mut s,
                drive(),
                &fx.ctx("https", Some("d"), ALLOW),
                &up.origin,
            )
            .await;
            assert_eq!(row(&s, "File").value, format!("Plan.docx ({DRIVE_FILE})"));
        }
        assert_eq!(up.hits.load(Ordering::SeqCst), 1);
    }

    /// A name read for one record type never names another type's id of the
    /// same spelling: the person behind permission `1234567890` can't title
    /// file `1234567890`.
    #[tokio::test]
    async fn a_cached_name_only_names_its_own_record_type() {
        const BOTH: &str = "1234567890";
        let up = upstream_paths(&[
            (
                "/drive/v3/files/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/permissions/",
                r#"{"id":"1234567890","type":"user","emailAddress":"dana@example.com"}"#,
            ),
            DRIVE_FILE_READ,
        ])
        .await;
        let fx = Fixture::new();
        let ctx = fx.ctx("https", Some("d"), ALLOW);
        let mut unshare = drive_card(
            "DELETE",
            &format!("/drive/v3/files/{DRIVE_FILE}/permissions/{BOTH}"),
        );
        resolve_names(&mut unshare, drive(), &ctx, &up.origin).await;
        assert_eq!(row(&unshare, "Who").value, "dana@example.com");
        // Its id spells the person's: read as a file (and not found), never
        // served the person's name from the cache.
        let mut delete = drive_card("DELETE", &format!("/drive/v3/files/{BOTH}"));
        resolve_names(&mut delete, drive(), &ctx, &up.origin).await;
        assert_eq!(row(&delete, "File").value, BOTH);
        assert_eq!(up.hits.load(Ordering::SeqCst), 3);
    }

    /// A cell write names its spreadsheet and leads with it, with no
    /// second path-link row repeating the id.
    #[tokio::test]
    async fn a_sheets_write_names_the_spreadsheet_once() {
        const SHEET: &str = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdE";
        let up = upstream_paths(&[(
            "/v4/spreadsheets/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdE?",
            r#"{"spreadsheetId":"1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdE","properties":{"title":"Q4 Budget"}}"#,
        )])
        .await;
        let fx = Fixture::new();
        let path = format!("/v4/spreadsheets/{SHEET}/values:batchUpdate");
        let mut s = summary::summarize_request(
            "google-sheets",
            "POST",
            &path,
            Some("application/json"),
            Some(br#"{"data":[{"range":"Sheet1!C5","values":[[4200]]}]}"#),
        );
        // What `enrich` does on the real host, then the read on ours.
        s.link_path_record("google-sheets", "sheets.googleapis.com", "POST", &path);
        let resolver = summary::record_resolver("google-sheets").unwrap();
        s.link_refs(|id| resolver.record_url("sheets.googleapis.com", id));
        resolve_names(
            &mut s,
            resolver,
            &fx.ctx("https", Some("s"), ALLOW),
            &up.origin,
        )
        .await;
        s.finalize_title();
        assert_eq!(s.action, "Update cells in spreadsheet Q4 Budget");
        let labels: Vec<&str> = s.details.iter().map(|d| d.label.as_str()).collect();
        assert_eq!(labels, ["Spreadsheet", "Sheet1!C5"]);
        assert_eq!(row(&s, "Spreadsheet").value, format!("Q4 Budget ({SHEET})"));
        assert_eq!(
            row(&s, "Spreadsheet").url.as_deref(),
            Some(&*format!(
                "https://docs.google.com/spreadsheets/d/{SHEET}/edit"
            ))
        );
    }

    // ── Before → after ──────────────────────────────────────────────────

    const DEAL: &str = "/crm/v3/objects/deals/123456";
    const DEAL_BODY: &[u8] = br#"{"properties":{"amount":"5000","dealstage":"won"}}"#;
    const DEAL_NOW: &str = r#"{"id":"123456","properties":{"amount":"3000","dealstage":"won"}}"#;

    fn deal() -> ApprovalSummary {
        summary::summarize_request(
            "hubspot",
            "PATCH",
            DEAL,
            Some("application/json"),
            Some(DEAL_BODY),
        )
    }

    #[tokio::test]
    async fn an_edit_reads_what_stands_and_leads_with_the_change() {
        let up = upstream_body(DEAL_NOW).await;
        let fx = Fixture::new();
        let ctx = EnrichContext {
            method: "PATCH",
            path: DEAL,
            body: Some(DEAL_BODY),
            ..fx.ctx("https", Some("conn1"), ALLOW)
        };
        let mut s = deal();
        resolve_current(&mut s, &ctx, &up.origin).await;
        assert_eq!(row(&s, "Properties › Amount").value, "3000 → 5000");
        assert_eq!(up.hits.load(Ordering::SeqCst), 1);
        let last = up.last.lock().unwrap().clone();
        assert!(last.starts_with(&format!("get {DEAL} ")), "{last}");
        assert!(last.contains("authorization: bearer sf-token"));
        assert!(!last.contains("x-agent-extra") && !last.contains("content-length: 212"));
        // GitHub refuses a read without a User-Agent: every read names the
        // gateway.
        assert!(last.contains("user-agent: onecli-gateway/"), "{last}");
    }

    #[tokio::test]
    async fn no_read_without_permission_credential_or_body_and_failures_keep_the_card() {
        let up = upstream_body(DEAL_NOW).await;
        let fx = Fixture::new();
        let base = |conn, may: &'static (dyn Fn(&str) -> bool + Sync), body| EnrichContext {
            method: "PATCH",
            path: DEAL,
            body,
            ..fx.ctx("https", conn, may)
        };
        for ctx in [
            base(Some("c"), DENY, Some(DEAL_BODY)),
            base(None, ALLOW, Some(DEAL_BODY)),
            base(Some("c"), ALLOW, None),
        ] {
            let mut s = deal();
            let before = s.clone();
            resolve_current(&mut s, &ctx, &up.origin).await;
            assert_eq!(s.details, before.details);
        }
        assert_eq!(up.hits.load(Ordering::SeqCst), 0);

        // Refused, unreadable, too slow or too big: the card keeps its rows.
        let refused = serve(Duration::ZERO, |_| ("403 Forbidden", "{}".into())).await;
        let junk = upstream_body("<html>").await;
        let slow = serve(BULK_BUDGET + Duration::from_millis(300), |_| {
            ("200 OK", DEAL_NOW.into())
        })
        .await;
        let huge = serve(Duration::ZERO, |_| {
            ("200 OK", " ".repeat(MAX_READ_BYTES + 1) + DEAL_NOW)
        })
        .await;
        for up in [refused, junk, slow, huge] {
            let mut s = deal();
            let before = s.details.clone();
            resolve_current(&mut s, &base(Some("c"), ALLOW, Some(DEAL_BODY)), &up.origin).await;
            assert_eq!(s.details, before);
        }
    }

    // ── An app whose credential is its own header (HeyReach) ───────────────────

    /// HeyReach's two name reads, answered with its documented shapes.
    const HEYREACH: &[(&str, &str)] = &[
        (
            "/api/public/campaign/GetById?campaignId=235",
            r#"{"id":235,"name":"Q4 outbound","status":"IN_PROGRESS"}"#,
        ),
        (
            "/api/public/inbox/GetChatroom/123/2-ODM0",
            r#"{"id":"2-ODM0","linkedInAccountId":123,"messages":[{"body":"earlier"}],
                "correspondentProfile":{"firstName":"Jane","lastName":"Smith"}}"#,
        ),
    ];

    /// A held HeyReach request whose injection set `X-API-KEY`; the agent
    /// also sent headers of its own.
    fn heyreach_fixture(injected: &[&str]) -> Fixture {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-api-key", "hr-secret-key".parse().unwrap());
        headers.insert("content-length", "40".parse().unwrap());
        headers.insert("x-agent-extra", "leak".parse().unwrap());
        Fixture {
            headers,
            credential_headers: injected.iter().map(|h| h.parse().unwrap()).collect(),
            ..Fixture::new()
        }
    }

    #[tokio::test]
    async fn an_app_keyed_by_its_own_header_is_named_with_that_header_only() {
        let up = upstream_paths(HEYREACH).await;
        let fx = heyreach_fixture(&["x-api-key"]);
        let resolver = summary::record_resolver("heyreach").unwrap();
        let ctx = fx.ctx("https", Some("conn-hr"), ALLOW);

        let mut s = summary::summarize_request(
            "heyreach",
            "POST",
            "/api/public/campaign/Pause?campaignId=235",
            None,
            None,
        );
        resolve_names(&mut s, resolver, &ctx, &up.origin).await;
        s.finalize_title();
        assert_eq!(s.action, "Pause campaign Q4 outbound");
        let sent = up.last.lock().unwrap().clone();
        assert!(
            sent.starts_with("get /api/public/campaign/getbyid?campaignid=235 "),
            "{sent}"
        );
        assert!(sent.contains("x-api-key: hr-secret-key"), "{sent}");
        assert!(!sent.contains("x-agent-extra") && !sent.contains("content-length: 40"));
        assert!(!sent.contains("authorization"), "{sent}");

        // A message's recipient, named from its conversation.
        let mut s = summary::summarize_request(
            "heyreach",
            "POST",
            "/api/public/inbox/SendMessage",
            Some("application/json"),
            Some(br#"{"message":"Hi","conversationId":"2-ODM0","linkedInAccountId":123}"#),
        );
        resolve_names(&mut s, resolver, &ctx, &up.origin).await;
        assert_eq!(row(&s, "To").value, "Jane Smith");
        assert_eq!(up.hits.load(Ordering::SeqCst), 2, "one read per record");
    }

    /// A header the AGENT sent is not a credential the gateway injected, so
    /// it never authorizes a read: nothing injected, nothing carried, no read.
    #[tokio::test]
    async fn a_header_the_agent_sent_never_authorizes_a_read() {
        let up = upstream_paths(HEYREACH).await;
        for injected in [&[][..], &["authorization"]] {
            let fx = heyreach_fixture(injected);
            let mut s = summary::summarize_request(
                "heyreach",
                "POST",
                "/api/public/campaign/Pause?campaignId=235",
                None,
                None,
            );
            resolve_names(
                &mut s,
                summary::record_resolver("heyreach").unwrap(),
                &fx.ctx("https", Some("conn-hr"), ALLOW),
                &up.origin,
            )
            .await;
            assert_eq!(row(&s, "Campaign").value, "Campaign · 235", "{injected:?}");
        }
        assert_eq!(up.hits.load(Ordering::SeqCst), 0);
    }
}
