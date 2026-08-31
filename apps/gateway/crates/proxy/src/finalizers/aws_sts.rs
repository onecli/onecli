//! AWS STS AssumeRole — resolves temporary credentials via cross-account
//! role assumption, then signs requests with SigV4.
//!
//! Temp credentials are cached in a DashMap with TTL-based expiry.

use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use aws_sdk_sts::Client as StsClient;
use dashmap::DashMap;
use tracing::info;

use super::aws_sigv4::{self, AwsCredentials};
use crate::body;

const EXPIRY_BUFFER_SECS: i64 = 300;

#[derive(Clone)]
struct CachedCredentials {
    creds: AwsCredentials,
    expires_at: i64,
}

static CACHE: LazyLock<DashMap<String, CachedCredentials>> = LazyLock::new(DashMap::new);

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_secs() as i64
}

/// Resolve temporary AWS credentials for an AssumeRole connection.
///
/// Checks the in-memory cache first. On cache miss or near-expiry,
/// calls STS AssumeRole and caches the result.
pub async fn resolve_credentials(
    role_arn: &str,
    external_id: &str,
    region: &str,
    session_policy: Option<&str>,
    agent_id: &str,
) -> anyhow::Result<AwsCredentials> {
    let cache_key = format!("{role_arn}:{agent_id}");
    let now = now_epoch();

    // Check cache — drop the guard before any .await
    if let Some(entry) = CACHE.get(&cache_key) {
        if entry.expires_at - EXPIRY_BUFFER_SECS > now {
            return Ok(entry.creds.clone());
        }
    }

    let creds = assume_role(role_arn, external_id, region, session_policy, agent_id).await?;

    CACHE.insert(
        cache_key,
        CachedCredentials {
            creds: creds.clone(),
            expires_at: now_epoch() + 3600,
        },
    );

    Ok(creds)
}

async fn assume_role(
    role_arn: &str,
    external_id: &str,
    region: &str,
    session_policy: Option<&str>,
    agent_id: &str,
) -> anyhow::Result<AwsCredentials> {
    let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(aws_config::Region::new(region.to_string()))
        .load()
        .await;
    let client = StsClient::new(&config);

    let truncated_id: String = agent_id.chars().take(32).collect();
    let session_name = format!("onecli-{truncated_id}");

    let mut req = client
        .assume_role()
        .role_arn(role_arn)
        .external_id(external_id)
        .role_session_name(&session_name);

    if let Some(policy) = session_policy {
        if !policy.is_empty() {
            req = req.policy(policy);
        }
    }

    let resp = req
        .send()
        .await
        .with_context(|| format!("STS AssumeRole failed for {role_arn}"))?;

    let sts_creds = resp
        .credentials()
        .ok_or_else(|| anyhow::anyhow!("STS AssumeRole returned no credentials"))?;

    info!(
        role_arn = %role_arn,
        agent_id = %agent_id,
        "STS AssumeRole succeeded"
    );

    Ok(AwsCredentials {
        access_key_id: sts_creds.access_key_id().to_string(),
        secret_access_key: sts_creds.secret_access_key().to_string(),
        session_token: Some(sts_creds.session_token().to_string()),
        region: region.to_string(),
    })
}

/// The AssumeRole parameters carried on a request's internal headers.
///
/// `Debug` is hand-written rather than derived: the session policy can carry
/// customer policy text, so it is reported by presence only. The external ID
/// is deliberately shown — AWS states it is not a secret (anyone who can read
/// the role sees it), and having it in a failure log is what makes a
/// misconfigured trust policy diagnosable.
pub struct AssumeRoleParams {
    pub role_arn: String,
    pub external_id: String,
    pub region: String,
    pub session_policy: Option<String>,
}

impl std::fmt::Debug for AssumeRoleParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AssumeRoleParams")
            .field("role_arn", &self.role_arn)
            .field("external_id", &self.external_id)
            .field("region", &self.region)
            .field("session_policy", &self.session_policy.is_some())
            .finish()
    }
}

/// Read the AssumeRole parameters off the internal headers, removing them.
///
/// The external ID is REQUIRED, and that is the point of this function.
/// `sts:ExternalId` is what stops the confused-deputy problem: it is generated
/// per customer by us and pinned in their role's trust policy, so a role
/// assumed without it is a role assumed without the check the id exists for.
/// Injection only sets the header when the stored credential actually carries
/// the field (`connect.rs`), so "absent" means the credential is incomplete —
/// which is exactly when we must NOT proceed.
///
/// This is the same fail-closed law the rest of the pipeline follows: when a
/// required credential cannot be produced, nothing is injected and the request
/// fails, rather than going out with weaker authority than intended.
///
/// Headers are validated BEFORE any is removed, so a malformed request cannot
/// leave the map half-stripped (mirrors `aws_sigv4::extract_credentials`).
pub fn extract_assume_role_params(
    headers: &mut hyper::HeaderMap,
) -> anyhow::Result<AssumeRoleParams> {
    let role_arn = headers
        .get("x-onecli-aws-role-arn")
        .context("missing x-onecli-aws-role-arn header")?
        .to_str()
        .map_err(|_| anyhow::anyhow!("invalid UTF-8 in x-onecli-aws-role-arn header"))?
        .to_string();

    let external_id = headers
        .get("x-onecli-aws-external-id")
        .context(
            "missing x-onecli-aws-external-id header — refusing to assume the role without \
             the external ID that defends against the confused-deputy problem",
        )?
        .to_str()
        .map_err(|_| anyhow::anyhow!("invalid UTF-8 in x-onecli-aws-external-id header"))?
        .to_string();

    // An empty (or blank) value is the same failure wearing a different hat:
    // AWS documents ExternalId as min length 2, so this could only ever be a
    // rejected call or — worse, if that ever changed — an unprotected one.
    if external_id.trim().is_empty() {
        anyhow::bail!(
            "empty x-onecli-aws-external-id header — refusing to assume the role without \
             the external ID that defends against the confused-deputy problem"
        );
    }

    let region = headers
        .get("x-onecli-aws-assume-region")
        .and_then(|v| v.to_str().ok().map(|s| s.to_string()))
        .unwrap_or_else(|| "us-east-1".to_string());
    let session_policy = headers
        .get("x-onecli-aws-session-policy")
        .and_then(|v| v.to_str().ok().map(|s| s.to_string()));

    // Validated — now strip them, so none of ours reach the upstream.
    headers.remove("x-onecli-aws-role-arn");
    headers.remove("x-onecli-aws-external-id");
    headers.remove("x-onecli-aws-assume-region");
    headers.remove("x-onecli-aws-session-policy");

    Ok(AssumeRoleParams {
        role_arn,
        external_id,
        region,
        session_policy,
    })
}

/// Sign an outgoing AWS request using AssumeRole credentials.
///
/// Extracts role ARN and external ID from internal headers, resolves
/// temporary credentials via STS, then signs the request with SigV4.
pub async fn finalize_request(
    host: &str,
    method: &str,
    path: &str,
    headers: &mut hyper::HeaderMap,
    body: reqwest::Body,
) -> anyhow::Result<reqwest::Body> {
    let params = extract_assume_role_params(headers)?;

    let agent_id = headers
        .get("x-onecli-agent-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    let creds = resolve_credentials(
        &params.role_arn,
        &params.external_id,
        &params.region,
        params.session_policy.as_deref(),
        &agent_id,
    )
    .await?;

    let body_bytes = body::buffer_body(body).await?;
    let hostname = host.split(':').next().unwrap_or(host);
    let url = format!("https://{host}{path}");

    aws_sigv4::sign_request(method, &url, headers, &body_bytes, &creds, hostname)?;

    info!(
        method = %method,
        host = %host,
        path = %path,
        role_arn = %params.role_arn,
        "AWS SigV4 signed (AssumeRole)"
    );

    Ok(reqwest::Body::from(body_bytes))
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const ARN: &str = "arn:aws:iam::123456789012:role/OneCLI-Agent-Role";

    fn headers(pairs: &[(&str, &str)]) -> hyper::HeaderMap {
        let mut h = hyper::HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                hyper::header::HeaderName::from_bytes(k.as_bytes()).expect("header name"),
                hyper::header::HeaderValue::from_str(v).expect("header value"),
            );
        }
        h
    }

    #[test]
    fn extracts_the_full_parameter_set() {
        let mut h = headers(&[
            ("x-onecli-aws-role-arn", ARN),
            ("x-onecli-aws-external-id", "onecli-abc-123"),
            ("x-onecli-aws-assume-region", "eu-west-2"),
            ("x-onecli-aws-session-policy", "{}"),
        ]);

        let p = extract_assume_role_params(&mut h).expect("params");

        assert_eq!(p.role_arn, ARN);
        assert_eq!(p.external_id, "onecli-abc-123");
        assert_eq!(p.region, "eu-west-2");
        assert_eq!(p.session_policy.as_deref(), Some("{}"));
        // Our internal headers must never reach the upstream.
        assert!(h.is_empty(), "internal headers should be stripped");
    }

    #[test]
    fn defaults_the_region_but_never_the_external_id() {
        let mut h = headers(&[
            ("x-onecli-aws-role-arn", ARN),
            ("x-onecli-aws-external-id", "onecli-abc-123"),
        ]);

        let p = extract_assume_role_params(&mut h).expect("params");

        assert_eq!(p.region, "us-east-1");
        assert_eq!(p.session_policy, None);
    }

    /// THE regression this guard exists for. The external ID is the
    /// confused-deputy defense: assuming the role without it is assuming it
    /// without the check the customer pinned in their trust policy. It used to
    /// default to "" and call AssumeRole anyway.
    #[test]
    fn refuses_when_the_external_id_header_is_absent() {
        let mut h = headers(&[("x-onecli-aws-role-arn", ARN)]);

        let err = extract_assume_role_params(&mut h).expect_err("must refuse");

        assert!(
            err.to_string().contains("x-onecli-aws-external-id"),
            "error should name the missing header, got: {err}"
        );
    }

    #[test]
    fn refuses_an_empty_external_id() {
        let mut h = headers(&[
            ("x-onecli-aws-role-arn", ARN),
            ("x-onecli-aws-external-id", ""),
        ]);

        let err = extract_assume_role_params(&mut h).expect_err("must refuse");

        assert!(
            err.to_string().contains("x-onecli-aws-external-id"),
            "error should name the header, got: {err}"
        );
    }

    /// Whitespace is not a value. AWS's own ExternalId pattern excludes
    /// spaces, so a blank header is the empty case wearing a disguise.
    #[test]
    fn refuses_a_whitespace_only_external_id() {
        let mut h = headers(&[
            ("x-onecli-aws-role-arn", ARN),
            ("x-onecli-aws-external-id", "   "),
        ]);

        let err = extract_assume_role_params(&mut h).expect_err("must refuse");

        assert!(
            err.to_string().contains("x-onecli-aws-external-id"),
            "error should name the header, got: {err}"
        );
    }

    #[test]
    fn refuses_when_the_role_arn_is_absent() {
        let mut h = headers(&[("x-onecli-aws-external-id", "onecli-abc-123")]);

        let err = extract_assume_role_params(&mut h).expect_err("must refuse");

        assert!(
            err.to_string().contains("x-onecli-aws-role-arn"),
            "error should name the missing header, got: {err}"
        );
    }

    /// A refused request must not be left half-stripped: the caller may log or
    /// otherwise inspect it, and a partially-mutated map is a trap.
    #[test]
    fn a_refusal_leaves_the_headers_untouched() {
        let mut h = headers(&[
            ("x-onecli-aws-role-arn", ARN),
            ("x-onecli-aws-assume-region", "eu-west-2"),
        ]);

        let _ = extract_assume_role_params(&mut h).expect_err("must refuse");

        assert!(
            h.contains_key("x-onecli-aws-role-arn"),
            "role arn must survive a refusal"
        );
        assert!(
            h.contains_key("x-onecli-aws-assume-region"),
            "region must survive a refusal"
        );
    }

    /// Unrelated headers belong to the caller's request and must pass through.
    #[test]
    fn leaves_non_onecli_headers_alone() {
        let mut h = headers(&[
            ("x-onecli-aws-role-arn", ARN),
            ("x-onecli-aws-external-id", "onecli-abc-123"),
            ("content-type", "application/json"),
        ]);

        extract_assume_role_params(&mut h).expect("params");

        assert_eq!(
            h.get("content-type").and_then(|v| v.to_str().ok()),
            Some("application/json")
        );
    }
}
