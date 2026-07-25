import { describe, expect, it } from "vitest";
import { ossPolicyValidator } from "./policy-oss-locks";
import { ServiceError } from "./errors";
import type { PolicyTargetInput } from "../validations/policy";

// The OSS edition's policy locks. These run against the DEFAULT registries —
// exactly what an OSS process sees (no initEeApps): base apps available, the
// shared EE-stub list (aws-role, datadog, …) present with `available: false`.

describe("ossPolicyValidator.validate (granular session policy)", () => {
  it("rejects unconditionally with the cloud-only message", async () => {
    await expect(
      ossPolicyValidator.validate("org-1", "github", null, {
        repositories: ["a/b"],
      }),
    ).rejects.toMatchObject({
      code: "UNPROCESSABLE",
      message:
        "Granular resource scoping (repositories/folders) is available on OneCLI Cloud.",
    });
  });
});

describe("ossPolicyValidator.validateTargets (cloud-only apps)", () => {
  const run = (targets: PolicyTargetInput[]) =>
    ossPolicyValidator.validateTargets!(targets);

  it("rejects an app target for a cloud-only (EE-stub) provider, naming the app", async () => {
    const err = await run([{ kind: "app", provider: "aws-role" }]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("UNPROCESSABLE");
    expect((err as ServiceError).message).toBe(
      "AWS Role connections are available on OneCLI Cloud.",
    );
  });

  it("rejects when the cloud-only target is mixed among valid ones", async () => {
    await expect(
      run([
        { kind: "network", hostPattern: "api.example.com" },
        { kind: "app", provider: "datadog" },
      ]),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });

  it("accepts a base (connectable) app", async () => {
    await expect(
      run([{ kind: "app", provider: "github" }]),
    ).resolves.toBeUndefined();
  });

  it("accepts an UNKNOWN provider string (typos, and onprem-style excluded apps, stay non-fatal)", async () => {
    await expect(
      run([{ kind: "app", provider: "not-a-real-app" }]),
    ).resolves.toBeUndefined();
  });

  it("ignores non-app target kinds", async () => {
    await expect(
      run([
        { kind: "network", hostPattern: "*.x.com" },
        { kind: "secret", secretScope: "project" },
        { kind: "connection", connectionId: "conn-1" },
      ]),
    ).resolves.toBeUndefined();
  });

  it("accepts an empty target list", async () => {
    await expect(run([])).resolves.toBeUndefined();
  });
});
