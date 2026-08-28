import { describe, expect, it } from "vitest";
import { isProviderRefusal, isTrialCreditExhausted } from "./provider-refusal";

/** The gateway's real trial-credit 403 body, as the harness wraps it (the
 * shape observed live in dev — prose mentions no refusal token, so without
 * its own code this fell through to the raw red-box passthrough). */
const TRIAL_CREDIT_403 =
  'Anthropic API error (403 Forbidden): {"add_key_url":"https://app-dev.onecli.sh/w/x/connections/llms","error":"trial_credit_exhausted","limit_usd":5.0,"message":"Your free OneCLI trial credit ($5.00) is used up. Add your own Anthropic API key in the OneCLI dashboard to keep going: https://app-dev.onecli.sh/w/x/connections/llms","period":"total"}';

describe("isTrialCreditExhausted", () => {
  it("classifies the gateway's budget_exceeded body", () => {
    expect(isTrialCreditExhausted(TRIAL_CREDIT_403)).toBe(true);
  });

  it("matches the code, not prose — a message merely quoting the words does not classify", () => {
    expect(
      isTrialCreditExhausted("Error: the budget exceeded our expectations"),
    ).toBe(false);
    expect(isTrialCreditExhausted("harness event stream ended")).toBe(false);
    // The ORG-budget sibling keeps its own code and the raw passthrough:
    // its message names an admin-configured budget, which is accurate there.
    expect(
      isTrialCreditExhausted(
        '{"error":"budget_exceeded","message":"This organization\'s spend budget for the anthropic key ($50.00 this month) has been reached."}',
      ),
    ).toBe(false);
  });

  // The supervisor checks trial-credit FIRST, so this pair documents the
  // handoff: the same body must not ALSO read as a generic provider refusal
  // (whose "check the model key" copy would misdirect — there is no key).
  it("the trial-credit body is not a generic provider refusal", () => {
    expect(isProviderRefusal(TRIAL_CREDIT_403)).toBe(false);
  });
});

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
