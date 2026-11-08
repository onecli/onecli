"use client";

import { useState } from "react";
import { useHostedAvailability } from "@/hooks/use-hosted-availability";
import { useOrg } from "@/hooks/use-org";
import {
  createDoor,
  isHostedPrimary,
  type CreateDoor,
} from "@/lib/agents/create-door";
import { IS_CLOUD } from "@/lib/env";
import type { AgentKind } from "@/lib/api/types";
import { CreateAgentDialog } from "./create-agent-dialog";
import { NewHostedAgentDialog } from "./new-hosted-agent-dialog";
import { HostedOnboardingDialog } from "./hosted-onboarding-dialog";

export interface AgentCreateFlow {
  /** Which create door this org/workspace gets (see `createDoor`). */
  door: CreateDoor;
  /** False while the reads that decide the PRIMARY action are in flight: the
   *  agent list, and on cloud the org's world. Callers hold their trigger
   *  until then — swapping a primary after paint is the broken transition
   *  the door exists to prevent. */
  ready: boolean;
  /** True while the door still depends on an availability read (BYO world
   *  only — hosted and mixed worlds ignore availability). */
  awaitingAvailability: boolean;
  /** Open BYO (access-token) creation. */
  openByo: () => void;
  /** The hosted path: creation for everyone, except a cloud BYO-world org,
   *  whose move to hosted is a migration and books the onboarding call. */
  openHosted: () => void;
  /** The door's primary action (what "New agent" means here). */
  openPrimary: () => void;
  /** Whether a create flow has been opened since mount (a latch). The hosted
   *  flow runs follow-up steps (LLM key, connections) AFTER its own dialog
   *  closes and the new agent already exists, so "is a dialog open" is not
   *  enough to know the user is mid-creation. */
  engaged: boolean;
  /** The create dialogs, each mounted on its first open (they carry their
   *  own reads, which a closed dialog on every page must not spend). Render
   *  once, anywhere in the tree. */
  dialogs: React.ReactNode;
}

/**
 * The ONE agent-create flow, shared by every entry point (the sidebar's
 * "New agent" row and the empty agents page): it decides the door, routes a
 * click to the right dialog, and owns the dialogs. Two copies of "a BYO-world
 * org's hosted click books a call" would drift the first time either moved.
 *
 * `agents` is the caller's list (`undefined` while loading) — the sidebar
 * reads it by explicit workspace, the page by URL scope; the door only needs
 * each agent's `kind`.
 */
export const useAgentCreateFlow = (
  agents: { kind: AgentKind }[] | undefined,
  agentsPending: boolean,
): AgentCreateFlow => {
  const [byoOpen, setByoOpen] = useState(false);
  const [hostedOpen, setHostedOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // Which dialogs have ever opened: each mounts then and STAYS mounted, so
  // its close animation and post-create steps (LLM key, connections) run.
  // `markOpened` keeps the same object once a dialog is marked, so opening
  // again is a no-op re-render (the `?new=` effect may call an opener more
  // than once).
  const [opened, setOpened] = useState<
    Partial<Record<"byo" | "hosted" | "onboarding", true>>
  >({});
  const markOpened = (dialog: "byo" | "hosted" | "onboarding") =>
    setOpened((o) => (o[dialog] ? o : { ...o, [dialog]: true }));
  const engaged = Object.keys(opened).length > 0;
  // Read, not polled: the sidebar and the chat section own the availability
  // poll; the shared cache is fresh enough to decide which door shows.
  const availability = useHostedAvailability();
  // Cloud-only by construction: a disabled query reports isPending forever,
  // hence every read below guards with IS_CLOUD.
  const { data: org, isPending: orgPending } = useOrg();
  const orgLoading = IS_CLOUD && orgPending;
  const door = createDoor({
    agents: agentsPending ? undefined : (agents ?? []),
    availability,
    orgByoLegacy: IS_CLOUD ? (org?.byoLegacy ?? null) : null,
    orgByoEnabled: IS_CLOUD ? (org?.byoEnabled ?? null) : null,
  });

  const openByo = () => {
    markOpened("byo");
    setByoOpen(true);
  };
  // Cloud only, and only the BYO world: the call migrates a BYO-world org
  // onto OUR runners. A self-host deployment's hosted agents run on its own
  // runner — nothing to migrate, so hosted opens creation directly.
  const openHosted = () => {
    if (IS_CLOUD && door === "byo-with-hosted") {
      markOpened("onboarding");
      setOnboardingOpen(true);
    } else {
      markOpened("hosted");
      setHostedOpen(true);
    }
  };

  return {
    door,
    ready: !agentsPending && !orgLoading,
    awaitingAvailability:
      availability === "loading" && !(IS_CLOUD && org?.byoLegacy === false),
    openByo,
    openHosted,
    openPrimary: isHostedPrimary(door) ? openHosted : openByo,
    engaged,
    dialogs: (
      <>
        {opened.byo && (
          <CreateAgentDialog open={byoOpen} onOpenChange={setByoOpen} />
        )}
        {opened.hosted && (
          <NewHostedAgentDialog
            open={hostedOpen}
            onOpenChange={setHostedOpen}
          />
        )}
        {opened.onboarding && (
          <HostedOnboardingDialog
            open={onboardingOpen}
            onOpenChange={setOnboardingOpen}
          />
        )}
      </>
    ),
  };
};
