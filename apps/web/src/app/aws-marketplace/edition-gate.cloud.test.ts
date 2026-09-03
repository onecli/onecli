import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cloud-arm counterpart of edition-gate.onprem.test.ts: the same real
 * handlers/actions under the cloud edition must WORK — proving the onprem
 * refusals are edition gates, not unconditional dead ends that would break
 * the hosted flow too.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  delete process.env.EDITION;
});

const probes = vi.hoisted(() => ({
  cookieReads: 0,
  registerCalls: 0,
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    probes.cookieReads += 1;
    return {
      get: () => ({ value: "fake:123456789012" }),
      delete: () => {},
    };
  },
}));

vi.mock("@/lib/actions/resolve-user", () => ({
  resolveOrgContextWithRole: async () => ({
    userId: "u1",
    userEmail: "admin@example.test",
    organizationId: "org-1",
    role: "admin",
  }),
}));

vi.mock("@onecli/api/ee/billing/aws-marketplace/service", () => ({
  registerMarketplaceCustomer: async () => {
    probes.registerCalls += 1;
    return {
      status: "subscribed",
      entitledAgents: 10,
      contractExpiresAt: null,
    };
  },
  AwsMarketplaceError: class AwsMarketplaceError extends Error {},
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/aws-marketplace/fulfill/route";
import {
  completeMarketplaceRegistration,
  hasPendingMarketplaceToken,
} from "@/ee/billing/aws-marketplace/actions";

interface FulfillInit {
  method?: string;
  body?: URLSearchParams;
  headers?: Record<string, string>;
}

const fulfillRequest = (init?: FulfillInit) =>
  new NextRequest("https://onecli.sh/aws-marketplace/fulfill", {
    method: init?.method ?? "GET",
    body: init?.body,
    headers: init?.headers,
  });

beforeEach(() => {
  probes.cookieReads = 0;
  probes.registerCalls = 0;
});

describe("cloud: the same surface works", () => {
  it("POST /aws-marketplace/fulfill parks the token and redirects to register", async () => {
    const body = new URLSearchParams({
      "x-amzn-marketplace-token": "opaque-aws-token",
    });
    const res = await POST(
      fulfillRequest({
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/aws-marketplace/register");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("aws-mp-token=");
    expect(cookie).toContain("HttpOnly");
  });

  it("GET /aws-marketplace/fulfill redirects to register", async () => {
    const res = await GET(fulfillRequest());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/aws-marketplace/register");
  });

  it("the actions run: token visible, registration reaches the service", async () => {
    await expect(hasPendingMarketplaceToken()).resolves.toBe(true);
    const result = await completeMarketplaceRegistration();
    expect(result.ok).toBe(true);
    expect(result.status).toBe("subscribed");
    expect(probes.registerCalls).toBe(1);
  });
});
