import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api-fetch";
import {
  saveCredentials,
  type SaveCredentialsRequest,
} from "./connect-credentials";
vi.mock("@/lib/api-fetch", () => ({ apiFetch: vi.fn() }));
const fetchMock = vi.mocked(apiFetch);
const input: SaveCredentialsRequest = {
  appId: "postgres",
  scope: { kind: "workspace", workspaceId: "w" },
  body: { fields: { password: "secret" } },
};
beforeEach(() => {
  fetchMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});
describe("credential save client", () => {
  it.each(["workspace", "organization"] as const)(
    "saves in explicit %s scope and overrides ambient opposite scope",
    async (kind) => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ success: true, connectionId: "id" })),
      );
      const scope =
        kind === "workspace"
          ? { kind, workspaceId: "w" }
          : { kind, organizationId: "o" };
      await expect(saveCredentials({ ...input, scope })).resolves.toEqual({
        success: true,
        connectionId: "id",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        kind === "workspace"
          ? "/v1/apps/postgres/connect"
          : "/v1/org/apps/postgres/connect",
        expect.objectContaining({
          headers: {
            "X-Workspace-Id": kind === "workspace" ? "w" : "",
            "X-Organization-Id": kind === "organization" ? "o" : "",
          },
        }),
      );
    },
  );
  it.each([
    {},
    { success: true },
    { success: true, connectionId: " " },
    {
      success: true,
      connectionId: "id",
      connection: { id: "other", label: null },
    },
  ])("rejects malformed saved response %j", async (body) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(saveCredentials(input)).rejects.toThrow(
      "invalid saved connection",
    );
  });
  it.each(["Save refused", { message: "Save refused" }])(
    "uses shared refusal parser for %j",
    async (error) => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error }), { status: 403 }),
      );
      await expect(saveCredentials(input)).rejects.toThrow("Save refused");
    },
  );
  it("retains ambient/default scope for an ordinary workspace connect without an explicit ID", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, connectionId: "id" })),
    );
    await expect(
      saveCredentials({
        ...input,
        scope: { kind: "workspace", workspaceId: undefined },
      }),
    ).resolves.toEqual({ success: true, connectionId: "id" });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });
  it("rejects missing organization scope before sending credentials", async () => {
    await expect(
      saveCredentials({
        ...input,
        scope: { kind: "organization", organizationId: undefined },
      }),
    ).rejects.toThrow("explicit connection scope");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["", " "])(
    "rejects explicitly blank workspace scope %j rather than falling back to ambient",
    async (workspaceId) => {
      await expect(
        saveCredentials({
          ...input,
          scope: { kind: "workspace", workspaceId },
        }),
      ).rejects.toThrow("explicit connection scope");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each(["request", "body"])(
    "bounds stalled %s with a deadline",
    async (stage) => {
      vi.useFakeTimers();
      if (stage === "request")
        fetchMock.mockImplementation(() => new Promise(() => {}));
      else {
        const response = new Response();
        vi.spyOn(response, "json").mockImplementation(
          () => new Promise(() => {}),
        );
        fetchMock.mockResolvedValue(response);
      }
      const result = expect(saveCredentials(input)).rejects.toThrow(
        "timed out",
      );
      await vi.advanceTimersByTimeAsync(25_000);
      await result;
      const signal = fetchMock.mock.calls[0]?.[1]?.signal;
      expect(signal?.aborted).toBe(true);
    },
  );
});
