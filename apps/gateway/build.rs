//! Build script: derive the active OneCLI edition from Cargo features.
//!
//! Editions are mutually exclusive, but OSS is implicit (no edition feature),
//! so `cargo build` with no features stays a valid OSS build. We map the
//! selected edition feature to a positive `edition_*` cfg so source code can
//! write `#[cfg(edition_cloud)]` / `#[cfg(edition_oss)]` instead of the older
//! `#[cfg(feature = "cloud")]` / `#[cfg(not(feature = "cloud"))]` idiom (which
//! does not scale to a third edition). Selecting two or more editions sets
//! `edition_conflict`, which trips a `compile_error!` in `src/edition.rs`.

fn main() {
    // Declare every cfg we may set so the `unexpected_cfgs` lint (clippy runs
    // with `-D warnings`) does not flag them as unknown.
    println!("cargo::rustc-check-cfg=cfg(edition_oss)");
    println!("cargo::rustc-check-cfg=cfg(edition_cloud)");
    println!("cargo::rustc-check-cfg=cfg(edition_onprem_slim)");
    println!("cargo::rustc-check-cfg=cfg(edition_onprem_full)");
    println!("cargo::rustc-check-cfg=cfg(edition_conflict)");

    // (Cargo feature env var, edition cfg). Editions are mutually exclusive; add
    // new ones here with a matching `rerun-if-env-changed` below.
    let editions: &[(&str, &str)] = &[
        ("CARGO_FEATURE_CLOUD", "edition_cloud"),
        ("CARGO_FEATURE_ONPREM_SLIM", "edition_onprem_slim"),
        ("CARGO_FEATURE_ONPREM_FULL", "edition_onprem_full"),
    ];

    let selected: Vec<&str> = editions
        .iter()
        .filter(|(env, _)| std::env::var_os(env).is_some())
        .map(|&(_, cfg)| cfg)
        .collect();

    match selected.as_slice() {
        // No edition feature → OSS (the implicit default).
        [] => println!("cargo::rustc-cfg=edition_oss"),
        [cfg] => println!("cargo::rustc-cfg={cfg}"),
        // Two or more editions selected at once → let src/edition.rs fail loudly.
        _ => println!("cargo::rustc-cfg=edition_conflict"),
    }

    // Re-run only when this script or the edition feature set changes.
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-env-changed=CARGO_FEATURE_CLOUD");
    println!("cargo::rerun-if-env-changed=CARGO_FEATURE_ONPREM_SLIM");
    println!("cargo::rerun-if-env-changed=CARGO_FEATURE_ONPREM_FULL");
}
