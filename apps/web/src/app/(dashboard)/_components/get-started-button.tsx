"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { MessageSquare, Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import {
  ORG_PATH_RE,
  WORKSPACE_PATH_RE,
  readDefaultOrgCookie,
} from "@/lib/navigation";
import { useAgents } from "@/hooks/use-agents";
import {
  firstHostedAgent,
  getStartedPath,
} from "@/lib/agents/get-started-target";
import { GetStartedPicker } from "./get-started-picker";

// A router to the agent — create one, or open the one you have. Which of the
// two is `getStartedPath`'s call, and the LABEL says which before you press
// it: "Create agent" or "Chat", never a vague "Get Started" that could mean
// either. Workspace scope resolves locally; org and account scopes first ask
// which workspace in the picker, since their URLs carry no workspace to
// resolve against. In OSS the org branch is unreachable (no /org or /account
// paths exist), so the picker code path is inert there.
export const GetStartedButton = () => {
  const router = useRouter();
  const pathname = usePathname();
  const [pickerOrgId, setPickerOrgId] = useState<string | null>(null);

  // Follows the URL scope and shares the roster's cache entry, so this costs
  // no extra request on any workspace page and is warm by the time it's
  // clicked. Off outside a workspace — there the picker does the reading.
  const workspaceId = WORKSPACE_PATH_RE.exec(pathname)?.[1];
  const { data: agents = [] } = useAgents(Boolean(workspaceId));
  const existing = workspaceId ? firstHostedAgent(agents) : undefined;

  const handleClick = () => {
    const orgScoped = ORG_PATH_RE.exec(pathname)?.[1];
    const accountScoped = pathname.startsWith("/account");

    if (orgScoped) {
      setPickerOrgId(orgScoped);
      return;
    }
    if (accountScoped) {
      // Account pages belong to no org; the last-visited org's cookie decides.
      // Without one, the home redirect resolves the default org itself.
      const cookieOrg = readDefaultOrgCookie();
      if (cookieOrg) setPickerOrgId(cookieOrg);
      else router.push("/");
      return;
    }
    if (workspaceId) {
      router.push(getStartedPath(workspaceId, agents));
      return;
    }
    // Neither workspace nor org nor account scope (the home shell): let the
    // home redirect resolve the default org, which lands somewhere scoped.
    router.push("/");
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="brand" size="sm" onClick={handleClick}>
            {existing ? (
              <MessageSquare className="size-3.5" />
            ) : (
              <Plus className="size-3.5" />
            )}
            {existing ? "Chat" : "Create agent"}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {existing
            ? `Pick up your conversation with ${existing.name}`
            : "Create your first agent"}
        </TooltipContent>
      </Tooltip>
      <GetStartedPicker
        organizationId={pickerOrgId}
        onOpenChange={(open) => {
          if (!open) setPickerOrgId(null);
        }}
      />
    </>
  );
};
