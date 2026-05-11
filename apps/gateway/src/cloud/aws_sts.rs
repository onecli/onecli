//! Cloud aws_sts stub — exists only so `cargo fmt` can parse the
//! `#[path = "cloud/aws_sts.rs"]` declaration. Real implementation
//! lives in the cloud repo.

pub(crate) async fn finalize_request(
    _host: &str,
    _method: &str,
    _path: &str,
    _headers: &mut hyper::HeaderMap,
    _body: reqwest::Body,
) -> anyhow::Result<reqwest::Body> {
    unreachable!()
}
