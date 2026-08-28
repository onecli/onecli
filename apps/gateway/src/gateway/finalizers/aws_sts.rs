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
use crate::gateway::body;

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
pub(crate) async fn resolve_credentials(
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

/// Sign an outgoing AWS request using AssumeRole credentials.
///
/// Extracts role ARN and external ID from internal headers, resolves
/// temporary credentials via STS, then signs the request with SigV4.
pub(crate) async fn finalize_request(
    host: &str,
    method: &str,
    path: &str,
    headers: &mut hyper::HeaderMap,
    body: reqwest::Body,
) -> anyhow::Result<reqwest::Body> {
    let role_arn = headers
        .remove("x-onecli-aws-role-arn")
        .context("missing x-onecli-aws-role-arn header")?
        .to_str()
        .map_err(|_| anyhow::anyhow!("invalid UTF-8 in x-onecli-aws-role-arn header"))?
        .to_string();
    let external_id = headers
        .remove("x-onecli-aws-external-id")
        .map(|v| {
            v.to_str()
                .map_err(|_| anyhow::anyhow!("invalid UTF-8 in x-onecli-aws-external-id header"))
                .map(|s| s.to_string())
        })
        .transpose()?
        .unwrap_or_default();
    let region = headers
        .remove("x-onecli-aws-assume-region")
        .and_then(|v| v.to_str().ok().map(|s| s.to_string()))
        .unwrap_or_else(|| "us-east-1".to_string());
    let session_policy = headers
        .remove("x-onecli-aws-session-policy")
        .and_then(|v| v.to_str().ok().map(|s| s.to_string()));

    let agent_id = headers
        .get("x-onecli-agent-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();

    let creds = resolve_credentials(
        &role_arn,
        &external_id,
        &region,
        session_policy.as_deref(),
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
        role_arn = %role_arn,
        "AWS SigV4 signed (AssumeRole)"
    );

    Ok(reqwest::Body::from(body_bytes))
}
