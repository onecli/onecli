"use server";

import { requireOrgAdminContext } from "@/lib/actions/resolve-user";
import {
  listSecrets,
  createSecret,
  deleteSecret,
  updateSecret,
} from "@onecli/api/services/secret-service";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";
import type {
  CreateSecretInput,
  UpdateSecretInput,
} from "@onecli/api/validations/secret";

export const getOrgSecrets = async () => {
  const { organizationId } = await requireOrgAdminContext();
  const secrets = await listSecrets({ organizationId });
  return secrets.map((s) => ({
    ...s,
    metadata: (s.metadata ?? null) as Record<string, unknown> | null,
  }));
};

export const createOrgSecretAction = async (input: CreateSecretInput) => {
  const { userId, userEmail, organizationId } = await requireOrgAdminContext();
  return withAudit(
    () => createSecret({ organizationId }, input),
    (s) => ({
      organizationId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.SECRET,
      metadata: { secretId: s.id, name: input.name, scope: "organization" },
    }),
  );
};

export const deleteOrgSecretAction = async (secretId: string) => {
  const { userId, userEmail, organizationId } = await requireOrgAdminContext();
  return withAudit(
    () => deleteSecret({ organizationId }, secretId),
    () => ({
      organizationId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.SECRET,
      metadata: { secretId, scope: "organization" },
    }),
  );
};

export const updateOrgSecretAction = async (
  secretId: string,
  input: UpdateSecretInput,
) => {
  const { userId, userEmail, organizationId } = await requireOrgAdminContext();
  return withAudit(
    () => updateSecret({ organizationId }, secretId, input),
    () => ({
      organizationId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.SECRET,
      metadata: { secretId, scope: "organization" },
    }),
  );
};
