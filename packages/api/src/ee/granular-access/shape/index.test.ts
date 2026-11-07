import { describe, expect, it } from "vitest";
import { validatePolicyShape } from "./index";

describe("validatePolicyShape", () => {
  // The gateway refuses every request under a policy on another provider's
  // axis, so no provider may store one.
  it.each([
    ["google-drive", { folders: ["/x"] }],
    ["google-drive", { repositories: ["o/r"] }],
    ["dropbox", { driveFolders: ["A"] }],
    ["dropbox", { repositories: ["o/r"] }],
    ["github-app", { folders: ["/x"] }],
    ["github-app", { driveFolders: ["A"] }],
  ])("refuses a foreign axis on %s: %j", async (provider, policy) => {
    await expect(validatePolicyShape(provider, null, policy)).rejects.toThrow(
      /scoped with/,
    );
  });

  it("passes each provider's own axis to its validator", async () => {
    await expect(
      validatePolicyShape("google-drive", null, { driveFolders: ["A/B"] }),
    ).resolves.toBeUndefined();
    await expect(
      validatePolicyShape("dropbox", null, { folders: ["/x"] }),
    ).resolves.toBeUndefined();
    await expect(
      validatePolicyShape(
        "github-app",
        { repos: ["o/r"] },
        {
          repositories: ["o/r"],
        },
      ),
    ).resolves.toBeUndefined();
    // Providers without granular scoping are accepted as-is.
    await expect(
      validatePolicyShape("slack", null, { folders: ["/x"] }),
    ).resolves.toBeUndefined();
  });
});
