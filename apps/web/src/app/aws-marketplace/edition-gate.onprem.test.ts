import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BEHAVIORAL proof that the AWS Marketplace web surface is dark on a
 * self-host — executes the real route handlers, page component, and server
 * actions under the onprem edition and observes the refusals (the
 * source-level pins in edition-gate.test.ts guard the gates' presence;
 * this file proves what they DO). Cloud-arm sanity checks confirm the
 * gates are edition checks, not unconditional dead ends.
 */

// Onprem before the module graph loads: NEXT_PUBLIC_EDITION deleted →
// parseEdition → onprem → IS_CLOUD false, frozen at `@/lib/env` load
// (hence vi.hoisted). EDITION deleted too — an ambient shell value would
// silently flip every arm below.
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
  delete process.env.EDITION;
});

// notFound()/redirect() never return in production — throwing mocks keep a
// page from executing past a guard and hiding the exact bug under test.
const nav = vi.hoisted(() => ({
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((to: string): never => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));
vi.mock("next/navigation", () => nav);

// Observability probes for what must NOT happen off cloud.
const probes = vi.hoisted(() => ({
  cookieReads: 0,
  sessionReads: 0,
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

vi.mock("@/lib/auth/server", () => ({
  getServerSession: async () => {
    probes.sessionReads += 1;
    return { email: "admin@example.test" };
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

// The api-package service: reaching this off cloud IS the leak this suite
// exists to rule out.
vi.mock("@onecli/api/ee/billing/aws-marketplace/service", () => ({
  registerMarketplaceCustomer: async () => {
    probes.registerCalls += 1;
    return {
      status: "pending",
      entitledAgents: 0,
      contractExpiresAt: null,
    };
  },
  AwsMarketplaceError: class AwsMarketplaceError extends Error {},
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/aws-marketplace/fulfill/route";
import AwsMarketplaceRegisterPage from "@/app/aws-marketplace/register/page";
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
  new NextRequest("https://selfhost.example.test/aws-marketplace/fulfill", {
    method: init?.method ?? "GET",
    body: init?.body,
    headers: init?.headers,
  });

beforeEach(() => {
  probes.cookieReads = 0;
  probes.sessionReads = 0;
  probes.registerCalls = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("onprem: the marketplace web surface answers dark", () => {
  it("POST /aws-marketplace/fulfill is a plain 404 and parks no cookie", async () => {
    const body = new URLSearchParams({
      "x-amzn-marketplace-token": "real-looking-token",
    });
    const res = await POST(
      fulfillRequest({
        method: "POST",
        body,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(res.status).toBe(404);
    // No Set-Cookie: the token must not be parked on a self-host.
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("GET /aws-marketplace/fulfill is a plain 404, not a redirect", async () => {
    const res = await GET(fulfillRequest());
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("the register page notFounds before touching session or cookies", async () => {
    await expect(
      AwsMarketplaceRegisterPage({
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(probes.sessionReads).toBe(0);
    expect(probes.cookieReads).toBe(0);
  });

  it("hasPendingMarketplaceToken reports none without reading cookies", async () => {
    await expect(hasPendingMarketplaceToken()).resolves.toBe(false);
    expect(probes.cookieReads).toBe(0);
  });

  it("completeMarketplaceRegistration refuses before any registration runs", async () => {
    // The cookie mock would hand it a valid-shaped token and the resolver a
    // real admin context — the gate must refuse before any of that matters.
    const result = await completeMarketplaceRegistration();
    expect(result).toEqual({
      ok: false,
      error: "Not available on this deployment.",
    });
    expect(probes.registerCalls).toBe(0);
    expect(probes.cookieReads).toBe(0);
  });
});
