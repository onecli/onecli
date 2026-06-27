//! Approval push notifications.
//!
//! When a request is held for manual approval and an `ntfy` approval path is
//! enabled, the gateway publishes a notification carrying **Approve / Deny**
//! action buttons. Tapping one POSTs back to the gateway's approval callback
//! (`/v1/approvals/{id}/approve|deny`), guarded by a per-channel callback token.
//!
//! Publishing is best-effort: failures are logged and never block the held
//! request (it can still be resolved via any other enabled channel, or it
//! auto-denies at timeout).

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tracing::{info, warn};

use crate::approval::{ApprovalDecision, PendingApproval};
use crate::crypto::CryptoService;
use crate::db::ApprovalPathRow;

/// Max characters of the request body preview included in the notification.
const PREVIEW_CHARS: usize = 500;

/// Default remember-window for resolved decisions (seconds). Override with the
/// `APPROVAL_RESOLVED_TTL_SECS` env var. Within this window a repeat callback is
/// idempotent / conflict-aware; past it the approval is treated as timed out.
const DEFAULT_RESOLVED_TTL_SECS: u64 = 600;

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Short-lived memory of how recently-resolved approvals were decided, so the
/// ntfy callback can tell a benign retry (same decision) from a conflicting
/// late tap (opposite decision) after the pending approval is already gone.
pub(crate) struct ResolvedDecisions {
    inner: Mutex<HashMap<String, (ApprovalDecision, u64)>>,
    ttl_secs: u64,
}

impl Default for ResolvedDecisions {
    fn default() -> Self {
        Self::with_ttl(DEFAULT_RESOLVED_TTL_SECS)
    }
}

impl ResolvedDecisions {
    pub fn with_ttl(ttl_secs: u64) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            ttl_secs,
        }
    }

    /// Build from `APPROVAL_RESOLVED_TTL_SECS` (falls back to the default).
    pub fn from_env() -> Self {
        let ttl = std::env::var("APPROVAL_RESOLVED_TTL_SECS")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|&n| n > 0)
            .unwrap_or(DEFAULT_RESOLVED_TTL_SECS);
        Self::with_ttl(ttl)
    }

    /// The configured remember-window in seconds.
    pub fn ttl_secs(&self) -> u64 {
        self.ttl_secs
    }

    /// Record the decision that resolved an approval.
    pub fn record(&self, id: &str, decision: ApprovalDecision) {
        if let Ok(mut map) = self.inner.lock() {
            let now = unix_now();
            map.retain(|_, (_, at)| now.saturating_sub(*at) < self.ttl_secs);
            map.insert(id.to_string(), (decision, now));
        }
    }

    /// The decision that resolved this approval, if still within the TTL.
    pub fn get(&self, id: &str) -> Option<ApprovalDecision> {
        let mut map = self.inner.lock().ok()?;
        let (decision, at) = map.get(id).copied()?;
        if unix_now().saturating_sub(at) < self.ttl_secs {
            Some(decision)
        } else {
            map.remove(id);
            None
        }
    }
}

/// How many recent approval events to retain in the in-memory debug log.
const APPROVAL_LOG_CAPACITY: usize = 200;

/// A single approval-pipeline event, surfaced to the dashboard's "Test approval"
/// debug view so users can confirm publish/callback success without `docker logs`.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ApprovalEvent {
    #[serde(skip)]
    pub project_id: String,
    pub at: String,
    pub message: String,
}

/// A small, project-scoped ring buffer of recent approval events (publish,
/// callback decisions, test triggers). Lives in `GatewayState`.
#[derive(Default)]
pub(crate) struct ApprovalEventLog {
    entries: Mutex<VecDeque<ApprovalEvent>>,
}

impl ApprovalEventLog {
    pub fn record(&self, project_id: &str, message: impl Into<String>) {
        let at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Iso8601::DEFAULT)
            .unwrap_or_default();
        let event = ApprovalEvent {
            project_id: project_id.to_string(),
            at,
            message: message.into(),
        };
        if let Ok(mut entries) = self.entries.lock() {
            if entries.len() >= APPROVAL_LOG_CAPACITY {
                entries.pop_front();
            }
            entries.push_back(event);
        }
    }

    /// Most recent `limit` events for a project, oldest-first within the slice.
    pub fn recent(&self, project_id: &str, limit: usize) -> Vec<ApprovalEvent> {
        let entries = match self.entries.lock() {
            Ok(e) => e,
            Err(_) => return Vec::new(),
        };
        let mut recent: Vec<ApprovalEvent> = entries
            .iter()
            .rev()
            .filter(|e| e.project_id == project_id)
            .take(limit)
            .cloned()
            .collect();
        recent.reverse();
        recent
    }
}

fn setting<'a>(row: &'a ApprovalPathRow, key: &str) -> Option<&'a str> {
    row.settings
        .as_ref()
        .and_then(|s| s.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Expand `{var}` placeholders in user-supplied notification fields (Tags,
/// Priority) from the request being approved. Unknown placeholders are left
/// as-is. Available: agentId, agentName, method, host, path.
fn expand_vars(template: &str, approval: &PendingApproval) -> String {
    template
        .replace("{agentId}", &approval.agent_id)
        .replace("{agentName}", &approval.agent_name)
        .replace("{method}", &approval.method)
        .replace("{host}", &approval.host)
        .replace("{path}", &approval.path)
}

/// Publish a plain ntfy status note (no action buttons) to the same topic —
/// used to confirm a decision after the fact, since iOS action buttons give no
/// inline feedback. Best-effort; contains no secrets (decision + name + time).
pub(crate) async fn publish_ntfy_status(
    client: &reqwest::Client,
    crypto: &CryptoService,
    ntfy: &ApprovalPathRow,
    title: &str,
    body: &str,
    tags: &str,
) {
    let (Some(server_url), Some(topic)) = (setting(ntfy, "serverUrl"), setting(ntfy, "topic"))
    else {
        return;
    };
    let publish_token = match ntfy.credentials.as_deref() {
        Some(enc) => crypto
            .decrypt(enc)
            .await
            .ok()
            .and_then(|json| serde_json::from_str::<Value>(&json).ok())
            .and_then(|c| {
                c.get("publishToken")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(String::from)
            }),
        None => None,
    };

    let url = format!("{}/{}", server_url.trim_end_matches('/'), topic);
    let mut req = client
        .post(&url)
        .header("Title", title)
        .header("Tags", tags)
        .header("Priority", "low")
        .body(body.to_string());
    if let Some(token) = &publish_token {
        req = req.bearer_auth(token);
    }
    if let Err(e) = req.send().await {
        warn!(error = %e, "ntfy status note publish failed");
    }
}

/// Publish a manual-approval request to ntfy with Approve/Deny buttons.
pub(crate) async fn publish_ntfy_approval(
    client: &reqwest::Client,
    crypto: &CryptoService,
    log: &ApprovalEventLog,
    ntfy: &ApprovalPathRow,
    approval: &PendingApproval,
) {
    let approval_id = &approval.id;
    let project_id = &approval.project_id;

    let Some(server_url) = setting(ntfy, "serverUrl") else {
        warn!(%approval_id, "ntfy approval path missing serverUrl — skipping publish");
        log.record(project_id, "ntfy publish skipped: serverUrl not set");
        return;
    };
    let Some(topic) = setting(ntfy, "topic") else {
        warn!(%approval_id, "ntfy approval path missing topic — skipping publish");
        log.record(project_id, "ntfy publish skipped: topic not set");
        return;
    };
    let Some(callback_base) = setting(ntfy, "callbackBaseUrl") else {
        warn!(%approval_id, "ntfy approval path missing callbackBaseUrl — skipping publish");
        log.record(project_id, "ntfy publish skipped: callbackBaseUrl not set");
        return;
    };

    // Decrypt the publish + callback tokens.
    let creds: Option<Value> = match ntfy.credentials.as_deref() {
        Some(enc) => match crypto.decrypt(enc).await {
            Ok(json) => serde_json::from_str(&json).ok(),
            Err(e) => {
                warn!(%approval_id, error = %e, "failed to decrypt ntfy credentials");
                None
            }
        },
        None => None,
    };
    let token = |key: &str| {
        creds
            .as_ref()
            .and_then(|c| c.get(key))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(String::from)
    };
    // The callback token is required (it secures the Approve/Deny buttons).
    // The publish token is optional — an open ntfy server allows anonymous
    // publish, so only attach Authorization when a token is configured.
    let Some(callback_token) = token("callbackToken") else {
        warn!(%approval_id, "ntfy approval path missing callback token — skipping publish");
        log.record(
            project_id,
            "ntfy publish skipped: callback token not set (the Approve/Deny buttons need it)",
        );
        return;
    };
    let publish_token = token("publishToken");

    let server_url = server_url.trim_end_matches('/');
    let callback_base = callback_base.trim_end_matches('/');
    let approve_url = format!("{callback_base}/v1/approvals/{approval_id}/approve");
    let deny_url = format!("{callback_base}/v1/approvals/{approval_id}/deny");

    // ntfy action-button syntax; up to 3 actions per message (we use 2).
    let actions = format!(
        "http, Approve, {approve_url}, method=POST, headers.Authorization=Bearer {callback_token}, clear=true; \
         http, Deny, {deny_url}, method=POST, headers.Authorization=Bearer {callback_token}, clear=true"
    );

    // Prefer the gateway's structured request summary (same one the dashboard
    // bell shows) so the push reads "Send email · To: … · Subject: …" rather
    // than a bare method+URL. Fall back to the legacy body preview, then to a
    // generic line. A footer always names the agent + target for context.
    let title = match approval.summary.as_ref() {
        Some(s) if !s.action.is_empty() => format!("OneCLI: {}?", s.action),
        _ => format!("OneCLI: approve {} {}?", approval.method, approval.host),
    };
    let mut body = if let Some(summary) = approval.summary.as_ref() {
        summary.render_text()
    } else if let Some(preview) = approval
        .body_preview
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        preview.chars().take(PREVIEW_CHARS).collect()
    } else {
        format!(
            "Agent '{}' wants to {} {}://{}{}",
            approval.agent_name, approval.method, approval.scheme, approval.host, approval.path
        )
    };
    body.push_str(&format!(
        "\n\n— {} · {} {}",
        approval.agent_name, approval.method, approval.host
    ));

    let url = format!("{server_url}/{topic}");
    let mut req = client
        .post(&url)
        .header("Title", title)
        .header("Actions", actions)
        .body(body);
    if let Some(publish_token) = &publish_token {
        req = req.bearer_auth(publish_token);
    }
    // Priority and Tags support variable expansion from the request context.
    if let Some(priority) = setting(ntfy, "priority") {
        req = req.header("Priority", expand_vars(priority, approval));
    }
    if let Some(tags) = setting(ntfy, "tags") {
        req = req.header("Tags", expand_vars(tags, approval));
    }

    match req.send().await {
        Ok(resp) if resp.status().is_success() => {
            info!(%approval_id, "published ntfy approval notification");
            log.record(
                project_id,
                format!("ntfy publish OK → {server_url}/{topic} (awaiting Approve/Deny)"),
            );
        }
        Ok(resp) => {
            let status = resp.status();
            warn!(%approval_id, status = %status, "ntfy publish returned non-success");
            log.record(project_id, format!("ntfy publish FAILED: HTTP {status}"));
        }
        Err(e) => {
            warn!(%approval_id, error = %e, "ntfy publish request failed");
            log.record(project_id, format!("ntfy publish FAILED: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_decisions_idempotent_and_conflict() {
        let r = ResolvedDecisions::default();
        assert!(r.get("a1").is_none());

        r.record("a1", ApprovalDecision::Approve);
        assert_eq!(r.get("a1"), Some(ApprovalDecision::Approve));

        // Same decision again is idempotent; opposite is a detectable conflict.
        assert_eq!(r.get("a1"), Some(ApprovalDecision::Approve));
        assert_ne!(r.get("a1"), Some(ApprovalDecision::Deny));

        // A later decision overwrites (e.g. re-record on the resolving path).
        r.record("a1", ApprovalDecision::Deny);
        assert_eq!(r.get("a1"), Some(ApprovalDecision::Deny));

        assert!(r.get("unknown").is_none());
    }
}
