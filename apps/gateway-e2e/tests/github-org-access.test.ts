import { gzipSync } from "node:zlib";

import { describe, expect } from "vitest";

import {
  startForwardProxy,
  type ProxiedRequest,
  type ProxiedResponse,
} from "../src/forward-proxy.js";
import { throughProxy } from "../src/proxy.js";
import { scenario, type Cx } from "../src/scenario.js";

/**
 * GitHub organization access, end to end through the real binary: the GitHub
 * OAuth connection injects into `api.github.com`, GitHub answers 403 because
 * one organization refused the token, and the gateway answers the agent with
 * guidance, records the refusal on the connection, and clears it only once
 * the refused endpoint answers again.
 *
 * Hermetic: `api.github.com` is reached through a local forward proxy that
 * plays GitHub (the same pattern as navan.test.ts), answering with the exact
 * shapes GitHub sends: the OAuth-restriction message (gzipped when the client
 * accepts gzip, as GitHub does) and the `X-GitHub-SSO` header. Every org,
 * repo and token is made up.
 */
const GH = "http://api.github.com";

const RESTRICTED = (org: string): string =>
  JSON.stringify({
    message: `Although you appear to have the correct authorization credentials, the \`${org}\` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited. For more information on these restrictions, including how to enable this app, visit https://docs.github.com/articles/restricting-access-to-your-organization-s-data/`,
    documentation_url: "https://docs.github.com/rest",
  });

/** GitHub's refusal, gzipped exactly when the client asked for gzip. */
const restricted = (req: ProxiedRequest, org: string): ProxiedResponse => {
  const body = RESTRICTED(org);
  return (req.header("accept-encoding") ?? "").includes("gzip")
    ? {
        status: 403,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-encoding": "gzip",
        },
        body: gzipSync(body),
      }
    : {
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
        body,
      };
};

const ok: ProxiedResponse = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: "[]",
};

const GITHUB_CONNECTION = {
  provider: "github",
  label: "octo",
} as const;

const WORLD = {
  grantAll: true,
  appConnections: [{ ...GITHUB_CONNECTION, metadata: { username: "octo" } }],
};

/** The connection's stored metadata, read straight from the database. */
const storedMetadata = async (cx: Cx): Promise<Record<string, unknown>> => {
  const row = await cx.db.prisma.appConnection.findUniqueOrThrow({
    where: { id: `${cx.ids.workspace}-conn-0` },
    select: { metadata: true },
  });
  return (row.metadata ?? {}) as Record<string, unknown>;
};

/** The record write runs off the request path: wait for it to land. */
const eventually = async <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> => {
  for (let i = 0; i < 50; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return read();
};

describe("GitHub organization access (wire-level)", () => {
  scenario(
    "a gzipped approval refusal becomes guidance and is recorded on the connection",
    async (cx) => {
      await cx.seed(WORLD);
      const proxy = await startForwardProxy({
        respond: (req) => restricted(req, "Acme-Labs"),
      });
      try {
        const gw = await cx.startGateway({
          env: {
            HTTP_PROXY: proxy.url,
            HTTPS_PROXY: proxy.url,
            NO_PROXY: "127.0.0.1",
          },
        });
        const res = await throughProxy(gw.origin, {
          url: `${GH}/repos/acme-labs/api/pulls/7`,
          token: cx.ids.agentToken,
          // What curl --compressed, Node fetch, Python requests and Go send.
          headers: { "accept-encoding": "gzip, deflate" },
          timeoutMs: 30_000,
        });

        // GitHub really was asked, with the connection's token and the
        // client's gzip preference.
        expect(proxy.requests()).toHaveLength(1);
        expect(proxy.requests()[0]?.header("authorization")).toBe(
          "Bearer e2e-oauth-0",
        );
        expect(proxy.requests()[0]?.header("accept-encoding")).toContain(
          "gzip",
        );

        // The agent gets the gateway's own plain-JSON guidance.
        expect(res.status).toBe(403);
        expect(res.header("x-should-retry")).toBe("false");
        expect(res.header("content-encoding")).toBeUndefined();
        expect(res.json()).toMatchObject({
          error: "github_org_access_required",
          provider: "github",
          org: "acme-labs",
          reason: "approval_required",
        });
        // The link opens the GitHub app page naming the org, as the
        // dashboard and the chat card parse it.
        const link = new URL(
          (res.json() as { connect_url: string }).connect_url,
        );
        expect(link.pathname).toBe(
          `/w/${cx.ids.workspace}/connections/apps/github`,
        );
        expect(link.searchParams.get("org_access")).toBe("acme-labs");

        // The refusal lands on the connection, the profile kept beside it.
        const md = await eventually(
          () => storedMetadata(cx),
          (m) => m.githubOrgAccess !== undefined,
        );
        expect(md.username).toBe("octo");
        expect(md.githubOrgAccess).toEqual({
          "acme-labs": {
            reason: "approval_required",
            write: false,
            endpoint: "repos/acme-labs/api/pulls",
          },
        });
      } finally {
        await proxy.close();
      }
    },
  );

  scenario(
    "an SSO refusal never hands the agent GitHub's per-call SSO link",
    async (cx) => {
      await cx.seed(WORLD);
      const proxy = await startForwardProxy({
        respond: () => ({
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-github-sso":
              "required; url=https://github.com/orgs/Acme/sso?authorization_request=E2E-ONE-TIME",
          },
          body: JSON.stringify({
            message: "Resource protected by organization SAML enforcement.",
          }),
        }),
      });
      try {
        const gw = await cx.startGateway({
          env: {
            HTTP_PROXY: proxy.url,
            HTTPS_PROXY: proxy.url,
            NO_PROXY: "127.0.0.1",
          },
        });
        const res = await throughProxy(gw.origin, {
          url: `${GH}/repos/Acme/api`,
          token: cx.ids.agentToken,
          timeoutMs: 30_000,
        });
        expect(res.status).toBe(403);
        expect(res.json()).toMatchObject({
          error: "github_org_access_required",
          org: "acme",
          reason: "sso_required",
        });
        expect(res.body).not.toContain("authorization_request");
        expect(res.header("x-github-sso")).toBeUndefined();
      } finally {
        await proxy.close();
      }
    },
  );

  scenario(
    "only the refused endpoint answering clears the record; the org's public side does not",
    async (cx) => {
      await cx.seed({
        ...WORLD,
        appConnections: [
          {
            ...GITHUB_CONNECTION,
            metadata: {
              username: "octo",
              githubOrgAccess: {
                "acme-labs": {
                  reason: "approval_required",
                  write: false,
                  endpoint: "repos/acme-labs/api/pulls",
                },
              },
            },
          },
        ],
      });
      // GitHub now lets the token in (approval granted): every call is 200.
      const proxy = await startForwardProxy({ respond: () => ok });
      try {
        const gw = await cx.startGateway({
          env: {
            HTTP_PROXY: proxy.url,
            HTTPS_PROXY: proxy.url,
            NO_PROXY: "127.0.0.1",
          },
        });
        const get = (path: string) =>
          throughProxy(gw.origin, {
            url: `${GH}${path}`,
            token: cx.ids.agentToken,
            timeoutMs: 30_000,
          });

        // The org's public side answers whether or not it approved OneCLI:
        // these successes prove nothing, so the record stays.
        expect((await get("/orgs/acme-labs")).status).toBe(200);
        expect((await get("/orgs/acme-labs/repos")).status).toBe(200);
        expect(
          (await get("/repos/acme-labs/api/contents/README.md")).status,
        ).toBe(200);
        await new Promise((r) => setTimeout(r, 500));
        expect((await storedMetadata(cx)).githubOrgAccess).toBeDefined();

        // The refused endpoint itself answers (any case): proof, cleared.
        expect(
          (await get("/repos/Acme-Labs/API/pulls?state=open")).status,
        ).toBe(200);
        const md = await eventually(
          () => storedMetadata(cx),
          (m) => m.githubOrgAccess === undefined,
        );
        expect(md.githubOrgAccess).toBeUndefined();
        expect(md.username).toBe("octo");
      } finally {
        await proxy.close();
      }
    },
  );

  scenario(
    "any other GitHub 403 reaches the agent byte for byte, and records nothing",
    async (cx) => {
      await cx.seed(WORLD);
      const body = JSON.stringify({
        message: "Must have admin rights to Repository.",
      });
      const proxy = await startForwardProxy({
        respond: () => ({
          status: 403,
          headers: { "content-type": "application/json" },
          body,
        }),
      });
      try {
        const gw = await cx.startGateway({
          env: {
            HTTP_PROXY: proxy.url,
            HTTPS_PROXY: proxy.url,
            NO_PROXY: "127.0.0.1",
          },
        });
        const res = await throughProxy(gw.origin, {
          url: `${GH}/repos/acme-labs/api/hooks`,
          token: cx.ids.agentToken,
          timeoutMs: 30_000,
        });
        expect(res.status).toBe(403);
        expect(res.body).toBe(body);
        await new Promise((r) => setTimeout(r, 500));
        expect((await storedMetadata(cx)).githubOrgAccess).toBeUndefined();
      } finally {
        await proxy.close();
      }
    },
  );
});
