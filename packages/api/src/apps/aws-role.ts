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
  if (!externalId) {
    throw new Error("External ID is required");
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
  },
};
