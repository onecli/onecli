//! Graceful shutdown: the signal, and the drain it starts.
//!
//! The gateway is PID 1 in its container, and Linux discards a signal whose
//! disposition is still the default for PID 1 — so without the handler
//! installed here, SIGTERM does nothing at all and every deploy ends in a
//! SIGKILL after the orchestrator's stop timeout. Installing it is what makes
//! shutdown possible; the rest of this module is what makes it graceful.
//!
//! Three pieces:
//!
//! - a **signal**, broadcast to every connection so it can stop taking new work
//!   while finishing what it has;
//! - a **guard**, held by each task the drain must wait for;
//! - a **deadline**, because some of what this proxy carries is an indefinite
//!   byte pipe that can never "finish" on its own.
//!
//! Nothing here costs anything per request: a connection subscribes once when
//! it is accepted, and the guard is one atomic upgrade at the same moment.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use tracing::{info, warn};

/// Default seconds for the WHOLE shutdown: draining, the final telemetry
/// flush, and closing the pool.
///
/// Sized against the tightest real budget — the all-in-one container gets
/// Docker's default 10s between SIGTERM and SIGKILL — with a second of
/// headroom, so even a fully-burned shutdown still gets to log that it
/// finished. ECS allows 30s.
const DEFAULT_SHUTDOWN_SECS: u64 = 9;

const SHUTDOWN_SECS_ENV: &str = "GATEWAY_SHUTDOWN_TIMEOUT_SECS";

/// Seconds held back from the drain for the steps that follow it.
///
/// The flush is the step that actually persists data, so it must never be the
/// one that runs out of budget: whatever the total is, these seconds are
/// reserved before the drain is allowed to spend any of it.
const POST_DRAIN_RESERVE_SECS: u64 = 4;

static SIGNAL: OnceLock<watch::Sender<bool>> = OnceLock::new();

/// Weak handle used to mint guards.
///
/// Weak on purpose: the strong sender lives in `DRAIN` so the drain can drop
/// it, and a `OnceLock` can never give its contents back. Upgrading keeps
/// working while the drain is in progress, which closes the window where a
/// CONNECT completes just as its accept task's guard falls away.
static GUARDS: OnceLock<mpsc::WeakSender<()>> = OnceLock::new();

/// The strong sender plus its receiver, owned here so [`drain_connections`]
/// can take and drop the sender — the only way `recv()` ever reports that the
/// last guard is gone.
static DRAIN: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>> = Mutex::new(None);

fn signal_tx() -> &'static watch::Sender<bool> {
    SIGNAL.get_or_init(|| watch::channel(false).0)
}

/// Install the signal handlers. Call once, early in `main`.
///
/// A second signal exits immediately: an operator who sends SIGTERM twice is
/// asking for the process to be gone now, not for a tidier drain.
pub fn install() {
    // Capacity is irrelevant — guards never send, they only exist to be
    // dropped. The receiver reports `None` once every clone is gone.
    let (tx, rx) = mpsc::channel::<()>(1);
    let _ = GUARDS.set(tx.downgrade());
    *DRAIN.lock().expect("shutdown drain state") = Some((tx, rx));

    // Touch the signal channel now so a subscriber can never race its creation.
    let _ = signal_tx();

    tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};

        // Registered once and reused for both waits. Re-registering between
        // them would drop a signal delivered in the gap: a listener created
        // after a broadcast never sees it, so the operator's second Ctrl-C
        // would be swallowed exactly when they are trying to force an exit.
        let Ok(mut term) =
            signal(SignalKind::terminate()).map_err(|e| warn!(error = %e, "cannot handle SIGTERM"))
        else {
            return;
        };
        let Ok(mut int) =
            signal(SignalKind::interrupt()).map_err(|e| warn!(error = %e, "cannot handle SIGINT"))
        else {
            return;
        };

        let name = tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = int.recv() => "SIGINT",
        };
        info!(signal = name, "shutdown started");
        let _ = signal_tx().send(true);

        tokio::select! {
            _ = term.recv() => {},
            _ = int.recv() => {},
        }
        warn!("second shutdown signal — exiting immediately");
        std::process::exit(1);
    });
}

/// A subscription to the shutdown signal. One per connection, never per request.
pub struct Signal(watch::Receiver<bool>);

pub fn subscribe() -> Signal {
    Signal(signal_tx().subscribe())
}

impl Signal {
    /// Resolve once shutdown has been requested — immediately if it already has.
    ///
    /// `wait_for`, not `changed()`: `subscribe()` marks the current value as
    /// seen, so a receiver created after the signal fired would wait forever on
    /// `changed()`. That is the difference between draining a connection opened
    /// during shutdown and hanging on it.
    pub async fn wait(&mut self) {
        // Err is unreachable: the sender is a `'static` that is never dropped.
        let _ = self.0.wait_for(|&down| down).await;
    }
}

/// Keeps [`drain_connections`] waiting for as long as it is alive.
pub struct TaskGuard {
    _tx: mpsc::Sender<()>,
}

/// Mint a guard for a task the drain must wait for.
///
/// `None` once the drain has finished — a task starting that late is not worth
/// waiting for, since the process is already on its way out.
pub fn task_guard() -> Option<TaskGuard> {
    GUARDS.get()?.upgrade().map(|tx| TaskGuard { _tx: tx })
}

/// Parse the configured total budget. Anything unset, unparseable or zero
/// falls back to the default rather than producing a shutdown that cannot
/// finish anything.
fn parse_shutdown_secs(raw: Option<&str>) -> Duration {
    let secs = raw
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|secs| *secs > 0)
        .unwrap_or(DEFAULT_SHUTDOWN_SECS);
    Duration::from_secs(secs)
}

/// The shutdown clock, started once and consulted by each phase.
///
/// A single budget rather than one timeout per phase: the phases run in
/// sequence, so independent caps silently add up — and the configured value
/// would bound only the first of them while the flush that persists data ran
/// past the point where the orchestrator sends SIGKILL. Every phase asks this
/// for its slice, so no combination can exceed the total.
pub struct Budget {
    deadline: std::time::Instant,
}

impl Budget {
    /// Start the clock. Reads `GATEWAY_SHUTDOWN_TIMEOUT_SECS` (default 9s).
    pub fn start() -> Self {
        let total = parse_shutdown_secs(std::env::var(SHUTDOWN_SECS_ENV).ok().as_deref());
        Self {
            deadline: std::time::Instant::now() + total,
        }
    }

    fn remaining(&self) -> Duration {
        self.deadline
            .saturating_duration_since(std::time::Instant::now())
    }

    /// What the connection drain may spend — everything but the reserve.
    pub fn drain_share(&self) -> Duration {
        self.remaining()
            .saturating_sub(Duration::from_secs(POST_DRAIN_RESERVE_SECS))
    }

    /// Cap a post-drain phase at both its own limit and what is actually left.
    pub fn allow(&self, cap: Duration) -> Duration {
        self.remaining().min(cap)
    }
}

/// Wait for every guarded task to finish, up to `deadline`.
///
/// Returns whether they all did. Anything still running when this returns
/// false is cut when the process exits — which is the intended outcome for the
/// indefinite pipes (WebSockets) that deliberately hold no guard, and the
/// accepted cost for anything else that is genuinely stuck.
pub async fn drain_connections(deadline: Duration) -> bool {
    // The lock guard is a temporary in this statement and drops at the
    // semicolon — it must never be held across the await below.
    let taken = DRAIN.lock().expect("shutdown drain state").take();
    drain_pair(taken, deadline).await
}

/// The drain itself, over an owned channel pair.
///
/// Split out from the globals so it can be tested directly: the statics are
/// process-wide and `drain_connections` consumes them, so tests driving them
/// would steal each other's state and pass or fail by scheduling order.
async fn drain_pair(
    pair: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
    deadline: Duration,
) -> bool {
    let Some((tx, mut rx)) = pair else {
        // Either `install` was never called or the drain already ran.
        return true;
    };

    // Dropping the last strong sender here is what lets `recv` report `None`
    // once every guard is gone.
    drop(tx);
    tokio::time::timeout(deadline, async { while rx.recv().await.is_some() {} })
        .await
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A drain pair plus `n` guards on it, owned entirely by one test.
    fn pair_with_guards(n: usize) -> ((mpsc::Sender<()>, mpsc::Receiver<()>), Vec<TaskGuard>) {
        let (tx, rx) = mpsc::channel::<()>(1);
        let guards = (0..n)
            .map(|_| TaskGuard { _tx: tx.clone() })
            .collect::<Vec<_>>();
        ((tx, rx), guards)
    }

    #[tokio::test]
    async fn drain_returns_immediately_when_nothing_is_tracked() {
        let (pair, _none) = pair_with_guards(0);
        assert!(drain_pair(Some(pair), Duration::from_secs(5)).await);
    }

    #[tokio::test]
    async fn drain_waits_for_live_guards_then_completes() {
        let (pair, mut guards) = pair_with_guards(2);

        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            guards.clear();
        });

        let started = std::time::Instant::now();
        assert!(drain_pair(Some(pair), Duration::from_secs(5)).await);
        // Without this the test also passes against a drain that ignores
        // guards entirely and returns the moment it is called.
        assert!(started.elapsed() >= Duration::from_millis(50));
    }

    #[tokio::test]
    async fn drain_reports_false_when_a_guard_outlives_the_deadline() {
        let (pair, _guards) = pair_with_guards(1);

        assert!(!drain_pair(Some(pair), Duration::from_millis(50)).await);
    }

    #[tokio::test]
    async fn drain_is_a_no_op_when_shutdown_was_never_installed() {
        assert!(drain_pair(None, Duration::from_secs(5)).await);
    }

    /// The reason `Signal::wait` uses `wait_for` rather than `changed()`.
    #[tokio::test]
    async fn wait_resolves_for_a_receiver_created_after_the_signal() {
        let (tx, _rx) = watch::channel(false);
        tx.send(true).expect("send");

        let mut signal = Signal(tx.subscribe());
        tokio::time::timeout(Duration::from_millis(100), signal.wait())
            .await
            .expect("wait must resolve for a late subscriber");
    }

    /// Parsed as a pure function rather than by mutating the environment:
    /// `set_var`/`remove_var` race every other test reading env in this binary.
    #[test]
    fn shutdown_secs_falls_back_on_anything_unusable() {
        let default = Duration::from_secs(DEFAULT_SHUTDOWN_SECS);
        assert_eq!(parse_shutdown_secs(None), default);
        assert_eq!(parse_shutdown_secs(Some("")), default);
        assert_eq!(parse_shutdown_secs(Some("soon")), default);
        // Zero would leave every phase nothing to spend, which is worse than
        // the default rather than a stricter version of it.
        assert_eq!(parse_shutdown_secs(Some("0")), default);
        assert_eq!(parse_shutdown_secs(Some(" 20 ")), Duration::from_secs(20));
    }

    #[test]
    fn budget_reserves_the_post_drain_phases_and_never_overshoots() {
        let budget = Budget {
            deadline: std::time::Instant::now() + Duration::from_secs(9),
        };

        // The drain may spend everything except the reserve...
        let drain = budget.drain_share();
        assert!(drain <= Duration::from_secs(5));
        assert!(drain > Duration::from_secs(4));

        // ...and each later phase is capped by whatever is genuinely left, so
        // no configured value can make the phases sum past the total.
        assert!(budget.allow(Duration::from_secs(3)) <= Duration::from_secs(3));
        // A cap far larger than the budget is clamped to the budget, which is
        // what stops a generous per-phase limit from outliving the whole.
        assert!(budget.allow(Duration::from_secs(600)) <= Duration::from_secs(9));
    }

    #[test]
    fn budget_hands_out_nothing_once_it_is_spent() {
        let budget = Budget {
            deadline: std::time::Instant::now() - Duration::from_secs(1),
        };
        assert_eq!(budget.drain_share(), Duration::ZERO);
        assert_eq!(budget.allow(Duration::from_secs(3)), Duration::ZERO);
    }
}
