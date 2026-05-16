//! Cloud telemetry stub — replaced by cloud overlay.
//!
//! This file exists so `cargo fmt` can resolve the `#[path = "cloud/telemetry.rs"]`
//! module declaration. The real implementation lives in the cloud repo.

pub(crate) use crate::telemetry::*;
