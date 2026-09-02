"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { Input } from "@onecli/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@onecli/ui/components/popover";
import { getApps } from "@onecli/api/apps/registry";
import { AppIcon } from "@/lib/components/app-icon";

export interface AppMultiSelectProps {
  /** Selected provider ids. */
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Accessible name for the trigger (e.g. the rule these apps belong to). */
  label?: string;
}

/** A compact multi-select over the app catalog — the apps a rule grants. */
export const AppMultiSelect = ({
  value,
  onChange,
  disabled,
  label,
}: AppMultiSelectProps) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const apps = useMemo(
    () => [...getApps()].sort((a, b) => a.name.localeCompare(b.name)),
    [],
  );
  const selected = useMemo(() => new Set(value), [value]);
  const selectedApps = apps.filter((a) => selected.has(a.id));

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? apps.filter((a) => a.name.toLowerCase().includes(needle))
    : apps;

  const toggle = (id: string) =>
    onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={label ? `Apps for ${label}` : undefined}
          className="h-8 min-w-[9rem] justify-between gap-2 font-normal"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {selectedApps.length === 0 ? (
              <span className="text-muted-foreground">Select apps</span>
            ) : (
              <>
                <span className="flex -space-x-1">
                  {selectedApps.slice(0, 3).map((a) => (
                    <span
                      key={a.id}
                      className="ring-background flex rounded-sm ring-2"
                    >
                      <AppIcon
                        icon={a.icon}
                        darkIcon={a.darkIcon}
                        name={a.name}
                        size={16}
                      />
                    </span>
                  ))}
                </span>
                <span className="text-xs whitespace-nowrap">
                  {selectedApps.length} app
                  {selectedApps.length === 1 ? "" : "s"}
                </span>
              </>
            )}
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 max-w-[90vw] p-0">
        <div className="border-b p-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search apps…"
            aria-label="Search apps"
            className="h-8"
            autoFocus
          />
        </div>
        <div className="max-h-64 overflow-y-auto overscroll-contain p-1">
          {filtered.length === 0 ? (
            <p className="text-muted-foreground px-2 py-6 text-center text-xs">
              No apps found.
            </p>
          ) : (
            filtered.map((a) => (
              <label
                key={a.id}
                className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5"
              >
                <Checkbox
                  checked={selected.has(a.id)}
                  onCheckedChange={() => toggle(a.id)}
                />
                <AppIcon
                  icon={a.icon}
                  darkIcon={a.darkIcon}
                  name={a.name}
                  size={18}
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {a.name}
                </span>
              </label>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
