import { describe, expect, it } from "vitest";
import { isProviderRefusal } from "./provider-refusal";

describe("isProviderRefusal", () => {
  it.each([
    // Anthropic error types, as jcode wraps them (type string embedded).
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
    '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    '{"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource"}}',
    '{"type":"error","error":{"type":"billing_error","message":"This organization has been disabled"}}',
    '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    // Anthropic credits prose.
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    // OpenAI: the canonical quota message, and the invalid-key CODE (its
    // type is invalid_request_error, which alone must NOT classify).
    "You exceeded your current quota, please check your plan and billing details.",
    '{"error":{"message":"Incorrect API key provided: sk-abc***","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}',
    // Subscription-style prose limits — sentences, not typed JSON.
    "You've reached your usage limit. Your limit will reset at 3pm.",
    "Rate limit reached. Please wait before sending another message.",
  ])("classifies a provider refusal: %s", (message) => {
    expect(isProviderRefusal(message)).toBe(true);
  });

  it.each([
    // The 400 catch-all is NOT a key problem: context overflow can never
    // succeed on resend, so it must keep the raw passthrough.
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 214937 tokens > 200000 maximum"}}',
    // Provider-side 500s: no key change fixes these, and the harness's
    // generic "API Error" wrapper alone must not classify.
    'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    // Harness deaths and transport faults.
    "harness event stream ended unexpectedly",
    "Error: harness connection closed",
    "harness launch failed: spawn ENOENT",
    // A terminal error merely QUOTING billing-adjacent words (a tool name,
    // echoed request text) is not a refusal.
    "Error: tool billing-report failed: file not found",
    // "operate limits" must not ride the rate-limit token.
    "Error: the sandbox cannot operate limits on this volume",
  ])("keeps the raw passthrough for: %s", (message) => {
    expect(isProviderRefusal(message)).toBe(false);
  });

  it.each([
    // The gateway's OWN policy refusals ride the same wire (model traffic is
    // proxied) and would otherwise match the rate-limit token — but the fix
    // is the policy rule, never the model key, so the raw text (which names
    // the rule) must survive.
    'API Error: 429 {"error":"rate_limited","message":"This request was rate-limited by an OneCLI policy rule.","limit":10,"window":"1m"}',
    'API Error: 403 {"error":"blocked_by_policy","message":"Blocked by OneCLI policy rule \\"Block usage limits probing\\"."}',
    '{"error":"access_restricted","message":"Credentials exist for this host but none are assigned to this agent."}',
  ])("never re-dresses a OneCLI policy refusal: %s", (message) => {
    expect(isProviderRefusal(message)).toBe(false);
  });
});
