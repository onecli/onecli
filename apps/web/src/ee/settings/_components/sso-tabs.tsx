"use client";

import { useSearchParams } from "next/navigation";
import {
  AnimatedTabs,
  AnimatedTabList,
  AnimatedTabTrigger,
} from "@onecli/ui/components/animated-tabs";
import { useReplaceParam } from "@/lib/settings-modal/use-replace-param";

type Tab = "sso" | "provisioning";

/**
 * The SSO page's two halves: how people sign in (SSO), and how accounts
 * arrive and leave (Provisioning). The tab lives in `?tab=`, so a link can
 * open either one.
 */
export const SsoTabs = ({
  sso,
  provisioning,
}: {
  sso: React.ReactNode;
  provisioning: React.ReactNode;
}) => {
  const params = useSearchParams();
  const replaceParam = useReplaceParam();
  const tab: Tab =
    params.get("tab") === "provisioning" ? "provisioning" : "sso";

  return (
    <div className="flex flex-col gap-6">
      <AnimatedTabs
        value={tab}
        onValueChange={(value) =>
          replaceParam("tab", value === "sso" ? null : value)
        }
      >
        <AnimatedTabList>
          <AnimatedTabTrigger value="sso">SSO</AnimatedTabTrigger>
          <AnimatedTabTrigger value="provisioning">
            Provisioning
          </AnimatedTabTrigger>
        </AnimatedTabList>
      </AnimatedTabs>
      {tab === "sso" ? sso : provisioning}
    </div>
  );
};
