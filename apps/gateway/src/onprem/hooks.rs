//! Onprem hooks stub — replaced by the onprem overlay.
//!
//! This file exists so `cargo fmt` can resolve the `#[path = "onprem/hooks.rs"]`
//! module declaration. The real implementation lives in the cloud repo.

pub(crate) use super::hooks::*;
