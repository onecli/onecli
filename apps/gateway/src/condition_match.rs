use crate::policy::PolicyRule;

/// OSS stub: no condition matching, no body buffering.
pub(crate) fn needs_body_buffer(_rules: &[PolicyRule]) -> bool {
    false
}

pub(crate) fn matches(_rule: &PolicyRule, _body: Option<&[u8]>) -> bool {
    true
}

pub(crate) async fn prepare_body(
    body: hyper::body::Incoming,
    _method: &str,
    _url: &str,
) -> anyhow::Result<(Option<Vec<u8>>, reqwest::Body)> {
    Ok((None, reqwest::Body::wrap(body)))
}
