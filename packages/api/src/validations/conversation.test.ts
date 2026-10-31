import { describe, expect, it } from "vitest";

import * as conversation from "./conversation";
import { isRawErrorPayload } from "./conversation";

describe("transcript-rejection recovery", () => {
  it("asks for a fresh restart without promising signed-history repair", () => {
    const message = conversation.TURN_FAILURE_COPY.transcript_rejected?.message;
    expect(message).toBe(conversation.TRANSCRIPT_REJECTED_MESSAGE);
    expect(message).toContain(
      "restart the agent from its menu in the dashboard",
    );
    expect(message).toContain("start it fresh");
    expect(message).not.toMatch(/in a little while|repair the history/);
  });
});

describe("model-endpoint 404 copy", () => {
  it("names the endpoint and the operator, never the key", () => {
    const entry = conversation.TURN_FAILURE_COPY.model_endpoint_not_found;
    expect(entry?.code).toBe("model_endpoint_not_found");
    expect(entry?.message).toBe(conversation.MODEL_ENDPOINT_NOT_FOUND_MESSAGE);
    expect(entry?.message).toContain("model endpoint");
    expect(entry?.message).toContain("model name");
    expect(entry?.message).toContain("contact whoever operates this agent");
    expect(entry?.message).not.toMatch(/\bkey\b/i);
  });
});

describe("TURN_FAILURE_COPY", () => {
  it("tells an agent with an unreadable key to re-enter it, not that it hit a limit", () => {
    // The agent HAS the key (the gateway's `credential_unavailable`), so the
    // provider-refusal copy ("usually a usage limit or an expired key") and
    // the attach copy would both send the person to the wrong fix.
    const entry = conversation.TURN_FAILURE_COPY.model_key_unreadable;
    expect(entry?.code).toBe("model_key_unreadable");
    expect(entry?.message).toBe(conversation.MODEL_KEY_UNREADABLE_MESSAGE);
    expect(entry?.message).toContain("Re-enter the key");
    expect(entry?.message).not.toMatch(/usage limit|attach/i);
  });

  it("keys every entry by its own code, and every code is a turn code", () => {
    // A code the allowlist stores but `TURN_ERROR_CODES` lacks would be a
    // value the web's types say cannot exist.
    const codes: readonly string[] = conversation.TURN_ERROR_CODES;
    for (const [wire, entry] of Object.entries(
      conversation.TURN_FAILURE_COPY,
    )) {
      expect(entry?.code).toBe(wire);
      expect(codes).toContain(wire);
    }
  });

  it("names who can change a policy block without claiming its scope", () => {
    // An org rule or org budget is not a workspace admin's to change.
    const message = conversation.TURN_FAILURE_COPY.blocked_by_policy?.message;
    expect(message).toBe(conversation.BLOCKED_BY_POLICY_MESSAGE);
    expect(message).toContain("An admin can review it");
    expect(message).not.toMatch(/workspace admin/i);
  });
});

describe("isRawErrorPayload", () => {
  it.each([
    // The agent runtime's wrapper around a provider's error body: a 5xx no
    // key can fix, and a context overflow that resending never fixes.
    'Claude API error (500 Internal Server Error): {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_011CXYZ"}',
    'Claude API error (400 Bad Request): {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
    // OpenAI's envelope, compact and pretty-printed.
    'OpenAI API error (404 Not Found): {"error":{"message":"The model `gpt-x` does not exist","type":"invalid_request_error","code":"model_not_found"}}',
    '{\n  "error": {\n    "message": "Bad gateway",\n    "type": "server_error"\n  }\n}',
    // A body quoted inside another string (escaped quotes).
    'Error: "{\\"error\\":{\\"message\\":\\"upstream connect error\\"}}"',
    // A proxy's HTML error page.
    "Claude API error (502 Bad Gateway): <html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body></body></html>",
    "<!DOCTYPE html><html><body>Service Unavailable</body></html>",
    // The gateway could not reach the model provider at all (the laptop's
    // internet dropped, DNS, TLS), stored by a supervisor that sent no code.
    'Anthropic API error (502 Bad Gateway): {"error":"upstream_unreachable","host":"api.anthropic.com","message":"Could not reach api.anthropic.com (DNS, connection, or TLS failure). Check the hostname: it may not exist. This is not a credential or connection problem."}',
    // Same body quoted inside another string.
    'Error: "{\\"error\\":\\"upstream_unreachable\\",\\"host\\":\\"api.openai.com\\"}"',
  ])("flags a raw payload: %s", (error) => {
    expect(isRawErrorPayload(error)).toBe(true);
  });

  it.each([
    // The gateway's own refusals: a flat string code beside a readable
    // message that names the rule or the budget. Passthrough is deliberate.
    'Claude API error (403 Forbidden): {"error":"blocked_by_policy","message":"Blocked by OneCLI policy rule \\"no-anthropic\\". POST /v1/messages is not allowed."}',
    '{"error":"budget_exceeded","message":"This organization\'s spend budget for the anthropic key ($50.00 this month) has been reached, so the key is paused."}',
    // Ordinary sentences are the useful answer.
    "harness event stream ended unexpectedly",
    "I couldn't finish because the repository is read-only.",
    "Failed to run `git push`: permission denied",
    "Request failed with 429 Too Many Requests",
    "The npm install failed because the registry timed out.",
    'Set "error" to false in the config and retry.',
    "",
  ])("leaves a sentence alone: %s", (error) => {
    expect(isRawErrorPayload(error)).toBe(false);
  });

  it("never matches the platform's own failure copy", () => {
    // A coded failure's `turn.error` IS this copy, and the surfaces apply the
    // check without looking at the code: a canonical sentence that matched
    // would be swapped for the generic one.
    const copy = Object.entries(conversation).flatMap(
      ([name, value]: [string, unknown]) =>
        name.endsWith("_MESSAGE") && typeof value === "string" ? [value] : [],
    );
    expect(copy.length).toBeGreaterThan(10);
    for (const message of copy) {
      expect(isRawErrorPayload(message), message).toBe(false);
    }
  });
});
