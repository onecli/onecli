import { describe, expect, it } from "vitest";

import { buildCodexOAuthStub } from "./codex-stubs";

const decodeClaims = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as {
    "https://api.openai.com/auth": Record<string, string>;
  };

const parse = (stub: string) =>
  JSON.parse(stub) as {
    tokens: Record<string, string>;
  };

describe("buildCodexOAuthStub", () => {
  it("carries the vaulted ChatGPT account id, so Codex's workspace check finds it", () => {
    const { tokens } = parse(buildCodexOAuthStub({ accountId: "acc_123" }));

    expect(tokens.account_id).toBe("acc_123");
    expect(
      decodeClaims(tokens.id_token!)["https://api.openai.com/auth"]
        .chatgpt_account_id,
    ).toBe("acc_123");
  });

  it("keeps every credential a placeholder", () => {
    const { tokens } = parse(buildCodexOAuthStub({ accountId: "acc_123" }));

    expect(tokens.access_token).toBe("onecli-managed");
    expect(tokens.refresh_token).toBe("onecli-managed");
  });

  it.each([undefined, null, ""])(
    "falls back to the placeholder account id without one (%s)",
    (accountId) => {
      const { tokens } = parse(buildCodexOAuthStub({ accountId }));

      expect(tokens.account_id).toBe("onecli-managed");
      expect(
        decodeClaims(tokens.id_token!)["https://api.openai.com/auth"]
          .chatgpt_account_id,
      ).toBe("onecli-managed");
    },
  );

  it("stamps the vaulted ChatGPT plan, so Codex doesn't treat a paid plan as free", () => {
    const { tokens } = parse(
      buildCodexOAuthStub({ accountId: "acc_123", planType: "plus" }),
    );

    expect(
      decodeClaims(tokens.id_token!)["https://api.openai.com/auth"]
        .chatgpt_plan_type,
    ).toBe("plus");
  });

  it.each([undefined, null, ""])(
    "leaves the plan claim out rather than guessing one (%s)",
    (planType) => {
      const { tokens } = parse(
        buildCodexOAuthStub({ accountId: "acc_123", planType }),
      );

      expect(
        decodeClaims(tokens.id_token!)["https://api.openai.com/auth"],
      ).not.toHaveProperty("chatgpt_plan_type");
    },
  );

  it("never advertises the free plan by default", () => {
    const { tokens } = parse(buildCodexOAuthStub());

    expect(
      decodeClaims(tokens.id_token!)["https://api.openai.com/auth"],
    ).toEqual({
      chatgpt_user_id: "onecli-managed",
      chatgpt_account_id: "onecli-managed",
    });
  });
});
