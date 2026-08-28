import { beforeEach, describe, expect, it, vi } from "vitest";

// The key-health probe's DEGRADATION law, with the db mocked at the boundary
// (the scan's SQL semantics are proven by secret-service.pg.test.ts against
// real PG): health is decoration on the secrets list, so a failed request-log
// probe must degrade that host's badge to null — never fail the list itself.

const dbMock = vi.hoisted(() => ({
  secret: { findMany: vi.fn() },
  requestLog: { findFirst: vi.fn() },
}));

vi.mock("@onecli/db", () => ({ db: dbMock, Prisma: { JsonNull: null } }));

import { listSecrets } from "./secret-service";

const anthropicKey = {
  id: "sec-1",
  name: "Anthropic key",
  type: "anthropic",
  valueSource: "inline",
  opRef: null,
  hostPattern: "api.anthropic.com",
  pathPattern: null,
  injectionConfig: null,
  metadata: null,
  scope: "workspace",
  createdAt: new Date("2026-08-01T00:00:00Z"),
};

const SCOPE = { workspaceId: "ws-1", organizationId: "org-1" };

describe("listSecrets key-health degradation", () => {
  beforeEach(() => {
    dbMock.secret.findMany.mockReset();
    dbMock.requestLog.findFirst.mockReset();
    dbMock.secret.findMany.mockResolvedValue([anthropicKey]);
  });

  it("positive control: a branding probe result reaches the row", async () => {
    const at = new Date();
    dbMock.requestLog.findFirst.mockResolvedValue({
      status: 401,
      createdAt: at,
    });

    const rows = await listSecrets(SCOPE);
    expect(rows[0]?.lastError).toEqual({ status: 401, at });
  });

  it("a failed probe degrades to no badge — never a failed secrets list", async () => {
    dbMock.requestLog.findFirst.mockRejectedValue(
      new Error("db connection reset"),
    );

    const rows = await listSecrets(SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastError).toBeNull();
  });
});
