"use client";

import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { Button } from "@onecli/ui/components/button";
import {
  settingsPage,
  visibleSettingsPages,
  type SettingsPageId,
  type SettingsViewer,
} from "./pages";

/** Below `md` the nav column is a menu, so the page keeps the room. */
export const MobilePagePicker = ({
  page,
  viewer,
  onPick,
}: {
  page: SettingsPageId;
  viewer: SettingsViewer;
  onPick: (id: SettingsPageId) => void;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="outline" size="sm" className="gap-1.5">
        {settingsPage(page).title}
        <ChevronDown className="size-3.5 opacity-60" aria-hidden />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-56">
      {visibleSettingsPages(viewer).map((item) => (
        <DropdownMenuItem key={item.id} onSelect={() => onPick(item.id)}>
          <span className="text-muted-foreground w-24 shrink-0 text-xs">
            {item.section}
          </span>
          {item.title}
          {item.id === page && (
            <Check className="ml-auto size-3.5" aria-hidden />
          )}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
);
