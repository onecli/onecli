import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ PREVIEW_DOMAIN: "" }));
vi.mock("../lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/env")>()),
  get PREVIEW_DOMAIN() {
    return env.PREVIEW_DOMAIN;
  },
}));

const { checkProposalHost, proposalRefusalMessage } =
  await import("./custom-connection-policy");

describe("checkProposalHost", () => {
  beforeEach(() => {
    vi.stubEnv("ONECLI_EXTERNAL_URL", "https://app.onecli-test.dev");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    env.PREVIEW_DOMAIN = "";
  });

  it("lets an unknown third-party host through", () => {
    expect(checkProposalHost({ hostPattern: "api.acmecrm.io" })).toBeNull();
  });

  it("refuses OneCLI's own domain, whatever the subdomain", () => {
    expect(checkProposalHost({ hostPattern: "evil.onecli-test.dev" })).toEqual({
      kind: "onecli_host",
    });
  });

  it("refuses the sandbox preview zone: its hosts run agent-written code", () => {
    expect(
      checkProposalHost({ hostPattern: "x.previews-test.dev" }),
    ).toBeNull();
    env.PREVIEW_DOMAIN = "previews-test.dev";
    expect(checkProposalHost({ hostPattern: "x.previews-test.dev" })).toEqual({
      kind: "onecli_host",
    });
  });

  it.each([
    "api.anthropic.com",
    "api.openai.com",
    "chatgpt.com",
    "api.groq.com",
    "generativelanguage.googleapis.com",
  ])("refuses the model provider host %s: its key is a model key", (host) => {
    const refusal = checkProposalHost({ hostPattern: host });
    expect(refusal).toEqual({ kind: "llm_host" });
    expect(refusal && proposalRefusalMessage(refusal)).toMatch(/Models page/);
  });

  it("lets an unlisted service on a shared developer platform through", () => {
    // Ownership is the registrable domain, and these are public suffixes or
    // domains no single catalog app owns.
    for (const hostPattern of [
      "translation.googleapis.com",
      "abc123.execute-api.us-east-1.amazonaws.com",
      "acme.azurewebsites.net",
    ]) {
      expect(checkProposalHost({ hostPattern }), hostPattern).toBeNull();
    }
  });

  it.each([
    ["acme.jfrog.io", "jfrog-artifactory"],
    ["acme.my.salesforce.com", "salesforce"],
    ["acme-prod.snowflakecomputing.com", "snowflake"],
  ])(
    "refuses a host-bound app's tenant host %s, even with no tool catalog",
    (hostPattern, appId) => {
      expect(checkProposalHost({ hostPattern })).toMatchObject({
        kind: "catalog_app",
        appId,
      });
    },
  );

  it("refuses a host owned by a catalog app and points at the real app", () => {
    const refusal = checkProposalHost({ hostPattern: "api.github.com" });
    expect(refusal).toMatchObject({ kind: "catalog_app", appId: "github" });
    expect(refusal && proposalRefusalMessage(refusal)).toMatch(
      /built-in OneCLI app/,
    );
    // Same registrable domain, unlisted host: still GitHub's.
    expect(
      checkProposalHost({ hostPattern: "uploads.github.com" }),
    ).toMatchObject({ kind: "catalog_app" });
  });

  it.each([
    "echo.postman-echo.com",
    "abc123.webhook.site",
    "x.ngrok-free.app",
    "some-words.trycloudflare.com",
    "eo1.m.pipedream.net",
    "*.oastify.com",
  ])("refuses the request-bin / echo / tunnel host %s", (hostPattern) => {
    const refusal = checkProposalHost({ hostPattern });
    expect(refusal).toMatchObject({ kind: "reflector_host" });
    expect(refusal && proposalRefusalMessage(refusal)).toMatch(
      /echo or tunnel service/,
    );
  });
});
