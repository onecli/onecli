//! EE cache stub — replaced by the EE overlay.
//!
//! This file exists so `cargo fmt` can resolve the `#[path = "ee/cache.rs"]`
//! module declaration. The real implementation lives in the cloud repo.

pub(crate) use crate::cache::*;
