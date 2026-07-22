//! EE policy_engine stub — replaced by the EE overlay.
//!
//! This file exists so `cargo fmt` can resolve the `#[path = "ee/policy_engine.rs"]`
//! module declaration in `main.rs` (rustfmt parses `#[path]` declarations
//! unconditionally, ignoring `#[cfg]`). The OSS build compiles
//! `src/policy_engine.rs` instead; the EE engine lives in the enterprise repo.
