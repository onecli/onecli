"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getApp } from "@onecli/api/apps/registry";
import { useAppMessages } from "@/hooks/use-app-connected";
import { useSetConnectionGrant } from "@/hooks/use-grants";
import { queryKeys } from "@/lib/api/keys";
import { connectPopupHeight, openConnectPopup } from "@/lib/connect-popup";
import { connectionsPath, WORKSPACE_PATH_RE } from "@/lib/navigation";
import { useAgentPageAgentMaybe } from "../../_components/agent-page-frame";
import { AttachConnectionDialog } from "./attach-connection-dialog";

const PROVIDER_ID_RE = /^[a-z0-9-]{1,64}$/;

/**
 * The chat page's `?attach=<provider>` door: a deep link (the Slack card's
 * Attach button) lands on this agent's chat with the attach dialog already
 * open for that app — the same dialog the in-chat card opens. Closing it
 * consumes the param (shallow, the page family's convention) so refresh/back
 * does not reopen it.
 *
 * The provider is revalidated like every card surface: shape AND catalog
 * membership (the web's isCardConnectLink law / the adapter's getApp gate) —
 * a crafted `?attach=totally-fake` must not render an official-looking
 * first-party dialog for an app that does not exist.
 */
export const AttachParamDialog = () => {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ agentId?: string }>();
  const agentId = params?.agentId ?? "";
  const agentName = useAgentPageAgentMaybe()?.name;
  const workspaceId = pathname.match(WORKSPACE_PATH_RE)?.[1];

  const raw = searchParams.get("attach");
  const provider = raw && PROVIDER_ID_RE.test(raw) && getApp(raw) ? raw : null;

  const queryClient = useQueryClient();
  const setGrant = useSetConnectionGrant();
  // Claim fence: only popups THIS door opened are handled — the in-chat
  // card's listener fences on its own claims the same way, so one event
  // never fans out across surfaces. A SET keyed by provider (the card's
  // shape — not a boolean, not the current URL param): the landing must
  // complete — cache refresh and the auto-grant the Slack button promised —
  // even if the dialog was closed or the param changed to a DIFFERENT
  // provider while the popup was in flight, and a stale claim must never be
  // consumed by another provider's popup.
  const claimed = useRef(new Set<string>());

  useAppMessages({
    onConnected: ({ provider: connected, connectionId }) => {
      if (!connected || !claimed.current.has(connected)) return;
      claimed.current.delete(connected);
      // The pool changed even without a fresh id — refresh the list and the
      // count badges, like the in-chat card does.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.connections.all(),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
      // Fresh connection from this door: wire the agent up with full access
      // — the outcome the Slack card's button promised.
      if (connectionId && agentId) {
        setGrant.mutate({
          agentId,
          connectionId,
          input: { access: "full" },
        });
      }
    },
    // The app needs credentials configured before it can connect; this
    // dialog has no config surface, so route to the connections page — the
    // same routing as the in-chat card.
    onConfigure: (configureProvider) => {
      if (!claimed.current.has(configureProvider)) return;
      claimed.current.delete(configureProvider);
      router.push(
        connectionsPath(
          { pathname },
          `/apps/${encodeURIComponent(configureProvider)}`,
        ),
      );
    },
  });

  // CONSUME the link: strip its param (shallow — no server round-trip), the
  // same convention as the agent page's other param-consuming surfaces
  // (apps-section, channels-section).
  const stripParam = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete("attach");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  }, []);

  // A shape-valid id the catalog doesn't know gets feedback, not silence —
  // honest clicks land here on version skew (the Slack adapter's newer
  // catalog vs this bundle) or a since-removed app. Consumed so refresh
  // stays quiet; shape-INVALID ids keep pure silence (a crafted link
  // deserves none).
  const unknownToasted = useRef<string | null>(null);
  useEffect(() => {
    if (!raw || provider || !PROVIDER_ID_RE.test(raw)) return;
    if (unknownToasted.current === raw) return;
    unknownToasted.current = raw;
    toast.error("That app isn't available here yet.");
    stripParam();
  }, [raw, provider, stripParam]);

  // Closed-but-still-parameterized guard: the shallow strip is the real
  // consumption, and this state closes the dialog immediately regardless of
  // when the router syncs the stripped URL back into useSearchParams. A
  // fresh deep link (the param reappearing after a real strip) reopens.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!provider) setClosedFor(null);
  }, [provider]);

  const close = useCallback(() => {
    setClosedFor(provider);
    stripParam();
  }, [provider, stripParam]);

  if (!provider || !agentId) return null;

  // Mounted while the param is present, open driven by state — so closing
  // plays Radix's exit animation instead of snap-unmounting, and the
  // provider key remounts fresh dialog state if a new deep link swaps the
  // app mid-open.
  return (
    <AttachConnectionDialog
      key={provider}
      agentId={agentId}
      agentName={agentName}
      provider={provider}
      open={provider !== closedFor}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onConnectNew={() => {
        claimed.current.add(provider);
        const app = getApp(provider);
        const popup = openConnectPopup(provider, {
          workspaceId,
          ...(agentName && { agentName }),
          ...(app && { height: connectPopupHeight(app) }),
        });
        if (!popup) {
          claimed.current.delete(provider);
          toast.error(
            "Popup blocked. Allow popups for this site and try again.",
          );
        }
      }}
    />
  );
};
