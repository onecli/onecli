"use server";

import { resolveUser } from "@/lib/actions/resolve-user";
import { getApp } from "@/lib/apps/registry";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@/lib/services/audit-service";
import {
  getAppConfig,
  upsertAppConfig,
  deleteAppConfig,
  hasAppConfig as hasAppConfigService,
  toggleAppConfigEnabled,
} from "@/lib/services/app-config-service";

export const saveAppConfig = async (
  provider: string,
  values: Record<string, string>,
) => {
  const { userId, userEmail, accountId } = await resolveUser();
  const app = getApp(provider);
  if (!app?.configurable) {
    throw new Error(`Provider "${provider}" is not configurable`);
  }

  return withAudit(
    () =>
      upsertAppConfig(accountId, provider, values, app.configurable!.fields),
    () => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.APP_CONFIG,
      metadata: { provider },
    }),
  );
};

export const getAppConfigStatus = async (provider: string) => {
  const { accountId } = await resolveUser();
  return getAppConfig(accountId, provider);
};

export const deleteAppConfigAction = async (provider: string) => {
  const { userId, userEmail, accountId } = await resolveUser();

  return withAudit(
    () => deleteAppConfig(accountId, provider),
    () => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.APP_CONFIG,
      metadata: { provider },
    }),
  );
};

export const checkAppConfigExists = async (
  provider: string,
): Promise<boolean> => {
  const { accountId } = await resolveUser();
  return hasAppConfigService(accountId, provider);
};

export const setAppConfigEnabled = async (
  provider: string,
  enabled: boolean,
) => {
  const { userId, userEmail, accountId } = await resolveUser();

  return withAudit(
    () => toggleAppConfigEnabled(accountId, provider, enabled),
    () => ({
      accountId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.APP_CONFIG,
      metadata: { provider, enabled },
    }),
  );
};
