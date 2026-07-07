//! Onprem auth stub — replaced by the onprem overlay.
//!
//! This file exists so `cargo fmt` can resolve the `#[path = "ee/onprem/auth.rs"]`
//! module declaration. The real implementation lives in the cloud repo.

pub(crate) use super::auth::*;
