//! The entrypoint abstraction: how `main` runs N listeners over one shared
//! context.
//!
//! The gateway serves several front doors — today the combined HTTP proxy +
//! control-plane listener ([`crate::GatewayServer`]), later a Postgres
//! interceptor and whatever else — and they all share the same resolved
//! context (database pool, crypto, stores, policy engine). An [`Entrypoint`]
//! is one such front door: it binds, serves until shutdown fires, and
//! releases its port. `main` builds the context once, constructs the
//! configured entrypoints, and [`run_all`] drives them.
//!
//! Contract:
//! - `run` owns the whole listener lifecycle: bind, accept loop, and closing
//!   the port on the shutdown signal. Connection draining stays with the
//!   shutdown module's task guards — an entrypoint returning only means no
//!   NEW work is accepted.
//! - A fatal entrypoint error (a failed bind, most commonly) fails the whole
//!   process — a gateway that silently lost one of its front doors would be
//!   worse than one that restarts.

use anyhow::Result;

/// One front door of the gateway. See the module docs for the contract.
#[async_trait::async_trait]
pub trait Entrypoint: Send {
    /// This entrypoint's name, for startup and error logs.
    fn name(&self) -> &'static str;

    /// Bind and serve until the process-wide shutdown signal fires, then
    /// release the port and return. `Err` is fatal for the whole gateway.
    async fn run(self: Box<Self>) -> Result<()>;
}

/// Run every configured entrypoint to completion.
///
/// All entrypoints stop on the same process-wide shutdown signal, so in an
/// orderly shutdown every task finishes and the joined results come back
/// `Ok`. The first fatal error is propagated (after the others are aborted —
/// the process is exiting either way, and the drain machinery is not running
/// yet at that point).
///
/// With exactly one entrypoint this reduces to `entrypoint.run().await`.
pub async fn run_all(entrypoints: Vec<Box<dyn Entrypoint>>) -> Result<()> {
    let mut set = tokio::task::JoinSet::new();
    for entrypoint in entrypoints {
        let name = entrypoint.name();
        set.spawn(async move {
            let result = entrypoint.run().await;
            (name, result)
        });
    }

    let mut first_error: Option<anyhow::Error> = None;
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok((_, Ok(()))) => {}
            Ok((name, Err(error))) => {
                tracing::error!(entrypoint = name, error = ?error, "entrypoint failed");
                first_error.get_or_insert(error.context(format!("entrypoint {name}")));
                // The process is coming down: stop the siblings now rather
                // than serving on a half-alive gateway.
                set.abort_all();
            }
            // A panicked/cancelled task: abort_all cancels siblings, ignore.
            Err(join_error) if join_error.is_cancelled() => {}
            Err(join_error) => {
                first_error.get_or_insert_with(|| {
                    anyhow::anyhow!("entrypoint task panicked: {join_error}")
                });
                set.abort_all();
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    struct Ok1;
    #[async_trait::async_trait]
    impl Entrypoint for Ok1 {
        fn name(&self) -> &'static str {
            "ok1"
        }
        async fn run(self: Box<Self>) -> Result<()> {
            Ok(())
        }
    }

    struct Failing;
    #[async_trait::async_trait]
    impl Entrypoint for Failing {
        fn name(&self) -> &'static str {
            "failing"
        }
        async fn run(self: Box<Self>) -> Result<()> {
            anyhow::bail!("bind refused")
        }
    }

    /// Runs until aborted; proves a sibling failure cancels it.
    struct Hanging(Arc<AtomicBool>);
    #[async_trait::async_trait]
    impl Entrypoint for Hanging {
        fn name(&self) -> &'static str {
            "hanging"
        }
        async fn run(self: Box<Self>) -> Result<()> {
            self.0.store(true, Ordering::SeqCst);
            std::future::pending::<()>().await;
            Ok(())
        }
    }

    #[tokio::test]
    async fn all_ok_resolves_ok() {
        assert!(run_all(vec![Box::new(Ok1), Box::new(Ok1)]).await.is_ok());
    }

    #[tokio::test]
    async fn empty_set_resolves_ok() {
        assert!(run_all(vec![]).await.is_ok());
    }

    #[tokio::test]
    async fn one_failure_propagates_and_names_the_entrypoint() {
        let started = Arc::new(AtomicBool::new(false));
        let err = run_all(vec![
            Box::new(Hanging(Arc::clone(&started))),
            Box::new(Failing),
        ])
        .await
        .expect_err("a failing entrypoint must fail the gateway");
        assert!(err.to_string().contains("failing"), "got: {err:#}");
    }
}
