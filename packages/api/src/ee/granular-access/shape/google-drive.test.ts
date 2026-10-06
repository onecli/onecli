import { describe, expect, it } from "vitest";
import { validateGoogleDrivePolicy } from "./google-drive";

const ok = (policy: Record<string, unknown>) =>
  expect(validateGoogleDrivePolicy(null, policy)).resolves.toBeUndefined();
const bad = (policy: Record<string, unknown>) =>
  expect(validateGoogleDrivePolicy(null, policy)).rejects.toThrow();
const chainOf = (depth: number) =>
  Array.from({ length: depth }, (_, i) => `f${i}`).join("/");

describe("validateGoogleDrivePolicy", () => {
  it("accepts folder-ID chains and the unrestricted shapes", async () => {
    await ok({ driveFolders: ["0AbcSharedDrive/1xyz-_A"] });
    await ok({ driveFolders: ["1solo"] });
    await ok({});
    await ok({ driveFolders: [] });
    // Drive's deepest legal nesting.
    await ok({ driveFolders: [chainOf(100)] });
  });

  it("rejects anything the gateway could not verify", async () => {
    await bad({ driveFolders: "1solo" });
    await bad({ driveFolders: ["/My Drive/x"] });
    await bad({ driveFolders: ["a//b"] });
    await bad({ driveFolders: ["a'b"] });
    await bad({ driveFolders: [""] });
    await bad({ driveFolders: [42] });
    await bad({ driveFolders: Array.from({ length: 101 }, (_, i) => `f${i}`) });
    await bad({ driveFolders: [chainOf(101)] });
  });
});
