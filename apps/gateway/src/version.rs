//! Resolve the running app/build version.
//!
//! Read from the `APP_VERSION` env var (stamped on the deployed image/task — cloud
//! sets `<semver>+<short-sha>`, e.g. `1.38.0+f6cca6e5`), falling back to the
//! compile-time crate version for local/unstamped builds.

/// The app version reported by `/healthz` and telemetry.
pub fn app_version() -> String {
    std::env::var("APP_VERSION")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}
