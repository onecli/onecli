//! Cloud granular-access stub — replaced by the EE overlay.
//!
//! This file exists so `cargo fmt` can resolve the
//! `#[path = "ee/granular_access.rs"]` module declaration in `main.rs`.
//! The real implementation lives in the cloud repo.
//!
//! Unlike the other cloud stubs there is nothing to re-export: the module is
//! `#[cfg(feature = "cloud")]`-only and is referenced solely from other cloud
//! modules, so the OSS build never compiles it.
