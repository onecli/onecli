import type { AppDefinition, OAuthExchangeResult } from "@/lib/apps/types";

const AWS_ACCESS_KEY_PATTERN = /^[A-Z0-9]{16,128}$/;
const AWS_REGION_PATTERN = /^[a-z]{2}(-[a-z0-9]+){1,3}$/;

const exchangeCredentials = async (
  fields: Record<string, string>,
): Promise<OAuthExchangeResult> => {
  const { accessKeyId, secretAccessKey, region } = fields;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Access Key ID and Secret Access Key are required");
  }
  if (!region) {
    throw new Error("Default region is required");
  }
  if (!AWS_ACCESS_KEY_PATTERN.test(accessKeyId)) {
    throw new Error(
      "Invalid Access Key ID format. Expected uppercase alphanumeric (e.g., AKIAIOSFODNN7EXAMPLE)",
    );
  }
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new Error(
      "Invalid region format. Expected format like us-east-1, eu-west-2",
    );
  }

  const maskedKey = `${accessKeyId.slice(0, 4)}...${accessKeyId.slice(-4)}`;

  return {
    credentials: {
      type: "aws_iam",
      accessKeyId,
      secretAccessKey,
      region,
    },
    scopes: ["AWS IAM Credentials"],
    metadata: {
      username: maskedKey,
      name: `AWS (${region})`,
      region,
    },
  };
};

export const aws: AppDefinition = {
  id: "aws",
  name: "AWS",
  icon: "/icons/aws.svg",
  darkIcon: "/icons/aws-light.svg",
  description: "Access AWS services: S3, EC2, Lambda, and more.",
  connectionMethod: {
    type: "credentials_import",
    fields: [
      {
        name: "accessKeyId",
        label: "Access Key ID",
        placeholder: "AKIAIOSFODNN7EXAMPLE",
      },
      {
        name: "secretAccessKey",
        label: "Secret Access Key",
        placeholder: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        secret: true,
      },
      {
        name: "region",
        label: "Default Region",
        description: "AWS region for requests (e.g., us-east-1)",
        placeholder: "us-east-1",
      },
    ],
    exchangeCredentials,
    fileImport: {
      label: "Import from credentials file",
      accept: ".json,application/json",
      keyMap: {
        aws_access_key_id: "accessKeyId",
        aws_secret_access_key: "secretAccessKey",
        region: "region",
      },
    },
  },
  available: true,
};
