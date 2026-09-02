"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { extractOrgId } from "@/lib/org-navigation";
import {
  getUserOrganizations,
  getActiveOrganizationId,
  type UserOrganization,
} from "@/lib/workspaces/actions";

export interface UseActiveOrgResult {
  orgs: UserOrganization[];
  activeOrg: UserOrganization | undefined;
  activeOrgId: string | null;
  setActiveOrgId: (id: string) => void;
  isLoading: boolean;
}

// Resolves the org the user is currently viewing — and their role in it — keyed
// on the org id in the URL, so it re-fetches whenever the active org changes
// (e.g. when the switcher navigates to /org/<id>/...). Extracted from OrgSwitcher
// so the account menu (NavUser) reads the same switch-aware source and the role
// it shows can't drift from the org actually being viewed.
export const useActiveOrg = (): UseActiveOrgResult => {
  const pathname = usePathname();
  const orgId = extractOrgId(pathname);
  const [orgs, setOrgs] = useState<UserOrganization[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    Promise.all([getUserOrganizations(), getActiveOrganizationId()])
      .then(([orgList, activeId]) => {
        setOrgs(orgList);
        setActiveOrgId(activeId);
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [orgId]);

  const activeOrg = orgs.find((o) => o.id === activeOrgId);

  return { orgs, activeOrg, activeOrgId, setActiveOrgId, isLoading };
};
