import { describe, expect, it } from "vitest";
import { onpremPolicyValidator } from "./policy-onprem-validator";
import { validatePolicyShape } from "../ee/granular-access/shape";

// The onprem edition's default policy validator is SHAPE-ONLY: the same
// provider-shape validation as cloud's `eePolicyValidator`, minus the plan
// gate. Granular scoping is stored and the one enforcing gateway executes it —
// the former hard-422 "locks" (and the cloud-only `validateTargets` fence) are
// gone. Deliberately db-free: shape validation must never need an org lookup.

describe("onpremPolicyValidator.validate (shape-only, no plan gate)", () => {
  it("accepts a provider without a granular config (no lock)", async () => {
    await expect(
      onpremPolicyValidator.validate("org-1", "github", null, {
        repositories: ["a/b"],
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts github-app repositories present on the installation", async () => {
    await expect(
      onpremPolicyValidator.validate(
        "org-1",
        "github-app",
        { repos: ["acme/api", "acme/web"] },
        { repositories: ["acme/api"] },
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects github-app repositories missing from the installation (the shared shape rule)", async () => {
    await expect(
      onpremPolicyValidator.validate(
        "org-1",
        "github-app",
        { repos: ["acme/api"] },
        { repositories: ["acme/other"] },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("acme/other"),
    });
  });

  it("accepts absolute dropbox folder paths and rejects relative ones", async () => {
    await expect(
      onpremPolicyValidator.validate("org-1", "dropbox", null, {
        folders: ["/Work/Reports"],
      }),
    ).resolves.toBeUndefined();
    await expect(
      onpremPolicyValidator.validate("org-1", "dropbox", null, {
        folders: ["not-absolute"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("is exactly the shared shape half (parity with the cloud validator)", async () => {
    // `eePolicyValidator` = plan gate + `validatePolicyShape`; onprem =
    // `validatePolicyShape` alone. Same input through both paths must reach
    // the same verdict, so the editions can never drift apart silently.
    const metadata = { repos: ["acme/api"] };
    const policy = { repositories: ["acme/ghost"] };
    const viaOnprem = await onpremPolicyValidator
      .validate("org-1", "github-app", metadata, policy)
      .catch((e: unknown) => e);
    const viaShape = await validatePolicyShape(
      "github-app",
      metadata,
      policy,
    ).catch((e: unknown) => e);
    expect(viaOnprem).toBeInstanceOf(Error);
    expect((viaOnprem as Error).message).toBe((viaShape as Error).message);
  });
});

describe("onpremPolicyValidator.validateTargets", () => {
  it("is absent — all providers are allowed (the one-catalog gateway enforces them)", () => {
    // Absent = permissive per the PolicyValidator contract; a cloud-only
    // provider in an app target is no longer rejected on onprem.
    expect(onpremPolicyValidator.validateTargets).toBeUndefined();
  });
});
