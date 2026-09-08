import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  cliAuthSession: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  apiKey: {
    findUnique: vi.fn(),
  },
}));

vi.mock("@onecli/db", () => ({ db: dbMock }));

import { pollCliAuthSession } from "./cli-auth-service";

const CODE = "abc123";
const API_KEY = `oc_${"a".repeat(64)}`;
const FUTURE = new Date(Date.now() + 60_000);

describe("pollCliAuthSession — atomic consume", () => {
  beforeEach(() => {
    dbMock.cliAuthSession.findUnique.mockReset();
    dbMock.cliAuthSession.updateMany.mockReset();
    dbMock.apiKey.findUnique.mockReset();
  });

  it("returns the api key only when the consume update wins", async () => {
    dbMock.cliAuthSession.findUnique.mockResolvedValue({
      status: "confirmed",
      apiKey: API_KEY,
      expiresAt: FUTURE,
    });
    dbMock.cliAuthSession.updateMany.mockResolvedValue({ count: 1 });
    dbMock.apiKey.findUnique.mockResolvedValue({ workspaceId: "ws-1" });

    await expect(pollCliAuthSession(CODE)).resolves.toEqual({
      status: "ok",
      api_key: API_KEY,
      workspace_id: "ws-1",
    });

    expect(dbMock.cliAuthSession.updateMany).toHaveBeenCalledWith({
      where: { code: CODE, status: "confirmed", apiKey: { not: null } },
      data: { apiKey: null, status: "consumed" },
    });
  });

  it("does not return the api key when another poll already consumed it", async () => {
    dbMock.cliAuthSession.findUnique.mockResolvedValue({
      status: "confirmed",
      apiKey: API_KEY,
      expiresAt: FUTURE,
    });
    dbMock.cliAuthSession.updateMany.mockResolvedValue({ count: 0 });

    await expect(pollCliAuthSession(CODE)).resolves.toEqual({
      status: "expired",
    });
    expect(dbMock.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it("treats an already-consumed session as expired", async () => {
    dbMock.cliAuthSession.findUnique.mockResolvedValue({
      status: "consumed",
      apiKey: null,
      expiresAt: FUTURE,
    });

    await expect(pollCliAuthSession(CODE)).resolves.toEqual({
      status: "expired",
    });
    expect(dbMock.cliAuthSession.updateMany).not.toHaveBeenCalled();
  });
});
