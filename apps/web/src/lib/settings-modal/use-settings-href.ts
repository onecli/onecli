"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
  withSettingsParam,
  type SettingsPageId,
} from "@/lib/settings-modal/pages";

/**
 * Where a settings link goes: into the Settings modal, `?settings=<page>`
 * over the current URL. The one place the gear, the account menu and the
 * scope rows ask, so they cannot disagree.
 */
export const useSettingsHref = () => {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  return (page: SettingsPageId): string =>
    withSettingsParam(pathname, search, page);
};
