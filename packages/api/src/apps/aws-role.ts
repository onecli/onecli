import type { AppDefinition, OAuthExchangeResult } from "./types";

const AWS_ROLE_ARN_PATTERN = /^arn:aws:iam::\d{12}:role\/.+$/;
const AWS_REGION_PATTERN = /^[a-z]{2}(-[a-z0-9]+){1,3}$/;

const exchangeCredentials = async (
  fields: Record<string, string>,
): Promise<OAuthExchangeResult> => {
  const { roleArn, externalId, region } = fields;

  if (!roleArn) {
    throw new Error("Role ARN is required");
  }
  // Server-filled (`serverFields` below), never user input — an empty value
  // here means the org's external ID could not be resolved, not that a user
  // left a box blank. Assuming the role without it would drop the
  // confused-deputy protection the id exists for, so refuse instead.
  if (!externalId) {
    throw new Error(
      "Could not resolve this organization's AWS external ID. Please try again.",
    );
  }
  if (!region) {
    throw new Error("Default region is required");
  }
  if (!AWS_ROLE_ARN_PATTERN.test(roleArn)) {
    throw new Error(
      "Invalid Role ARN format. Expected arn:aws:iam::<account-id>:role/<role-name>",
    );
  }
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new Error(
      "Invalid region format. Expected format like us-east-1, eu-west-2",
    );
  }

  const accountId = roleArn.split(":")[4] ?? "unknown";
  const roleName = roleArn.split("/").pop() ?? "unknown";

  return {
    credentials: {
      type: "aws_assume_role",
      roleArn,
      externalId,
      region,
    },
    scopes: ["AWS STS AssumeRole"],
    metadata: {
      username: roleName,
      name: `AWS ${accountId} (${region})`,
      region,
      accountId,
      tags: [region, accountId],
    },
  };
};

export const awsRole: AppDefinition = {
  id: "aws-role",
  name: "AWS Role",
  icon: "/icons/aws.svg",
  darkIcon: "/icons/aws-light.svg",
  description:
    "Connect via IAM AssumeRole with temporary credentials and per-agent permissions. No keys shared.",
  connectionMethod: {
    type: "credentials_import",
    fields: [
      {
        name: "roleArn",
        label: "Role ARN",
        description: "The ARN of the IAM role in your AWS account",
        placeholder: "arn:aws:iam::123456789012:role/OneCLI-Agent-Role",
      },
      {
        name: "region",
        label: "Default Region",
        description: "AWS region for requests (e.g., us-east-1)",
        placeholder: "us-east-1",
      },
    ],
    exchangeCredentials,
    // The external ID is OURS to generate, per AWS's guidance on third-party
    // role access: it defeats the confused-deputy problem only while a
    // customer cannot choose it. So it is never a form field — the connect
    // routes fill it from the caller's own organization.
    serverFields: [{ name: "externalId", source: "orgAwsExternalId" }],
  },
};
