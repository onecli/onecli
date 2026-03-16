//! Cloud auth stub — replaced by onecli-cloud overlay.
//!
//! This file exists so `cargo fmt` can resolve the `#[path = "cloud/auth.rs"]`
//! module declaration. The real implementation lives in the cloud repo.

pub(crate) use crate::auth::*;
