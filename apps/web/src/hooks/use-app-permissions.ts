"use client";

import { useQuery } from "@tanstack/react-query";
import { appPermissions } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

/**
 * The public app-permission catalog (id/name/description per tool). One list
 * query serves every consumer — apps without a catalog are simply absent, so
 * callers don't need per-provider 404 handling.
 */
export const useAppPermissionDefinitions = () =>
  useQuery({
    queryKey: queryKeys.appPermissionDefinitions.list(),
    queryFn: appPermissions.list,
    // Static per deploy.
    staleTime: Infinity,
  });
