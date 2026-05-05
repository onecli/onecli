//! Cloud-only app providers (OSS stub — returns an empty slice).

use crate::apps::AppProvider;

/// Returns cloud-only app provider definitions.
pub(crate) fn providers() -> &'static [AppProvider] {
    &[]
}
