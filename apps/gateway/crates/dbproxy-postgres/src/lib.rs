//! The PostgreSQL adapter of the gateway's database front door.
//!
//! [`dbproxy`] holds everything engine-agnostic (policy, approvals, audit,
//! limits, the upstream dial). This crate adds what is PostgreSQL's own:
//!
//! - [`front_door`]: one connection from first byte to session end;
//! - [`client`]: the agent's TLS, startup packet and token;
//! - [`server`]: the gateway's own TLS login to the database server;
//! - [`session`]: every unit of work judged, then relayed;
//! - [`names`]: the server's prepared statements, kept in step with it;
//! - [`cancel`]: cancel requests, with keys that never leave the gateway;
//! - [`wire`]: reading and writing protocol messages;
//! - [`classify`]: what one message's SQL text does, read by PostgreSQL's own
//!   parser, with [`tokens`] covering what the parser's summary does not
//!   show;
//! - [`settings`]: the server settings no statement may move;
//! - [`functions`]: which built-in functions only compute a value;
//! - [`reason`]: why a statement is refused whatever the policy says.

pub mod cancel;
pub mod classify;
pub mod client;
pub mod front_door;
pub mod functions;
pub mod names;
pub mod reason;
pub mod server;
pub mod session;
pub mod settings;
pub mod tokens;
pub mod wire;

pub use client::TLS_HANDSHAKE;
pub use front_door::FrontDoor;
