"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Rocket } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import {
  ORG_PATH_RE,
  readDefaultOrgCookie,
  withProjectPrefix,
} from "@/lib/navigation";
import { GetStartedPicker } from "./get-started-picker";

// A router to the Install page — the one instruction surface. Project scope
// (and the flat OSS layout) navigates straight there; org and account scopes
// first ask project → agent in the picker, since their URLs carry no project
// to install into. In OSS the org branch is unreachable (no /org or /account
// paths exist), so the picker code path is inert there.
export const GetStartedButton = () => {
  const router = useRouter();
  const pathname = usePathname();
  const [pickerOrgId, setPickerOrgId] = useState<string | null>(null);

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
    router.push(withProjectPrefix(pathname, "/install"));
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="brand" size="sm" onClick={handleClick}>
            <Rocket className="size-3.5" />
            Get Started
          </Button>
        </TooltipTrigger>
        <TooltipContent>Set up and run your agent</TooltipContent>
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
