"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AgentIcon } from "@/lib/agents/agent-icon";
import { useAgents } from "@/hooks/use-agents";
import { useGrantsSummary } from "@/hooks/use-grants";
import { useHostedAvailability } from "@/hooks/use-hosted-availability";
import { useOrg } from "@/hooks/use-org";
import { createDoor } from "@/lib/agents/create-door";
import { IS_CLOUD } from "@/lib/env";
import { agentSectionPath, AGENT_CREATE_PARAM } from "@/lib/navigation";
import { Card } from "@onecli/ui/components/card";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { AgentCard } from "./agent-card";
import { CreateAgentDialog } from "./create-agent-dialog";
import { NewHostedAgentDialog } from "./new-hosted-agent-dialog";
import { HostedOnboardingDialog } from "./hosted-onboarding-dialog";
import { AgentCreateDoor, type CreateDoorPrimary } from "./agent-create-door";

interface AgentsContentProps {
  /** Cloud composes its quota-gated primary button in here. */
  renderCreateButton?: (primary: CreateDoorPrimary) => React.ReactNode;
}

export const AgentsContent = ({
  renderCreateButton,
}: AgentsContentProps = {}) => {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const manageAgentId = searchParams.get("manage");
  const createRequested = searchParams.get(AGENT_CREATE_PARAM) !== null;
  const { data: agents, isPending: loading } = useAgents();
  // The door needs to tell "no agents" from "we don't know yet" (an error
  // leaves `data` undefined with `loading` false), but every RENDER below
  // wants a list — without this, a failed read paints neither cards nor the
  // empty state, just a blank page.
  const agentList = agents ?? [];
  const { data: summaries = [] } = useGrantsSummary();
  const [createOpen, setCreateOpen] = useState(false);
  const [hostedOpen, setHostedOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // Read, not polled: the sidebar and the chat section own the availability
  // poll; the shared cache is fresh enough to decide which create door shows.
  const availability = useHostedAvailability();
  // The org's creation world (cloud: byoLegacy picks the door; the hook is
  // disabled on self-host, where a disabled query reports isPending forever —
  // hence every read below guards with IS_CLOUD).
  const { data: org, isPending: orgPending } = useOrg();
  const orgLoading = IS_CLOUD && orgPending;
  // ONE door — on cloud the org's world decides; self-host keeps the
  // what-you-already-have rule (§3.10 as re-decided 2026-08-23).
  const door = createDoor({
    agents,
    availability,
    orgByoLegacy: IS_CLOUD ? (org?.byoLegacy ?? null) : null,
    orgByoEnabled: IS_CLOUD ? (org?.byoEnabled ?? null) : null,
  });
  // A legacy user's move to hosted is a migration, so their hosted entry books
  // the onboarding call; everyone else goes straight into creation. Cloud
  // only, and only the BYO world: the call migrates a BYO-world org onto OUR
  // runners. The mixed world (`hosted-with-byo`) is already living on them —
  // its hosted primary opens creation, never the call. A self-host
  // deployment's hosted agents run on its own runner — there is nothing for
  // us to migrate, so its chevron opens hosted creation directly.
  const onCreateHosted = () =>
    IS_CLOUD && door === "byo-with-hosted"
      ? setOnboardingOpen(true)
      : setHostedOpen(true);

  // `?new=1` (the primary button's landing): open the create flow on arrival
  // and strip the param, so a refresh doesn't reopen it.
  //
  // It opens THE SAME door the page's own create button would (§3.15 as
  // amended) — deliberately routed through `onCreateHosted`, so a legacy BYO
  // user still gets the onboarding call rather than being dropped into hosted
  // creation. Opening the hosted dialog directly here would have quietly
  // bypassed that migration gate for anyone arriving by link.
  //
  // Waits for the reads the door actually depends on: the agent list
  // (`createDoor` treats `undefined` as "still loading" and falls back to
  // BYO), on cloud the org's world (an org-world miss would drop a BYO-world
  // user into hosted creation instead of the onboarding call), and
  // availability — EXCEPT for a byoLegacy=false org (the hosted AND mixed
  // worlds), whose door ignores availability entirely: a failed instance
  // read parks availability on "loading" forever, and this link must not
  // stall while the page happily paints the hosted door.
  //
  // The guard is the PARAM's presence, never a latch: stripping it is what
  // makes this fire once, so pressing the button again on this same page
  // reopens the dialog. A one-shot ref silently broke that second press.
  const doorAwaitsAvailability =
    availability === "loading" && !(IS_CLOUD && org?.byoLegacy === false);
  useEffect(() => {
    if (!createRequested || doorAwaitsAvailability || loading || orgLoading)
      return;
    // `?new=1` is a HOSTED-INTENT link (the Get Started landing): any door
    // with a hosted arm routes through `onCreateHosted` — hosted-world orgs
    // into creation, BYO-world orgs into the onboarding call (deliberately
    // NOT the page's BYO primary) — and only the pure-BYO door opens BYO
    // creation. Routed on the DOOR, never raw availability, which would
    // disagree with it (e.g. a hosted-world org on a runner-less read must
    // still land in the hosted flow, not BYO creation).
    if (door === "byo") setCreateOpen(true);
    else onCreateHosted();
    const params = new URLSearchParams(searchParams);
    params.delete(AGENT_CREATE_PARAM);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
    // `onCreateHosted` is intentionally not a dependency: it is recreated every
    // render, and the door it picks is already pinned by `availability` and
    // `door` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    createRequested,
    doorAwaitsAvailability,
    loading,
    orgLoading,
    door,
    searchParams,
    router,
    pathname,
  ]);

  // `?manage=<id-prefix>` (attach-model step 3): the deep link lands on the
  // agent page's Connections section — the attach surfaces live there now. Prefix
  // matching preserved from the old dialog-opening behavior; one-shot per
  // mount.
  const redirected = useRef(false);
  useEffect(() => {
    if (redirected.current || !manageAgentId || !agents?.length) return;
    const target = agents.find((a) => a.id.startsWith(manageAgentId));
    if (!target) return;
    redirected.current = true;
    router.replace(agentSectionPath(pathname, target.id, "connections"));
    // Depends on `agents` (the query's stable reference), never on the
    // `agentList` fallback: a fresh array literal every render would re-run
    // this effect on every render.
  }, [manageAgentId, agents, router, pathname]);

  const summaryByAgent = new Map(summaries.map((s) => [s.id, s.grantsSummary]));

  // Gate on the agents read, plus (cloud) the org's world while it is genuinely
  // in flight — the world decides the PRIMARY button, and swapping a primary
  // after paint breaks the user. `orgLoading` is react-query's isPending, never
  // `org == null`: an errored org read renders with the workspace-derived
  // fallback instead of a permanent skeleton. Availability "loading" likewise
  // deliberately falls back (see createDoor) rather than holding the page:
  // useInstance returns null for BOTH in-flight and failed reads.
  if (loading || orgLoading) {
    return (
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <Card key={i} className="p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-48" />
              </div>
              <div className="flex gap-2">
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="size-8 rounded-md" />
              </div>
            </div>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <AgentCreateDoor
          door={door}
          onCreateByo={() => setCreateOpen(true)}
          onCreateHosted={onCreateHosted}
          renderPrimary={renderCreateButton}
        />
      </div>

      {agentList.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-16 text-center">
          <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
            <AgentIcon className="text-muted-foreground size-6" />
          </div>
          <p className="text-sm font-medium">No agents yet</p>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs">
            {/* Describes the PRIMARY button on this page — keyed to the door,
                not the hosted surface: a failed agents read leaves the split
                door over an empty list, where the visible primary is BYO and
                promising the brief-and-chat flow would point at a button that
                isn't there. */}
            {door === "hosted" || door === "hosted-with-byo"
              ? "Create an agent, give it a brief, and start chatting."
              : "Create an agent to generate an access token for connecting to the gateway."}
          </p>
        </Card>
      ) : (
        agentList.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            summary={summaryByAgent.get(agent.id)}
          />
        ))
      )}

      <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
      <NewHostedAgentDialog open={hostedOpen} onOpenChange={setHostedOpen} />
      <HostedOnboardingDialog
        open={onboardingOpen}
        onOpenChange={setOnboardingOpen}
      />
    </div>
  );
};
