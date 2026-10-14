//! Shared body buffering utilities for the gateway pipeline.

use std::io::Read as _;

use anyhow::Context as _;
use futures_util::{Stream, StreamExt as _};
use http_body_util::BodyExt;
use hyper::body::Bytes;
use hyper::header::{HeaderMap, CONTENT_ENCODING};

const MAX_BODY_SIZE: usize = 10 * 1024 * 1024; // 10 MB

/// Buffer a streaming `reqwest::Body` into bytes, enforcing size during read.
///
/// Rejects the body as soon as accumulated bytes exceed `MAX_BODY_SIZE`,
/// preventing OOM on large uploads without buffering the entire payload first.
pub async fn buffer_body(mut body: reqwest::Body) -> anyhow::Result<Bytes> {
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

/// The start of an upstream response body, read to classify it without
/// consuming the rest: [`read_head`] returns it, and the caller replays it in
/// front of whatever it did not read.
pub struct Head {
    pub bytes: Vec<u8>,
    /// The body ended within the bytes read: `bytes` is all of it.
    pub complete: bool,
}

/// Read whole chunks of `stream` until at least `limit` bytes are held or the
/// body ends. The last chunk is kept whole, so `bytes` can exceed `limit`.
pub async fn read_head<S>(stream: &mut S, limit: usize) -> anyhow::Result<Head>
where
    S: Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
{
    let mut bytes = Vec::new();
    while bytes.len() < limit {
        match stream.next().await {
            Some(chunk) => bytes.extend_from_slice(&chunk.context("reading the response body")?),
            None => {
                return Ok(Head {
                    bytes,
                    complete: true,
                })
            }
        }
    }
    Ok(Head {
        bytes,
        complete: false,
    })
}

/// `body` as the upstream meant it, at most `limit` bytes. Providers gzip
/// even a 200-byte error whenever the client accepts it (curl `--compressed`,
/// Node `fetch`, Python `requests` and Go's client all do), and the gateway
/// relays the client's `Accept-Encoding`. `None` for an encoding other than
/// gzip, or a body that does not inflate. Inflation stops at `limit`, so a
/// gzip bomb costs no more than `limit` bytes.
pub fn decoded(headers: &HeaderMap, body: &[u8], limit: usize) -> Option<Vec<u8>> {
    let encoding = headers
        .get(CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .unwrap_or("");
    if encoding.is_empty() || encoding.eq_ignore_ascii_case("identity") {
        return Some(body[..body.len().min(limit)].to_vec());
    }
    if !encoding.eq_ignore_ascii_case("gzip") {
        return None;
    }
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(body)
        .take(limit as u64)
        .read_to_end(&mut out)
        .ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderValue;

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        use std::io::Write as _;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(bytes).expect("gzip");
        encoder.finish().expect("gzip")
    }

    fn encoded(value: &'static str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_ENCODING, HeaderValue::from_static(value));
        headers
    }

    #[test]
    fn a_plain_or_gzipped_body_decodes_and_other_encodings_do_not() {
        assert_eq!(
            decoded(&HeaderMap::new(), b"plain", 64).as_deref(),
            Some(&b"plain"[..])
        );
        assert_eq!(
            decoded(&encoded("gzip"), &gzip(b"zipped"), 64).as_deref(),
            Some(&b"zipped"[..])
        );
        assert_eq!(decoded(&encoded("br"), b"opaque", 64), None);
        assert_eq!(decoded(&encoded("gzip"), b"not gzip", 64), None);
    }

    /// A gzip bomb inflates no further than the limit.
    #[test]
    fn decoding_is_bounded() {
        let bomb = gzip(&vec![b'a'; 16 * 1024 * 1024]);
        assert_eq!(
            decoded(&encoded("gzip"), &bomb, 4096).map(|b| b.len()),
            Some(4096)
        );
        assert_eq!(
            decoded(&HeaderMap::new(), &[b'a'; 100], 10).map(|b| b.len()),
            Some(10)
        );
    }

    #[tokio::test]
    async fn the_head_is_complete_only_when_the_body_ends_within_the_limit() {
        let chunks = |n: usize| {
            futures_util::stream::iter(vec![Ok::<_, reqwest::Error>(Bytes::from(vec![0u8; n]))])
        };
        let small = read_head(&mut chunks(2), 64).await.expect("read");
        assert_eq!((small.bytes.len(), small.complete), (2, true));
        let large = read_head(&mut chunks(100), 64).await.expect("read");
        assert_eq!((large.bytes.len(), large.complete), (100, false));
    }

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
