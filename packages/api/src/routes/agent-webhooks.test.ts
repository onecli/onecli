import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { webhookReceiveRoutes } from "./agent-webhooks";
import { ServiceError } from "../services/errors";
import { errorHandler } from "../middleware/error-handler";

/**
 * The public catch URL's HTTP contract (POST /v1/hooks/:token). The fire
 * semantics live in services/agent-webhook.pg.test.ts; the service is mocked
 * here so this file is about status codes, the body-size cap, and the one
 * house error shape every refusal wears.
 */

const receiveWebhook = vi.hoisted(() => vi.fn());

vi.mock("../services/agent-webhook-service", () => ({
  receiveWebhook,
  createWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  listWebhooks: vi.fn(),
  updateWebhook: vi.fn(),
}));
vi.mock("../validations/webhooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../validations/webhooks")>()),
  MAX_WEBHOOK_BODY_BYTES: 1024,
}));

const app = new Hono().route("/v1/hooks", webhookReceiveRoutes());
app.onError(errorHandler);
const post = (body: string, token = "whk_abc") =>
  app.request(`/v1/hooks/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

/** The `{ error: { message, type } }` shape the rest of /v1 answers with. */
const errorBody = async (res: Response) =>
  (await res.json()) as { error: { message: string; type: string } };

beforeEach(() => {
  receiveWebhook.mockReset();
});

describe("POST /v1/hooks/:token", () => {
  it("accepts with 202 and hands the raw body and content type to the service", async () => {
    receiveWebhook.mockResolvedValue("accepted");
    const res = await post('{"meeting":1}');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(receiveWebhook).toHaveBeenCalledWith(
      "whk_abc",
      '{"meeting":1}',
      "application/json",
    );
  });

  it("answers 404 for an unknown or disabled token, in the house error shape", async () => {
    receiveWebhook.mockResolvedValue("not_found");
    const res = await post("{}");
    expect(res.status).toBe(404);
    expect(await errorBody(res)).toEqual({
      error: { message: "Not found", type: "not_found_error" },
    });
  });

  it("answers 429 when the webhook's queue is full, never accepting and dropping", async () => {
    receiveWebhook.mockRejectedValue(new ServiceError("CONFLICT", "full"));
    const res = await post("{}");
    expect(res.status).toBe(429);
    expect((await errorBody(res)).error.type).toBe("rate_limit_error");
  });

  it("refuses an oversized body with 413 before reaching the service", async () => {
    const res = await post("x".repeat(2048));
    expect(res.status).toBe(413);
    expect((await errorBody(res)).error.message).toBe("Payload too large");
    expect(receiveWebhook).not.toHaveBeenCalled();
  });

  it("answers any other method with a 404 that never echoes the token", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await app.request("/v1/hooks/whk_secret", { method });
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain("whk_secret");
    }
    expect(receiveWebhook).not.toHaveBeenCalled();
  });
});
