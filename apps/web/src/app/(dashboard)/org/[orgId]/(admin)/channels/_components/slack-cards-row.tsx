"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Card, CardContent, CardHeader } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import { queryKeys } from "@/lib/api";
import { useOrgChannels } from "@/hooks/use-org-channels";
import { useAppMessages } from "@/hooks/use-app-connected";
import { SlackSharedAppCard } from "./slack-shared-app-card";
import { SlackIntegrationCard } from "./slack-integration-card";

/**
 * The Slack setup surface, routed by STATE so the admin always sees one
 * guided path instead of two rival cards:
 *
 * - CHOICE (shared app offered, nothing connected yet): ONE card at a time.
 *   Which face LEADS follows the server's `installMintsAgentApps`: until
 *   Slack approves the deployment's app as a manager app, an install is
 *   onboarding-only — agent apps still need the config token — so the token
 *   paste leads and the OneCLI app is the "or…" alternative. Once approved,
 *   the OneCLI app subsumes the token and leads. Either way: a small swap
 *   affordance under the leading card's action swaps the surface in place,
 *   and the alternative carries the recommended way back.
 * - INSTALLED: the shared card's status face, with the token card's compact
 *   truths (mint posture, recovery, removal) stacked under it.
 * - TOKEN-ONLY: the connected token card first — it is the active thing —
 *   with the OneCLI app's install offer under it (team onboarding is value
 *   the org doesn't have yet, not a rival path).
 * - DARK (flag off / self-host default / older server): the token card
 *   alone, exactly as before the shared arm existed.
 *
 * Also the landing for `?connected=slack` — the OAuth consent tab redirects
 * here after a shared-app install (dashboard- or Slack-initiated). One-shot:
 * refetch, then either close the popup (the opener's focus refetch shows the
 * install) or toast and strip the param.
 */
export const SlackCardsRow = () => {
  const { data, isPending, isError, refetch } = useOrgChannels();
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // The consent popup's handshake (the app-detail pattern): the popup posts
  // app-connected to its opener before closing, because nothing else tells
  // this tab the install landed — closing a popup changes neither this
  // document's visibility nor its focus state, so no refetch would fire.
  useAppMessages({
    onConnected: (event) => {
      if (event.provider !== "slack") return;
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
      toast.success("Slack connected");
    },
  });

  // The choice state's swap. `null` means "the default face" — which face
  // that IS comes from the data (below), so it can't be baked into the
  // initial state. Focus follows the swap (the content under the reader just
  // changed), via a tabIndex={-1} container — the standard in-place-swap
  // move for keyboard/SR users.
  const [view, setView] = useState<"shared" | "token" | null>(null);
  const swapped = useRef(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!swapped.current) return;
    swapped.current = false;
    surfaceRef.current?.focus();
  }, [view]);
  const swapTo = (next: "shared" | "token") => {
    swapped.current = true;
    setView(next);
  };

  const connectedParam = searchParams.get("connected");
  const consumedConnectedParam = useRef(false);
  useEffect(() => {
    if (consumedConnectedParam.current) return;
    if (connectedParam !== "slack") return;
    consumedConnectedParam.current = true;
    qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    if (window.opener) {
      // The consent popup: tell the opener FIRST (its own useAppMessages
      // invalidates and toasts over there), then close. The invalidation
      // above ran in THIS window's QueryClient, which dies with it.
      (window.opener as Window).postMessage(
        { type: "app-connected", provider: "slack" },
        window.location.origin,
      );
      window.close();
      return;
    }
    toast.success("Slack connected");
    const params = new URLSearchParams(searchParams.toString());
    params.delete("connected");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [connectedParam, qc, searchParams, router, pathname]);

  const sharedApp = data?.sharedApp;
  const installed = Boolean(sharedApp?.installation);
  const sharedOffered = Boolean(sharedApp?.available);
  const tokenConnected =
    data?.integrations.some((i) => i.provider === "slack") ?? false;

  // Until Slack approves the deployment's app as a manager app, installing
  // it can't mint agent apps — the token paste leads the choice. Older
  // servers don't send the field: same posture (false).
  const defaultFace: "shared" | "token" = sharedApp?.installMintsAgentApps
    ? "shared"
    : "token";
  const face = view ?? defaultFace;

  // Leaving the choice state resets the swap: if everything is later
  // disconnected, the choice reopens on the DEFAULT face, not wherever the
  // last setup happened to end.
  useEffect(() => {
    if (installed || tokenConnected) setView(null);
  }, [installed, tokenConnected]);

  // The stack replaces the old two-column grid; the page owns the column
  // width so every card on it lines up.
  const stack = "flex w-full flex-col gap-4";

  // A NEUTRAL skeleton while loading: which card leads depends on the data,
  // so naming either up front would flash the wrong identity and then swap
  // it out from under the reader.
  if (isPending) {
    return (
      <div className={stack}>
        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <Skeleton className="size-10 rounded-xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-72" />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-9 w-40" />
          </CardContent>
        </Card>
      </div>
    );
  }

  // A FAILED load must not impersonate "nothing configured": the setup faces
  // would hide a live install and invite a duplicate token paste or install.
  if (isError) {
    return (
      <div className={stack}>
        <Card>
          <CardHeader>
            <p className="text-sm font-medium">
              Could not load the Slack settings.
            </p>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Dark posture and older servers: the token card alone.
  if (!sharedOffered && !installed) {
    return (
      <div className={stack}>
        <SlackIntegrationCard />
      </div>
    );
  }

  // The SETUP CHOICE: nothing connected yet — one card at a time, swap in
  // place, default first.
  if (!installed && !tokenConnected) {
    return (
      <div
        ref={surfaceRef}
        tabIndex={-1}
        // A keyboard-activated swap marks the script-focused container
        // :focus-visible — show the ring there (the only indicator of where
        // focus landed); pointer activation doesn't match it, so no flash.
        className={cn(
          stack,
          "rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        {face === "shared" ? (
          <SlackSharedAppCard
            choice={{
              role: defaultFace === "shared" ? "leading" : "alternative",
              onSwap: () => swapTo("token"),
            }}
          />
        ) : (
          <SlackIntegrationCard
            choice={{
              role: defaultFace === "token" ? "leading" : "alternative",
              onSwap: () => swapTo("shared"),
            }}
          />
        )}
      </div>
    );
  }

  // Connected states: status first, the other surface stacked under it.
  return (
    <div className={stack}>
      {installed ? (
        <>
          <SlackSharedAppCard />
          <SlackIntegrationCard />
        </>
      ) : (
        <>
          <SlackIntegrationCard />
          <SlackSharedAppCard />
        </>
      )}
    </div>
  );
};
