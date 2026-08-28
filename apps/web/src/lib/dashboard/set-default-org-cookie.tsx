"use client";

import { useEffect } from "react";
import { DEFAULT_ORG_COOKIE } from "@/lib/navigation";

export const SetDefaultOrgCookie = ({ orgId }: { orgId: string }) => {
  useEffect(() => {
    const current = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${DEFAULT_ORG_COOKIE}=`))
      ?.split("=")[1];
    if (current !== orgId) {
      document.cookie = `${DEFAULT_ORG_COOKIE}=${orgId};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
    }
  }, [orgId]);

  return null;
};
