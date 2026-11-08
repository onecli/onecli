//! A database login: the agent's OneCLI token and a connection id, turned
//! into an authorized session bound to that connection's stored target.
//!
//! The agent never holds the database password. It names the connection it
//! wants (the id shown in its connections list) and proves who it is with
//! its token; the gateway resolves the token to an agent exactly as the HTTP
//! lanes do, checks that the agent's grants select that connection, and only
//! then decrypts the stored credentials it will log in with.

use std::fmt;

use cache::CacheStore;
use context::{PolicyEngine, ProxyContext};
use proxy::connect::{self, ConnectError, ConnectResponse};
use tracing::warn;

use crate::statement::policy_host;
use crate::target::{DbTarget, TargetError};
use crate::Engine;

/// An agent authorized to use one stored connection.
pub struct Login {
    /// Who is connected, as every policy and telemetry call needs it.
    pub proxy_ctx: ProxyContext,
    /// The connection the agent named; statements are judged as its traffic.
    pub connection_id: String,
    /// Its label in the dashboard, for logs and approval cards.
    pub connection_label: Option<String>,
    /// The synthetic host every statement of this session is judged under.
    pub policy_host: String,
    /// The resolution this login was authorized by: the published policy
    /// rules and the workspace's available apps travel with it, so the
    /// per-statement decision never touches the database. A session
    /// re-reads it per unit ([`refresh`]).
    pub resolved: ConnectResponse,
    /// Where and how to log in upstream.
    pub target: DbTarget,
}

impl fmt::Debug for Login {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Login")
            .field("agent_id", &self.proxy_ctx.agent_id)
            .field("connection_id", &self.connection_id)
            .field("target", &self.target)
            .finish_non_exhaustive()
    }
}

/// Why a login was refused. Every variant is shown to the agent, and none
/// says more than the agent may know: a connection id it cannot use reads
/// the same whether it exists in another workspace or not at all.
#[derive(Debug)]
pub enum LoginError {
    /// The token resolves to no agent.
    InvalidToken,
    /// The agent's grants select no connection with this id (or it was
    /// disconnected, or it belongs to another engine).
    NotGranted { connection_id: String },
    /// The connection is selected but unusable as stored.
    BadTarget(TargetError),
    /// The gateway could not resolve the login (database or decryption).
    Unavailable,
}

impl fmt::Display for LoginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidToken => f.write_str(
                "the OneCLI agent token was not accepted; use the token from your OneCLI agent settings as the password",
            ),
            Self::NotGranted { connection_id } => write!(
                f,
                "this agent has no access to a database connection with id \"{connection_id}\"; \
                 connect it in the OneCLI dashboard and switch it on for this agent, then use its connection id as the user name",
            ),
            Self::BadTarget(error) => error.fmt(f),
            Self::Unavailable => {
                f.write_str("the OneCLI gateway could not check this login right now; retry shortly")
            }
        }
    }
}

impl std::error::Error for LoginError {}

/// Authorize `agent_token` for the connection `connection_id` of `engine`.
pub async fn authorize(
    engine: &Engine,
    agent_token: &str,
    connection_id: &str,
    policy_engine: &PolicyEngine,
    cache: &dyn CacheStore,
) -> Result<Login, LoginError> {
    let host = policy_host(connection_id, engine.zone);
    let resolved = connect::resolve(agent_token, &host, policy_engine, cache)
        .await
        .map_err(|error| match error {
            ConnectError::InvalidToken => LoginError::InvalidToken,
            ConnectError::Internal(detail) => {
                warn!(error = %detail, "database login: resolution failed");
                LoginError::Unavailable
            }
        })?;

    // The resolution lists the connections of the zone's provider that the
    // agent's grants select, credentials still encrypted. The id must be one
    // of them; anything else is refused without saying why.
    let not_granted = || LoginError::NotGranted {
        connection_id: connection_id.to_string(),
    };
    let row = resolved
        .app_connections
        .iter()
        .find(|row| row.id == connection_id && row.provider == engine.provider)
        .ok_or_else(not_granted)?;
    let encrypted = row.credentials.as_deref().ok_or_else(not_granted)?;
    let decrypted = policy_engine
        .crypto
        .decrypt(encrypted)
        .await
        .map_err(|error| {
            warn!(connection_id, error = %error, "database login: credential decryption failed");
            LoginError::Unavailable
        })?;
    let target = DbTarget::from_credentials(&decrypted).map_err(LoginError::BadTarget)?;

    let proxy_ctx = ProxyContext {
        workspace_id: resolved.workspace_id.clone(),
        organization_id: resolved.organization_id.clone(),
        agent_id: resolved.agent_id.clone(),
        agent_name: resolved.agent_name.clone(),
        agent_identifier: resolved.agent_identifier.clone(),
        agent_token: agent_token.to_string(),
    };
    Ok(Login {
        proxy_ctx,
        connection_id: connection_id.to_string(),
        connection_label: row.label.clone(),
        policy_host: host,
        target,
        resolved,
    })
}

/// Re-resolve a live session's grants through the connect cache (one cache
/// read per unit while it is warm), so a connection switched off for the
/// agent, a changed rule, or a deleted agent reaches sessions already open.
/// Returns the fresh resolution, or why the session must end.
pub async fn refresh(
    login: &Login,
    engine: &Engine,
    policy_engine: &PolicyEngine,
    cache: &dyn CacheStore,
) -> Result<ConnectResponse, LoginError> {
    let (Some(org), Some(workspace)) = (
        login.proxy_ctx.organization_id.as_deref(),
        login.proxy_ctx.workspace_id.as_deref(),
    ) else {
        return Err(LoginError::InvalidToken);
    };
    let resolved = connect::resolve_from_cache(
        org,
        workspace,
        &login.proxy_ctx.agent_token,
        &login.policy_host,
        policy_engine,
        cache,
    )
    .await
    .map_err(|error| match error {
        ConnectError::InvalidToken => LoginError::InvalidToken,
        ConnectError::Internal(detail) => {
            warn!(error = %detail, "database session: re-resolution failed");
            LoginError::Unavailable
        }
    })?;
    let still_granted = resolved
        .app_connections
        .iter()
        .any(|row| row.id == login.connection_id && row.provider == engine.provider);
    if still_granted {
        Ok(resolved)
    } else {
        Err(LoginError::NotGranted {
            connection_id: login.connection_id.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusals_never_echo_a_stored_value_and_name_the_fix() {
        let not_granted = LoginError::NotGranted {
            connection_id: "c1".into(),
        }
        .to_string();
        assert!(not_granted.contains("\"c1\""));
        assert!(not_granted.contains("switch it on for this agent"));
        assert!(LoginError::InvalidToken.to_string().contains("token"));
        assert!(LoginError::BadTarget(TargetError::InvalidHost)
            .to_string()
            .contains("reconnect"));
    }
}
