"use client";

import { useInstance } from "@/hooks/use-instance";
import { IS_CLOUD } from "@/lib/env";

/**
 * Whether this deployment shows a hosted agent its computer: the hosted
 * platform, where the deployment serves previews. Present while the
 * instance loads (loading must never render as unavailable), absent once it
 * resolves without previews. The one rule every surface that places the
 * computer reads (the chat's dock, the agent header's Computer button), so
 * they can never disagree about whether it exists.
 */
export const useHasDesktop = (): boolean => {
  const instance = useInstance();
  return IS_CLOUD && (instance === null || instance.previews !== undefined);
};
