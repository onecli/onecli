import { apiGet, apiPost } from "./client";
import type { PageScope } from "./scope";
import type { Secret, CreatedSecret, CreateSecretInput } from "./types";

export const list = () => apiGet<Secret[]>("/v1/secrets");

// Scope-aware secrets list: org pages read /v1/org/secrets (admin-gated,
// requireProject: false), project pages /v1/secrets. Kept SEPARATE from `list`
// because a few callers pass `list` DIRECTLY as a React Query `queryFn` (which
// invokes it with its context object) — giving `list` a positional `scope` would
// make that context arrive as the scope. Both endpoints return the caller's OWN
// secrets (no inherited partner secrets), which is exactly what a policy target
// may reference.
const secretsPath = (scope: PageScope) =>
  scope === "organization" ? "/v1/org/secrets" : "/v1/secrets";

export const listScoped = (scope: PageScope = "project") =>
  apiGet<Secret[]>(secretsPath(scope));

export const create = (input: CreateSecretInput) =>
  apiPost<CreatedSecret>("/v1/secrets", input);
