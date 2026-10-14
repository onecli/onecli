//! Credential-bearing query parameters, masked for log lines.
//!
//! Some providers carry a live credential in the query string rather than a
//! header: SharePoint upload sessions sign with `tempauth=`, Facebook takes
//! `access_token=`, Google APIs and Trello take `key=`, presigned S3/Azure URLs
//! embed a signature, a Drive/Cloud Storage resumable session is authorized by
//! its `upload_id=`, and an OAuth callback carries `code=`. The gateway logs the
//! request URL on most proxied calls, so without this the credential lands in
//! the log store verbatim and stays there for as long as the logs are retained.
//!
//! Logging only. The forwarded request keeps its real query string or it
//! would fail upstream, so callers mask the copy bound for `tracing` and never
//! the value they send. Request telemetry is already safe: it stores the
//! query-stripped path.

use std::borrow::Cow;

use percent_encoding::percent_decode_str;

/// Shown in place of a masked value.
const MASK: &str = "***";

/// Name fragments that mark a credential in a URL query on top of the secret
/// keys a body is masked by ([`summary::is_sensitive_key`]): request
/// signatures (`sig`, `X-Amz-Signature`), `X-Amz-Credential`, embedded auth
/// tokens (`tempauth`, `authtoken`), OAuth `code`, and session handles that
/// authorize on their own (`session_id`, a resumable upload's `upload_id`).
const URL_CREDENTIAL_FRAGMENTS: [&str; 6] =
    ["sig", "auth", "code", "credential", "session", "upload_id"];

/// Whether a query parameter's name looks like it carries a credential.
///
/// Substring-matched on the decoded, lowercased name, so a provider's new
/// `*_token` or `*_secret` is covered the day it appears, and any name ending
/// in `key` is one (Google's and Trello's `key`, `x-api-key`, Azure API
/// Management's `subscription-key`).
/// Deliberately over-inclusive: masking a harmless `next_token` cursor or a
/// `sort_key` costs a little debuggability, a missed credential costs a leak.
fn is_credential_param(name: &str) -> bool {
    let name = percent_decode_str(name)
        .decode_utf8_lossy()
        .to_ascii_lowercase();
    name.ends_with("key")
        || summary::is_sensitive_key(&name)
        || URL_CREDENTIAL_FRAGMENTS.iter().any(|f| name.contains(f))
}

/// The name of a `name=value` query pair when that name marks a credential.
fn credential_name(pair: &str) -> Option<&str> {
    pair.split_once('=')
        .map(|(name, _)| name)
        .filter(|name| is_credential_param(name))
}

/// `url` (a full URL or a bare path-and-query) with the value of every
/// credential-looking query parameter replaced by `***`.
///
/// The scheme, host, path, parameter names and every other value are kept so
/// the line is still useful. Borrowed unchanged when nothing needs masking
/// (no query, or no credential in it): this runs on every proxied request.
/// String-based on purpose: odd input must degrade to "logged, minus anything
/// sensitive", never panic.
pub(crate) fn redact_for_log(url: &str) -> Cow<'_, str> {
    let Some((base, query)) = url.split_once('?') else {
        return Cow::Borrowed(url);
    };
    if !query.split('&').any(|pair| credential_name(pair).is_some()) {
        return Cow::Borrowed(url);
    }
    let mut masked = String::with_capacity(url.len());
    masked.push_str(base);
    masked.push('?');
    for (i, pair) in query.split('&').enumerate() {
        if i > 0 {
            masked.push('&');
        }
        match credential_name(pair) {
            Some(name) => {
                masked.push_str(name);
                masked.push('=');
                masked.push_str(MASK);
            }
            None => masked.push_str(pair),
        }
    }
    Cow::Owned(masked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_credential_params_providers_put_in_the_query() {
        for (url, name) in [
            (
                "https://contoso-my.sharepoint.com/_api/v2.0/drive/items/X/uploadSession?guid='a1'&tempauth=v1.LIVE",
                "tempauth",
            ),
            (
                "https://graph.facebook.com/v18.0/me?access_token=LIVE",
                "access_token",
            ),
            ("https://api.example.com/x?refresh_token=LIVE", "refresh_token"),
            ("https://api.example.com/x?client_secret=LIVE", "client_secret"),
            ("https://api.example.com/x?api_key=LIVE", "api_key"),
            ("https://api.example.com/x?x-api-key=LIVE", "x-api-key"),
            (
                "https://b.s3.amazonaws.com/o?X-Amz-Credential=LIVE",
                "X-Amz-Credential",
            ),
            (
                "https://b.s3.amazonaws.com/o?X-Amz-Signature=LIVE",
                "X-Amz-Signature",
            ),
            (
                "https://b.s3.amazonaws.com/o?X-Amz-Security-Token=LIVE",
                "X-Amz-Security-Token",
            ),
            ("https://b.s3.amazonaws.com/o?AWSAccessKeyId=LIVE", "AWSAccessKeyId"),
            ("https://acct.blob.core.windows.net/c/o?sv=2024&sig=LIVE", "sig"),
            ("https://idp.example.com/callback?code=LIVE&state=s1", "code"),
            ("https://api.example.com/x?auth=LIVE", "auth"),
            ("https://api.example.com/x?session_id=LIVE", "session_id"),
            // Google APIs: an API key as `key` (or the `$key` system name).
            (
                "https://www.googleapis.com/youtube/v3/videos?part=id&key=LIVE",
                "key",
            ),
            ("https://www.googleapis.com/x?$key=LIVE", "$key"),
            // Trello: the gateway injects both of these.
            ("https://api.trello.com/1/members/me?key=LIVE", "key"),
            ("https://api.trello.com/1/members/me?token=LIVE", "token"),
            // A Drive / Cloud Storage resumable session URI authorizes the
            // upload by itself.
            (
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=LIVE",
                "upload_id",
            ),
            // Azure API Management's default query name for its key.
            (
                "https://contoso.azure-api.net/echo?subscription-key=LIVE",
                "subscription-key",
            ),
            // Any other `*key` name, whatever the provider calls it.
            ("https://api.example.com/x?client_key=LIVE", "client_key"),
        ] {
            let out = redact_for_log(url);
            assert!(out.contains(&format!("{name}=***")), "{name}: {out}");
            assert!(!out.contains("LIVE"), "{name} leaked: {out}");
        }
    }

    #[test]
    fn keeps_everything_that_is_not_a_credential() {
        let url = "https://graph.microsoft.com/v1.0/me/messages?$top=50&$select=subject&limit=10&keyword=x";
        assert_eq!(redact_for_log(url), url);
        let out = redact_for_log(
            "https://contoso-my.sharepoint.com/_api/v2.0/drive/items/X/uploadSession?guid='a1'&dc=0&tempauth=v1.LIVE",
        );
        assert_eq!(
            out,
            "https://contoso-my.sharepoint.com/_api/v2.0/drive/items/X/uploadSession?guid='a1'&dc=0&tempauth=***"
        );
    }

    /// This runs on every proxied request: a URL with nothing to mask is
    /// handed back as is, not copied.
    #[test]
    fn nothing_to_mask_borrows_instead_of_copying() {
        for url in [
            "https://api.anthropic.com:443/v1/messages",
            "/v1/messages",
            "https://x.test/y?",
            "https://x.test/y?limit=5&cursor=abc",
        ] {
            let out = redact_for_log(url);
            assert!(matches!(out, Cow::Borrowed(_)), "{url} was copied");
            assert_eq!(out, url);
        }
    }

    #[test]
    fn case_and_percent_encoding_do_not_defeat_it() {
        let out = redact_for_log("https://x.test/y?Access_Token=A1&TempAuth=B2&access_t%6Fken=C3");
        for leaked in ["A1", "B2", "C3"] {
            assert!(!out.contains(leaked), "{leaked} leaked: {out}");
        }
    }

    #[test]
    fn every_repeat_and_the_whole_value_are_masked() {
        // Repeated names, and base64 values that carry their own '='.
        let out = redact_for_log("https://x.test/y?token=A1&token=B2&sig=YWJjZA==");
        assert_eq!(out, "https://x.test/y?token=***&token=***&sig=***");
    }

    #[test]
    fn odd_queries_degrade_safely() {
        let out = redact_for_log("https://x.test/y?&flag&&token=abc&");
        assert_eq!(out, "https://x.test/y?&flag&&token=***&");
    }

    #[test]
    fn a_bare_path_is_masked_the_same_way() {
        // WebSocket upgrades and the granular-access guard log the
        // path-and-query, and upgrades routinely carry the token there.
        let out = redact_for_log("/socket?room=general&access_token=wss_LIVE");
        assert_eq!(out, "/socket?room=general&access_token=***");
    }
}
