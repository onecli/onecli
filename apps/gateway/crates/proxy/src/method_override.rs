//! Refusing a request that asks the upstream to run a different method.
//!
//! Some APIs let a client "tunnel" one method through another: Salesforce runs
//! `POST …?_HttpMethod=DELETE` as a delete, and Google runs a POST carrying
//! `X-HTTP-Method-Override: GET` as a read. Most APIs ignore those spellings
//! entirely (GitHub runs that POST as a POST). The gateway can't know which
//! reading the upstream will apply, so it never guesses: policy, the read and
//! write split, the approval card and telemetry all judge the request line,
//! and a request whose override names any OTHER method is refused here, before
//! any rule is consulted or any credential is minted.
//!
//! An override that repeats the request line's own method is harmless (both
//! readings agree), so it passes.

use std::borrow::Cow;

use common::method_override::{HEADERS, PARAMS};
use hyper::{HeaderMap, Method, Response};
use percent_encoding::percent_decode_str;
use tracing::warn;

use super::hooks::{self, ForwardResponseBody};
use super::response;
use context::ProxyContext;

/// The activity-feed rule name a refusal is recorded under.
const RULE_NAME: &str = "Method override";

/// One override that names a method other than the request line's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mismatch {
    /// How the override was sent, e.g. `the x-http-method-override header`.
    pub via: String,
    /// The method it names, as sent (trimmed).
    pub named: String,
}

/// The first override in `headers` or the query that names a method other
/// than `wire`. Header values are split on commas; query names and values
/// are percent-decoded (`+` as space) and names compared case-insensitively,
/// so a spelling an upstream might read is never missed. Never panics on
/// hostile input: undecodable bytes are read lossily, which can only add a
/// refusal.
pub fn mismatch(wire: &Method, path_and_query: &str, headers: &HeaderMap) -> Option<Mismatch> {
    let differs = |named: &str| !named.eq_ignore_ascii_case(wire.as_str());

    for name in HEADERS {
        for value in headers.get_all(*name) {
            let value = String::from_utf8_lossy(value.as_bytes());
            if let Some(named) = value.split(',').map(str::trim).find(|v| differs(v)) {
                return Some(Mismatch {
                    via: format!("the {name} header"),
                    named: named.to_string(),
                });
            }
        }
    }

    let (_, query) = path_and_query.split_once('?')?;
    // `;` is a pair separator to some frameworks; splitting on it too can
    // only surface more overrides, never hide one.
    query.split(['&', ';']).find_map(|pair| {
        let (raw_name, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        let name = decode(raw_name);
        let name = name.trim();
        if !PARAMS.iter().any(|p| p.eq_ignore_ascii_case(name)) {
            return None;
        }
        let named = decode(raw_value);
        let named = named.trim();
        differs(named).then(|| Mismatch {
            via: format!("the {name} query parameter"),
            named: named.to_string(),
        })
    })
}

/// Refuse (403 `method_override_refused`, recorded as a block) a request
/// whose override names another method; `None` lets it through. Shared by
/// the HTTP forward path and the WebSocket upgrade (always a GET).
pub fn refuse(
    proxy_ctx: &ProxyContext,
    host: &str,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
) -> Option<Response<ForwardResponseBody>> {
    let found = mismatch(method, path, headers)?;
    // The query can carry anything (tokens included), so only its path is
    // logged; the override itself says what was refused.
    let path_only = path.split('?').next().unwrap_or(path);
    warn!(%method, %host, path = %path_only, via = %found.via, named = %found.named, "BLOCKED: method override names another method");
    hooks::emit_block_telemetry(proxy_ctx, host, method.as_str(), path, RULE_NAME);
    Some(response::method_override_refused(
        method.as_str(),
        path,
        &found,
    ))
}

/// Percent-decoded, `+` as space, lossy on bad UTF-8. Borrows when there is
/// nothing to decode (the common case for every query pair on every request).
fn decode(s: &str) -> Cow<'_, str> {
    if !s.contains(['%', '+']) {
        return Cow::Borrowed(s);
    }
    Cow::Owned(
        percent_decode_str(&s.replace('+', " "))
            .decode_utf8_lossy()
            .into_owned(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&str, &[u8])]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.append(
                hyper::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                hyper::header::HeaderValue::from_bytes(v).unwrap(),
            );
        }
        m
    }

    fn named(wire: Method, pq: &str, headers: &[(&str, &[u8])]) -> Option<String> {
        mismatch(&wire, pq, &h(headers)).map(|m| m.named)
    }

    #[test]
    fn no_override_passes() {
        for m in [Method::GET, Method::POST, Method::PATCH, Method::DELETE] {
            assert_eq!(named(m, "/x?a=1&method=DELETE", &[]), None);
        }
    }

    #[test]
    fn a_disguised_write_is_refused_whichever_way_it_points() {
        // The GitHub case: a POST dressed as a read. GitHub ignores the
        // header and runs the POST, so judging it as a GET would admit a
        // write through a read grant.
        assert_eq!(
            named(
                Method::POST,
                "/repos/o/r/issues",
                &[("x-http-method-override", b"GET")]
            ),
            Some("GET".into())
        );
        // The Salesforce case: a POST that runs as a delete.
        assert_eq!(
            named(
                Method::POST,
                "/services/data/v62.0/sobjects/Contact/003AA?_HttpMethod=DELETE",
                &[]
            ),
            Some("DELETE".into())
        );
    }

    #[test]
    fn every_spelling_is_seen() {
        for name in HEADERS {
            assert_eq!(
                named(Method::POST, "/x", &[(name, b"DELETE")]),
                Some("DELETE".into()),
                "{name}"
            );
        }
        for pq in [
            "/x?_HttpMethod=DELETE",
            "/x?_method=DELETE",
            "/x?%24httpMethod=DELETE",
            "/x?_HTTPMETHOD=delete",
            "/x?_m%65thod=DELETE",
            "/x?a=1;_method=DELETE",
            "/x?_method+=DELETE",
        ] {
            assert!(named(Method::POST, pq, &[]).is_some(), "{pq}");
        }
    }

    #[test]
    fn an_override_repeating_the_request_line_passes() {
        assert_eq!(
            named(
                Method::POST,
                "/x?_HttpMethod=post",
                &[("x-http-method-override", b"POST")]
            ),
            None
        );
        assert_eq!(
            named(Method::GET, "/x", &[("x-http-method-override", b" get ")]),
            None
        );
    }

    #[test]
    fn anything_but_the_request_line_is_refused() {
        // Empty, unknown, a comma list with one stray, unreadable bytes.
        assert_eq!(named(Method::POST, "/x?_method=", &[]), Some(String::new()));
        assert_eq!(
            named(Method::POST, "/x?_HttpMethod", &[]),
            Some(String::new())
        );
        assert_eq!(
            named(Method::POST, "/x", &[("x-http-method", b"MERGE")]),
            Some("MERGE".into())
        );
        assert_eq!(
            named(
                Method::POST,
                "/x",
                &[("x-http-method-override", b"POST, DELETE")]
            ),
            Some("DELETE".into())
        );
        assert!(named(Method::POST, "/x", &[("x-method-override", b"\xff")]).is_some());
    }

    #[test]
    fn the_refusal_says_how_it_was_sent() {
        let found = mismatch(&Method::POST, "/x?_HttpMethod=PATCH", &HeaderMap::new());
        assert_eq!(
            found,
            Some(Mismatch {
                via: "the _HttpMethod query parameter".into(),
                named: "PATCH".into(),
            })
        );
    }
}
