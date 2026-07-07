import type { OrgAppConfigProvider } from "./types";

// OSS default: no provider — the org credential tier is skipped everywhere
// and resolution stays project → env, byte-equivalent to before the seam.
let _orgAppConfig: OrgAppConfigProvider | null = null;

export const initOrgAppConfig = (provider: OrgAppConfigProvider | null) => {
  _orgAppConfig = provider;
};

export const getOrgAppConfig = (): OrgAppConfigProvider | null => _orgAppConfig;
