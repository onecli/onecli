"use client";

import { KeyRound, Sparkles } from "lucide-react";
import { DropdownMenuItem } from "@onecli/ui/components/dropdown-menu";
import type { CreateDoor } from "@/lib/agents/create-door";

interface AgentCreateDoorAlternativeProps {
  door: CreateDoor;
  onCreateByo: () => void;
  onCreateHosted: () => void;
}

/**
 * The chevron's one menu entry: the path that is NOT the door's primary.
 * Shared by the agents page's split button and the sidebar's New agent row,
 * so the two never disagree on what the second path is called or opens.
 */
export const AgentCreateDoorAlternative = ({
  door,
  onCreateByo,
  onCreateHosted,
}: AgentCreateDoorAlternativeProps) =>
  door === "hosted-with-byo" ? (
    // The mixed world's second path: BYO creation, named plainly — this menu
    // only exists for orgs that already know the word.
    <DropdownMenuItem onSelect={onCreateByo}>
      <KeyRound className="size-3.5" aria-hidden />
      New BYO agent
    </DropdownMenuItem>
  ) : (
    <DropdownMenuItem onSelect={onCreateHosted}>
      <Sparkles className="size-3.5" aria-hidden />
      New hosted agent
    </DropdownMenuItem>
  );
