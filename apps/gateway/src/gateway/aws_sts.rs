//! AWS STS AssumeRole — OSS stub.
//!
//! The cloud build swaps this for `cloud/aws_sts.rs` which resolves
//! temporary credentials via STS AssumeRole before signing.

/// OSS fallback — delegates to direct-key signing.
pub(crate) async fn finalize_request(
    host: &str,
    method: &str,
    path: &str,
    headers: &mut hyper::HeaderMap,
    body: reqwest::Body,
) -> anyhow::Result<reqwest::Body> {
    super::aws_sigv4::finalize_request(host, method, path, headers, body).await
}
