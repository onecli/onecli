import type {
  CreateSecretInput,
  UpdateSecretInput,
} from "@onecli/api/validations/secret";

export interface SecretActions {
  createSecret: (input: CreateSecretInput) => Promise<{ id: string }>;
  deleteSecret: (secretId: string) => Promise<void>;
  updateSecret: (secretId: string, input: UpdateSecretInput) => Promise<void>;
}
