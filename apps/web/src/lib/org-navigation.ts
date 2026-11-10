"use client";

import { usePathname } from "next/navigation";
import { ORG_PATH_RE, orgConnectionsPath } from "@/lib/navigation";

export const extractOrgId = (pathname: string): string | undefined =>
  pathname.match(ORG_PATH_RE)?.[1];

/** The current org's Shared Connections root: the `basePath` every org-scope
 *  connections component hands the shared workspace tabs. */
export const useOrgConnectionsPath = (): string => {
  const orgId = extractOrgId(usePathname());
  return orgId ? orgConnectionsPath(orgId) : "";
};
