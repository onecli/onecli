import { describe, expect, it } from "vitest";
import {
  WEBHOOK_FAILURE_DISABLE_THRESHOLD,
  createWebhookSchema,
  updateWebhookSchema,
  webhookRunOutcome,
} from "./webhooks";

describe("webhookRunOutcome", () => {
  it("a success resets the streak", () => {
    expect(webhookRunOutcome("done", 4)).toEqual({
      lastOutcome: "ok",
      consecutiveFailures: 0,
    });
  });

  it("a failure counts, and the threshold turns the webhook off with a reason", () => {
    expect(webhookRunOutcome("failed", 0)).toEqual({
      lastOutcome: "failed",
      consecutiveFailures: 1,
    });
    expect(
      webhookRunOutcome("failed", WEBHOOK_FAILURE_DISABLE_THRESHOLD - 1),
    ).toEqual({
      lastOutcome: "failed",
      consecutiveFailures: WEBHOOK_FAILURE_DISABLE_THRESHOLD,
      enabled: false,
      disabledReason: "failures",
    });
  });

  it("a human stop books nothing", () => {
    expect(webhookRunOutcome("aborted", 3)).toBeNull();
  });
});

describe("the route schemas", () => {
  it("create needs both fields, trimmed and bounded", () => {
    expect(
      createWebhookSchema.safeParse({ name: "  Hook ", instructions: " x " })
        .data,
    ).toEqual({ name: "Hook", instructions: "x" });
    expect(createWebhookSchema.safeParse({ name: "Hook" }).success).toBe(false);
    expect(
      createWebhookSchema.safeParse({ name: "Hook", instructions: "x", a: 1 })
        .success,
    ).toBe(false);
  });

  it("update refuses an empty patch and unknown keys", () => {
    expect(updateWebhookSchema.safeParse({}).success).toBe(false);
    expect(updateWebhookSchema.safeParse({ token: "x" }).success).toBe(false);
    expect(updateWebhookSchema.safeParse({ enabled: false }).success).toBe(
      true,
    );
  });
});
