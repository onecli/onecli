const CODEX_ID_TOKEN = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJzdWIiOiJvbmVjbGktbWFuYWdlZCIsImVtYWlsIjoib25lY2xpQG9uZWNsaS5zaCIsImV4cCI6NDEwMjQ0NDgwMCwiaWF0IjoxNzM1Njg5NjAwLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9wbGFuX3R5cGUiOiJmcmVlIiwiY2hhdGdwdF91c2VyX2lkIjoib25lY2xpLW1hbmFnZWQiLCJjaGF0Z3B0X2FjY291bnRfaWQiOiJvbmVjbGktbWFuYWdlZCJ9fQ",
  "b25lY2xpLW1hbmFnZWQtc2lnbmF0dXJl",
].join(".");

export const CODEX_OAUTH_STUB = JSON.stringify(
  {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: CODEX_ID_TOKEN,
      access_token: "onecli-managed",
      refresh_token: "onecli-managed",
      account_id: "onecli-managed",
    },
    last_refresh: "2025-01-01T00:00:00Z",
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
