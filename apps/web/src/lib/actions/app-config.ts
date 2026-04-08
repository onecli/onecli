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
  listConfiguredProviders,
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

/**
 * Returns the set of provider IDs that have their envDefaults env vars set.
 * Only checks apps that define envDefaults in their app definition.
 */
export const getAvailableEnvDefaults = async (): Promise<string[]> => {
  const { apps } = await import("@/lib/apps/registry");
  return apps
    .filter((app) => {
      const envDefaults = app.configurable?.envDefaults;
      if (!envDefaults) return false;
      return Object.values(envDefaults).every(
        (envVar) => !!process.env[envVar],
      );
    })
    .map((app) => app.id);
};

export const checkAppConfigExists = async (
  provider: string,
): Promise<boolean> => {
  const { accountId } = await resolveUser();
  return hasAppConfigService(accountId, provider);
};

/**
 * Returns all provider IDs that have an enabled AppConfig for the current account.
 * Use this instead of calling checkAppConfigExists in a loop.
 */
export const getConfiguredProviders = async (): Promise<string[]> => {
  const { accountId } = await resolveUser();
  return listConfiguredProviders(accountId);
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
