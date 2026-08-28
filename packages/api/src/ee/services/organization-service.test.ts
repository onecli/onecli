import { beforeEach, describe, expect, it, vi } from "vitest";

// `createOrganization` first checks the free-org quota
// (`organizationMember.count`), then delegates to `bootstrapOrganization`, whose
// first db call is `organization.create`. Mock both: the count stays under the
// cap so we reach the create, and the create throws whatever `state.createError`
// holds. A stub `PrismaClientKnownRequestError` stands in for the real Prisma
// class — the service's `instanceof Prisma.PrismaClientKnownRequestError` check
// resolves against this same stub, so no live Prisma client is needed.
const h = vi.hoisted(() => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
      this.name = "PrismaClientKnownRequestError";
    }
  }
  return {
    PrismaClientKnownRequestError,
    state: { createError: undefined as unknown },
  };
});

vi.mock("@onecli/db", () => ({
  Prisma: { PrismaClientKnownRequestError: h.PrismaClientKnownRequestError },
  db: {
    organizationMember: { count: async () => 0 },
    // `bootstrapOrganization` reads the owner's display name for the
    // workspace name before creating anything.
    user: { findUnique: async () => ({ name: null }) },
    organization: {
      create: async () => {
        throw h.state.createError;
      },
    },
  },
}));

import { createOrganization } from "./organization-service";
import { ServiceError } from "../../services/errors";

beforeEach(() => {
  h.state.createError = undefined;
});

describe("createOrganization", () => {
  it("translates a duplicate-name slug collision (P2002) into a friendly CONFLICT", async () => {
    h.state.createError = new h.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`slug`)",
      "P2002",
    );

    try {
      await createOrganization("user-1", "user@example.com", "Acme Inc");
      expect.unreachable("should have thrown a CONFLICT");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      const svc = err as ServiceError;
      expect(svc.code).toBe("CONFLICT");
      // Names the org and stays free of the raw Prisma leak.
      expect(svc.message).toContain("Acme Inc");
      expect(svc.message).not.toMatch(/prisma|constraint|P2002/i);
    }
  });

  it("rethrows non-P2002 errors unchanged (no false 'name taken')", async () => {
    const boom = new Error("connection reset");
    h.state.createError = boom;

    await expect(
      createOrganization("user-1", "user@example.com", "Acme Inc"),
    ).rejects.toBe(boom);
  });
});
