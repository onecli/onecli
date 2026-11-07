"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { useSetWorkspaceTimezone } from "@/hooks/use-workspaces";

interface Props {
  workspaceId: string;
  /** The stored choice; null = the platform default. */
  currentTimezone: string | null;
}

/** Sentinel for "platform default": a Select item cannot carry an empty value. */
const DEFAULT_OPTION = "__default__";

/**
 * The zones this browser knows, grouped by IANA area. The list is the same
 * family the API validates against, so every entry is one the server
 * accepts. Computed once: the list does not change within a page.
 */
const zoneGroups = (): { area: string; zones: string[] }[] => {
  const byArea = new Map<string, string[]>();
  for (const zone of Intl.supportedValuesOf("timeZone")) {
    const area = zone.slice(0, zone.indexOf("/"));
    byArea.set(area, [...(byArea.get(area) ?? []), zone]);
  }
  return [...byArea.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([area, zones]) => ({ area, zones }));
};
const GROUPS = zoneGroups();
const KNOWN = new Set(GROUPS.flatMap(({ zones }) => zones));

export const WorkspaceTimezoneCard = ({
  workspaceId,
  currentTimezone,
}: Props) => {
  // What the server holds, as of the last save: the page is a server
  // component and its prop does not refresh after a mutation, so the saved
  // value is tracked here or "Save" would re-enable for the value just saved.
  const [saved, setSaved] = useState(currentTimezone);
  const [selected, setSelected] = useState(saved ?? DEFAULT_OPTION);
  // The visitor's own zone, read after mount: the server rendering this
  // page keeps a different clock, and a value that differs between the two
  // would mismatch on hydration.
  const [browserZone, setBrowserZone] = useState<string | null>(null);
  useEffect(() => {
    setBrowserZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  const setTimezone = useSetWorkspaceTimezone();
  // A stored zone this browser's list lacks (a legacy spelling saved from
  // another browser, say) still has to be selectable, or the trigger shows
  // nothing and the first save would silently replace it.
  const unlisted = saved && !KNOWN.has(saved) ? saved : null;
  const suggestBrowserZone =
    browserZone !== null && browserZone !== selected && KNOWN.has(browserZone);

  const chosen = selected === DEFAULT_OPTION ? null : selected;
  const dirty = chosen !== saved;
  const canSubmit = dirty && !setTimezone.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    try {
      const workspace = await setTimezone.mutateAsync({
        id: workspaceId,
        timezone: chosen,
      });
      setSaved(workspace.timezone);
      toast.success(
        chosen
          ? `Agents now keep time in ${chosen}`
          : "Agents now use the platform default timezone",
      );
    } catch {
      // the hook already toasts the server reason
    }
  };

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-base font-semibold">Timezone</h3>
          <p className="text-muted-foreground text-sm">
            The clock your agents&apos; computers run on: file timestamps, the
            dates they read and write, and the local time websites see. Changing
            it restarts every running agent in this workspace.
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="workspace-timezone">Zone</Label>
          <Select
            value={selected}
            onValueChange={setSelected}
            disabled={setTimezone.isPending}
          >
            <SelectTrigger id="workspace-timezone" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_OPTION}>Platform default</SelectItem>
              {unlisted !== null ? (
                <SelectItem value={unlisted}>{unlisted}</SelectItem>
              ) : null}
              <SelectSeparator />
              {GROUPS.map(({ area, zones }) => (
                <SelectGroup key={area}>
                  <SelectLabel>{area}</SelectLabel>
                  {zones.map((zone) => (
                    <SelectItem key={zone} value={zone}>
                      {zone}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          {suggestBrowserZone ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="text-muted-foreground hover:text-foreground h-auto w-fit px-0"
              onClick={() => setSelected(browserZone)}
              disabled={setTimezone.isPending}
            >
              Use my zone ({browserZone})
            </Button>
          ) : null}
        </div>
        <div className="flex justify-end">
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {setTimezone.isPending ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </div>
    </Card>
  );
};
