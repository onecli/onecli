"use client";

import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { Button } from "@onecli/ui/components/button";
import { useSwitchWorkspaceInSettings } from "./use-switch-workspace";
import type { SettingsPageId } from "./pages";

/**
 * Top right of a workspace page: which workspace the page is about. Only
 * drawn when the viewer has more than one, so the one-workspace org (most
 * of them) never sees the word. Switching keeps the page and the param but
 * lands on the other workspace's chat underneath, so closing the modal
 * leaves you in the workspace you just looked at.
 */
export const WorkspacePicker = ({
  page,
  workspaceId,
  workspaces,
}: {
  page: SettingsPageId;
  workspaceId: string;
  workspaces: { id: string; name: string | null }[];
}) => {
  const { switchTo, pending } = useSwitchWorkspaceInSettings(page);
  const name = (w: { name: string | null }) => w.name ?? "Untitled workspace";
  const current = workspaces.find((w) => w.id === workspaceId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          aria-busy={pending}
        >
          <span className="text-muted-foreground">Workspace:</span>
          <span className="max-w-40 truncate font-medium">
            {current ? name(current) : "Choose"}
          </span>
          <ChevronDown className="size-3.5 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {workspaces.map((w) => (
          <DropdownMenuItem
            key={w.id}
            onSelect={() => {
              if (w.id !== workspaceId) switchTo(w.id);
            }}
          >
            <span className="truncate">{name(w)}</span>
            {w.id === workspaceId && (
              <Check className="ml-auto size-3.5" aria-hidden />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
