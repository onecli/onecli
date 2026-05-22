import { apiGet, apiPost } from "./client";
import type { Secret, CreatedSecret, CreateSecretInput } from "./types";

export const list = () => apiGet<Secret[]>("/v1/secrets");

export const create = (input: CreateSecretInput) =>
  apiPost<CreatedSecret>("/v1/secrets", input);
