import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `refusal` is where a failed response becomes an `ApiError`, and callers
 * branch on its `status`. The behavior worth pinning: a body that parses as
 * JSON but isn't the `{ error }` envelope, or whose message isn't a string,
 * still yields an `ApiError` with the response's status instead of throwing
 * while the message is read.
 */

const apiFetch =
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
vi.mock("@/lib/api-fetch", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetch(path, init),
}));

const { ApiError, apiPost, refusal, refusalMessage } = await import("./client");

beforeEach(() => {
  apiFetch.mockReset();
});

describe("refusalMessage", () => {
  it.each([
    [
      "a nested envelope",
      { error: { message: "Try again later", type: "busy" } },
      "Try again later",
    ],
    [
      "a bare string",
      { error: "Already on this plan" },
      "Already on this plan",
    ],
    ["an empty string", { error: "" }, ""],
    ["null", null, null],
    ["an array", [], null],
    ["a number", 42, null],
    ["no error key", { message: "stray" }, null],
    ["a null error", { error: null }, null],
    ["a numeric message", { error: { message: 42 } }, null],
    ["an object message", { error: { message: { a: 1 } } }, null],
    [
      "an uncallable toString",
      { error: { message: { toString: null } } },
      null,
    ],
  ])("reads %s", (_label, body, expected) => {
    expect(refusalMessage(body)).toBe(expected);
  });
});

describe("refusal", () => {
  it.each([
    ["null", "Request failed: 409"],
    ['{"error":{"message":{"toString":null}}}', "Request failed: 409"],
    ['{"error":{"message":42}}', "Request failed: 409"],
    ['{"error":"Already on this plan"}', "Already on this plan"],
    [
      '{"error":{"message":"Try again later","type":"busy"}}',
      "Try again later",
    ],
    ['{"error":""}', ""],
  ])("keeps the status for the body %s", async (body, message) => {
    const error = refusal(new Response(body, { status: 409 }));
    await expect(error).resolves.toBeInstanceOf(ApiError);
    await expect(error).resolves.toMatchObject({ status: 409, message });
  });
});

describe("the JSON verbs", () => {
  it("reject with the response status when the error body is null", async () => {
    apiFetch.mockResolvedValue(new Response("null", { status: 409 }));
    const error = await apiPost("/v1/example", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409 });
  });
});
