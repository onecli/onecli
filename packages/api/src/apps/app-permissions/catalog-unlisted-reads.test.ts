import { describe, expect, it } from "vitest";
import { getAppPermissionDefinitions } from ".";
import { defaultOtherReads } from "./types";
import {
  compileConnectionStack,
  defaultConnectionGrant,
} from "../../services/grants-compile";
import { evaluateNew } from "../../services/policy-translation/evaluator";
import type { NewRule } from "../../services/policy-translation/types";

// "Other reads" (GET/HEAD outside an app's tool list) are allowed by default
// only on a catalog that opted in with `unlistedReads: "allow"`. The opt-in
// is a claim about the provider's API: no GET the connection's credential
// reaches, outside the read tools, returns a credential or secret, runs code,
// or changes state. This file holds the evidence for each claim, and fails
// when a catalog flips without it.
//
// Every request below is a vendor-documented GET that a read must never
// reach without a human: under the REAL default grant, through the real
// evaluator, each is held for approval (never allowed, never full access).
// This catches both ways a default attach could leak: an opted-in catalog
// whose API has such a GET, and a read TOOL broad enough to swallow one (a
// raw `/projects/*` prefix covering `/projects/{id}/variables`).

/** A GET the default grant must hold, and the doc that says why. */
interface SensitiveRead {
  host: string;
  path: string;
  why: string;
}

const SENSITIVE_READS: Record<string, SensitiveRead[]> = {
  twilio: [
    {
      host: "api.twilio.com",
      path: "/2010-04-01/Accounts/ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
      why: "returns the account's auth_token",
    },
  ],
  salesforce: [
    {
      host: "acme.my.salesforce.com",
      path: "/services/data/v66.0/tooling/executeAnonymous/?anonymousBody=System.debug(1)%3B",
      why: "runs Apex (Tooling API executeAnonymous)",
    },
  ],
  cloudflare: [
    {
      host: "api.cloudflare.com",
      path: "/client/v4/accounts/a1/cfd_tunnel/t1/token",
      why: "returns the tunnel token that runs the tunnel",
    },
  ],
  datadog: [
    {
      host: "api.datadoghq.com",
      path: "/api/v2/api_keys/k1",
      why: "returns the API key value (attributes.key)",
    },
  ],
  vercel: [
    {
      host: "api.vercel.com",
      path: "/v1/projects/p1/env/e1",
      why: "returns the decrypted value of an environment variable",
    },
    {
      host: "api.vercel.com",
      path: "/v9/projects/p1/env",
      why: "lists environment variables (under the project tool's old prefix)",
    },
  ],
  gitlab: [
    {
      host: "gitlab.com",
      path: "/api/v4/projects/1/variables",
      why: "returns CI/CD variable values",
    },
    {
      host: "gitlab.com",
      path: "/api/v4/projects/1/triggers",
      why: "returns pipeline trigger tokens",
    },
    {
      host: "gitlab.com",
      path: "/api/v4/groups/1/variables",
      why: "returns group CI/CD variable values",
    },
  ],
  supabase: [
    {
      host: "api.supabase.com",
      path: "/v1/projects/abc/api-keys?reveal=true",
      why: "returns the project's API keys",
    },
  ],
  sentry: [
    {
      host: "acme.sentry.io",
      path: "/api/0/projects/acme/web/keys/",
      why: "returns client keys, secret and DSN included",
    },
    {
      host: "acme.sentry.io",
      path: "/api/0/projects/acme/web/hooks/",
      why: "returns service hooks, signing secret included",
    },
  ],
  resend: [
    {
      host: "api.resend.com",
      path: "/webhooks/w1",
      why: "returns the webhook's signing_secret",
    },
  ],
  flyio: [
    {
      host: "api.machines.dev",
      path: "/v1/apps/app1/secrets?show_secrets=true",
      why: "returns the app's secret values",
    },
  ],
  posthog: [
    {
      host: "us.posthog.com",
      path: "/api/organizations/o1/projects/1/",
      why: "returns the project with its secret_api_token",
    },
  ],
  pagerduty: [
    {
      host: "api.pagerduty.com",
      path: "/event_orchestrations/eo1/integrations/i1",
      why: "returns the integration's routing_key (Events API ingest key)",
    },
  ],
  coralogix: [
    {
      host: "api.eu1.coralogix.com",
      path: "/mgmt/openapi/5/aaa/send-data-keys/v3",
      why: "returns Send-Your-Data API key values",
    },
  ],
  onyx: [
    {
      host: "cloud.onyx.app",
      path: "/api/manage/credential/1",
      why: "returns a connector credential's credential_json",
    },
  ],
  "zoho-crm": [
    {
      host: "www.zohoapis.com",
      path: "/crm/v8/settings/variables",
      why: "returns CRM variables, documented as API authentication parameters",
    },
  ],
  "microsoft-word": [
    {
      host: "graph.microsoft.com",
      path: "/v1.0/shares/u!aHR0cHM6Ly9leGFtcGxlLmNvbQ",
      why: "grants durable access (Prefer: redeemSharingLink)",
    },
  ],
  youtube: [
    {
      host: "www.googleapis.com",
      path: "/youtube/v3/liveStreams?part=cdn&mine=true",
      why: "returns the stream key (cdn.ingestionInfo.streamName)",
    },
  ],
  "vertex-ai": [
    {
      host: "us-central1-aiplatform.googleapis.com",
      path: "/v1/projects/p1/locations/us-central1/datasets/d1/datasetVersions/v1:restore",
      why: "restores a dataset version (datasetVersions.restore)",
    },
  ],
  zendesk: [
    {
      host: "acme.zendesk.com",
      path: "/api/v2/webhooks/01GZ/signing_secret",
      why: "returns the webhook's signing secret (Show Webhook Signing Secret)",
    },
    {
      host: "acme.zendesk.com",
      path: "/api/v2/oauth/tokens.json?all=true",
      why: "lists every OAuth token in the account (List Tokens, all=true)",
    },
  ],
  heyreach: [
    {
      host: "api.heyreach.io",
      path: "/api/public/li_account/GetAccountProxy/123",
      why: "returns a custom proxy's username and password (GetAccountProxy)",
    },
    {
      host: "api.heyreach.io",
      path: "/api/public/management/organizations/api-keys/workspaces/5421",
      why: "returns the workspace's API and integration keys (GetWorkspaceApiKeys)",
    },
    {
      host: "api.heyreach.io",
      path: "/api/public/webhooks/GetWebhookById?webhookId=1&includeCustomHeaders=true",
      why: "returns the custom headers a webhook sends (Get Webhook By Id)",
    },
  ],
};

/** Catalogs that keep Other reads on Needs approval (no opt-in) with no
 * SENSITIVE_READS case, each with the reason. Every other catalog opts in,
 * so a new catalog has to land in one list or the other on purpose. */
const HELD = new Set([
  ...Object.keys(SENSITIVE_READS),
  // `unlisted: "block"`: Always allow is invalid, and Query-protocol services
  // run any Action, deletes included, as a GET.
  "aws",
  "aws-role",
  // Its read wildcard (`read_all`, GET on /v1/* and /v2/*) already covers
  // every Stripe GET, so the catch-all only decides a request the catalog
  // never claimed. Holding it keeps that a deliberate choice for an API
  // that moves money, not an inherited one.
  "stripe",
  // `unlisted: "block"`: the database front door judges every statement as
  // one of the catalog's three requests, so no unlisted request exists.
  "postgres",
]);

const AGENT = "agent-1";
const CONNECTION = "conn-1";

/** The default attach's stack as the evaluator reads it: grant rows naming
 * the agent, bound to the connection that wins injection. */
const defaultStack = (provider: string): NewRule[] =>
  compileConnectionStack(
    "Grant: a · c",
    provider,
    defaultConnectionGrant(provider),
  ).map((rule, i) => ({
    scope: "workspace",
    priority: i,
    isDefault: false,
    source: "grant",
    name: rule.name,
    identities: [{ type: "agent", id: AGENT }],
    targets: [
      {
        kind: "connection",
        connectionId: CONNECTION,
        provider,
        tools: rule.tools,
        method: rule.method ?? null,
      },
    ],
    action: rule.action,
    requireApproval: rule.requireApproval,
    rateLimit: null,
    rateLimitWindow: null,
    conditions: null,
  }));

describe("default Other reads: opt-in per audited catalog", () => {
  const definitions = getAppPermissionDefinitions();

  it("every catalog is either opted in or held on purpose", () => {
    for (const def of definitions) {
      expect(defaultOtherReads(def), def.provider).toBe(
        HELD.has(def.provider) ? "ask" : "allow",
      );
    }
  });

  it("no catalog that blocks unlisted requests opts in", () => {
    for (const def of definitions.filter((d) => d.unlisted === "block")) {
      expect(def.unlistedReads, def.provider).toBeUndefined();
    }
  });

  // `exhaustive` hides the "Not listed above" rows. That is honest only when
  // nothing outside the tools can be allowed or held: the catalog must also
  // block unlisted requests, or the hidden rows would still decide them.
  it("every exhaustive catalog blocks unlisted requests", () => {
    const exhaustive = definitions.filter((d) => d.exhaustive);
    expect(exhaustive.map((d) => d.provider)).toContain("postgres");
    for (const def of exhaustive) {
      expect(def.unlisted, def.provider).toBe("block");
    }
  });

  it.each(
    Object.entries(SENSITIVE_READS).flatMap(([provider, reads]) =>
      reads.map((read) => [provider, read.why, read] as const),
    ),
  )("%s: the default grant holds a GET that %s", (provider, _why, read) => {
    const decision = evaluateNew(defaultStack(provider), {
      host: read.host,
      path: read.path,
      method: "GET",
      agentId: AGENT,
      hasInjections: true,
      isLlmHost: false,
      winningConnectionId: CONNECTION,
    });
    expect(decision).toMatchObject({ action: "allow", requireApproval: true });
  });
});
