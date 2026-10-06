"use client";

import { usePathname } from "next/navigation";
import { ORG_PATH_RE, orgConnectionsPath } from "@/lib/navigation";

export { ORG_PATH_RE };

export const extractOrgId = (pathname: string): string | undefined =>
  pathname.match(ORG_PATH_RE)?.[1];

export const generateOrgPrefix = (orgId: string | undefined): string =>
  orgId ? `/org/${orgId}` : "";

export const useOrgPrefix = (): string => {
  const pathname = usePathname();
  return generateOrgPrefix(extractOrgId(pathname));
};

/** The current org's Global Connections root: the `basePath` every org-scope
 *  connections component hands the shared workspace tabs. */
export const useOrgConnectionsPath = (): string => {
  const orgId = extractOrgId(usePathname());
  return orgId ? orgConnectionsPath(orgId) : "";
};
