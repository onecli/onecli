//! Enterprise feature modules (`src/ee/`), compiled into every edition.
//!
//! Everything under this module — and this file itself — is covered by the
//! OneCLI Enterprise License, not the Apache License that covers the rest of
//! this crate; nothing else in the crate is. The terms are in
//! `/LICENSE-ENTERPRISE` at the repository root, and `src/ee/LICENSE` carries
//! the same notice for the directory.
//!
//! Copyright (c) 2025-present ChartDB, Inc.
//!
//! These are the licensed FEATURES: budgets, granular resource access,
//! multi-instance operation (the Redis-backed stores, `ha`), directory
//! group principals + app availability (`principals`), the RBAC API-key
//! rechecks (`rbac`), the org-scoped routes, their agent-facing
//! responses, and the platform trial credit (`platform_llm` — hosted-only
//! by nature: it injects the PLATFORM's own key, which only the hosted
//! deployment possesses). On an unlicensed deployment each degrades at its own runtime
//! gate (`entitled()` at load or startup — budgets resolve empty, session
//! policies never stamp, group principals and the availability allowlist
//! never resolve, the key ROLE rechecks stand down, the org approvals feed
//! answers the license 403, and a Redis-configured gateway refuses to boot).
//! Org-scoped CREDENTIALS are not one of them: org secrets and connections
//! inject on every tier.
//!
//! Hosted-platform PLUMBING also lives here (`cognito`, `kms_crypto`):
//! Cognito session validation and the KMS envelope crypto backend — never
//! entitlement-gated. Cognito is dead on self-host BY CODE (the selector
//! requires `Edition::Cloud`); the KMS arm is dead there BY CONFIG (every
//! supported self-host path provisions `SECRET_ENCRYPTION_KEY`, so local AES
//! serves — a keyless deployment falls through to KMS regardless of edition).
//! Same rule as the API package, where `ee/kms-crypto.ts` and the Cognito
//! services are licensed.
//!
//! Free capabilities never live here, even when they were written for the
//! hosted product: app providers, request summarizers, request finalizers and
//! body-condition matching sit in their shared homes (`crate::apps`,
//! `crate::summary`, `crate::gateway::finalizers`, `crate::condition_match`).

pub(crate) mod budget;
pub(crate) mod cognito;
pub(crate) mod granular_access;
pub(crate) mod ha;
pub(crate) mod kms_crypto;
pub(crate) mod org_routes;
pub(crate) mod platform_llm;
pub(crate) mod principals;
pub(crate) mod rbac;
pub(crate) mod response;
