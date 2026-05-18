//! AWS SigV4 request signing for the gateway.
//!
//! Parses AWS service and region from hostnames, then signs requests using
//! the `aws-sigv4` crate. Credentials are delivered via `x-onecli-aws-*`
//! internal headers injected by the credential system.

use anyhow::Context as _;
use aws_credential_types::Credentials;
use aws_sigv4::http_request::{
    sign, PayloadChecksumKind, SignableBody, SignableRequest, SignatureLocation, SigningParams,
    SigningSettings,
};
use aws_sigv4::sign::v4;
use hyper::header::{HeaderName, HeaderValue};

use super::super::body::buffer_body;

const AWS_ACCESS_KEY_HEADER: &str = "x-onecli-aws-access-key-id";
const AWS_SECRET_KEY_HEADER: &str = "x-onecli-aws-secret-access-key";
const AWS_SESSION_TOKEN_HEADER: &str = "x-onecli-aws-session-token";
const AWS_REGION_HEADER: &str = "x-onecli-aws-region";

#[derive(Clone)]
pub(crate) struct AwsCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    pub region: String,
}

/// Extract and remove AWS credentials from internal headers.
/// Returns `None` if any credential header is missing or invalid UTF-8.
/// Validates all headers before removing any, preventing partial removal
/// on malformed requests.
pub(crate) fn extract_credentials(headers: &mut hyper::HeaderMap) -> Option<AwsCredentials> {
    let access_key_id = headers
        .get(AWS_ACCESS_KEY_HEADER)?
        .to_str()
        .ok()?
        .to_owned();
    let secret_access_key = headers
        .get(AWS_SECRET_KEY_HEADER)?
        .to_str()
        .ok()?
        .to_owned();
    let region = headers.get(AWS_REGION_HEADER)?.to_str().ok()?.to_owned();

    let session_token = headers
        .remove(AWS_SESSION_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok().map(|s| s.to_string()));

    headers.remove(AWS_ACCESS_KEY_HEADER);
    headers.remove(AWS_SECRET_KEY_HEADER);
    headers.remove(AWS_REGION_HEADER);

    Some(AwsCredentials {
        access_key_id,
        secret_access_key,
        session_token,
        region,
    })
}

/// Parse the AWS service name and region from a hostname.
///
/// Supported patterns:
/// - `{service}.{region}.amazonaws.com` → (service, region)
/// - `{service}.amazonaws.com` → (service, default_region)
/// - `{bucket}.s3.{region}.amazonaws.com` → (s3, region)
/// - `{service}.{region}.api.aws` → (service, region)
pub(crate) fn parse_service_region<'a>(
    hostname: &'a str,
    default_region: &'a str,
) -> (&'a str, &'a str) {
    if let Some(rest) = hostname.strip_suffix(".api.aws") {
        return match rest.split_once('.') {
            Some((service, region)) => (service, region),
            None => (rest, default_region),
        };
    }

    if let Some(rest) = hostname.strip_suffix(".amazonaws.com") {
        let parts: Vec<&str> = rest.split('.').collect();
        return match parts.as_slice() {
            [service, region] => (service, region),
            [service] => (service, global_service_region(service, default_region)),
            [_, service, region] if *service == "s3" || service.starts_with("s3-") => {
                (service, region)
            }
            _ => {
                let region = parts.last().copied().unwrap_or(default_region);
                let service = if parts.len() >= 2 {
                    parts[parts.len() - 2]
                } else {
                    "unknown"
                };
                (service, region)
            }
        };
    }

    ("unknown", default_region)
}

fn global_service_region<'a>(service: &str, default_region: &'a str) -> &'a str {
    match service {
        "iam" | "sts" | "cloudfront" | "route53" | "s3" => {
            if default_region.is_empty() {
                "us-east-1"
            } else {
                default_region
            }
        }
        _ => default_region,
    }
}

/// Sign an HTTP request with AWS SigV4.
///
/// Strips any existing `authorization`, `x-amz-date`, and
/// `x-amz-content-sha256` headers, then computes a fresh signature
/// and applies the signing output headers.
pub(crate) fn sign_request(
    method: &str,
    url: &str,
    headers: &mut hyper::HeaderMap,
    body: &[u8],
    creds: &AwsCredentials,
    hostname: &str,
) -> anyhow::Result<()> {
    let (service, region) = parse_service_region(hostname, &creds.region);

    headers.remove("authorization");
    headers.remove("x-amz-date");
    headers.remove("x-amz-content-sha256");
    headers.remove("x-amz-security-token");

    if !headers.contains_key("host") {
        if let Ok(host_val) = HeaderValue::from_str(hostname) {
            headers.insert("host", host_val);
        }
    }

    let identity = Credentials::new(
        &creds.access_key_id,
        &creds.secret_access_key,
        creds.session_token.clone(),
        None, // expiry
        "onecli-gateway",
    )
    .into();

    let mut settings = SigningSettings::default();
    settings.payload_checksum_kind = if service == "s3" {
        PayloadChecksumKind::XAmzSha256
    } else {
        PayloadChecksumKind::NoHeader
    };
    settings.signature_location = SignatureLocation::Headers;

    let signing_params = v4::SigningParams::builder()
        .identity(&identity)
        .region(region)
        .name(service)
        .time(std::time::SystemTime::now())
        .settings(settings)
        .build()
        .context("building SigV4 signing params")?;

    let header_pairs: Vec<(&str, &str)> = {
        let mut pairs = Vec::with_capacity(headers.len());
        for (name, value) in headers.iter() {
            if let Ok(v) = value.to_str() {
                pairs.push((name.as_str(), v));
            }
        }
        pairs
    };

    let signable = SignableRequest::new(
        method,
        url,
        header_pairs.into_iter(),
        SignableBody::Bytes(body),
    )
    .context("creating SigV4 signable request")?;

    let (output, _signature) = sign(signable, &SigningParams::V4(signing_params))
        .context("computing SigV4 signature")?
        .into_parts();

    for (name, value) in output.headers() {
        let header_name =
            HeaderName::from_bytes(name.as_bytes()).context("invalid signing header name")?;
        let header_value = HeaderValue::from_str(value).context("invalid signing header value")?;
        headers.insert(header_name, header_value);
    }

    Ok(())
}

/// Sign an outgoing AWS request.
///
/// Extracts credentials from internal headers, buffers the body, signs
/// with SigV4, and returns the signed body. Returns the body unchanged
/// if no AWS credential headers are present.
pub(crate) async fn finalize_request(
    host: &str,
    method: &str,
    path: &str,
    headers: &mut hyper::HeaderMap,
    body: reqwest::Body,
) -> anyhow::Result<reqwest::Body> {
    let creds = match extract_credentials(headers) {
        Some(c) => c,
        None => return Ok(body),
    };

    let body_bytes = buffer_body(body).await?;
    let hostname = host.split(':').next().unwrap_or(host);
    let url = format!("https://{host}{path}");

    sign_request(method, &url, headers, &body_bytes, &creds, hostname)?;

    tracing::info!(
        method = %method,
        host = %host,
        path = %path,
        "AWS SigV4 signed"
    );

    Ok(reqwest::Body::from(body_bytes))
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_standard_regional() {
        let (svc, region) = parse_service_region("s3.us-east-1.amazonaws.com", "us-west-2");
        assert_eq!(svc, "s3");
        assert_eq!(region, "us-east-1");
    }

    #[test]
    fn parse_ec2_regional() {
        let (svc, region) = parse_service_region("ec2.eu-west-1.amazonaws.com", "us-east-1");
        assert_eq!(svc, "ec2");
        assert_eq!(region, "eu-west-1");
    }

    #[test]
    fn parse_global_sts() {
        let (svc, region) = parse_service_region("sts.amazonaws.com", "ap-southeast-1");
        assert_eq!(svc, "sts");
        assert_eq!(region, "ap-southeast-1");
    }

    #[test]
    fn parse_global_iam() {
        let (svc, region) = parse_service_region("iam.amazonaws.com", "eu-central-1");
        assert_eq!(svc, "iam");
        assert_eq!(region, "eu-central-1");
    }

    #[test]
    fn parse_s3_virtual_hosted() {
        let (svc, region) =
            parse_service_region("my-bucket.s3.us-west-2.amazonaws.com", "us-east-1");
        assert_eq!(svc, "s3");
        assert_eq!(region, "us-west-2");
    }

    #[test]
    fn parse_api_aws_format() {
        let (svc, region) = parse_service_region("lambda.us-west-2.api.aws", "us-east-1");
        assert_eq!(svc, "lambda");
        assert_eq!(region, "us-west-2");
    }

    #[test]
    fn parse_dynamodb_regional() {
        let (svc, region) =
            parse_service_region("dynamodb.ap-northeast-1.amazonaws.com", "us-east-1");
        assert_eq!(svc, "dynamodb");
        assert_eq!(region, "ap-northeast-1");
    }

    #[test]
    fn parse_unknown_host_uses_default() {
        let (svc, region) = parse_service_region("custom.example.com", "us-east-1");
        assert_eq!(svc, "unknown");
        assert_eq!(region, "us-east-1");
    }

    #[test]
    fn extract_credentials_removes_headers() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            AWS_ACCESS_KEY_HEADER,
            HeaderValue::from_static("AKIAIOSFODNN7EXAMPLE"),
        );
        headers.insert(
            AWS_SECRET_KEY_HEADER,
            HeaderValue::from_static("wJalrXUtnFEMI"),
        );
        headers.insert(AWS_REGION_HEADER, HeaderValue::from_static("us-east-1"));
        headers.insert("content-type", HeaderValue::from_static("application/json"));

        let creds = extract_credentials(&mut headers).expect("should extract");
        assert_eq!(creds.access_key_id, "AKIAIOSFODNN7EXAMPLE");
        assert_eq!(creds.secret_access_key, "wJalrXUtnFEMI");
        assert_eq!(creds.session_token, None);
        assert_eq!(creds.region, "us-east-1");

        assert!(!headers.contains_key(AWS_ACCESS_KEY_HEADER));
        assert!(!headers.contains_key(AWS_SESSION_TOKEN_HEADER));
        assert!(!headers.contains_key(AWS_SECRET_KEY_HEADER));
        assert!(!headers.contains_key(AWS_REGION_HEADER));
        assert!(headers.contains_key("content-type"));
    }

    #[test]
    fn extract_credentials_returns_none_when_missing() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        assert!(extract_credentials(&mut headers).is_none());
    }

    #[test]
    fn extract_credentials_no_partial_removal() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            AWS_ACCESS_KEY_HEADER,
            HeaderValue::from_static("AKIAIOSFODNN7EXAMPLE"),
        );
        // Missing secret and region — should return None without removing access key
        assert!(extract_credentials(&mut headers).is_none());
        assert!(
            headers.contains_key(AWS_ACCESS_KEY_HEADER),
            "should not remove headers when extraction fails"
        );
    }

    #[test]
    fn extract_credentials_with_session_token() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(
            AWS_ACCESS_KEY_HEADER,
            HeaderValue::from_static("ASIAIOSFODNN7EXAMPLE"),
        );
        headers.insert(
            AWS_SECRET_KEY_HEADER,
            HeaderValue::from_static("wJalrXUtnFEMI"),
        );
        headers.insert(
            AWS_SESSION_TOKEN_HEADER,
            HeaderValue::from_static("FwoGZXIvYXdzEBY"),
        );
        headers.insert(AWS_REGION_HEADER, HeaderValue::from_static("us-west-2"));

        let creds = extract_credentials(&mut headers).expect("should extract");
        assert_eq!(creds.access_key_id, "ASIAIOSFODNN7EXAMPLE");
        assert_eq!(creds.secret_access_key, "wJalrXUtnFEMI");
        assert_eq!(creds.session_token.as_deref(), Some("FwoGZXIvYXdzEBY"));
        assert_eq!(creds.region, "us-west-2");

        assert!(!headers.contains_key(AWS_ACCESS_KEY_HEADER));
        assert!(!headers.contains_key(AWS_SECRET_KEY_HEADER));
        assert!(!headers.contains_key(AWS_SESSION_TOKEN_HEADER));
        assert!(!headers.contains_key(AWS_REGION_HEADER));
    }
}
