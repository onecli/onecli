// The stub id_token advertises a *paid* ChatGPT plan on purpose. codex-cli
// (>= 0.14x) selects its model backend from the `chatgpt_plan_type` claim:
// a "free" plan routes model calls to wss://api.openai.com/v1/responses (API
// mode), where the injected ChatGPT-OAuth subscription token is rejected with
// 401; a paid plan routes to wss://chatgpt.com/backend-api/codex/responses,
// where the injected subscription token is accepted. The real entitlement is
// still enforced upstream by the injected token — this claim only steers routing.
const CODEX_ID_TOKEN = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzdWIiOiJvbmVjbGktbWFuYWdlZCIsImVtYWlsIjoib25lY2xpQG9uZWNsaS5zaCIsImV4cCI6NDEwMjQ0NDgwMCwiaWF0IjoxNzM1Njg5NjAwLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9wbGFuX3R5cGUiOiJwbHVzIiwiY2hhdGdwdF91c2VyX2lkIjoib25lY2xpLW1hbmFnZWQiLCJjaGF0Z3B0X2FjY291bnRfaWQiOiJvbmVjbGktbWFuYWdlZCJ9fQ",
  "b25lY2xpLW1hbmFnZWQtc2lnbmF0dXJl",
].join(".");

// Codex treats ~/.codex/auth.json as stale and tries to self-refresh when
// last_refresh is older than its refresh window — which fails against the
// onecli-managed placeholder tokens. Build the stub on demand and stamp
// last_refresh with the current time so it always looks freshly refreshed and
// the gateway retains refresh control. Generated per call so a long-running
// API process never serves a stale timestamp.
export const buildCodexOAuthStub = () =>
  JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: CODEX_ID_TOKEN,
        access_token: "onecli-managed",
        refresh_token: "onecli-managed",
        account_id: "onecli-managed",
      },
      last_refresh: new Date().toISOString(),
    },
    null,
    2,
  );

export const CODEX_APIKEY_STUB = JSON.stringify(
  {
    auth_mode: "apikey",
    OPENAI_API_KEY: "onecli-managed",
  },
  null,
  2,
);
