import { describe, expect, it } from "vitest";
import { awsRole } from "./aws-role";

describe("aws-role", () => {
  it("declares externalId as a server field, never a form field", () => {
    const m = awsRole.connectionMethod;
    if (m.type !== "credentials_import") throw new Error("shape changed");
    // The regression guard: if externalId ever reappears as a user-entered
    // field, the confused-deputy protection is client-controlled again.
    expect(m.fields.map((f) => f.name)).not.toContain("externalId");
    expect(m.serverFields).toEqual([
      { name: "externalId", source: "orgAwsExternalId" },
    ]);
  });

  it("refuses to build credentials with no external id", async () => {
    const m = awsRole.connectionMethod;
    if (m.type !== "credentials_import") throw new Error("shape changed");
    await expect(
      m.exchangeCredentials({
        roleArn: "arn:aws:iam::123456789012:role/R",
        region: "us-east-1",
        externalId: "",
      }),
    ).rejects.toThrow(/external ID/i);
  });

  it("carries the external id into the stored credentials", async () => {
    const m = awsRole.connectionMethod;
    if (m.type !== "credentials_import") throw new Error("shape changed");
    const result = await m.exchangeCredentials({
      roleArn: "arn:aws:iam::123456789012:role/OneCLI",
      region: "us-east-1",
      externalId: "onecli-abc",
    });
    // The gateway's AssumeRole finalizer reads this field off the connection.
    expect(result.credentials).toMatchObject({
      type: "aws_assume_role",
      externalId: "onecli-abc",
    });
  });
});
