import { describe, expect, it } from "vitest";
import { exitCodeOf } from "./exec-backend";

describe("exitCodeOf", () => {
  it("maps Success to 0", () => {
    expect(exitCodeOf({ status: "Success" })).toBe(0);
  });

  it("extracts the guest exit code from NonZeroExitCode causes", () => {
    expect(
      exitCodeOf({
        status: "Failure",
        reason: "NonZeroExitCode",
        details: {
          causes: [{ reason: "ExitCode", message: "42" }],
        },
      }),
    ).toBe(42);
  });

  it("collapses failures without an honest code to 1", () => {
    expect(exitCodeOf({ status: "Failure", reason: "InternalError" })).toBe(1);
    expect(exitCodeOf({ status: "Failure", reason: "NonZeroExitCode" })).toBe(
      1,
    );
    expect(
      exitCodeOf({
        status: "Failure",
        reason: "NonZeroExitCode",
        details: { causes: [{ reason: "ExitCode", message: "not-a-number" }] },
      }),
    ).toBe(1);
    expect(
      exitCodeOf({
        status: "Failure",
        reason: "NonZeroExitCode",
        details: { causes: [{ reason: "ExitCode", message: "9000" }] },
      }),
    ).toBe(1);
  });
});
