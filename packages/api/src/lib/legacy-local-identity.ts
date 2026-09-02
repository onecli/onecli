/**
 * The identity a pre-2.0 self-hosted deployment created for itself.
 *
 * Before logins existed, the server provisioned one user on first request and
 * signed every visitor in as it. That mode is gone; these two literals remain
 * only so an upgrading deployment can recognise its own legacy row and hand it
 * to the operator's real account (see `legacy-adoption.ts`).
 *
 * `local-admin` is unforgeable as a marker: it was written by exactly one
 * function, it is unique-constrained, and nothing can produce it now — the
 * identity layer stamps `ba:<uuid>` and Cognito stamps a provider subject.
 *
 * These retire once the upgrade window closes; nothing else may depend on them.
 */
export const LEGACY_LOCAL_AUTH_ID = "local-admin";

export const LEGACY_LOCAL_EMAIL = "admin@localhost";
