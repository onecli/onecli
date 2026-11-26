import { describe, expect, it } from "vitest";
import { loggablePath } from "./loggable-path";

describe("loggablePath", () => {
  it("redacts the webhook token, which is a credential", () => {
    expect(loggablePath("/v1/hooks/whk_secret-token")).toBe(
      "/v1/hooks/[redacted]",
    );
  });
  it("redacts the legacy /api alias the api-server rewrites onto /v1", () => {
    expect(loggablePath("/api/hooks/whk_secret-token")).toBe(
      "/api/hooks/[redacted]",
    );
  });
  it("leaves every other path alone", () => {
    expect(loggablePath("/v1/agents/a1/webhooks")).toBe(
      "/v1/agents/a1/webhooks",
    );
    expect(loggablePath("/v1/hooks")).toBe("/v1/hooks");
  });
});
