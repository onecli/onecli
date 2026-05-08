import type {
  CreateSecretInput,
  UpdateSecretInput,
} from "@/lib/validations/secret";

export interface SecretActions {
  createSecret: (input: CreateSecretInput) => Promise<{ id: string }>;
  deleteSecret: (secretId: string) => Promise<void>;
  updateSecret: (secretId: string, input: UpdateSecretInput) => Promise<void>;
}
