//! One unit of database work, judged the way an HTTP request is.
//!
//! The same steps as the forward path, in the same order: the workspace's
//! app availability, then the first-match policy engine over the published
//! rules, then a human approval when a rule asks for one. Each refusal and
//! each approval step leaves its request-log row, and an allowed unit leaves
//! one once its result is known ([`Admitted::finish`]). The engine adapter
//! only turns the [`Verdict`] into its own wire protocol.

use std::sync::Arc;
use std::time::Instant;

use approval::hold::{self, HoldLog, HoldOutcome, Rejection};
use approval::{ApprovalStore, PendingApproval, APPROVAL_TIMEOUT_SECS};
use cache::CacheStore;
use policy::{MatchedRule, PolicyDecision};
use proxy::connect::ConnectResponse;
use telemetry::core::{RequestDecision, RequestMeta};
use tracing::{info, warn};

use crate::login::Login;
use crate::statement::{Classified, StatementClass};
use crate::Engine;

/// The longest statement text an approval card carries; the rest is cut.
const APPROVAL_STATEMENT_LEN: usize = 2000;

/// One unit as the gate judges it.
pub struct Unit<'a> {
    pub classified: Classified,
    /// The unit's statements with every literal replaced by a placeholder:
    /// what the request log records and an approver reads. Never a value the
    /// agent sent, so a password in an `INSERT` never reaches either.
    pub normalized: &'a str,
}

/// What the gate decided.
pub enum Verdict {
    /// Run it. Call [`Admitted::finish`] once the server has answered, so the
    /// unit's row records the outcome.
    Run(Box<Admitted>),
    /// Do not run it; tell the agent why.
    Refuse(Refusal),
}

/// Why a unit was refused, in terms an adapter can put on its wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub kind: RefusalKind,
    /// The whole explanation for the agent: what was refused, why, and what
    /// to do about it.
    pub message: String,
}

/// The broad reason, for an adapter that maps refusals to error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalKind {
    /// The policy (a rule, the default, availability, or the classifier).
    Denied,
    /// A rate-limit rule is exhausted.
    RateLimited,
    /// A reviewer declined, nobody decided in time, or it was withdrawn.
    NotApproved,
    /// The approval machinery is unavailable or the gateway is restarting;
    /// the unit may be retried.
    Unavailable,
    /// The engine's parser rejected the text; the message is its error.
    Invalid,
}

/// A unit the gate let through, carrying what its request-log row needs.
pub struct Admitted {
    meta: Option<RequestMeta>,
    matched_rule: Option<MatchedRule>,
    approval: Option<ApprovedHold>,
    start: Instant,
}

struct ApprovedHold {
    log_id: String,
    approval_id: String,
    triggered_at: String,
    approved_by: Option<String>,
}

impl Admitted {
    /// Record the unit's row: `succeeded` is whether the server ran it
    /// without an error. Housekeeping units are never recorded.
    pub fn finish(self, succeeded: bool) {
        let Some(mut meta) = self.meta else {
            return;
        };
        meta.status = if succeeded { 200 } else { 500 };
        meta.latency_ms = elapsed_ms(self.start);
        meta.matched_rule = self.matched_rule;
        let mut existing_log_id = None;
        if let Some(held) = self.approval {
            meta.decision = Some(RequestDecision::ApprovalApproved {
                approval_id: held.approval_id,
                triggered_at: held.triggered_at,
                resolved_at: proxy::hooks::iso_now(),
                approved_by: held.approved_by,
            });
            existing_log_id = Some(held.log_id);
        }
        meta.existing_log_id = existing_log_id;
        telemetry::on_request(meta.into_event(None));
    }
}

/// Everything the gate needs about the session.
pub struct Gate<'a> {
    pub engine: &'a Engine,
    pub login: &'a Login,
    /// The session's current resolution: the login's, replaced by each
    /// refresh as the connect cache turns over.
    pub resolved: ConnectResponse,
    pub cache: &'a dyn CacheStore,
    pub approvals: &'a Arc<dyn ApprovalStore>,
    pub pool: &'a sqlx::PgPool,
}

impl Gate<'_> {
    /// Judge one unit. Waits for a human when a rule requires approval.
    pub async fn judge(&self, unit: &Unit<'_>) -> Verdict {
        let start = Instant::now();
        let class = match &unit.classified {
            Classified::Housekeeping => {
                return Verdict::Run(Box::new(Admitted {
                    meta: None,
                    matched_rule: None,
                    approval: None,
                    start,
                }));
            }
            Classified::Unparseable(message) => {
                // Not a policy decision: the server would have rejected the
                // text the same way, so nothing is recorded.
                return refuse(RefusalKind::Invalid, message.clone());
            }
            Classified::Forbidden(reason) => {
                self.record(
                    RequestDecision::Blocked {
                        rule_name: format!("{} safety: {reason}", self.engine.display_name),
                    },
                    None,
                    unit,
                    StatementClass::Write,
                    start,
                );
                return refuse(
                    RefusalKind::Denied,
                    format!(
                        "OneCLI blocked this statement: {reason}. Nothing was run on the database."
                    ),
                );
            }
            Classified::Judged(class) => *class,
        };
        let (method, path) = class.policy_request();
        let host = self.login.policy_host.as_str();
        let ctx = &self.login.proxy_ctx;

        // A restricted workspace reaches only the apps it was granted, on
        // every lane.
        if let Some(provider) =
            ee::principals::app_availability_block(host, path, &self.resolved.available_apps)
        {
            self.record(
                RequestDecision::Blocked {
                    rule_name: format!("App unavailable: {provider}"),
                },
                None,
                unit,
                class,
                start,
            );
            return refuse(
                RefusalKind::Denied,
                format!(
                    "{} is not available to this workspace; an organization admin can make it available in the OneCLI dashboard.",
                    self.engine.display_name
                ),
            );
        }

        let (decision, matched_rule) = policy_engine::evaluate(
            ctx,
            host,
            method,
            path,
            policy::ConditionBody::None,
            // The connection's credential is what this session logs in with:
            // credentialed traffic, so a Default Rule's deny applies to it.
            true,
            false,
            Some(&self.login.connection_id),
            self.cache,
            &self.resolved.policy_rules_v2,
        )
        .await;

        let what = class.label();
        match decision {
            PolicyDecision::Allow => Verdict::Run(self.admitted(unit, matched_rule, None, start)),
            PolicyDecision::BlockedByDefaultPolicy => {
                self.record(
                    RequestDecision::BlockedByDefaultPolicy,
                    matched_rule,
                    unit,
                    class,
                    start,
                );
                refuse(
                    RefusalKind::Denied,
                    format!(
                        "OneCLI blocked this {what} statement: this agent has no rule allowing it on this connection. \
                         Ask the user to grant {what} access for this agent in the OneCLI dashboard.{}",
                        rules_hint(ctx)
                    ),
                )
            }
            PolicyDecision::Blocked { rule_name } => {
                self.record(
                    RequestDecision::Blocked {
                        rule_name: rule_name.clone(),
                    },
                    matched_rule,
                    unit,
                    class,
                    start,
                );
                refuse(
                    RefusalKind::Denied,
                    format!(
                        "OneCLI blocked this {what} statement (rule \"{rule_name}\"). Nothing was run on the database.{}",
                        rules_hint(ctx)
                    ),
                )
            }
            PolicyDecision::RateLimited {
                rule_name,
                limit,
                window,
                retry_after_secs,
            } => {
                self.record(
                    RequestDecision::RateLimited {
                        rule_name: rule_name.clone(),
                    },
                    matched_rule,
                    unit,
                    class,
                    start,
                );
                refuse(
                    RefusalKind::RateLimited,
                    format!(
                        "OneCLI rate limit reached (rule \"{rule_name}\": {limit} per {window}); retry in {retry_after_secs}s."
                    ),
                )
            }
            PolicyDecision::ManualApproval { rule_id } => {
                info!(rule_id = %rule_id, class = what, "database statement held for approval");
                self.hold_for_approval(unit, class, matched_rule, start)
                    .await
            }
        }
    }

    async fn hold_for_approval(
        &self,
        unit: &Unit<'_>,
        class: StatementClass,
        matched_rule: Option<MatchedRule>,
        start: Instant,
    ) -> Verdict {
        let ctx = &self.login.proxy_ctx;
        let (Some(workspace_id), Some(org_id)) =
            (ctx.workspace_id.as_deref(), ctx.organization_id.as_deref())
        else {
            return refuse(RefusalKind::Unavailable, approval_unavailable());
        };
        let (method, path) = class.policy_request();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let approval_id = uuid::Uuid::new_v4().to_string();
        let card = self.approval_summary(unit, class);
        let approval = PendingApproval {
            id: approval_id.clone(),
            organization_id: org_id.to_string(),
            workspace_id: workspace_id.to_string(),
            agent_id: ctx.agent_id.clone().unwrap_or_default(),
            agent_name: ctx.agent_name.clone().unwrap_or_default(),
            agent_identifier: ctx.agent_identifier.clone(),
            method: method.to_string(),
            scheme: self.engine.scheme.to_string(),
            host: self.login.policy_host.clone(),
            path: path.to_string(),
            headers: Default::default(),
            body_preview: Some(card.render_text()),
            summary: Some(card),
            raw_body: None,
            app: Some(self.engine.provider.to_string()),
            batch: None,
            created_at: now,
            expires_at: now + APPROVAL_TIMEOUT_SECS,
        };

        let triggered_at = proxy::hooks::iso_now();
        let log_id = uuid::Uuid::new_v4().to_string();
        let held = hold::hold(
            self.approvals,
            &approval,
            Some(HoldLog {
                log_id: log_id.clone(),
                pool: self.pool.clone(),
            }),
            || {
                if let Some(mut meta) = self.meta(unit, class, 202, 0) {
                    meta.decision = Some(RequestDecision::ApprovalPending {
                        approval_id: approval_id.clone(),
                        triggered_at: triggered_at.clone(),
                        generic_card: false,
                    });
                    meta.matched_rule = matched_rule.clone();
                    let mut event = meta.into_event(None);
                    event.log_id = Some(log_id.clone());
                    telemetry::on_request(event);
                }
            },
        )
        .await;

        let denied = |status: u16, reason: &str, approved_by: Option<String>| {
            if let Some(mut meta) = self.meta(unit, class, status, elapsed_ms(start)) {
                meta.decision = Some(RequestDecision::ApprovalDenied {
                    approval_id: approval_id.clone(),
                    reason: reason.to_string(),
                    triggered_at: triggered_at.clone(),
                    resolved_at: proxy::hooks::iso_now(),
                    approved_by,
                });
                meta.existing_log_id = Some(log_id.clone());
                meta.matched_rule = matched_rule.clone();
                telemetry::on_request(meta.into_event(None));
            }
        };

        match held {
            HoldOutcome::Approved { approved_by } => {
                info!(approval_id = %approval_id, "database statement approved");
                Verdict::Run(self.admitted(
                    unit,
                    matched_rule.clone(),
                    Some(ApprovedHold {
                        log_id,
                        approval_id,
                        triggered_at,
                        approved_by,
                    }),
                    start,
                ))
            }
            HoldOutcome::Rejected {
                rejection,
                decided_by,
            } => {
                denied(403, rejection.telemetry_reason(), decided_by);
                refuse(RefusalKind::NotApproved, rejection_message(rejection))
            }
            HoldOutcome::StoreUnavailable => {
                refuse(RefusalKind::Unavailable, approval_unavailable())
            }
            HoldOutcome::WaitFailed(error) => {
                warn!(approval_id = %approval_id, %error, "approval wait failed; statement not run");
                denied(502, "approval_store_unavailable", None);
                refuse(RefusalKind::Unavailable, approval_unavailable())
            }
            HoldOutcome::ShuttingDown => {
                denied(503, "gateway_restarting", None);
                refuse(
                    RefusalKind::Unavailable,
                    "The OneCLI gateway is restarting; nothing was run. Reconnect and send the statement again."
                        .to_string(),
                )
            }
        }
    }

    /// The card an approver reads: what kind of change, on which connection,
    /// and the statement itself with its literals hidden.
    fn approval_summary(&self, unit: &Unit<'_>, class: StatementClass) -> summary::ApprovalSummary {
        let action = match class {
            StatementClass::Read => "Read data",
            StatementClass::Write => "Change data",
            StatementClass::Schema => "Change the schema",
        };
        let mut card =
            summary::ApprovalSummary::new(format!("{action} in {}", self.engine.display_name));
        let connection = self
            .login
            .connection_label
            .clone()
            .unwrap_or_else(|| self.login.connection_id.clone());
        card.push("Connection", connection);
        card.push(
            "Database",
            format!(
                "{} on {}",
                self.login.target.database, self.login.target.host
            ),
        );
        card.push_clamped("Statement", unit.normalized, APPROVAL_STATEMENT_LEN);
        card
    }

    fn admitted(
        &self,
        unit: &Unit<'_>,
        matched_rule: Option<MatchedRule>,
        approval: Option<ApprovedHold>,
        start: Instant,
    ) -> Box<Admitted> {
        let class = match unit.classified {
            Classified::Judged(class) => class,
            Classified::Housekeeping | Classified::Forbidden(_) | Classified::Unparseable(_) => {
                StatementClass::Write
            }
        };
        Box::new(Admitted {
            meta: self.meta(unit, class, 200, 0),
            matched_rule,
            approval,
            start,
        })
    }

    /// The unit's request-log row before its decision is set: the shared
    /// builder every lane uses, attributed to this connection, with the
    /// normalized statement and the injection the login stands for.
    fn meta(
        &self,
        unit: &Unit<'_>,
        class: StatementClass,
        status: u16,
        latency_ms: u32,
    ) -> Option<RequestMeta> {
        let (method, path) = class.policy_request();
        let mut meta = proxy::hooks::request_meta(
            &self.login.proxy_ctx,
            &self.login.policy_host,
            method,
            path,
            status,
            latency_ms,
        )?;
        meta.provider = self.engine.provider.to_string();
        meta.injected = true;
        meta.injection_count = 1;
        meta.connection_label = self.login.connection_label.clone();
        meta.statement = Some(unit.normalized.to_string());
        Some(meta)
    }

    fn record(
        &self,
        decision: RequestDecision,
        matched_rule: Option<MatchedRule>,
        unit: &Unit<'_>,
        class: StatementClass,
        start: Instant,
    ) {
        if let Some(mut meta) = self.meta(unit, class, 403, elapsed_ms(start)) {
            meta.decision = Some(decision);
            meta.matched_rule = matched_rule;
            telemetry::on_request(meta.into_event(None));
        }
    }
}

fn refuse(kind: RefusalKind, message: String) -> Verdict {
    Verdict::Refuse(Refusal { kind, message })
}

fn elapsed_ms(start: Instant) -> u32 {
    u32::try_from(start.elapsed().as_millis()).unwrap_or(u32::MAX)
}

/// Where the agent's rules are managed, appended to a policy refusal.
fn rules_hint(ctx: &context::ProxyContext) -> String {
    let url = context::scoped_url(
        context::dashboard_url(),
        "/rules",
        ctx.workspace_id.as_deref(),
    );
    format!(" Rules: {url}")
}

fn approval_unavailable() -> String {
    "This statement needs approval, but OneCLI could not hold it for review right now; nothing was run. Retry shortly."
        .to_string()
}

fn rejection_message(rejection: Rejection) -> String {
    match rejection {
        Rejection::Declined => {
            "The reviewer declined this statement; it was not run. Do not retry it without asking the user."
        }
        Rejection::Expired => {
            "Nobody approved this statement in time; it was not run. Ask the user before retrying."
        }
        Rejection::Superseded => {
            "The user sent a new message that changes this request, so the statement was withdrawn before anyone \
             approved it; it was not run. Read the user's latest message and send a revised statement."
        }
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejections_say_nothing_ran_and_what_to_do() {
        for rejection in [
            Rejection::Declined,
            Rejection::Expired,
            Rejection::Superseded,
        ] {
            let message = rejection_message(rejection);
            assert!(message.contains("not run"), "{rejection:?}: {message}");
        }
    }
}
