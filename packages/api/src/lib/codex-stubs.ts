const ONECLI_MANAGED = "onecli-managed";

const base64UrlJson = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

// Placeholder id_token. Codex only decodes its claims (the signature is never
// verified), so it is minted per stub with the vaulted secret's ChatGPT
// account id and plan. Codex ≥0.156 checks the selected workspace against
// `wham/accounts/check`, which lists the REAL account (the gateway injects the
// real token) — so an `onecli-managed` account id fails with "selected
// workspace missing from routing discovery". The plan gates client-side
// features: a "free" plan hides the built-in image_gen tool, and workspace
// plans (team, business, enterprise, edu) unlock workspace connectors. An
// unknown plan leaves the claim out rather than guessing one.
const buildCodexIdToken = (accountId: string, planType: string | null) =>
  [
    base64UrlJson({ alg: "HS256", typ: "JWT" }),
    base64UrlJson({
      sub: ONECLI_MANAGED,
      email: "onecli@onecli.sh",
      exp: 4102444800,
      iat: 1735689600,
      "https://api.openai.com/auth": {
        ...(planType ? { chatgpt_plan_type: planType } : {}),
        chatgpt_user_id: ONECLI_MANAGED,
        chatgpt_account_id: accountId,
      },
    }),
    Buffer.from(`${ONECLI_MANAGED}-signature`).toString("base64url"),
  ].join(".");

// Codex treats ~/.codex/auth.json as stale and tries to self-refresh when
// last_refresh is older than its refresh window — which fails against the
// onecli-managed placeholder tokens. Build the stub on demand and stamp
// last_refresh with the current time so it always looks freshly refreshed and
// the gateway retains refresh control. Generated per call so a long-running
// API process never serves a stale timestamp.
//
// `accountId` and `planType` come from the vaulted secret. Neither is a
// credential — the gateway already sends the account id upstream as the
// `chatgpt-account-id` header. Without an account id the stub keeps the
// placeholder.
export const buildCodexOAuthStub = ({
  accountId,
  planType,
}: {
  accountId?: string | null;
  planType?: string | null;
} = {}) => {
  const account = accountId || ONECLI_MANAGED;
  return JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: buildCodexIdToken(account, planType || null),
        access_token: ONECLI_MANAGED,
        refresh_token: ONECLI_MANAGED,
        account_id: account,
      },
      last_refresh: new Date().toISOString(),
    },
    null,
    2,
  );
};

export const CODEX_APIKEY_STUB = JSON.stringify(
  {
    auth_mode: "apikey",
    OPENAI_API_KEY: ONECLI_MANAGED,
  },
  null,
  2,
);
