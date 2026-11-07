//! The proxy pipeline: CONNECT resolution and the MITM request path.
//!
//! [`connect`] resolves what to do for an agent + host combination (policy,
//! injections, app connections); the stage modules then carry a proxied
//! request end to end:
//!
//! - [`mitm`]: TLS interception with generated leaf certificates
//! - [`forward`]: request forwarding, header filtering, policy enforcement,
//!   unconnected-app interception
//! - [`websocket`]: the upgrade leg, credential-injected and piped
//! - [`hooks`]: the licensed pre/post-forward extension points
//! - [`finalizers`] / [`transforms`]: request signing and body transforms
//! - [`response`]: pre-built gateway responses
//! - [`egress`]: the destination guard — no non-public upstream without an
//!   operator allowlist entry
pub mod approval_enrich;
pub mod body;
#[cfg(test)]
mod byoc_groups_pg_test;
pub mod connect;
pub mod egress;
pub mod finalizers;
pub mod forward;
pub mod github_org_access;
#[cfg(test)]
mod guidance_connections_pg_test;
pub mod hints;
pub mod hooks;
mod log_redact;
pub mod method_override;
pub mod mitm;
pub mod refresh;
pub mod relay;
pub mod response;
#[cfg(test)]
mod shared_github_source_pg_test;
pub mod stale_token;
pub mod transforms;
pub mod tunnel;
pub mod websocket;
