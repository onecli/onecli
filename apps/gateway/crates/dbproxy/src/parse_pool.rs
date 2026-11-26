//! Parsing untrusted SQL text off the async runtime, in bounded memory and
//! with the stack it needs.
//!
//! A SQL parser recurses as deep as the text nests, and its memory grows with
//! the text, so neither can run on an async worker thread: one long chain of
//! operators would overflow that thread's stack and abort the process, and a
//! few large statements at once would exhaust a small gateway instance. Every
//! parse therefore runs here:
//!
//! - all text being parsed at once shares [`PARSE_BYTES_IN_FLIGHT`], so peak
//!   parser memory stays bounded however many sessions send large statements
//!   (each job is charged at least [`MIN_CHARGE_BYTES`], which also bounds
//!   the number of queued jobs);
//! - small texts run on a few long-lived threads whose stack covers the
//!   deepest tree that size can produce;
//! - larger texts each get a fresh thread with a stack sized for the largest
//!   text the gateway parses, which exits when the job is done so the memory
//!   it touched is returned.

use std::io;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

use tokio::sync::{oneshot, Semaphore};

use crate::limits::MAX_PARSED_STATEMENT_BYTES;

/// Total text parsed at once on this instance. One maximum-size statement
/// needs about 160 MB of parser memory in the worst case measured.
pub const PARSE_BYTES_IN_FLIGHT: usize = MAX_PARSED_STATEMENT_BYTES;

/// The least a job is charged against the budget, so a flood of tiny jobs
/// cannot queue without bound.
pub const MIN_CHARGE_BYTES: usize = 1024;

/// Texts up to this size run on the long-lived threads.
const SMALL_JOB_BYTES: usize = 64 * 1024;

/// The deepest parse measured needs about 40 bytes of stack per byte of text
/// (a long `a + a + ...` chain): 2.6 MiB for a small job, 40 MiB for the
/// largest text. Both stacks leave room on top.
const SMALL_JOB_STACK: usize = 8 * 1024 * 1024;
const LARGE_JOB_STACK: usize = 64 * 1024 * 1024;

type Job = Box<dyn FnOnce() + Send>;

/// The pool every database session parses through. Cheap to clone.
#[derive(Clone)]
pub struct ParsePool {
    inner: Arc<Inner>,
}

struct Inner {
    budget: Arc<Semaphore>,
    small: mpsc::Sender<Job>,
}

impl ParsePool {
    /// Start the long-lived threads.
    pub fn new() -> io::Result<Self> {
        let threads = thread::available_parallelism().map_or(2, |n| n.get().clamp(2, 8));
        let (small, jobs) = mpsc::channel::<Job>();
        let jobs = Arc::new(Mutex::new(jobs));
        for index in 0..threads {
            let jobs = Arc::clone(&jobs);
            thread::Builder::new()
                .name(format!("sql-parse-{index}"))
                .stack_size(SMALL_JOB_STACK)
                .spawn(move || loop {
                    // The lock is held only while waiting for the next job.
                    let next = match jobs.lock() {
                        Ok(jobs) => jobs.recv(),
                        Err(_) => return,
                    };
                    match next {
                        Ok(job) => job(),
                        Err(_) => return,
                    }
                })?;
        }
        Ok(Self {
            inner: Arc::new(Inner {
                budget: Arc::new(Semaphore::new(PARSE_BYTES_IN_FLIGHT)),
                small,
            }),
        })
    }

    /// Run `job`, which parses `bytes` of text, once the budget has room.
    /// `None` when the job could not run (no thread could be started) or did
    /// not finish; the caller then refuses the text rather than pass it
    /// unchecked. The job keeps its share of the budget until it finishes,
    /// even if the caller stops waiting.
    pub async fn run<T: Send + 'static>(
        &self,
        bytes: usize,
        job: impl FnOnce() -> T + Send + 'static,
    ) -> Option<T> {
        let charge = bytes.clamp(MIN_CHARGE_BYTES, PARSE_BYTES_IN_FLIGHT);
        let permit = Arc::clone(&self.inner.budget)
            .acquire_many_owned(u32::try_from(charge).ok()?)
            .await
            .ok()?;
        let (done, result) = oneshot::channel();
        let job: Job = Box::new(move || {
            let output = job();
            drop(permit);
            // The caller may have stopped waiting; the result is then unused.
            let _ = done.send(output);
        });
        if bytes <= SMALL_JOB_BYTES {
            self.inner.small.send(job).ok()?;
        } else {
            thread::Builder::new()
                .name("sql-parse-large".into())
                .stack_size(LARGE_JOB_STACK)
                .spawn(job)
                .ok()?;
        }
        result.await.ok()
    }

    #[cfg(test)]
    fn available(&self) -> usize {
        self.inner.budget.available_permits()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Recurse through roughly `bytes` of stack.
    fn deep(bytes: usize) -> usize {
        #[inline(never)]
        fn level(left: usize) -> usize {
            let frame = std::hint::black_box([0u8; 1024]);
            if left == 0 {
                usize::from(frame[0])
            } else {
                level(left - 1) + usize::from(frame[1])
            }
        }
        level(bytes / 1024)
    }

    #[tokio::test]
    async fn jobs_run_and_return_the_budget() {
        let pool = ParsePool::new().unwrap();
        assert_eq!(pool.run(10, || 1 + 1).await, Some(2));
        assert_eq!(
            pool.run(SMALL_JOB_BYTES + 1, || "large").await,
            Some("large")
        );
        assert_eq!(pool.available(), PARSE_BYTES_IN_FLIGHT);
    }

    /// Both depths are past the 2 MiB a spawned thread gets by default, with
    /// room for unoptimized test builds, whose frames are larger.
    #[tokio::test]
    async fn each_kind_of_thread_has_the_stack_its_jobs_need() {
        let pool = ParsePool::new().unwrap();
        assert_eq!(pool.run(10, || deep(3 * 1024 * 1024)).await, Some(0));
        assert_eq!(
            pool.run(SMALL_JOB_BYTES + 1, || deep(24 * 1024 * 1024))
                .await,
            Some(0)
        );
    }

    #[tokio::test]
    async fn an_abandoned_job_keeps_its_budget_until_it_finishes() {
        let pool = ParsePool::new().unwrap();
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let job = pool.run(PARSE_BYTES_IN_FLIGHT, move || wait.recv().is_ok());
        // Start the job, then stop waiting for it.
        let abandoned = tokio::time::timeout(std::time::Duration::from_millis(50), job).await;
        assert!(abandoned.is_err());
        assert_eq!(pool.available(), 0, "still running, still charged");
        release.send(()).unwrap();
        let next = pool.run(PARSE_BYTES_IN_FLIGHT, || true);
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(5), next).await,
            Ok(Some(true))
        );
    }

    #[tokio::test]
    async fn tiny_jobs_are_charged_the_minimum() {
        let pool = ParsePool::new().unwrap();
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let job = tokio::spawn({
            let pool = pool.clone();
            async move { pool.run(1, move || wait.recv().is_ok()).await }
        });
        while pool.available() == PARSE_BYTES_IN_FLIGHT {
            tokio::task::yield_now().await;
        }
        assert_eq!(pool.available(), PARSE_BYTES_IN_FLIGHT - MIN_CHARGE_BYTES);
        release.send(()).unwrap();
        assert_eq!(job.await.unwrap(), Some(true));
    }
}
