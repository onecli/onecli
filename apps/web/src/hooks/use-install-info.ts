"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/api/keys";
import { getInstallInfo } from "@/lib/actions/secrets";

/** The install-surface context: the caller's project API key (lazily minted)
 * plus host URLs. Server action as queryFn — the house pattern for reads with
 * no /v1 endpoint. */
export const useInstallInfo = () =>
  useQuery({
    queryKey: queryKeys.installInfo.all(),
    queryFn: () => getInstallInfo(),
  });
