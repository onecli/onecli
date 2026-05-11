"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useInvalidateGatewayCache } from "@/hooks/use-invalidate-cache";
import { withProjectPrefix } from "@/lib/navigation";
import { Accordion } from "@onecli/ui/components/accordion";
import type {
  AppToolGroup,
  AppPermissionLevel,
} from "@/lib/apps/app-permissions";
import {
  getAppPermissionStates,
  setAppPermissions,
  getOverlappingRuleCountForApp,
} from "@/lib/actions/rules";
import { AppPermissionGroup } from "./app-permission-group";

interface AppPermissionActions {
  getStates: (provider: string) => Promise<Record<string, AppPermissionLevel>>;
  setPermissions: (
    provider: string,
    changes: { toolId: string; permission: AppPermissionLevel }[],
  ) => Promise<void>;
  getOverlappingRuleCount: (provider: string) => Promise<number>;
}

interface AppPermissionsProps {
  provider: string;
  appName: string;
  groups: AppToolGroup[];
  actions?: AppPermissionActions;
  orgStates?: Record<string, AppPermissionLevel>;
}

export const AppPermissions = ({
  provider,
  appName,
  groups,
  actions,
  orgStates,
}: AppPermissionsProps) => {
  const pathname = usePathname();
  const [states, setStates] = useState<Record<string, AppPermissionLevel>>({});
  const [overlappingRuleCount, setOverlappingRuleCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const invalidateCache = useInvalidateGatewayCache();

  const fetchStates = actions?.getStates ?? getAppPermissionStates;
  const fetchOverlappingCount =
    actions?.getOverlappingRuleCount ?? getOverlappingRuleCountForApp;
  const applyPermissions = actions?.setPermissions ?? setAppPermissions;

  useEffect(() => {
    Promise.all([fetchStates(provider), fetchOverlappingCount(provider)])
      .then(([s, count]) => {
        setStates(s);
        setOverlappingRuleCount(count);
      })
      .catch(() => toast.error("Failed to load permission states"))
      .finally(() => setLoading(false));
  }, [provider, fetchStates, fetchOverlappingCount]);

  const applyChanges = useCallback(
    async (changes: { toolId: string; permission: AppPermissionLevel }[]) => {
      let prev: Record<string, AppPermissionLevel> = {};
      setStates((current) => {
        prev = current;
        const next = { ...current };
        for (const c of changes) {
          next[c.toolId] = c.permission;
        }
        return next;
      });

      setSaving(true);
      try {
        await applyPermissions(provider, changes);
        invalidateCache();
      } catch {
        setStates(prev);
        toast.error("Failed to update permissions");
      } finally {
        setSaving(false);
      }
    },
    [provider, invalidateCache, applyPermissions],
  );

  const handlePermissionChange = useCallback(
    (toolId: string, permission: AppPermissionLevel) => {
      applyChanges([{ toolId, permission }]);
    },
    [applyChanges],
  );

  const handleGroupChange = useCallback(
    (group: AppToolGroup, permission: AppPermissionLevel) => {
      const changes = group.tools.map((t) => ({
        toolId: t.id,
        permission,
      }));
      applyChanges(changes);
    },
    [applyChanges],
  );

  if (loading) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Permissions</h3>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const rulesHref = withProjectPrefix(pathname, "/rules");

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Permissions</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Control what agents can do with {appName}. Applied to all connected
          accounts.
        </p>
      </div>
      {overlappingRuleCount > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <AlertTriangle className="size-3.5 text-amber-500 shrink-0" />
          <p className="text-xs text-muted-foreground">
            Some endpoints are also restricted by{" "}
            <Link
              href={rulesHref}
              className="text-foreground underline underline-offset-2"
            >
              {overlappingRuleCount}{" "}
              {overlappingRuleCount === 1 ? "rule" : "rules"}
            </Link>{" "}
            on the Rules page.
          </p>
        </div>
      )}
      <Accordion type="multiple" defaultValue={groups.map((g) => g.category)}>
        {groups.map((group) => (
          <AppPermissionGroup
            key={group.category}
            group={group}
            permissionStates={states}
            onPermissionChange={handlePermissionChange}
            onGroupChange={(perm) => handleGroupChange(group, perm)}
            disabled={saving}
            orgStates={orgStates}
          />
        ))}
      </Accordion>
    </div>
  );
};
