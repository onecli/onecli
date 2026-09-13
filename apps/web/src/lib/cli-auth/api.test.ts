import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `confirmCliSession` rides raw `apiFetch` (it needs a custom header) and
 * parses its own refusal, so it is the one door outside the JSON verbs where
 * a body that is not the `{ error }` envelope can reach a person. The confirm
 * screen renders `error.message` verbatim: it must be the server's words or
 * this file's own fallback, never a `TypeError` from reading the body.
 */

const apiFetch =
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
vi.mock("@/lib/api-fetch", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init),
}));

const { confirmCliSession } = await import("./api");

beforeEach(() => {
  apiFetch.mockReset();
});

describe("confirmCliSession refusals", () => {
  it.each([
    ["null", "Failed to confirm"],
    ['{"error":{"message":{"toString":null}}}', "Failed to confirm"],
    ['{"error":{"message":"Code expired","type":"gone"}}', "Code expired"],
    ['{"error":"Workspace required"}', "Workspace required"],
    ["<html>bad gateway</html>", "Failed to confirm"],
  ])("renders a sentence for the body %s", async (body, message) => {
    apiFetch.mockResolvedValue(new Response(body, { status: 410 }));
    const error = await confirmCliSession("ABCD-1234", "ws_1").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ message });
  });

  it("sends the chosen workspace as the tenancy header", async () => {
    apiFetch.mockResolvedValue(new Response(null, { status: 204 }));
    await confirmCliSession("ABCD-1234", "ws_1");
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/auth/cli/confirm",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "ABCD-1234" }),
        headers: { "X-Workspace-Id": "ws_1" },
      }),
    );
  });
});
