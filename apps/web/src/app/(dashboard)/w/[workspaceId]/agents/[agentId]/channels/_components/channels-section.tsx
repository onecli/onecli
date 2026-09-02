"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { queryKeys } from "@/lib/api/keys";
import { useAgentChannels } from "@/hooks/use-channels";
import {
  useAppMessages,
  type AppConnectedEvent,
} from "@/hooks/use-app-connected";
import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { SlackAttachCard } from "./slack-attach-card";
import { SlackPresenceCard } from "./slack-presence-card";

/**
 * The agent's Channels section (step 6): one Slack card whose state follows
 * the presence — unattached (guided or paste floor, by org credential and
 * posture), pending (resume), attached, needs-attention. The frame provides
 * the section shell and guarantees the agent is hosted.
 *
 * Loading renders a skeleton, never "unavailable" — the availability rule the
 * chat surfaces follow.
 */
export const ChannelsSection = () => {
  const agent = useAgentPageAgent();
  const qc = useQueryClient();
  const view = useAgentChannels(agent.id);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // The events-arm install opens `installUrl` in a popup; Slack's OAuth
  // callback redirects that popup HERE with `?connected=slack`. The popup
  // instance hands the result to its opener (the page the user is watching)
  // and closes; a same-tab landing consumes the param directly. One-shot per
  // mount, then stripped, so a refresh doesn't re-toast (the app-detail
  // pattern).
  const connectedParam = searchParams.get("connected");
  const consumedConnectedParam = useRef(false);
  useEffect(() => {
    if (consumedConnectedParam.current) return;
    if (connectedParam !== "slack") return;
    consumedConnectedParam.current = true;
    if (window.opener) {
      (window.opener as Window).postMessage(
        { type: "app-connected", provider: "slack" },
        window.location.origin,
      );
      window.close();
      return;
    }
    qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    // The sidebar/rail Slack marks read the agent lists — root(), so the
    // sweep reaches the workspace-keyed sidebar key too.
    qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
    toast.success("Slack connected");
    const params = new URLSearchParams(searchParams.toString());
    params.delete("connected");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [connectedParam, qc, searchParams, router, pathname]);

  const handleConnected = useCallback(
    ({ provider }: AppConnectedEvent) => {
      // Provider must match: a popup keeps posting to its opener across
      // client-side navigation, so an app-connect popup opened elsewhere can
      // land here too.
      if (provider !== "slack") return;
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
      // Same sweep as the same-tab landing above — the Slack marks.
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
      toast.success("Slack connected");
    },
    [qc],
  );
  useAppMessages({ onConnected: handleConnected });

  if (view.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (view.isError) {
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground text-sm">
          The channel status didn&apos;t load.
        </p>
        <Button variant="outline" size="sm" onClick={() => view.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const data = view.data;
  const slack = data.presences.find((p) => p.provider === "slack");
  const orgSlack = data.orgIntegrations.find((i) => i.provider === "slack");
  const hasOrgCredentials = orgSlack?.hasCredentials ?? false;
  // Offline is a statement about presences that exist — an unattached agent
  // has nothing to be offline (and loading must never read as offline).
  const showOfflineBanner = !data.adapter.online && data.presences.length > 0;

  return (
    <div className="space-y-4">
      {showOfflineBanner && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 dark:border-amber-500/40 dark:bg-amber-500/15">
          <AlertTriangle
            className="size-4 shrink-0 text-amber-500"
            aria-hidden
          />
          <p className="min-w-0 text-sm">
            Channels are offline. The adapter hasn&apos;t reported in a while.
          </p>
        </div>
      )}

      {slack && slack.status !== "pending_setup" ? (
        <SlackPresenceCard
          agentId={agent.id}
          agentName={agent.name}
          presence={slack}
          hasOrgCredentials={hasOrgCredentials}
        />
      ) : (
        <SlackAttachCard
          agentId={agent.id}
          posture={data.posture}
          // A pending presence resumes on ITS transport (the provider-side app
          // baked one in); a fresh attach starts from the deployment's posture.
          pendingTransport={slack?.transport}
          hasOrgCredentials={hasOrgCredentials}
          organizationId={data.organizationId}
          viewerIsOrgAdmin={data.viewerIsOrgAdmin ?? true}
          resuming={slack?.status === "pending_setup"}
        />
      )}
    </div>
  );
};
