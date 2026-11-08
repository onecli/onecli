"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AgentIcon } from "@/lib/agents/agent-icon";
import { useAgents } from "@/hooks/use-agents";
import { defaultAgentSection } from "@/lib/agents/agent-sections";
import { sortAgentsOldestFirst } from "@/lib/agents/agent-order";
import { isHostedPrimary } from "@/lib/agents/create-door";
import {
  agentSectionPath,
  AGENT_CREATE_PARAM,
  AGENT_CREATE_PRIMARY,
} from "@/lib/navigation";
import { Card } from "@onecli/ui/components/card";
import { AgentCreateControl } from "./agent-create-control";
import type { CreateDoorPrimary } from "./agent-create-door";
import { AgentsDoorSkeleton } from "./agents-door-skeleton";
import { useAgentCreateFlow } from "./use-agent-create-flow";

interface AgentsContentProps {
  /** Cloud composes its quota-gated primary button in here. */
  renderCreateButton?: (primary: CreateDoorPrimary) => React.ReactNode;
}

/**
 * `/w/<id>/agents` is no longer a roster: every agent is a row in the
 * sidebar, and everything a card used to offer lives on the agent's own page.
 * What is left here is the door to creation:
 *
 * - With agents and nothing asked for: forward to the first (oldest) agent —
 *   the same front door a bare `/w/<id>` opens — so the many "back to agents"
 *   links land somewhere real.
 * - With no agents: the empty state and its create button.
 * - `?new=1` (the header's Get Started landing): open the hosted-intent
 *   create flow; `?new=primary`: open the door's primary action.
 * - `?manage=<id-prefix>`: forward to that agent's Connections.
 */
export const AgentsContent = ({
  renderCreateButton,
}: AgentsContentProps = {}) => {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const manageAgentId = searchParams.get("manage");
  const createRequested = searchParams.get(AGENT_CREATE_PARAM) !== null;
  const createPrimary =
    searchParams.get(AGENT_CREATE_PARAM) === AGENT_CREATE_PRIMARY;
  const { data: agents, isPending: loading } = useAgents();
  // An error leaves `data` undefined with `loading` false: render the empty
  // state with its create button rather than a blank page.
  const agentList = agents ?? [];
  const flow = useAgentCreateFlow(agents, loading);

  // `?new=1`: open the create flow on arrival and strip the param, so a
  // refresh doesn't reopen it. It is a HOSTED-INTENT link: any door with a
  // hosted arm routes through `openHosted` — hosted-world orgs into creation,
  // BYO-world orgs into the onboarding call (never around that gate) — and
  // only the pure-BYO door opens BYO creation. Waits for every read the door
  // depends on (`flow.ready`, and availability where the door needs it).
  //
  // The guard is the PARAM's presence, never a latch: stripping it is what
  // makes this fire once, so pressing the button again reopens the dialog.
  useEffect(() => {
    if (!createRequested || flow.awaitingAvailability || !flow.ready) return;
    if (createPrimary) flow.openPrimary();
    else if (flow.door === "byo") flow.openByo();
    else flow.openHosted();
    const params = new URLSearchParams(searchParams);
    params.delete(AGENT_CREATE_PARAM);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
    // `flow`'s openers are recreated every render; the door they route on is
    // already pinned by `flow.door` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    createRequested,
    createPrimary,
    flow.awaitingAvailability,
    flow.ready,
    flow.door,
    searchParams,
    router,
    pathname,
  ]);

  // `?manage=<id-prefix>` (attach-model step 3) lands on the agent page's
  // Connections section; otherwise, with agents and nothing asked for, the
  // first (oldest) agent. One-shot per mount.
  const redirected = useRef(false);
  const forwardTo = (() => {
    if (!agents?.length) return null;
    if (manageAgentId) {
      const target = agents.find((a) => a.id.startsWith(manageAgentId));
      return target
        ? agentSectionPath(pathname, target.id, "connections")
        : null;
    }
    // Never once creation is asked for or started: the user came here to
    // create, and the hosted flow's follow-up steps (LLM key, connections)
    // run after the new agent exists — forwarding then would unmount them.
    if (createRequested || flow.engaged) return null;
    const first = sortAgentsOldestFirst(agents)[0];
    return first
      ? agentSectionPath(pathname, first.id, defaultAgentSection(first.kind))
      : null;
  })();
  useEffect(() => {
    if (redirected.current || !forwardTo) return;
    redirected.current = true;
    router.replace(forwardTo);
  }, [forwardTo, router]);

  if (loading || forwardTo) return <AgentsDoorSkeleton />;

  const hasAgents = agentList.length > 0;
  return (
    <Card className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <div className="bg-muted flex size-12 items-center justify-center rounded-full">
        <AgentIcon className="text-muted-foreground size-6" />
      </div>
      <div>
        <p className="text-sm font-medium">
          {hasAgents ? "Create an agent" : "No agents yet"}
        </p>
        <p className="text-muted-foreground mt-1 max-w-xs text-xs">
          {/* Describes the PRIMARY button below — keyed to the door, not the
              hosted surface: a BYO-world org's visible primary is BYO, and
              promising the brief-and-chat flow would point at a button that
              isn't there. */}
          {isHostedPrimary(flow.door)
            ? "Create an agent, give it a brief, and start chatting."
            : "Create an agent to generate an access token for connecting to the gateway."}
        </p>
      </div>
      <AgentCreateControl flow={flow} renderCreateButton={renderCreateButton} />
    </Card>
  );
};
