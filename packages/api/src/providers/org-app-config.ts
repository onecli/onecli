import type { OrgAppConfigProvider } from "./types";
import { createEditionSlot } from "./edition-state";

// Org-level app-config reads (the workspace → org → env credential
// fallback). The implementation is shared across editions and boot-injected
// by `ensureEditionDefaults()` — it rides the DB client, so the slot's
// static default stays null to keep it out of client bundles. The
// `orgAppConfig` option and `initOrgAppConfig` remain as overrides (null
// resets to the unwired default).
const slot = createEditionSlot<OrgAppConfigProvider | null>(
  "orgAppConfig",
  null,
);

export const initOrgAppConfig = (provider: OrgAppConfigProvider | null) =>
  slot.init(provider);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultOrgAppConfig = (p: OrgAppConfigProvider) =>
  slot.setCloudDefault(p);

export const getOrgAppConfig = (): OrgAppConfigProvider | null => slot.get();
