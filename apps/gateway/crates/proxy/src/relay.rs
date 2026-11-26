//! The byte relay under the open lane's tunnels and the MITM lane's WebSocket
//! sessions: copy in both directions, propagate a half-close, give up on a
//! pipe nothing has used for a while, and count what crossed.
//!
//! One relay, not one per caller: the two need exactly the same thing, and a
//! second copy of a byte pump is how one of them ends up closing on a rule the
//! other does not.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
// tokio's, not std's: the same clock `timeout` runs on, so a paused test
// clock advances both together.
use tokio::time::Instant;

/// How long the WHOLE pipe may be silent before it is closed.
///
/// Measured across both directions: a long download with a silent client is
/// alive, and closing its upload side after ten quiet minutes would make the
/// server abort it. Only a pipe neither side has used for this long is idle.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(600);

/// One TLS record. Most of what crosses a tunnel is TLS, so a read rarely has
/// to split a record and a write rarely has to coalesce two.
const BUFFER_SIZE: usize = 16 * 1024;

/// Bytes moved through a relay, readable while it runs and after it ends,
/// however it ended. The caller owns it, so a relay cut short from outside
/// (shutdown, a reset) still reports what it carried.
#[derive(Debug, Default)]
pub struct Meter {
    to_server: AtomicU64,
    to_client: AtomicU64,
}

impl Meter {
    #[must_use]
    pub fn to_server(&self) -> u64 {
        self.to_server.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn to_client(&self) -> u64 {
        self.to_client.load(Ordering::Relaxed)
    }
}

/// When either direction last moved a byte. Shared by the two copies so each
/// can tell "I am quiet" from "the pipe is quiet".
struct Activity {
    started: Instant,
    last_ms: AtomicU64,
}

impl Activity {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            last_ms: AtomicU64::new(0),
        }
    }

    fn touch(&self) {
        // u64 millis is 584 million years; the cast cannot truncate.
        self.last_ms
            .store(self.started.elapsed().as_millis() as u64, Ordering::Relaxed);
    }

    fn idle_for(&self) -> Duration {
        self.started
            .elapsed()
            .saturating_sub(Duration::from_millis(self.last_ms.load(Ordering::Relaxed)))
    }
}

/// Relay bytes between `client` and `server` until both directions have
/// ended, one fails, or the pipe has been idle for `idle`.
///
/// A direction ends when its reader hits EOF; the peer's write side is shut
/// down so it learns that too (the half-close a plain TCP proxy owes both
/// ends), and the other direction keeps going until it ends on its own. An
/// error in either direction ends the relay at once: the caller drops the
/// streams, which closes what is left.
pub async fn relay<C, S>(
    client: &mut C,
    server: &mut S,
    idle: Duration,
    meter: &Meter,
) -> std::io::Result<()>
where
    C: AsyncRead + AsyncWrite + Unpin,
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (client_read, client_write) = tokio::io::split(client);
    let (server_read, server_write) = tokio::io::split(server);
    let activity = Activity::new();

    tokio::try_join!(
        copy_direction(client_read, server_write, idle, &activity, &meter.to_server),
        copy_direction(server_read, client_write, idle, &activity, &meter.to_client),
    )?;
    Ok(())
}

async fn copy_direction<R, W>(
    mut reader: R,
    mut writer: W,
    idle: Duration,
    activity: &Activity,
    moved: &AtomicU64,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; BUFFER_SIZE];
    loop {
        // Wait only for what is left of the pipe's idle budget. When this
        // direction's wait runs out, the loop recomputes it: the other
        // direction may have moved bytes meanwhile, in which case there is
        // budget left; if not, the pipe is idle and this direction ends.
        let remaining = idle.saturating_sub(activity.idle_for());
        if remaining.is_zero() {
            return Ok(());
        }
        let n = match tokio::time::timeout(remaining, reader.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(e),
            Err(_elapsed) => continue,
        };
        writer.write_all(&buf[..n]).await?;
        moved.fetch_add(n as u64, Ordering::Relaxed);
        activity.touch();
    }
    // EOF: pass the half-close on. Best effort: a peer that has already
    // gone away makes this fail, and that changes nothing about the outcome.
    let _ = writer.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    const IDLE: Duration = Duration::from_secs(5);

    /// Two duplex pairs: the relay sits between `client_far`/`server_far`'s
    /// near ends; the test speaks from the far ends.
    fn pipes() -> (
        tokio::io::DuplexStream,
        tokio::io::DuplexStream,
        tokio::io::DuplexStream,
        tokio::io::DuplexStream,
    ) {
        let (client_near, client_far) = duplex(64 * 1024);
        let (server_near, server_far) = duplex(64 * 1024);
        (client_near, client_far, server_near, server_far)
    }

    #[tokio::test]
    async fn carries_bytes_both_ways_and_counts_them() {
        let (mut client_near, mut client_far, mut server_near, mut server_far) = pipes();
        let meter = Meter::default();

        let relayed = async { relay(&mut client_near, &mut server_near, IDLE, &meter).await };
        let traffic = async {
            client_far.write_all(b"hello server").await.unwrap();
            let mut buf = [0u8; 12];
            server_far.read_exact(&mut buf).await.unwrap();
            assert_eq!(&buf, b"hello server");

            server_far
                .write_all(b"hi client, long reply")
                .await
                .unwrap();
            let mut buf = [0u8; 21];
            client_far.read_exact(&mut buf).await.unwrap();
            assert_eq!(&buf, b"hi client, long reply");

            // Both ends hang up: the relay ends cleanly.
            client_far.shutdown().await.unwrap();
            server_far.shutdown().await.unwrap();
        };
        let (result, ()) = tokio::join!(relayed, traffic);
        result.expect("relay ends cleanly");
        assert_eq!(meter.to_server(), 12);
        assert_eq!(meter.to_client(), 21);
    }

    /// EOF on one side is passed to the other as a half-close, and the
    /// opposite direction keeps flowing until it ends on its own.
    #[tokio::test]
    async fn propagates_a_half_close_and_keeps_the_other_direction_open() {
        let (mut client_near, mut client_far, mut server_near, mut server_far) = pipes();
        let meter = Meter::default();

        let relayed = async { relay(&mut client_near, &mut server_near, IDLE, &meter).await };
        let traffic = async {
            client_far.write_all(b"request").await.unwrap();
            client_far.shutdown().await.unwrap();

            let mut request = Vec::new();
            // read_to_end returns only once the relay has shut down the
            // server's write side, so the half-close arrived.
            server_far.read_to_end(&mut request).await.unwrap();
            assert_eq!(request, b"request");

            // The server can still answer on the other direction.
            server_far.write_all(b"response").await.unwrap();
            server_far.shutdown().await.unwrap();
            let mut response = Vec::new();
            client_far.read_to_end(&mut response).await.unwrap();
            assert_eq!(response, b"response");
        };
        let (result, ()) = tokio::join!(relayed, traffic);
        result.expect("relay ends cleanly");
        assert_eq!(meter.to_server(), 7);
        assert_eq!(meter.to_client(), 8);
    }

    /// A pipe nobody uses closes after `idle`, and the meter still reports
    /// what crossed before it went quiet.
    #[tokio::test(start_paused = true)]
    async fn closes_once_the_whole_pipe_is_idle() {
        let (mut client_near, mut client_far, mut server_near, _server_far) = pipes();
        let meter = Meter::default();

        let relayed = async { relay(&mut client_near, &mut server_near, IDLE, &meter).await };
        let traffic = async {
            client_far.write_all(b"one byte please").await.unwrap();
            // Then silence. Paused time auto-advances to the relay's timer.
        };
        let started = Instant::now();
        let (result, ()) = tokio::join!(relayed, traffic);
        result.expect("idle is a clean end");
        let elapsed = started.elapsed();
        assert!(elapsed >= IDLE, "closed after {elapsed:?}, before idle");
        assert!(
            elapsed < IDLE * 2,
            "closed after {elapsed:?}, long after idle"
        );
        assert_eq!(meter.to_server(), 15);
    }

    /// Activity in ONE direction keeps the whole pipe alive: a silent client
    /// downloading for longer than `idle` must not have its upload side cut.
    #[tokio::test(start_paused = true)]
    async fn one_active_direction_keeps_the_quiet_one_alive() {
        let (mut client_near, mut client_far, mut server_near, mut server_far) = pipes();
        let meter = Meter::default();

        let relayed = async { relay(&mut client_near, &mut server_near, IDLE, &meter).await };
        let traffic = async {
            // Server streams one chunk every idle/2 for 3 × idle: the client
            // direction is silent the whole time.
            for _ in 0..6 {
                tokio::time::sleep(IDLE / 2).await;
                server_far.write_all(b"chunk").await.unwrap();
                let mut buf = [0u8; 5];
                client_far.read_exact(&mut buf).await.unwrap();
            }
            // The upload side was never shut down behind the client's back:
            // it can still speak.
            client_far.write_all(b"late upload").await.unwrap();
            let mut buf = [0u8; 11];
            server_far.read_exact(&mut buf).await.unwrap();
            assert_eq!(&buf, b"late upload");
            client_far.shutdown().await.unwrap();
            server_far.shutdown().await.unwrap();
        };
        let (result, ()) = tokio::join!(relayed, traffic);
        result.expect("relay ends cleanly");
        assert_eq!(meter.to_client(), 30);
        assert_eq!(meter.to_server(), 11);
    }
}
