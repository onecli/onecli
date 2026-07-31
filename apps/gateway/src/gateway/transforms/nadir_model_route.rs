//! Right-size the `model` field on outbound LLM completion requests.
//!
//! Agents habitually pin their most capable model for every call. Most calls
//! do not need it. This transform sends the outbound prompt to Nadir's
//! complexity classifier, gets back a `simple` / `medium` / `complex` bucket,
//! and rewrites `model` to the tier the operator mapped that bucket to.
//! The agent's code, credentials, and SDK are untouched.
//!
//! Invoked via the `BodyTransform::NadirModelRoute` dispatch in `forward.rs`.
//! All Nadir-specific logic (host, method, path, config) is encapsulated here.
//!
//! **Off unless configured.** `transform_for_host` claims nothing until the
//! operator sets `NADIR_MODEL_ROUTING=1`, and even then a request is only
//! rewritten when its current model is one the operator listed on a tier
//! ladder (see `Ladder::rank`). An unrecognised model is never touched.
//!
//! **Fails open.** A classifier timeout, a non-200, a malformed body, or an
//! unmapped bucket all forward the original bytes unchanged. The only error
//! this returns is an unbufferable request body, which is unrecoverable
//! because the stream has already been consumed.
//!
//! **Privacy.** When enabled, the prompt text of routed requests is sent to
//! `api.getnadir.com` for classification. This is the explicit trade the
//! operator opts into; see `docs/nadir-integration.md`.

use std::sync::OnceLock;
use std::time::Duration;

use hyper::body::Bytes;
use hyper::Method;
use tracing::{debug, warn};

const BUCKET_URL: &str = "https://api.getnadir.com/v1/bucket";

/// Requests larger than this skip classification and forward unchanged. A
/// prompt this large is not a "simple" task under any classifier, and the
/// round-trip would cost more than the routing saves.
const MAX_CLASSIFY_BYTES: usize = 256 * 1024;

/// Cap on the classifier round-trip. Nadir buckets in ~10ms server-side; this
/// is a generous ceiling that still keeps a hung classifier from being felt.
const DEFAULT_TIMEOUT_MS: u64 = 1500;

// ── Config ──────────────────────────────────────────────────────────────

/// A bucket → model mapping for one API flavour.
#[derive(Debug, Default)]
struct Ladder {
    simple: Option<String>,
    medium: Option<String>,
    complex: Option<String>,
}

impl Ladder {
    fn from_env(prefix: &str, defaults: [Option<&str>; 3]) -> Self {
        let read = |suffix: &str, default: Option<&str>| {
            std::env::var(format!("{prefix}_{suffix}"))
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .or_else(|| default.map(String::from))
        };
        Self {
            simple: read("SIMPLE", defaults[0]),
            medium: read("MEDIUM", defaults[1]),
            complex: read("COMPLEX", defaults[2]),
        }
    }

    fn model_for(&self, bucket: &str) -> Option<&str> {
        match bucket {
            "simple" => self.simple.as_deref(),
            "medium" => self.medium.as_deref(),
            "complex" => self.complex.as_deref(),
            _ => None,
        }
    }

    /// Position of `model` on this ladder, cheapest first. `None` means the
    /// model is not on the ladder and must not be rewritten — the operator
    /// never told us where it sits, so we cannot know a swap is a downgrade.
    fn rank(&self, model: &str) -> Option<u8> {
        for (idx, entry) in [&self.simple, &self.medium, &self.complex]
            .into_iter()
            .enumerate()
        {
            if entry.as_deref() == Some(model) {
                return Some(idx as u8);
            }
        }
        None
    }
}

#[derive(Debug)]
struct NadirConfig {
    enabled: bool,
    api_key: Option<String>,
    /// Allow routing a request *up* the ladder. Off by default: a gateway that
    /// silently makes calls more expensive is a bad surprise.
    allow_upgrade: bool,
    timeout: Duration,
    anthropic: Ladder,
    openai: Ladder,
}

fn config() -> &'static NadirConfig {
    static CONFIG: OnceLock<NadirConfig> = OnceLock::new();
    CONFIG.get_or_init(|| {
        let flag = |name: &str| {
            matches!(
                std::env::var(name).ok().as_deref(),
                Some("1") | Some("true") | Some("TRUE")
            )
        };
        NadirConfig {
            enabled: flag("NADIR_MODEL_ROUTING"),
            api_key: std::env::var("NADIR_API_KEY")
                .ok()
                .filter(|k| !k.trim().is_empty()),
            allow_upgrade: flag("NADIR_ALLOW_UPGRADE"),
            timeout: Duration::from_millis(
                std::env::var("NADIR_TIMEOUT_MS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(DEFAULT_TIMEOUT_MS),
            ),
            // Anthropic ships a clean three-tier family, so it gets defaults.
            anthropic: Ladder::from_env(
                "NADIR_ANTHROPIC",
                [
                    Some("claude-haiku-4-5"),
                    Some("claude-sonnet-4-6"),
                    Some("claude-opus-4-6"),
                ],
            ),
            // OpenAI model names change too often to hardcode a ladder that
            // would silently route to a model the operator never chose.
            openai: Ladder::from_env("NADIR_OPENAI", [None, None, None]),
        }
    })
}

/// Claim this host for model routing, or leave it alone.
///
/// LLM endpoints are reached with a plain API-key secret rather than an OAuth
/// app connection, so they have no entry in the provider registry to hang a
/// transform on and must be matched by host here. Returning `None` while
/// routing is off is what keeps a disabled gateway from ever buffering an LLM
/// request body.
pub(crate) fn transform_for_host(host: &str) -> Option<crate::apps::BodyTransform> {
    (config().enabled && crate::policy::is_llm_host(host))
        .then_some(crate::apps::BodyTransform::NadirModelRoute)
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

// ── Request shape ───────────────────────────────────────────────────────

/// Which completion API this request speaks, which decides both where the
/// prompt lives in the body and which ladder applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Flavor {
    /// `POST /v1/messages` — Anthropic Messages API.
    AnthropicMessages,
    /// `POST /v1/chat/completions` — OpenAI and the many APIs that clone it.
    OpenAiChat,
}

impl Flavor {
    fn detect(host: &str, method: &Method, path: &str) -> Option<Self> {
        if method != Method::POST || !crate::policy::is_llm_host(host) {
            return None;
        }
        // Ignore any query string.
        let route = path.split('?').next().unwrap_or(path);
        match route {
            "/v1/messages" => Some(Self::AnthropicMessages),
            "/v1/chat/completions" => Some(Self::OpenAiChat),
            _ => None,
        }
    }

    fn ladder(self, cfg: &'static NadirConfig) -> &'static Ladder {
        match self {
            Self::AnthropicMessages => &cfg.anthropic,
            Self::OpenAiChat => &cfg.openai,
        }
    }
}

// ── Entry point ─────────────────────────────────────────────────────────

/// Attempt to right-size the model on an LLM completion request.
///
/// Returns the body unchanged whenever routing does not apply or anything at
/// all goes wrong. `Err` is reserved for a request body that could not be
/// buffered, which cannot be forwarded because the stream is already consumed.
pub(crate) async fn try_route_model(
    host: &str,
    method: &Method,
    path: &str,
    body: reqwest::Body,
) -> anyhow::Result<reqwest::Body> {
    let cfg = config();
    let Some(flavor) = Flavor::detect(host, method, path) else {
        return Ok(body);
    };

    let bytes = super::super::body::buffer_body(body).await?;
    if bytes.len() > MAX_CLASSIFY_BYTES {
        debug!(
            len = bytes.len(),
            "nadir: request above classify size cap, forwarding unchanged"
        );
        return Ok(reqwest::Body::from(bytes));
    }

    match route(&bytes, flavor, cfg).await {
        Some(rewritten) => Ok(reqwest::Body::from(rewritten)),
        None => Ok(reqwest::Body::from(bytes)),
    }
}

/// The routing decision. `None` means "forward the original bytes" — every
/// failure path lands here.
async fn route(bytes: &Bytes, flavor: Flavor, cfg: &'static NadirConfig) -> Option<Vec<u8>> {
    let mut json: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let obj = json.as_object_mut()?;

    let current = obj.get("model")?.as_str()?.to_string();
    let ladder = flavor.ladder(cfg);

    // Only models the operator placed on the ladder are eligible. Anything
    // else is a model we cannot rank, so a swap could silently cost more.
    let current_rank = ladder.rank(&current)?;

    let prompt = extract_prompt(obj, flavor)?;
    let bucket = classify(&prompt, cfg).await?;

    let target = ladder.model_for(&bucket)?;
    if target == current {
        return None;
    }

    let target_rank = ladder.rank(target)?;
    if target_rank > current_rank && !cfg.allow_upgrade {
        debug!(
            from = %current,
            to = %target,
            %bucket,
            "nadir: skipping upgrade (set NADIR_ALLOW_UPGRADE=1 to permit)"
        );
        return None;
    }

    obj.insert(
        "model".to_string(),
        serde_json::Value::String(target.to_string()),
    );
    clamp_max_tokens(obj, target);

    debug!(from = %current, to = %target, %bucket, "nadir: routed model");
    serde_json::to_vec(&json).ok()
}

/// Pull the classifiable text out of a completion request.
///
/// Anthropic carries the system prompt in a sibling `system` field rather than
/// a message, so it is folded in as a leading system message — the classifier
/// reads instructions there that materially change a task's difficulty.
fn extract_prompt(
    obj: &serde_json::Map<String, serde_json::Value>,
    flavor: Flavor,
) -> Option<Vec<serde_json::Value>> {
    let messages = obj.get("messages")?.as_array()?;
    if messages.is_empty() {
        return None;
    }

    let mut out: Vec<serde_json::Value> = Vec::with_capacity(messages.len() + 1);
    if flavor == Flavor::AnthropicMessages {
        if let Some(system) = obj.get("system") {
            let text = match system {
                serde_json::Value::String(s) => Some(s.clone()),
                // Anthropic also accepts system as an array of text blocks.
                serde_json::Value::Array(blocks) => {
                    let joined: Vec<&str> = blocks
                        .iter()
                        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                        .collect();
                    (!joined.is_empty()).then(|| joined.join("\n"))
                }
                _ => None,
            };
            if let Some(text) = text {
                out.push(serde_json::json!({ "role": "system", "content": text }));
            }
        }
    }
    out.extend(messages.iter().cloned());
    Some(out)
}

/// Ask Nadir which bucket this prompt falls in. `None` on any failure.
async fn classify(messages: &[serde_json::Value], cfg: &'static NadirConfig) -> Option<String> {
    let payload = serde_json::json!({
        "messages": messages,
        "source": "onecli",
    });

    let mut req = client()
        .post(BUCKET_URL)
        .timeout(cfg.timeout)
        .json(&payload);
    if let Some(ref key) = cfg.api_key {
        req = req.header("x-api-key", key);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            warn!(error = %e, "nadir: classifier unreachable, forwarding unchanged");
            return None;
        }
    };
    if !resp.status().is_success() {
        warn!(
            status = resp.status().as_u16(),
            "nadir: classifier returned non-success, forwarding unchanged"
        );
        return None;
    }

    #[derive(serde::Deserialize)]
    struct BucketResponse {
        bucket: String,
    }
    match resp.json::<BucketResponse>().await {
        Ok(b) => Some(b.bucket),
        Err(e) => {
            warn!(error = %e, "nadir: unreadable classifier response, forwarding unchanged");
            None
        }
    }
}

/// Keep `max_tokens` inside the target model's output ceiling.
///
/// Routing down can land on a model whose ceiling is lower than the one the
/// caller asked for, which the provider rejects with a 400. Only ever lowers.
fn clamp_max_tokens(obj: &mut serde_json::Map<String, serde_json::Value>, target: &str) {
    let Some(ceiling) = output_ceiling(target) else {
        return;
    };
    for field in ["max_tokens", "max_completion_tokens"] {
        if let Some(requested) = obj.get(field).and_then(serde_json::Value::as_u64) {
            if requested > ceiling {
                obj.insert(field.to_string(), serde_json::json!(ceiling));
                debug!(field, from = requested, to = ceiling, "nadir: clamped");
            }
        }
    }
}

/// Published max output tokens for models we ship a default ladder for.
/// `None` means unknown — leave `max_tokens` alone rather than guess.
fn output_ceiling(model: &str) -> Option<u64> {
    match model {
        "claude-haiku-4-5" => Some(64_000),
        "claude-sonnet-4-6" | "claude-opus-4-6" => Some(64_000),
        _ => None,
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cfg(allow_upgrade: bool) -> &'static NadirConfig {
        // Leaked rather than shared through the OnceLock so tests can vary the
        // config without depending on process-wide env or ordering.
        Box::leak(Box::new(NadirConfig {
            enabled: true,
            api_key: None,
            allow_upgrade,
            timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
            anthropic: Ladder {
                simple: Some("claude-haiku-4-5".into()),
                medium: Some("claude-sonnet-4-6".into()),
                complex: Some("claude-opus-4-6".into()),
            },
            openai: Ladder::default(),
        }))
    }

    #[test]
    fn detects_anthropic_messages() {
        assert_eq!(
            Flavor::detect("api.anthropic.com", &Method::POST, "/v1/messages"),
            Some(Flavor::AnthropicMessages)
        );
    }

    #[test]
    fn detects_openai_chat_ignoring_query() {
        assert_eq!(
            Flavor::detect(
                "api.openai.com",
                &Method::POST,
                "/v1/chat/completions?beta=1"
            ),
            Some(Flavor::OpenAiChat)
        );
    }

    #[test]
    fn ignores_non_completion_traffic() {
        // Right host, wrong endpoint.
        assert_eq!(
            Flavor::detect("api.anthropic.com", &Method::POST, "/v1/models"),
            None
        );
        // Right endpoint shape, wrong host.
        assert_eq!(
            Flavor::detect("api.github.com", &Method::POST, "/v1/messages"),
            None
        );
        // Right host and endpoint, wrong method.
        assert_eq!(
            Flavor::detect("api.anthropic.com", &Method::GET, "/v1/messages"),
            None
        );
    }

    #[test]
    fn ranks_only_ladder_models() {
        let ladder = &test_cfg(false).anthropic;
        assert_eq!(ladder.rank("claude-haiku-4-5"), Some(0));
        assert_eq!(ladder.rank("claude-opus-4-6"), Some(2));
        assert_eq!(ladder.rank("gpt-5"), None);
    }

    #[test]
    fn extracts_anthropic_system_as_leading_message() {
        let body = serde_json::json!({
            "model": "claude-opus-4-6",
            "system": "You are terse.",
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let prompt =
            extract_prompt(body.as_object().unwrap(), Flavor::AnthropicMessages).expect("prompt");
        assert_eq!(prompt.len(), 2);
        assert_eq!(prompt[0]["role"], "system");
        assert_eq!(prompt[0]["content"], "You are terse.");
        assert_eq!(prompt[1]["content"], "hi");
    }

    #[test]
    fn extracts_anthropic_system_from_block_array() {
        let body = serde_json::json!({
            "model": "claude-opus-4-6",
            "system": [{ "type": "text", "text": "Block one." }],
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let prompt =
            extract_prompt(body.as_object().unwrap(), Flavor::AnthropicMessages).expect("prompt");
        assert_eq!(prompt[0]["content"], "Block one.");
    }

    #[test]
    fn openai_flavor_ignores_sibling_system_field() {
        let body = serde_json::json!({
            "model": "gpt-5",
            "system": "ignored on this API",
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let prompt = extract_prompt(body.as_object().unwrap(), Flavor::OpenAiChat).expect("prompt");
        assert_eq!(prompt.len(), 1);
    }

    #[test]
    fn clamps_max_tokens_down_only() {
        let mut obj = serde_json::json!({ "max_tokens": 200_000u64 })
            .as_object()
            .unwrap()
            .clone();
        clamp_max_tokens(&mut obj, "claude-haiku-4-5");
        assert_eq!(obj["max_tokens"], 64_000u64);

        let mut small = serde_json::json!({ "max_tokens": 512u64 })
            .as_object()
            .unwrap()
            .clone();
        clamp_max_tokens(&mut small, "claude-haiku-4-5");
        assert_eq!(small["max_tokens"], 512u64);
    }

    #[test]
    fn clamp_leaves_unknown_models_alone() {
        let mut obj = serde_json::json!({ "max_tokens": 200_000u64 })
            .as_object()
            .unwrap()
            .clone();
        clamp_max_tokens(&mut obj, "some-unknown-model");
        assert_eq!(obj["max_tokens"], 200_000u64);
    }

    /// End-to-end against the live classifier. Ignored by default because it
    /// needs network; run with `cargo test -- --ignored live_classifier`.
    #[tokio::test]
    #[ignore = "hits api.getnadir.com"]
    async fn live_classifier_routes_a_trivial_prompt_down() {
        let bytes = Bytes::from(
            serde_json::to_vec(&serde_json::json!({
                "model": "claude-opus-4-6",
                "max_tokens": 1024,
                "messages": [{
                    "role": "user",
                    "content": "Rename the variable `x` to `count` in this one line.",
                }],
            }))
            .unwrap(),
        );

        let out = route(&bytes, Flavor::AnthropicMessages, test_cfg(false))
            .await
            .expect("a trivial prompt should route below opus");
        let json: serde_json::Value = serde_json::from_slice(&out).unwrap();

        let routed = json["model"].as_str().unwrap();
        assert_ne!(routed, "claude-opus-4-6", "expected a downgrade");
        assert!(
            ["claude-haiku-4-5", "claude-sonnet-4-6"].contains(&routed),
            "routed to an off-ladder model: {routed}"
        );
        // Everything else must survive the rewrite untouched.
        assert_eq!(json["max_tokens"], 1024);
        assert_eq!(json["messages"][0]["role"], "user");
    }

    /// The classifier is never called for a model the operator did not rank,
    /// so an off-ladder request cannot be rewritten even if Nadir is reachable.
    #[tokio::test]
    async fn off_ladder_model_is_untouched() {
        let bytes = Bytes::from(
            serde_json::to_vec(&serde_json::json!({
                "model": "some-self-hosted-model",
                "messages": [{ "role": "user", "content": "hi" }],
            }))
            .unwrap(),
        );
        let out = route(&bytes, Flavor::AnthropicMessages, test_cfg(false)).await;
        assert!(out.is_none(), "off-ladder model must not be rewritten");
    }

    #[tokio::test]
    async fn missing_model_field_is_untouched() {
        let bytes = Bytes::from(
            serde_json::to_vec(&serde_json::json!({
                "messages": [{ "role": "user", "content": "hi" }],
            }))
            .unwrap(),
        );
        let out = route(&bytes, Flavor::AnthropicMessages, test_cfg(false)).await;
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn malformed_body_is_untouched() {
        let bytes = Bytes::from_static(b"not json at all");
        let out = route(&bytes, Flavor::AnthropicMessages, test_cfg(false)).await;
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn unroutable_request_forwards_original_bytes() {
        // A GET to a non-completion path never reaches the classifier, and the
        // body must survive the pass-through byte for byte.
        let body = reqwest::Body::from("original");
        let out = try_route_model("api.github.com", &Method::GET, "/x", body)
            .await
            .expect("passthrough must not error");
        let buffered = super::super::super::body::buffer_body(out).await.unwrap();
        assert_eq!(buffered.as_ref(), b"original");
    }
}
