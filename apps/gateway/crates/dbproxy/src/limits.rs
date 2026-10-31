//! The bounds every database session runs under, whatever the engine.
//!
//! Each one caps something a single agent could otherwise use to exhaust a
//! gateway instance that many tenants share: open sessions, memory per
//! message, parser time and stack per statement, and sessions left idle.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Sessions one agent may hold open on one gateway instance. Generous for a
/// connection pool, small enough that one runaway agent cannot hold every
/// upstream connection the instance can make.
pub const MAX_SESSIONS_PER_AGENT: usize = 20;

/// A session with nothing in flight and no client message for this long is
/// closed, so an abandoned client does not pin a database connection.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The largest single protocol message either side may send through the
/// gateway. Messages are buffered whole before they are judged or relayed.
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// The most one unit of work may buffer before it is judged (a pipeline of
/// messages up to its `Sync`). Twice the largest message, so one maximal
/// parameter still fits beside its statement.
pub const MAX_UNIT_BYTES: usize = 2 * MAX_MESSAGE_BYTES;

/// The largest statement text the classifier parses. Parse time and parser
/// stack both grow with the text, so a longer message is refused unparsed
/// (the engine adapter tells the agent to send smaller batches or use its
/// bulk-load path); nothing unparsed ever runs.
pub const MAX_PARSED_STATEMENT_BYTES: usize = 1024 * 1024;

/// Bound on the whole login: the client's TLS handshake, its startup and
/// password messages, and the upstream connection and authentication.
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(30);

/// TCP keepalive on both legs of a session: a quiet session sends an empty
/// probe after [`KEEPALIVE_IDLE`], then every [`KEEPALIVE_INTERVAL`], and a
/// peer that answers none of [`KEEPALIVE_RETRIES`] is gone. The probes are
/// sent by the kernel, carry no data, and only flow on idle sockets.
///
/// The idle time sits well under common/default 350-second network idle
/// windows. Actual limits vary by infrastructure and configuration. Probes
/// keep a session's otherwise quiet flow active while it waits on the agent
/// or a long server query. [`IDLE_TIMEOUT`] still closes abandoned client
/// sessions with a reason; a vanished peer frees its session slot within
/// minutes instead of waiting for that session idle limit.
pub const KEEPALIVE_IDLE: Duration = Duration::from_secs(60);
/// See [`KEEPALIVE_IDLE`].
pub const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
/// See [`KEEPALIVE_IDLE`].
pub const KEEPALIVE_RETRIES: u32 = 4;

/// Turn on [`KEEPALIVE_IDLE`]'s keepalive for one leg of a session. Best
/// effort: a socket that refuses the option still works, it is only
/// exposed to idle drops, so the failure is logged and not fatal.
pub fn enable_keepalive(stream: &tokio::net::TcpStream) {
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(KEEPALIVE_IDLE)
        .with_interval(KEEPALIVE_INTERVAL)
        .with_retries(KEEPALIVE_RETRIES);
    if let Err(error) = socket2::SockRef::from(stream).set_tcp_keepalive(&keepalive) {
        tracing::debug!(%error, "could not enable TCP keepalive on a database session");
    }
}

/// Why a session slot was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TooManySessions {
    pub limit: usize,
}

impl std::fmt::Display for TooManySessions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "this agent already has {} database sessions open through this OneCLI gateway; close some and retry",
            self.limit
        )
    }
}

impl std::error::Error for TooManySessions {}

/// Open sessions per agent on this instance.
#[derive(Debug, Default, Clone)]
pub struct SessionSlots {
    open: Arc<Mutex<HashMap<String, usize>>>,
}

impl SessionSlots {
    /// Claim a slot for `agent_id`, released when the returned guard drops.
    pub fn claim(&self, agent_id: &str) -> Result<SessionSlot, TooManySessions> {
        self.claim_with_limit(agent_id, MAX_SESSIONS_PER_AGENT)
    }

    fn claim_with_limit(
        &self,
        agent_id: &str,
        limit: usize,
    ) -> Result<SessionSlot, TooManySessions> {
        let mut open = self
            .open
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let count = open.entry(agent_id.to_string()).or_default();
        if *count >= limit {
            return Err(TooManySessions { limit });
        }
        *count += 1;
        Ok(SessionSlot {
            slots: self.clone(),
            agent_id: agent_id.to_string(),
        })
    }

    fn release(&self, agent_id: &str) {
        let mut open = self
            .open
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(count) = open.get_mut(agent_id) {
            *count -= 1;
            if *count == 0 {
                open.remove(agent_id);
            }
        }
    }

    #[cfg(test)]
    fn open_for(&self, agent_id: &str) -> usize {
        self.open
            .lock()
            .unwrap()
            .get(agent_id)
            .copied()
            .unwrap_or(0)
    }
}

/// One claimed session slot; dropping it frees the slot.
#[derive(Debug)]
pub struct SessionSlot {
    slots: SessionSlots,
    agent_id: String,
}

impl Drop for SessionSlot {
    fn drop(&mut self) {
        self.slots.release(&self.agent_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_cap_each_agent_and_free_on_drop() {
        let slots = SessionSlots::default();
        let a1 = slots.claim_with_limit("a", 2).unwrap();
        let _a2 = slots.claim_with_limit("a", 2).unwrap();
        assert_eq!(
            slots.claim_with_limit("a", 2).unwrap_err(),
            TooManySessions { limit: 2 }
        );
        // Another agent has its own budget.
        let _b = slots.claim_with_limit("b", 2).unwrap();
        drop(a1);
        assert!(slots.claim_with_limit("a", 2).is_ok());
    }

    #[test]
    fn an_agent_with_no_sessions_leaves_no_entry() {
        let slots = SessionSlots::default();
        drop(slots.claim("a").unwrap());
        assert_eq!(slots.open_for("a"), 0);
        assert!(slots.open.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn keepalive_is_set_with_the_session_timings() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stream = tokio::net::TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        enable_keepalive(&stream);
        let socket = socket2::SockRef::from(&stream);
        assert!(socket.keepalive().unwrap());
        assert_eq!(socket.tcp_keepalive_time().unwrap(), KEEPALIVE_IDLE);
        assert_eq!(socket.tcp_keepalive_interval().unwrap(), KEEPALIVE_INTERVAL);
        assert_eq!(socket.tcp_keepalive_retries().unwrap(), KEEPALIVE_RETRIES);
        // Probes finish well inside a common/default 350 s network idle window.
        assert!(KEEPALIVE_IDLE < Duration::from_secs(350));
    }
}
