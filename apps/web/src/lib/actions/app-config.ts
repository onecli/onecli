"use server";

import { resolveProjectContext } from "@/lib/actions/resolve-user";
import { getApp } from "@onecli/api/apps/registry";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";
import {
  getAppConfig,
  upsertAppConfig,
  deleteAppConfig,
  hasAppConfig as hasAppConfigService,
  listConfiguredProviders,
  toggleAppConfigEnabled,
} from "@onecli/api/services/app-config-service";

export const saveAppConfig = async (
  provider: string,
  values: Record<string, string>,
) => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  const app = getApp(provider);
  if (!app?.configurable) {
    throw new Error(`Provider "${provider}" is not configurable`);
  }

  return withAudit(
    () =>
      upsertAppConfig(
        { projectId },
        provider,
        values,
        app.configurable!.fields,
      ),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.APP_CONFIG,
      metadata: { provider },
    }),
  );
};

export const getAppConfigStatus = async (provider: string) => {
  const { projectId } = await resolveProjectContext();
  return getAppConfig({ projectId }, provider);
};

export const deleteAppConfigAction = async (provider: string) => {
  const { userId, userEmail, projectId } = await resolveProjectContext();

  return withAudit(
    () => deleteAppConfig({ projectId }, provider),
    () => ({
      projectId,
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
  const { getApps } = await import("@onecli/api/apps/registry");
  return getApps()
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
  const { projectId } = await resolveProjectContext();
  return hasAppConfigService({ projectId }, provider);
};

/**
 * Returns all provider IDs that have an enabled AppConfig for the current account.
 * Use this instead of calling checkAppConfigExists in a loop.
 */
export const getConfiguredProviders = async (): Promise<string[]> => {
  const { projectId } = await resolveProjectContext();
  return listConfiguredProviders({ projectId });
};

export const setAppConfigEnabled = async (
  provider: string,
  enabled: boolean,
) => {
  const { userId, userEmail, projectId } = await resolveProjectContext();

  return withAudit(
    () => toggleAppConfigEnabled({ projectId }, provider, enabled),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.APP_CONFIG,
      metadata: { provider, enabled },
    }),
  );
};
