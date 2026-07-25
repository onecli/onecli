"use client";

import { useQuery } from "@tanstack/react-query";
import { appAvailability } from "@/lib/api";
import type { PageScope } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

// The apps available to the current project (policy-engine step 7), backing the
// connect-picker filter. Only PROJECT pages are governed — availability is a
// per-project provisioning gate, so the org (global) connect surface is never
// filtered. The response's `restricted` flag is the real gate: an "open" org
// (the default everywhere, and always in OSS) returns `restricted:false`, so the
// picker stays unfiltered and the feature is inert until an org opts in.
export const useAvailableApps = (scope: PageScope) =>
  useQuery({
    queryKey: queryKeys.appAvailability.available(),
    queryFn: appAvailability.available,
    // A failed/absent availability read must never hide apps — degrade to
    // "unrestricted" rather than an empty picker.
    retry: false,
    enabled: scope === "project",
  });
