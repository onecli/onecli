// Whether an `oc_` bearer commits to API-key auth (failed key auth → 401)
// instead of falling through to session auth. EE editions enable it — in
// onprem the session is ambient (local admin), so the fallthrough would
// silently resolve an org key to the user's default project. OSS default:
// false — today's fallthrough behavior, unchanged.
let _strictApiKeyAuth = false;

export const initStrictApiKeyAuth = (strict: boolean) => {
  _strictApiKeyAuth = strict;
};

export const getStrictApiKeyAuth = (): boolean => _strictApiKeyAuth;
