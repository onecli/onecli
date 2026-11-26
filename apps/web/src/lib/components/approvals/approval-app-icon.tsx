"use client";

import { ShieldAlert } from "lucide-react";
import { getApp } from "@onecli/api/apps/registry";
import { AppIcon } from "@/lib/components/app-icon";

/**
 * The leading mark of an approval card: the logo of the app the request is
 * for, so a reviewer sees "Salesforce" before reading a word. Requests to a
 * host no catalog app claims keep the amber approval shield.
 */
export const ApprovalAppIcon = ({ appId }: { appId?: string }) => {
  const app = appId ? getApp(appId) : undefined;
  if (!app) {
    return (
      <ShieldAlert
        aria-hidden="true"
        className="size-4 shrink-0 text-amber-600 dark:text-amber-500"
      />
    );
  }
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <AppIcon
        icon={app.icon}
        darkIcon={app.darkIcon}
        name={app.name}
        size={16}
      />
    </span>
  );
};
