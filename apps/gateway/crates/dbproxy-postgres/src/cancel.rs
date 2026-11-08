//! Cancel requests, kept inside the gateway.
//!
//! A PostgreSQL client cancels a running query by opening a new connection
//! and sending the process id and secret its session was given. The agent is
//! given a key the gateway made up; the server's real key never leaves the
//! gateway. A cancel request that names a live session's gateway key is
//! forwarded to that session's server with the real key. Anything else is
//! dropped silently, as the server itself would.
//!
//! Keys live on the instance that holds the session. A cancel that lands on
//! another instance behind the load balancer finds nothing and is dropped,
//! which is the protocol's own contract: cancellation is best effort.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use bytes::BytesMut;
use dbproxy::target::DbTarget;
use ring::rand::{SecureRandom, SystemRandom};
use tokio::io::AsyncWriteExt;
use tracing::debug;

use crate::server::CancelKey;

/// The `CancelRequest` code.
pub const CANCEL_REQUEST_CODE: i32 = 80_877_102;

/// The length of the secret the gateway hands out: the protocol 3.0 size,
/// which every client accepts.
const SECRET_BYTES: usize = 4;

/// A gateway-issued key: process id and secret.
type GatewayKey = (i32, Vec<u8>);

/// Every live session's keys on this instance.
#[derive(Clone, Default)]
pub struct CancelKeys {
    sessions: Arc<Mutex<HashMap<GatewayKey, Upstream>>>,
}

/// Where a session's cancel goes.
#[derive(Clone)]
struct Upstream {
    target: DbTarget,
    key: CancelKey,
}

impl CancelKeys {
    /// Register a session's real key; returns the key to give the agent and
    /// a guard that unregisters it when the session ends.
    pub fn register(&self, target: &DbTarget, key: CancelKey) -> Option<Registration> {
        let rng = SystemRandom::new();
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // A collision on 2^63 values is not expected; retry a few times
        // rather than reason about it.
        for _ in 0..4 {
            let mut bytes = [0u8; 4 + SECRET_BYTES];
            rng.fill(&mut bytes).ok()?;
            let process_id =
                i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) & i32::MAX;
            let secret = bytes[4..].to_vec();
            let id = (process_id, secret);
            if sessions.contains_key(&id) {
                continue;
            }
            sessions.insert(
                id.clone(),
                Upstream {
                    target: target.clone(),
                    key: key.clone(),
                },
            );
            return Some(Registration {
                keys: self.clone(),
                process_id: id.0,
                secret: id.1,
            });
        }
        None
    }

    /// Forward a `CancelRequest` body (after its code) to the server holding
    /// the session it names. Never reports back: the client gets no answer
    /// either way.
    pub async fn cancel(&self, body: &[u8]) {
        let Some((process_id, secret)) = body
            .split_first_chunk::<4>()
            .map(|(id, secret)| (i32::from_be_bytes(*id), secret.to_vec()))
        else {
            return;
        };
        let upstream = self
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&(process_id, secret))
            .cloned();
        let Some(upstream) = upstream else {
            debug!("cancel request for no live session; dropped");
            return;
        };
        if let Err(error) = send(&upstream).await {
            debug!(%error, "cancel request could not reach the server");
        }
    }
}

/// A session's registration; unregisters on drop.
pub struct Registration {
    keys: CancelKeys,
    pub process_id: i32,
    pub secret: Vec<u8>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.keys
            .sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&(self.process_id, std::mem::take(&mut self.secret)));
    }
}

/// Send the real key to the server over a fresh guarded connection. A cancel
/// request carries no credentials and a server accepts it in the clear, as
/// libpq sends it.
async fn send(upstream: &Upstream) -> anyhow::Result<()> {
    let mut stream = dbproxy::upstream::dial(&upstream.target).await?;
    let mut packet = BytesMut::new();
    let len = 12 + upstream.key.secret.len();
    packet.extend_from_slice(&i32::try_from(len)?.to_be_bytes());
    packet.extend_from_slice(&CANCEL_REQUEST_CODE.to_be_bytes());
    packet.extend_from_slice(&upstream.key.process_id.to_be_bytes());
    packet.extend_from_slice(&upstream.key.secret);
    stream.write_all(&packet).await?;
    stream.shutdown().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> DbTarget {
        DbTarget::from_credentials(
            r#"{"host":"db.example.com","port":5432,"database":"d","username":"u","password":"p","sslmode":"require"}"#,
        )
        .unwrap()
    }

    #[test]
    fn keys_are_unique_private_and_dropped_with_the_session() {
        let keys = CancelKeys::default();
        let real = CancelKey {
            process_id: 42,
            secret: vec![1, 2, 3, 4],
        };
        let first = keys.register(&target(), real.clone()).unwrap();
        let second = keys.register(&target(), real).unwrap();
        assert!(first.process_id >= 0);
        assert_ne!(
            (first.process_id, &first.secret),
            (second.process_id, &second.secret)
        );
        assert_ne!(first.secret, vec![1, 2, 3, 4], "never the server's own key");
        assert_eq!(keys.sessions.lock().unwrap().len(), 2);
        drop(first);
        assert_eq!(keys.sessions.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn unknown_or_short_requests_are_dropped() {
        let keys = CancelKeys::default();
        keys.cancel(&[0, 0]).await;
        keys.cancel(&[0, 0, 0, 1, 9, 9, 9, 9]).await;
    }
}
