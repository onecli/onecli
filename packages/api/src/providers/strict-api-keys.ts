// Whether an `oc_` bearer commits to API-key auth (failed key auth → 401)
// instead of falling through to session auth. Strict in EVERY edition: the
// ambient local-session hazard applies to onprem identically (an org key that
// failed key auth — e.g. no X-Workspace-Id header — would otherwise silently
// resolve to the local admin's default workspace), and org keys exist
// everywhere. `initStrictApiKeyAuth` remains as a test seam.
let _strictApiKeyAuth = true;

export const initStrictApiKeyAuth = (strict: boolean) => {
  _strictApiKeyAuth = strict;
};

export const getStrictApiKeyAuth = (): boolean => _strictApiKeyAuth;
