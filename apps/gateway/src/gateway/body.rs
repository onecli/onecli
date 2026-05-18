//! Shared body buffering utilities for the gateway pipeline.

use anyhow::Context as _;
use http_body_util::BodyExt;
use hyper::body::Bytes;

const MAX_BODY_SIZE: usize = 10 * 1024 * 1024; // 10 MB

/// Buffer a streaming `reqwest::Body` into bytes, enforcing size during read.
///
/// Rejects the body as soon as accumulated bytes exceed `MAX_BODY_SIZE`,
/// preventing OOM on large uploads without buffering the entire payload first.
pub(crate) async fn buffer_body(mut body: reqwest::Body) -> anyhow::Result<Bytes> {
    let mut buf = Vec::with_capacity(4096);

    while let Some(frame_result) = body.frame().await {
        let frame = frame_result.context("reading request body")?;
        if let Some(data) = frame.data_ref() {
            if buf.len() + data.len() > MAX_BODY_SIZE {
                anyhow::bail!("request body exceeds {MAX_BODY_SIZE} byte limit");
            }
            buf.extend_from_slice(data);
        }
    }

    Ok(Bytes::from(buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn buffer_body_rejects_oversized() {
        let oversized = vec![0u8; MAX_BODY_SIZE + 1];
        let body = reqwest::Body::from(oversized);
        let result = buffer_body(body).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("exceeds"),);
    }

    #[tokio::test]
    async fn buffer_body_accepts_within_limit() {
        let data = vec![42u8; 1024];
        let body = reqwest::Body::from(data.clone());
        let result = buffer_body(body).await.expect("should succeed");
        assert_eq!(result.as_ref(), data.as_slice());
    }
}
