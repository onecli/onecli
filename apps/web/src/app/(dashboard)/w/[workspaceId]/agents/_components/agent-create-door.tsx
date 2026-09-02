"use client";

import { Plus, ChevronDown, Sparkles, KeyRound } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import type { CreateDoor } from "@/lib/agents/create-door";

/** What the EE wrapper needs to render the primary button itself (it gates on
 *  quota before letting the click through). */
export interface CreateDoorPrimary {
  onClick: () => void;
  label: string;
  /** The split shape's flat right edge — the wrapper must not drop it. */
  className?: string;
}

interface AgentCreateDoorProps {
  door: CreateDoor;
  /** Open the BYO (access-token) create dialog. */
  onCreateByo: () => void;
  /** The hosted path — a create dialog for new users, the onboarding-call
   *  dialog for legacy ones. The caller decides; this component only routes
   *  the click. */
  onCreateHosted: () => void;
  /** Cloud composes its quota-gated button in here (see `CreateAgentButton`). */
  renderPrimary?: (primary: CreateDoorPrimary) => React.ReactNode;
}

/**
 * The agents page's ONE create control.
 *
 * There used to be two primary buttons side by side, which asked the user to
 * know the difference between "hosted" and "bring your own" before they had
 * made a single agent. Now the page answers that question for them
 * (`createDoor`) and this renders the answer: one button, and — only where a
 * second path genuinely exists (`byo-with-hosted`, `hosted-with-byo`) — a
 * chevron holding the other one.
 */
export const AgentCreateDoor = ({
  door,
  onCreateByo,
  onCreateHosted,
  renderPrimary,
}: AgentCreateDoorProps) => {
  const split = door === "byo-with-hosted" || door === "hosted-with-byo";
  const hostedPrimary = door === "hosted" || door === "hosted-with-byo";
  const primary: CreateDoorPrimary = {
    onClick: hostedPrimary ? onCreateHosted : onCreateByo,
    // A new user is never shown the word "agent type": their one button is
    // just "New agent". A returning BYO user keeps the label they know.
    label: hostedPrimary ? "New agent" : "Create agent",
    // Flat inner edge so the button and its chevron read as one control, and
    // a focus lift so the later sibling can't paint over the focus ring.
    className: split ? "rounded-r-none focus-visible:z-10" : undefined,
  };

  return (
    <div className={split ? "flex items-stretch" : undefined}>
      {renderPrimary ? (
        renderPrimary(primary)
      ) : (
        <Button
          size="sm"
          onClick={primary.onClick}
          className={primary.className}
        >
          <Plus className="size-3.5" aria-hidden />
          {primary.label}
        </Button>
      )}
      {split && (
        <>
          {/* A hairline seam, not a gap: the pair is one control with two
              targets, the way the invite/provision pattern reads. */}
          <div
            className="bg-primary-foreground/20 my-1 w-px shrink-0"
            aria-hidden
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className="rounded-l-none px-2 focus-visible:z-10"
                aria-label="More ways to create an agent"
              >
                <ChevronDown className="size-3.5" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {door === "hosted-with-byo" ? (
                // The mixed world's second path: BYO creation, named plainly —
                // this menu only exists for orgs that already know the word.
                <DropdownMenuItem onSelect={onCreateByo}>
                  <KeyRound className="size-3.5" aria-hidden />
                  New BYO agent
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={onCreateHosted}>
                  <Sparkles className="size-3.5" aria-hidden />
                  New hosted agent
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
};
