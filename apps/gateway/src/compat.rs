//! Legacy project→workspace wire compatibility (rename compat).
//!
//! The tenancy rename changed the gateway's control-plane wire: the
//! `X-Project-Id` scope header and the `projectId` field in approval-poll
//! rows. Released SDKs (≤ 3.1.0) and CLIs (≤ 2.11.0) still speak the old
//! wire — most critically the SDK's org-approvals watcher, which reads
//! `projectId` from poll rows and echoes it as `X-Project-Id` on the decision
//! POST; without this module every such approval silently auto-denies at the
//! timeout. This module keeps those clients working for a deprecation window.
//!
//! Invariants:
//! - ABSENCE-ONLY: [`legacy_workspace_header`] is only ever composed as an
//!   `.or_else` fallback after the canonical `x-workspace-id` read — a
//!   canonical header always wins and can never be overridden.
//! - SAME FENCES: the aliased value feeds the unchanged access checks
//!   (`user_can_access_workspace` / `verify_workspace_in_org`); this module
//!   resolves nothing itself and holds no DB handle.
//! - CONTROL-PLANE ONLY: nothing here is reachable from the CONNECT/forward
//!   data path, which never reads scope headers.
//!
//! Every legacy hit emits one `warn!(deprecated_surface = ...)` carrying the
//! (non-secret) workspace id — the sunset criterion is those log counts
//! going quiet, attributable per workspace/org.
//!
//! TEMPORARY — delete this module at sunset: remove `mod compat` in
//! `main.rs`, the two `.or_else(...legacy_workspace_header...)` fallbacks in
//! `auth.rs` (session + org-key header reads), the
//! [`LEGACY_WORKSPACE_HEADER`] element in `gateway.rs`'s CORS
//! `allow_headers`, the [`dual_emit_legacy_workspace`] call inside
//! `gateway::pending_approval_row`, the `#[serde(alias = "project_id")]`
//! on `approval::PendingApproval::workspace_id`, and the
//! `"(formerly X-Project-Id)"` hint in the three `AuthError` messages in
//! `auth.rs` (plus their pinned e2e assertions). The sibling Node layer is
//! `packages/api/src/lib/legacy-project-compat.ts`.

use axum::http::header::HeaderName;
use axum::http::HeaderMap;
use tracing::warn;

/// Read the legacy `X-Project-Id` header with the exact semantics of the
/// canonical `x-workspace-id` read (a non-UTF-8 or empty value counts as
/// absent). Compose ONLY as an `.or_else` fallback after the canonical read.
pub(crate) fn legacy_workspace_header(headers: &HeaderMap) -> Option<&str> {
    let value = headers
        .get("x-project-id")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())?;
    // The workspace id is not a secret and is what lets the sunset workflow
    // count remaining legacy callers per workspace/org.
    warn!(
        deprecated_surface = "x-project-id",
        workspace_id = %value,
        "legacy project-era scope header used; migrate the client before sunset"
    );
    Some(value)
}

/// The legacy header name for the CORS allow-list — browsers block a
/// preflight naming a header that isn't allow-listed, with no server log.
pub(crate) const LEGACY_WORKSPACE_HEADER: HeaderName = HeaderName::from_static("x-project-id");

/// Insert the legacy `projectId` key (the row's workspace id) in an
/// approval-poll row, so old SDKs can read the scope they echo back on the
/// decision POST. Takes the id explicitly so a rename of the canonical
/// `workspaceId` key can never turn this into a silent no-op.
pub(crate) fn dual_emit_legacy_workspace(row: &mut serde_json::Value, workspace_id: &str) {
    let Some(object) = row.as_object_mut() else {
        return;
    };
    object.insert(
        "projectId".to_string(),
        serde_json::Value::from(workspace_id),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[test]
    fn legacy_header_present_yields_value() {
        let map = headers(&[("x-project-id", "ws-1")]);
        assert_eq!(legacy_workspace_header(&map), Some("ws-1"));
    }

    #[test]
    fn legacy_header_absent_yields_none() {
        assert_eq!(legacy_workspace_header(&HeaderMap::new()), None);
    }

    #[test]
    fn empty_legacy_header_counts_as_absent() {
        let map = headers(&[("x-project-id", "")]);
        assert_eq!(legacy_workspace_header(&map), None);
    }

    #[test]
    fn dual_emit_writes_the_workspace_id_as_project_id() {
        let mut row = serde_json::json!({ "workspaceId": "ws-1", "id": "a" });
        dual_emit_legacy_workspace(&mut row, "ws-1");
        assert_eq!(row["projectId"], "ws-1");
        assert_eq!(row["workspaceId"], "ws-1");
    }

    #[test]
    fn dual_emit_on_a_non_object_is_a_no_op() {
        let mut row = serde_json::json!([1, 2]);
        dual_emit_legacy_workspace(&mut row, "ws-1");
        assert!(row.get("projectId").is_none());
    }

    /// Old-format Redis payloads (`project_id`) written by a pre-rename
    /// binary must deserialize on the new one, or every in-flight approval
    /// silently vanishes (auto-deny at timeout) during a rolling deploy.
    #[test]
    fn pending_approval_reads_the_pre_rename_redis_field() {
        let old_format = r#"{
            "id": "ap-1", "organization_id": "org-1", "project_id": "ws-1",
            "agent_id": "ag-1", "agent_name": "agent", "agent_identifier": null,
            "method": "GET", "scheme": "https", "host": "api.example.com",
            "path": "/v", "headers": {}, "body_preview": null,
            "created_at": 1, "expires_at": 2
        }"#;
        let parsed: crate::approval::PendingApproval =
            serde_json::from_str(old_format).expect("old-format payload must deserialize");
        assert_eq!(parsed.workspace_id, "ws-1");

        let new_format = old_format.replace("project_id", "workspace_id");
        let parsed: crate::approval::PendingApproval =
            serde_json::from_str(&new_format).expect("new-format payload must deserialize");
        assert_eq!(parsed.workspace_id, "ws-1");
    }
}
