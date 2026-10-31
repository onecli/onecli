//! The engine-agnostic half of the gateway's database front door.
//!
//! An agent opens a database session to the gateway with its OneCLI token;
//! the gateway logs in to the real server with the connection's stored
//! credentials and judges every unit of work the agent sends with the same
//! policy, approval and audit machinery the HTTP lanes use. This crate holds
//! everything that does not depend on the wire protocol, so a second engine
//! (MySQL) is one more adapter beside `dbproxy-postgres`, not a second copy:
//!
//! - [`statement`]: the classes a statement falls into and the synthetic
//!   policy request each is judged as;
//! - [`target`]: the stored connection settings, decoded and validated;
//! - [`upstream`]: the guarded dial and TLS configuration to the server;
//! - [`login`]: the agent token and connection id turned into a session;
//! - [`gate`]: one unit of work judged, held for approval, and audited;
//! - [`limits`]: the bounds every session runs under;
//! - [`parse_pool`]: parsing untrusted SQL off the async runtime, in bounded
//!   memory.

pub mod gate;
pub mod limits;
pub mod login;
pub mod parse_pool;
pub mod statement;
pub mod target;
pub mod upstream;

/// One database engine as the front door serves it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Engine {
    /// The app registry provider its connections belong to (`postgres`).
    pub provider: &'static str,
    /// The reserved policy zone its connections are judged under.
    pub zone: &'static str,
    /// The name people know it by, for messages and approval cards.
    pub display_name: &'static str,
    /// The URL scheme approval cards show (`postgresql`).
    pub scheme: &'static str,
}
