"use client";

import { useCallback } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { connectionsPath } from "@/lib/navigation";
import { useSettingsModal } from "./modal-context";
import { connectionsModalHref } from "./pages";

/**
 * Where a connections link goes, from wherever the connections components
 * render. On a route page: the route, as `connectionsPath` always built
 * it (`/w/<id>/connections/apps/<p>`, or `basePath` + sub for the org
 * pages). Inside the Settings modal: the same thing as modal params over
 * the URL beneath (`?settings=apps&app=<p>`), so an app's detail, a vault's
 * setup and the catalog's tabs all open in place and the modal stays up.
 *
 * `sub` is what the route pages append to `/connections`, query included
 * (`/apps/gmail?connected=<id>`): one argument, both worlds.
 */
export const useConnectionsHref = (basePath?: string) => {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const modal = useSettingsModal();
  return useCallback(
    (sub = ""): string =>
      modal
        ? connectionsModalHref(pathname, search, modal.page, sub)
        : connectionsPath({ pathname, basePath }, sub),
    [modal, pathname, search, basePath],
  );
};
