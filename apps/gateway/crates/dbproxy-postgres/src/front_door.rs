//! The PostgreSQL front door: one accepted TCP connection, from its first
//! byte to the end of its session.
//!
//! 1. [`client::accept`] brings the agent's connection into TLS and reads its
//!    startup packet (or handles a cancel request).
//! 2. The agent's token and the connection id it named are authorized
//!    ([`dbproxy::login::authorize`]); the database it asked for must be the
//!    connection's own.
//! 3. The gateway logs in to the real server ([`server::connect`]) with the
//!    stored credentials, then completes the agent's login with the server's
//!    parameters and a cancel key of its own.
//! 4. [`session::Session`] judges and relays every unit until either side
//!    closes.
//!
//! Every failure before the session is answered with an `ErrorResponse` the
//! agent's client shows, so a misconfigured agent learns what to fix.

use std::sync::Arc;

use approval::ApprovalStore;
use cache::CacheStore;
use context::PolicyEngine;
use dbproxy::gate::Gate;
use dbproxy::limits::{SessionSlots, LOGIN_TIMEOUT};
use dbproxy::login::{self, LoginError};
use dbproxy::parse_pool::ParsePool;
use dbproxy::Engine;
use tokio::net::TcpStream;
use tracing::{debug, info, warn};

use crate::cancel::CancelKeys;
use crate::client::{self, ClientStream, Opening, StartError, Started};
use crate::server::{self, ServerSession};
use crate::session::Session;
use crate::wire::{self, Frame, FrameReader};

/// PostgreSQL as the front door serves it.
pub const ENGINE: Engine = Engine {
    provider: apps::POSTGRES_PROVIDER,
    zone: apps::POSTGRES_POLICY_ZONE,
    display_name: "PostgreSQL",
    scheme: "postgresql",
};

/// What every session on this instance shares.
#[derive(Clone)]
pub struct FrontDoor {
    pub ca: Arc<ca::CertificateAuthority>,
    pub policy_engine: Arc<PolicyEngine>,
    pub cache: Arc<dyn CacheStore>,
    pub approvals: Arc<dyn ApprovalStore>,
    pub parse_pool: ParsePool,
    pub slots: SessionSlots,
    pub cancels: CancelKeys,
}

impl FrontDoor {
    /// Serve one connection whose first byte said it speaks PostgreSQL.
    pub async fn serve(&self, tcp: TcpStream) {
        let _ = tcp.set_nodelay(true);
        dbproxy::limits::enable_keepalive(&tcp);
        let opened =
            tokio::time::timeout(LOGIN_TIMEOUT, client::accept(tcp, &self.ca, &self.cancels)).await;
        let started = match opened {
            Ok(Ok(Opening::Session(started))) => started,
            Ok(Ok(Opening::Cancelled)) => return,
            Ok(Err(StartError::Plaintext)) => {
                debug!("database client refused: no TLS");
                return;
            }
            Ok(Err(StartError::Malformed(detail))) => {
                debug!(%detail, "database client refused at startup");
                return;
            }
            Err(_) => {
                debug!("database client took too long to start");
                return;
            }
        };
        if let Err(error) = self.session(*started).await {
            debug!(%error, "database session ended with an error");
        }
    }

    async fn session(&self, started: Started) -> anyhow::Result<()> {
        let Started {
            mut conn,
            connection_id,
            database,
            parameters,
            refused_parameter,
            unrecognized_options,
            wants_newer_minor,
        } = started;
        let login = tokio::time::timeout(LOGIN_TIMEOUT, async {
            let token = client::read_token(&mut conn).await?;
            let login = login::authorize(
                &ENGINE,
                &token,
                &connection_id,
                &self.policy_engine,
                self.cache.as_ref(),
            )
            .await;
            anyhow::Ok(login)
        })
        .await;
        let login = match login {
            Ok(Ok(Ok(login))) => login,
            Ok(Ok(Err(error))) => {
                let sqlstate = match error {
                    LoginError::InvalidToken => "28P01",
                    LoginError::NotGranted { .. } => "28000",
                    LoginError::BadTarget(_) | LoginError::Unavailable => "08004",
                };
                return refuse(&mut conn, sqlstate, &error.to_string()).await;
            }
            Ok(Err(error)) => return Err(error),
            Err(_) => return refuse(&mut conn, "08004", "the login took too long").await,
        };
        if !database.is_empty() && database != login.target.database && database != connection_id {
            let message = format!(
                "this connection reaches the database \"{}\", not \"{database}\"; connect to it, or connect another database in the OneCLI dashboard",
                login.target.database
            );
            return refuse(&mut conn, "3D000", &message).await;
        }
        if let Some(why) = refused_parameter {
            let message = format!("OneCLI refused a startup parameter: {why}");
            return refuse(&mut conn, "42501", &message).await;
        }
        let agent_id = login.proxy_ctx.agent_id.clone().unwrap_or_default();
        let _slot = match self.slots.claim(&agent_id) {
            Ok(slot) => slot,
            Err(full) => return refuse(&mut conn, "53300", &full.to_string()).await,
        };

        let application_name = format!(
            "onecli:{}",
            login
                .proxy_ctx
                .agent_identifier
                .as_deref()
                .or(login.proxy_ctx.agent_name.as_deref())
                .unwrap_or(&agent_id)
        );
        let mut upstream_parameters: Vec<(&str, &str)> = parameters
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        // Pinned so the gateway splits SQL text exactly as the server does.
        upstream_parameters.push(("client_encoding", "UTF8"));
        upstream_parameters.push(("standard_conforming_strings", "on"));
        upstream_parameters.push(("application_name", &application_name));
        let connected = tokio::time::timeout(
            LOGIN_TIMEOUT,
            server::connect(&login.target, &upstream_parameters),
        )
        .await;
        let ServerSession {
            conn: mut upstream,
            parameters: server_parameters,
            cancel_key,
        } = match connected {
            Ok(Ok(session)) => session,
            Ok(Err(error)) => return refuse(&mut conn, "08001", &error.to_string()).await,
            Err(_) => {
                return refuse(
                    &mut conn,
                    "08001",
                    "the database server did not answer in time",
                )
                .await
            }
        };
        let powers = server::role_powers(&mut upstream).await?;
        // The dashboard's warning reads this; a failed write only delays it.
        // CONNECT resolution can be cached: never stamp newer credentials (or
        // a moved row) with the role observed through the older snapshot.
        if let (Some(workspace_id), Some(organization_id), Some(expected)) = (
            login.proxy_ctx.workspace_id.as_deref(),
            login.proxy_ctx.organization_id.as_deref(),
            login
                .resolved
                .app_connections
                .iter()
                .find(|row| row.id == login.connection_id),
        ) {
            if let Err(error) = db::record_app_connection_superuser(
                &self.policy_engine.pool,
                expected,
                workspace_id,
                organization_id,
                powers.superuser,
            )
            .await
            {
                warn!(connection_id = %login.connection_id, %error, "could not record the role's superuser flag");
            }
        }
        let Some(registration) = self.cancels.register(&login.target, cancel_key) else {
            return refuse(
                &mut conn,
                "08004",
                "the gateway could not start the session",
            )
            .await;
        };

        let mut greeting: Vec<Frame> = Vec::new();
        if wants_newer_minor || !unrecognized_options.is_empty() {
            greeting.push(wire::negotiate_protocol_version(&unrecognized_options));
        }
        greeting.push(wire::auth_ok());
        greeting.extend(server_parameters);
        if powers.superuser {
            greeting.push(wire::notice_response(
                "01000",
                "this OneCLI connection logs in as a database superuser (or a role with access to the server's files or programs), which can reach past the statement checks OneCLI applies",
                Some("connect it with a role that has only the privileges the agent needs"),
            ));
        }
        greeting.push(wire::backend_key_data(
            registration.process_id,
            &registration.secret,
        ));
        greeting.push(wire::ready_for_query(wire::TxStatus::Idle));
        wire::write_frames(conn.stream(), &greeting).await?;
        info!(
            connection_id = %login.connection_id,
            agent_id = %agent_id,
            superuser = powers.superuser,
            "database session started"
        );

        let result = Session {
            gate: Gate {
                engine: &ENGINE,
                login: &login,
                resolved: login.resolved.clone(),
                cache: self.cache.as_ref(),
                approvals: &self.approvals,
                pool: &self.policy_engine.pool,
            },
            policy_engine: &self.policy_engine,
            parse_pool: &self.parse_pool,
            client: conn,
            server: upstream,
        }
        .run()
        .await;
        drop(registration);
        if let Err(error) = &result {
            warn!(connection_id = %login.connection_id, %error, "database session failed");
        }
        result
    }
}

/// Answer a login failure in a form the client shows, then end.
async fn refuse(
    conn: &mut FrameReader<ClientStream>,
    sqlstate: &str,
    message: &str,
) -> anyhow::Result<()> {
    let frame = wire::error_response("FATAL", sqlstate, message, None);
    wire::write_frames(conn.stream(), [&frame]).await?;
    Ok(())
}
