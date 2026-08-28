import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient();
const cache = new Map<string, string>();

export const getSecretValue = async (
  secretName: string,
  jsonField?: string,
): Promise<string> => {
  const cacheKey = `${secretName}:${jsonField ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { SecretString } = await client.send(
    new GetSecretValueCommand({ SecretId: secretName }),
  );
  if (!SecretString) throw new Error(`Secret ${secretName} has no value`);

  const value = jsonField ? JSON.parse(SecretString)[jsonField] : SecretString;
  if (!value)
    throw new Error(`Secret ${secretName} missing field ${jsonField}`);

  cache.set(cacheKey, value);
  return value;
};
