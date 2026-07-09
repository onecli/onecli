//! Cloud-only request summarizers (OSS stub — none registered).
//!
//! The cloud build swaps in `ee/cloud_summary.rs`, which registers summarizers
//! for cloud apps (Outlook, …). This mirrors the `ee_apps` OSS-stub /
//! cloud-override split, and is the fall-through arm of [`crate::summary`]'s
//! dispatch — so an OSS build simply has no cloud-only summarizers and uses the
//! generic fallback for those providers.

use crate::summary::RequestSummarizer;

/// No cloud-only summarizers in the OSS build.
pub(crate) fn summarizer(_provider: &str) -> Option<&'static dyn RequestSummarizer> {
    None
}
