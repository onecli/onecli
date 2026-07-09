//! Build edition identity for the gateway.
//!
//! The active edition is selected at build time via Cargo features and surfaced
//! as positive `edition_*` cfgs by `build.rs` (OSS is implicit — no edition
//! feature). This module exposes them as a runtime value so code can branch on
//! `edition()` / `capabilities()` instead of scattering `#[cfg(...)]`.

// `build.rs` sets `edition_conflict` when more than one edition feature is
// enabled at once. Fail loudly here rather than silently picking one.
#[cfg(edition_conflict)]
compile_error!("at most one OneCLI edition feature may be enabled at a time (e.g. `cloud`)");

/// The distribution edition this binary was built as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edition {
    Oss,
    Cloud,
    OnpremSlim,
    OnpremFull,
}

/// The edition selected at build time.
pub const fn edition() -> Edition {
    if cfg!(edition_cloud) {
        Edition::Cloud
    } else if cfg!(edition_onprem_slim) {
        Edition::OnpremSlim
    } else if cfg!(edition_onprem_full) {
        Edition::OnpremFull
    } else {
        Edition::Oss
    }
}

/// Capabilities derived from the build edition — the seam for runtime branches
/// as they migrate off `#[cfg]`. Extend with capability fields as consumers
/// appear (e.g. tenancy, crypto backend).
#[derive(Debug, Clone, Copy)]
pub struct Capabilities {
    pub edition: Edition,
}

/// Capabilities for the current build edition.
pub const fn capabilities() -> Capabilities {
    Capabilities { edition: edition() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edition_matches_build() {
        #[cfg(edition_cloud)]
        assert_eq!(edition(), Edition::Cloud);
        #[cfg(edition_oss)]
        assert_eq!(edition(), Edition::Oss);
        #[cfg(edition_onprem_slim)]
        assert_eq!(edition(), Edition::OnpremSlim);
        #[cfg(edition_onprem_full)]
        assert_eq!(edition(), Edition::OnpremFull);
    }
}
