use futures_util::StreamExt;
use http_body_util::BodyDataStream;
use tracing::warn;

use crate::policy::PolicyRule;

const CONDITION_BODY_BUFFER: usize = 16_384; // 16 KB

#[derive(serde::Deserialize)]
struct RawCondition {
    target: String,
    operator: String,
    value: String,
}

struct ParsedCondition {
    target: String,
    operator: String,
    value_lower: String,
}

fn parse_conditions(raw: &serde_json::Value) -> Option<Vec<ParsedCondition>> {
    let raw_conditions: Vec<RawCondition> = serde_json::from_value(raw.clone())
        .map_err(|e| warn!(error = %e, "failed to parse policy rule conditions"))
        .ok()?;
    if raw_conditions.is_empty() {
        return None;
    }
    Some(
        raw_conditions
            .into_iter()
            .map(|c| ParsedCondition {
                target: c.target,
                operator: c.operator,
                value_lower: c.value.to_ascii_lowercase(),
            })
            .collect(),
    )
}

pub(crate) fn matches(rule: &PolicyRule, body: Option<&[u8]>) -> bool {
    let conditions = match rule.conditions_raw.as_ref().and_then(parse_conditions) {
        Some(c) => c,
        None => return true,
    };

    conditions.iter().all(|c| condition_matches(c, body))
}

fn condition_matches(condition: &ParsedCondition, body: Option<&[u8]>) -> bool {
    match (condition.target.as_str(), condition.operator.as_str()) {
        ("body", "contains") => {
            let Some(bytes) = body else {
                return false;
            };
            let haystack = String::from_utf8_lossy(bytes).to_ascii_lowercase();
            haystack.contains(&condition.value_lower)
        }
        _ => true,
    }
}

pub(crate) async fn prepare_body(
    body: hyper::body::Incoming,
    method: &str,
    url: &str,
) -> anyhow::Result<(Option<Vec<u8>>, reqwest::Body)> {
    let mut stream = Box::pin(BodyDataStream::new(body));
    let mut chunks: Vec<hyper::body::Bytes> = Vec::with_capacity(4);
    let mut total_len: usize = 0;

    while total_len < CONDITION_BODY_BUFFER {
        match stream.next().await {
            Some(Ok(data)) => {
                total_len += data.len();
                chunks.push(data);
            }
            Some(Err(e)) => {
                return Err(anyhow::anyhow!(
                    "reading request body for condition check: {e}"
                ));
            }
            None => break,
        }
    }

    if total_len >= CONDITION_BODY_BUFFER {
        warn!(
            method = %method,
            url = %url,
            buffered = total_len,
            limit = CONDITION_BODY_BUFFER,
            "request body exceeds condition buffer limit — conditions evaluated on partial body"
        );
    }

    let mut buf = Vec::with_capacity(total_len.min(CONDITION_BODY_BUFFER));
    for chunk in &chunks {
        let remaining = CONDITION_BODY_BUFFER - buf.len();
        let take = remaining.min(chunk.len());
        buf.extend_from_slice(&chunk[..take]);
        if buf.len() >= CONDITION_BODY_BUFFER {
            break;
        }
    }

    let peeked_stream = futures_util::stream::iter(chunks.into_iter().map(Ok::<_, std::io::Error>));
    let remaining_stream = stream.map(|r| r.map_err(|e| std::io::Error::other(e.to_string())));
    let reassembled = reqwest::Body::wrap_stream(peeked_stream.chain(remaining_stream));

    Ok((Some(buf), reassembled))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_rule(conditions_json: Option<serde_json::Value>) -> PolicyRule {
        PolicyRule {
            name: "test".to_string(),
            path_pattern: "*".to_string(),
            method: None,
            action: crate::policy::PolicyAction::Block,
            conditions_raw: conditions_json,
        }
    }

    #[test]
    fn body_contains_match_case_insensitive() {
        let rule = make_rule(Some(serde_json::json!([
            {"target": "body", "operator": "contains", "value": "DELETE"}
        ])));
        assert!(matches(&rule, Some(b"please delete this item")));
        assert!(matches(&rule, Some(b"DELETE everything")));
    }

    #[test]
    fn body_contains_no_match() {
        let rule = make_rule(Some(serde_json::json!([
            {"target": "body", "operator": "contains", "value": "secret"}
        ])));
        assert!(!matches(&rule, Some(b"nothing here")));
    }

    #[test]
    fn empty_body_does_not_match() {
        let rule = make_rule(Some(serde_json::json!([
            {"target": "body", "operator": "contains", "value": "test"}
        ])));
        assert!(!matches(&rule, Some(b"")));
        assert!(!matches(&rule, None));
    }

    #[test]
    fn no_conditions_always_matches() {
        let rule = make_rule(None);
        assert!(matches(&rule, None));
        assert!(matches(&rule, Some(b"anything")));

        let rule2 = make_rule(Some(serde_json::json!([])));
        assert!(matches(&rule2, None));
    }

    #[test]
    fn multiple_conditions_and_semantics() {
        let rule = make_rule(Some(serde_json::json!([
            {"target": "body", "operator": "contains", "value": "foo"},
            {"target": "body", "operator": "contains", "value": "bar"}
        ])));
        assert!(matches(&rule, Some(b"foo and bar")));
        assert!(!matches(&rule, Some(b"only foo here")));
        assert!(!matches(&rule, Some(b"only bar here")));
    }

    #[test]
    fn unknown_target_or_operator_matches() {
        let rule = make_rule(Some(serde_json::json!([
            {"target": "header", "operator": "equals", "value": "x"}
        ])));
        assert!(matches(&rule, Some(b"anything")));
    }

    #[test]
    fn malformed_conditions_json_matches() {
        let rule = make_rule(Some(serde_json::json!("not an array")));
        assert!(matches(&rule, Some(b"anything")));
    }
}
