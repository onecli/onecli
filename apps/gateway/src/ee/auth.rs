//! EE auth stub — replaced by the EE overlay.
//!
//! This file exists so `cargo fmt` can resolve the `#[path = "ee/auth.rs"]`
//! module declaration. The real implementation lives in the cloud repo.

pub(crate) use crate::auth::*;
