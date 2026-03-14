import { cryptoService } from "@/lib/crypto";

const SECRET_PROVIDER_VALUES = ["local_db", "vault_hcp"] as const;

export type SecretProviderType = (typeof SECRET_PROVIDER_VALUES)[number];

interface VaultConfig {
  address: string;
  token: string;
  namespace: string | null;
  kvMount: string;
  kvPrefix: string;
}

export type SecretBackendConnectionStatus =
  | "connected"
  | "degraded"
  | "disconnected"
  | "not-applicable";

export interface SecretBackendStatus {
  mode: SecretProviderType;
  label: string;
  details: string;
  connectionStatus: SecretBackendConnectionStatus;
  connectionMessage: string;
}

export interface PersistSecretValueInput {
  providerType: SecretProviderType;
  userId: string;
  secretId: string;
  value: string;
  providerRef?: string | null;
}

export interface StoredSecretMaterial {
  providerType: SecretProviderType;
  encryptedValue: string | null;
  providerRef: string | null;
}

export interface SecretMaterialRecord {
  id: string;
  userId: string;
  providerType: string;
  encryptedValue: string | null;
  providerRef: string | null;
}

const getVaultConfig = (): VaultConfig => {
  const address = process.env.VAULT_ADDR?.trim();
  const token = process.env.VAULT_TOKEN?.trim();

  if (!address || !token) {
    throw new Error(
      "Vault provider requires VAULT_ADDR and VAULT_TOKEN environment variables",
    );
  }

  const kvMount = process.env.VAULT_KV_MOUNT?.trim() || "secret";
  const kvPrefix = process.env.VAULT_KV_PREFIX?.trim() || "onecli";
  const namespace = process.env.VAULT_NAMESPACE?.trim() || null;

  return {
    address: address.replace(/\/$/, ""),
    token,
    namespace,
    kvMount,
    kvPrefix,
  };
};

const buildVaultPath = (config: VaultConfig, userId: string, secretId: string) => {
  return [config.kvPrefix, "users", userId, "secrets", secretId].join("/");
};

const callVault = async (
  config: VaultConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
) => {
  const headers = new Headers({
    "x-vault-token": config.token,
  });

  if (config.namespace) {
    headers.set("x-vault-namespace", config.namespace);
  }

  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${config.address}/v1/${config.kvMount}/data/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });

  if (!response.ok) {
    const reason = await response.text().catch(() => "");
    throw new Error(
      `Vault ${method} failed (${response.status})${reason ? `: ${reason}` : ""}`,
    );
  }

  if (method === "DELETE") {
    return null;
  }

  return response.json();
};

const writeVaultSecretAtPath = async (
  path: string,
  value: string,
): Promise<void> => {
  const config = getVaultConfig();

  await callVault(config, "POST", path, {
    data: { value },
  });
};

const writeVaultSecret = async (
  userId: string,
  secretId: string,
  value: string,
): Promise<string> => {
  const config = getVaultConfig();
  const path = buildVaultPath(config, userId, secretId);

  await writeVaultSecretAtPath(path, value);

  return path;
};

const readVaultSecret = async (providerRef: string): Promise<string> => {
  const config = getVaultConfig();
  const payload = (await callVault(config, "GET", providerRef)) as {
    data?: { data?: { value?: string } };
  };

  const value = payload.data?.data?.value;
  if (!value) {
    throw new Error("Vault secret value missing");
  }

  return value;
};

const deleteVaultSecret = async (providerRef: string): Promise<void> => {
  const config = getVaultConfig();
  await callVault(config, "DELETE", providerRef);
};

export const getConfiguredSecretProviderType = (): SecretProviderType => {
  const value = process.env.SECRET_PROVIDER?.trim();
  if (!value) return "local_db";

  if (value === "local_db" || value === "vault_hcp") {
    return value;
  }

  throw new Error(
    `Invalid SECRET_PROVIDER: ${value}. Valid values are ${SECRET_PROVIDER_VALUES.join(", ")}`,
  );
};

export const getSecretBackendStatus = async (): Promise<SecretBackendStatus> => {
  const mode = getConfiguredSecretProviderType();

  if (mode === "local_db") {
    return {
      mode,
      label: "Local database",
      details: "Secrets are encrypted and stored in the application database.",
      connectionStatus: "not-applicable",
      connectionMessage: "No external secrets backend required",
    };
  }

  let config: VaultConfig;
  try {
    config = getVaultConfig();
  } catch (error) {
    return {
      mode,
      label: "HashiCorp Vault",
      details: "Secrets are stored in Vault KV v2.",
      connectionStatus: "disconnected",
      connectionMessage:
        error instanceof Error ? error.message : "Vault is not configured",
    };
  }

  const headers = new Headers({
    "x-vault-token": config.token,
  });
  if (config.namespace) {
    headers.set("x-vault-namespace", config.namespace);
  }

  try {
    const response = await fetch(`${config.address}/v1/sys/health`, {
      method: "GET",
      headers,
      cache: "no-store",
    });

    if (response.status === 200 || response.status === 429 || response.status === 472) {
      return {
        mode,
        label: "HashiCorp Vault",
        details: `KV mount: ${config.kvMount} • Prefix: ${config.kvPrefix}`,
        connectionStatus: "connected",
        connectionMessage: `Connected (${response.status})`,
      };
    }

    if (response.status === 473 || response.status === 501) {
      return {
        mode,
        label: "HashiCorp Vault",
        details: `KV mount: ${config.kvMount} • Prefix: ${config.kvPrefix}`,
        connectionStatus: "degraded",
        connectionMessage: `Vault reachable but not ready (${response.status})`,
      };
    }

    return {
      mode,
      label: "HashiCorp Vault",
      details: `KV mount: ${config.kvMount} • Prefix: ${config.kvPrefix}`,
      connectionStatus: "disconnected",
      connectionMessage: `Health check failed (${response.status})`,
    };
  } catch (error) {
    return {
      mode,
      label: "HashiCorp Vault",
      details: `KV mount: ${config.kvMount} • Prefix: ${config.kvPrefix}`,
      connectionStatus: "disconnected",
      connectionMessage:
        error instanceof Error ? error.message : "Vault connection failed",
    };
  }
};

export const parseSecretProviderType = (value: string): SecretProviderType => {
  if (value === "local_db" || value === "vault_hcp") {
    return value;
  }

  throw new Error(`Unsupported secret provider type: ${value}`);
};

export const persistSecretValue = async (
  input: PersistSecretValueInput,
): Promise<StoredSecretMaterial> => {
  if (input.providerType === "local_db") {
    return {
      providerType: "local_db",
      encryptedValue: cryptoService.encrypt(input.value),
      providerRef: null,
    };
  }

  if (input.providerRef) {
    await writeVaultSecretAtPath(input.providerRef, input.value);
    return {
      providerType: "vault_hcp",
      encryptedValue: null,
      providerRef: input.providerRef,
    };
  }

  const providerRef = await writeVaultSecret(
    input.userId,
    input.secretId,
    input.value,
  );

  return {
    providerType: "vault_hcp",
    encryptedValue: null,
    providerRef,
  };
};

export const resolveSecretValue = async (
  record: SecretMaterialRecord,
): Promise<string> => {
  const providerType = parseSecretProviderType(record.providerType);

  if (providerType === "local_db") {
    if (!record.encryptedValue) {
      throw new Error(`Missing encrypted value for secret ${record.id}`);
    }
    return cryptoService.decrypt(record.encryptedValue);
  }

  if (!record.providerRef) {
    throw new Error(`Missing Vault reference for secret ${record.id}`);
  }

  return readVaultSecret(record.providerRef);
};

export const deleteSecretMaterial = async (
  record: SecretMaterialRecord,
): Promise<void> => {
  const providerType = parseSecretProviderType(record.providerType);
  if (providerType === "vault_hcp" && record.providerRef) {
    await deleteVaultSecret(record.providerRef);
  }
};
