import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TURN_FAILURE_CODES } from "@onecli/agent-protocol";
import { describe, expect, it } from "vitest";
import {
  isModelEndpointNotFound,
  isProviderRefusal,
  isTranscriptRejected,
  isTrialCreditExhausted,
  terminalErrorClass,
} from "./provider-refusal";

/** The #1194 terminal error in the exact shape jcode relays it (ids made
 * up). */
const TRANSCRIPT_400 =
  'Anthropic API error (400 Bad Request): {"type":"error","error":{"type":"invalid_request_error","message":"messages.814: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01AAAAAAAAAAAAAAAAAAAAAA, toolu_01BBBBBBBBBBBBBBBBBBBBBB. Each `tool_use` block must have a corresponding `tool_result` block in the next message."},"request_id":"req_011CAAAAAAAAAAAAAAAAAAAA"}';

/** An agent that read a `.ico`: the stored image's media type is refused on
 * every turn after (Anthropic's wording; request id made up). */
const UNSUPPORTED_IMAGE_400 =
  'Anthropic API error (400 Bad Request): {"type":"error","error":{"type":"invalid_request_error","message":"messages.720.content.0.tool_result.content.1.image.source.base64.media_type: Input should be \'image/jpeg\', \'image/png\', \'image/gif\' or \'image/webp\'"},"request_id":"req_011CBBBBBBBBBBBBBBBBBBBB"}';

/** A rejected encrypted search result in saved history. Request id is fake. */
const SEARCH_RESULT_REPLAY_400 =
  'Anthropic API error (400 Bad Request): {"type":"error","error":{"type":"invalid_request_error","message":"messages.67.content.0: Invalid `encrypted_content` in `search_result` block"},"request_id":"req_011CCCCCCCCCCCCCCCCCCCCC"}';

/** A replayed thinking block whose signature no longer verifies. */
const THINKING_SIGNATURE_400 =
  'Anthropic API error (400 Bad Request): {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.0: Invalid `signature` in `thinking` block"},"request_id":"req_011CDDDDDDDDDDDDDDDDDDDD"}';

describe("isTranscriptRejected", () => {
  it.each([
    TRANSCRIPT_400,
    // The duplicate-result sibling: also the transcript, also forever.
    'Anthropic API error (400 Bad Request): {"type":"error","error":{"type":"invalid_request_error","message":"messages.12.content.0: unexpected `tool_use_id` found in `tool_result` blocks: toolu_01. Each `tool_result` block must have a corresponding `tool_use` block in the previous message."}}',
    UNSUPPORTED_IMAGE_400,
    SEARCH_RESULT_REPLAY_400,
    THINKING_SIGNATURE_400,
    // The public content-block name and unquoted field spelling.
    "Invalid encrypted_content in web_search_result block",
  ])("classifies the provider rejecting the stored conversation: %s", (m) => {
    expect(isTranscriptRejected(m)).toBe(true);
  });

  it.each([
    TRANSCRIPT_400,
    UNSUPPORTED_IMAGE_400,
    SEARCH_RESULT_REPLAY_400,
    THINKING_SIGNATURE_400,
  ])("is never a key problem: %s", (m) => {
    expect(isProviderRefusal(m)).toBe(false);
  });

  it.each([
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 214937 tokens > 200000 maximum"}}',
    "harness event stream ended unexpectedly",
    // A tool's own output that merely mentions the block names.
    "Error: the tool_use tool_result parser failed",
    // Prose that names the field without the provider's rejection shape.
    "the encrypted_content field was empty in the search_result",
    // A signature error outside the provider's known history blocks is not
    // evidence that restarting the conversation will help.
    "Invalid signature in jwt block",
    "Invalid encrypted_content in custom block",
    "Invalid signature in search_result block",
    "Invalid encrypted_content in thinking block",
    "Invalid signature in thinking blockage",
    // OpenAI's encrypted-reasoning size limit: a different failure (jcode
    // compacts it away), not a signature that no longer verifies.
    'OpenAI API error (400): {"error":{"message":"encrypted_content is too large","type":"invalid_request_error"}}',
  ])("does not claim unrelated failures: %s", (m) => {
    expect(isTranscriptRejected(m)).toBe(false);
  });
});

/** The gateway's real trial-credit 403 body, as the harness wraps it (the
 * shape observed live — prose mentions no refusal token, so without
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

/** A proxy in front of the provider forwarding to a path the backend does
 * not serve, behind jcode's Anthropic wrapper. */
const PROXY_WRONG_PATH_404 =
  'Anthropic API error (404 Not Found): {"error":{"code":"404","message": "Resource not found"}}';

describe("isModelEndpointNotFound", () => {
  it.each([
    PROXY_WRONG_PATH_404,
    // The other wrapper spelling the harness uses.
    'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-nonexistent"}}',
    // A proxy's HTML 404 page behind the wrapper.
    "Anthropic API error (404 Not Found): <html><body><h1>404 Not Found</h1></body></html>",
  ])("classifies a model-endpoint 404: %s", (message) => {
    expect(isModelEndpointNotFound(message)).toBe(true);
  });

  it("is not a key problem and not a damaged transcript", () => {
    expect(isProviderRefusal(PROXY_WRONG_PATH_404)).toBe(false);
    expect(isTranscriptRejected(PROXY_WRONG_PATH_404)).toBe(false);
  });

  it.each([
    // A tool's own output merely quoting a 404 is not the model endpoint.
    "Error: GET https://example.com/data returned 404 Not Found",
    "HTTP 404 from the docs site",
    // Other model-endpoint statuses keep their own handling.
    'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 214937 tokens > 200000 maximum"}}',
    // A status that merely starts with 404 is not 404.
    "API Error: 4040 something",
    // The gateway's OWN 404 names its fix; it is not the model endpoint.
    'API Error: 404 {"error":"credential_not_found","message":"No credentials configured for api.example.com in OneCLI."}',
  ])("keeps the raw passthrough for: %s", (message) => {
    expect(isModelEndpointNotFound(message)).toBe(false);
  });
});

/** The gateway's `access_restricted` answer on a model call, in the exact
 * shape jcode relays it (ids made up). */
const ACCESS_RESTRICTED_401 =
  'Anthropic API error (401 Unauthorized): {"error":"access_restricted","manage_url":"http://localhost:10254/w/ws/agents/a1/models","message":"api.anthropic.com credentials exist in OneCLI but this agent does not have access. Ask the user to attach the key to this agent: http://localhost:10254/w/ws/agents/a1/models","provider":"api.anthropic.com"}';

describe("terminalErrorClass", () => {
  it.each([
    // A missing grant is not a broken key, though its prose would match.
    [ACCESS_RESTRICTED_401, TURN_FAILURE_CODES.modelKeyNotAttached],
    [
      'API Error: 403 {"error":"blocked_by_policy","message":"Blocked by OneCLI policy rule \\"x\\"."}',
      TURN_FAILURE_CODES.blockedByPolicy,
    ],
    [
      'API Error: 429 {"error":"rate_limited","message":"This request was rate-limited by an OneCLI policy rule.","limit":10}',
      TURN_FAILURE_CODES.blockedByPolicy,
    ],
    [
      'Anthropic API error (401 Unauthorized): {"error":"credential_unavailable","message":"stored value could not be read"}',
      TURN_FAILURE_CODES.modelKeyUnreadable,
    ],
    [
      'API Error: 503 {"error":"gateway_restarting","message":"The gateway is restarting."}',
      TURN_FAILURE_CODES.gatewayUnavailable,
    ],
    // Quoted inside another string, the quotes arrive escaped.
    [
      '{"detail":"{\\"error\\":\\"upstream_timeout\\",\\"message\\":\\"slow\\"}"}',
      TURN_FAILURE_CODES.gatewayUnavailable,
    ],
    // The gateway's own 404 is its code's class, never the endpoint copy.
    [
      'API Error: 404 {"error":"credential_not_found","message":"No credentials configured for api.example.com in OneCLI."}',
      TURN_FAILURE_CODES.modelProviderError,
    ],
    // Each non-gateway class keeps its place in the order.
    [TRANSCRIPT_400, TURN_FAILURE_CODES.transcriptRejected],
    [TRIAL_CREDIT_403, TURN_FAILURE_CODES.trialCreditExhausted],
    [
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
      TURN_FAILURE_CODES.modelProviderError,
    ],
    [PROXY_WRONG_PATH_404, TURN_FAILURE_CODES.modelEndpointNotFound],
  ])("classifies %s", (message, code) => {
    expect(terminalErrorClass(message)).toBe(code);
  });

  it.each([
    // A provider's NESTED error object is never a gateway code.
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}',
    // An unknown flat code keeps the raw passthrough.
    '{"error":"some_future_code","message":"x"}',
    // Prototype names are never classes.
    '{"error":"constructor"}',
    "harness event stream ended unexpectedly",
  ])("keeps the raw passthrough for: %s", (message) => {
    expect(terminalErrorClass(message)).toBeUndefined();
  });

  it("classifies every code the gateway answers a proxied request with", () => {
    // The request path's vocabulary, read from the gateway's sources: the
    // proxy crate's response builders and the licensed per-request ones.
    // Control-plane routes (approval decisions, org admin) never answer a
    // model call, and test code only asserts on bodies the gateway forwards,
    // so both stay out. A code this misses would reach the chat as raw JSON.
    const crates = fileURLToPath(
      new URL("../../gateway/crates", import.meta.url),
    );
    const isTestFile = (name: string) => /(^|_)tests?\.rs$/.test(name);
    const rustFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return rustFiles(path);
        return name.endsWith(".rs") && !isTestFile(name) ? [path] : [];
      });
    const sources = [
      ...rustFiles(join(crates, "proxy/src")),
      join(crates, "ee/ee/src/response.rs"),
    ];
    const emitted = new Set<string>();
    for (const file of sources) {
      // Production code only: each file's trailing test module asserts on
      // provider bodies (`invalid_grant`, ...) the gateway forwards.
      const text = readFileSync(file, "utf8");
      const testModule = text.search(/#\[cfg\(test\)\]\s*mod tests/);
      const source = testModule === -1 ? text : text.slice(0, testModule);
      for (const shape of [
        /"error"\s*:\s*"([a-z_]+)"/g,
        /ERROR(?:_[A-Z_]+)?: &str = "([a-z_]+)"/g,
        // A code chosen at runtime is returned as `("<code>", format!(...))`.
        /\(\s*"([a-z_]+)",\s*format!/g,
      ]) {
        for (const match of source.matchAll(shape)) {
          if (match[1]) emitted.add(match[1]);
        }
      }
    }
    // Floors on the scan itself, so a source move cannot empty it silently.
    expect(emitted.size).toBeGreaterThan(20);
    expect(emitted).toContain("budget_exceeded");
    expect(emitted).toContain("trial_credit_exhausted");
    const unclassified = [...emitted].filter(
      (code) =>
        terminalErrorClass(JSON.stringify({ error: code })) === undefined,
    );
    expect(unclassified).toEqual([]);
  });
});
