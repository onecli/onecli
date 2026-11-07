"use client";

import { useId, useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@onecli/ui/components/popover";
import { cn } from "@onecli/ui/lib/utils";

/** Every IANA zone the browser knows, plus UTC (some engines omit it). */
const allTimezones = (): string[] => {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
};

/** "America/Los_Angeles" as people read it. */
const zoneLabel = (zone: string) => zone.replace(/_/g, " ");

/**
 * The timezone field every schedule has: a searchable list, so a typo can't
 * be saved. A stored zone the list lacks is still shown and kept. The
 * search box keeps focus and drives the list (the combobox pattern):
 * Up/Down/Home/End move the active option, Enter picks it, Escape closes.
 */
export const ScheduleTimezoneField = ({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (timezone: string) => void;
}) => {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const zones = useMemo(() => {
    const list = allTimezones();
    return value && !list.includes(value) ? [value, ...list] : list;
  }, [value]);
  const needle = query.trim().toLowerCase().replace(/\s+/g, "_");
  const shown = needle
    ? zones.filter((zone) => zone.toLowerCase().includes(needle))
    : zones;
  const optionId = (index: number) => `${listId}-${index}`;

  const openList = (next: boolean) => {
    setOpen(next);
    setQuery("");
    // Open on the current zone, so arrows move from where the person is.
    setActive(Math.max(0, zones.indexOf(value)));
  };
  const pick = (zone: string) => {
    onChange(zone);
    openList(false);
  };
  const moveTo = (index: number) => {
    const next = Math.min(Math.max(index, 0), shown.length - 1);
    setActive(next);
    document
      .getElementById(optionId(next))
      ?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Timezone</Label>
      <Popover open={open} onOpenChange={openList}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            className="w-full justify-between font-normal"
          >
            <span className="truncate">{zoneLabel(value)}</span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-(--radix-popover-trigger-width) p-0"
        >
          <div className="border-b p-2">
            <Input
              autoFocus
              role="combobox"
              aria-label="Search timezones"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                shown.length > 0 ? optionId(active) : undefined
              }
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                const keys: Record<string, () => void> = {
                  ArrowDown: () => moveTo(active + 1),
                  ArrowUp: () => moveTo(active - 1),
                  Home: () => moveTo(0),
                  End: () => moveTo(shown.length - 1),
                  Enter: () => {
                    const zone = shown[active];
                    if (zone) pick(zone);
                  },
                };
                const handle = keys[event.key];
                if (!handle) return;
                event.preventDefault();
                handle();
              }}
              placeholder="Search, e.g. London…"
              className="h-8"
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label="Timezones"
            className="max-h-60 overflow-y-auto p-1"
          >
            {shown.length === 0 ? (
              <p className="text-muted-foreground px-2 py-1.5 text-sm">
                No timezone found
              </p>
            ) : (
              shown.map((zone, index) => (
                <div
                  key={zone}
                  id={optionId(index)}
                  role="option"
                  aria-selected={zone === value}
                  onClick={() => pick(zone)}
                  onMouseMove={() => setActive(index)}
                  className={cn(
                    // ~420 zones: offscreen rows skip layout and paint.
                    "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm [contain-intrinsic-size:auto_2rem] [content-visibility:auto]",
                    index === active && "bg-accent",
                  )}
                >
                  <Check
                    className={cn(
                      "size-4 shrink-0",
                      zone === value ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden
                  />
                  <span className="truncate">{zoneLabel(zone)}</span>
                </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};
