import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  createArgs: undefined as Record<string, unknown> | undefined,
  createThrowsP2002: false,
  findFirstResult: null as Record<string, unknown> | null,
  updateArgs: undefined as Record<string, unknown> | undefined,
  deleteCount: 0,
}));

vi.mock("@onecli/db", () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return {
    Prisma: { PrismaClientKnownRequestError },
    db: {
      organizationDomain: {
        findMany: async () => state.rows,
        findFirst: async () => state.findFirstResult,
        create: async (args: Record<string, unknown>) => {
          if (state.createThrowsP2002) {
            throw new PrismaClientKnownRequestError("P2002");
          }
          state.createArgs = args;
          return { id: "dom-1", ...(args.data as Record<string, unknown>) };
        },
        update: async (args: Record<string, unknown>) => {
          state.updateArgs = args;
          return { id: "dom-1", verifiedAt: new Date() };
        },
        deleteMany: async () => ({ count: state.deleteCount }),
      },
    },
  };
});

import {
  createDomain,
  verifyDomain,
  deleteDomain,
  TXT_RECORD_PREFIX,
  type TxtResolver,
} from "./org-domain-service";
import { ServiceError } from "../../services/errors";

beforeEach(() => {
  state.rows = [];
  state.createArgs = undefined;
  state.createThrowsP2002 = false;
  state.findFirstResult = null;
  state.updateArgs = undefined;
  state.deleteCount = 0;
});

const pendingRow = {
  id: "dom-1",
  domain: "acme.com",
  verificationToken: "tok123",
  verifiedAt: null,
  createdAt: new Date(),
};

describe("createDomain", () => {
  it("normalizes case and punycodes unicode domains", async () => {
    await createDomain("org-1", "  ÜNïCode.Example  ", "user-1");
    const data = state.createArgs?.data as { domain: string };
    expect(data.domain).toBe("xn--ncode-cta3g.example");
  });

  it("strips a trailing dot", async () => {
    await createDomain("org-1", "acme.com.", "user-1");
    const data = state.createArgs?.data as { domain: string };
    expect(data.domain).toBe("acme.com");
  });

  it("rejects invalid shapes", async () => {
    await expect(createDomain("org-1", "not a domain", "u")).rejects.toThrow(
      "valid domain",
    );
    await expect(createDomain("org-1", "nodot", "u")).rejects.toThrow(
      "valid domain",
    );
  });

  it("rejects public email providers", async () => {
    await expect(createDomain("org-1", "GMAIL.com", "u")).rejects.toThrow(
      "Public email providers",
    );
    expect(state.createArgs).toBeUndefined();
  });

  it("maps the global-unique violation to CONFLICT", async () => {
    state.createThrowsP2002 = true;
    try {
      await createDomain("org-1", "acme.com", "u");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("CONFLICT");
    }
  });
});

describe("verifyDomain", () => {
  const resolverWith =
    (records: string[][]): TxtResolver =>
    async () =>
      records;

  it("verifies when the TXT record matches exactly", async () => {
    state.findFirstResult = { ...pendingRow };
    const resolver = resolverWith([
      ["some-other-record"],
      [`${TXT_RECORD_PREFIX}tok123`],
    ]);
    await verifyDomain("org-1", "dom-1", resolver);
    expect(state.updateArgs?.data).toMatchObject({
      verifiedAt: expect.any(Date),
    });
  });

  it("joins chunked TXT records before matching", async () => {
    state.findFirstResult = { ...pendingRow };
    const resolver = resolverWith([[TXT_RECORD_PREFIX, "tok123"]]);
    await expect(
      verifyDomain("org-1", "dom-1", resolver),
    ).resolves.toBeDefined();
  });

  it("fails with the propagation message when the record is missing", async () => {
    state.findFirstResult = { ...pendingRow };
    const resolver = resolverWith([["unrelated"]]);
    await expect(verifyDomain("org-1", "dom-1", resolver)).rejects.toThrow(
      "TXT record not found",
    );
    expect(state.updateArgs).toBeUndefined();
  });

  it("treats resolver errors (ENOTFOUND) as a missing record", async () => {
    state.findFirstResult = { ...pendingRow };
    const resolver: TxtResolver = async () => {
      throw new Error("queryTxt ENOTFOUND acme.com");
    };
    await expect(verifyDomain("org-1", "dom-1", resolver)).rejects.toThrow(
      "TXT record not found",
    );
  });

  it("is idempotent for already-verified domains (no DNS call)", async () => {
    state.findFirstResult = { ...pendingRow, verifiedAt: new Date() };
    const resolver: TxtResolver = async () => {
      throw new Error("should not be called");
    };
    await expect(
      verifyDomain("org-1", "dom-1", resolver),
    ).resolves.toBeDefined();
    expect(state.updateArgs).toBeUndefined();
  });

  it("404s for a domain outside the org (scoped lookup)", async () => {
    state.findFirstResult = null;
    await expect(verifyDomain("org-1", "foreign-id")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("deleteDomain", () => {
  it("deletes org-scoped rows", async () => {
    state.deleteCount = 1;
    await expect(deleteDomain("org-1", "dom-1")).resolves.toBeUndefined();
  });

  it("404s when nothing matched (wrong org or id)", async () => {
    state.deleteCount = 0;
    await expect(deleteDomain("org-1", "foreign-id")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
