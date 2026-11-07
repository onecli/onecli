"use client";

import { useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Checkbox } from "@onecli/ui/components/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { cn } from "@onecli/ui/lib/utils";
import type { ConversationKind } from "./api";
import { useMyConversations, useShareConversations } from "./hooks";
import { KIND_ICON } from "./read-constants";

export interface AddReadGrantDialogProps {
  agentId: string;
  agentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Already shared: hidden from the list. */
  grantedRefs: string[];
}

type Filter = "all" | ConversationKind;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "channel", label: "Public" },
  { value: "private_channel", label: "Private" },
  { value: "dm", label: "DMs" },
  { value: "group_dm", label: "Group DMs" },
];

/**
 * Pick ONE OR MANY of your own Slack conversations for the agent to read,
 * only ever asked about by you. Filter chips + "select all shown" make bulk
 * picks quick, but each pick still becomes its own grant (a snapshot: new
 * conversations are never added implicitly).
 */
export const AddReadGrantDialog = ({
  agentId,
  agentName,
  open,
  onOpenChange,
  grantedRefs,
}: AddReadGrantDialogProps) => {
  const mine = useMyConversations(agentId, open);
  const share = useShareConversations(agentId);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const shareable = useMemo(
    () =>
      (mine.data?.conversations ?? []).filter(
        (c) => !grantedRefs.includes(c.ref),
      ),
    [mine.data, grantedRefs],
  );
  const counts = useMemo(() => {
    const n: Record<Filter, number> = {
      all: shareable.length,
      channel: 0,
      private_channel: 0,
      dm: 0,
      group_dm: 0,
    };
    for (const c of shareable) n[c.kind] += 1;
    return n;
  }, [shareable]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^[#@]/, "");
    return shareable.filter(
      (c) =>
        (filter === "all" || c.kind === filter) &&
        (!q || c.name.toLowerCase().replace(/^[#@]/, "").includes(q)),
    );
  }, [shareable, filter, query]);

  const picked = shareable.filter((c) => selected.has(c.ref));
  const shownSelected = shown.filter((c) => selected.has(c.ref)).length;
  const allShown = shown.length > 0 && shownSelected === shown.length;

  const toggle = (ref: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });

  const toggleAllShown = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of shown) {
        if (allShown) next.delete(c.ref);
        else next.add(c.ref);
      }
      return next;
    });

  const reset = () => {
    setQuery("");
    setFilter("all");
    setSelected(new Set());
  };

  const submit = () => {
    if (picked.length === 0) return;
    share.mutate(
      { externalRefs: picked.map((c) => c.ref) },
      {
        onSuccess: () => {
          toast.success(
            picked.length === 1
              ? `${agentName} can now read ${picked[0]!.name}`
              : `${agentName} can now read ${picked.length} conversations`,
          );
          reset();
          onOpenChange(false);
        },
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Couldn't share"),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Let {agentName} read conversations</DialogTitle>
          <DialogDescription className="text-pretty">
            Only conversations you&apos;re in are listed. {agentName} reads them
            with your Slack access and can never post. Conversations you join
            later are not added automatically.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="slack-read-search">Conversations</Label>
            <div className="relative">
              <Search
                className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
                aria-hidden
              />
              <Input
                id="slack-read-search"
                className="pl-8"
                placeholder="Search channels and people"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div
              role="group"
              aria-label="Filter by type"
              className="flex flex-wrap gap-1.5"
            >
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={filter === f.value}
                  onClick={() => setFilter(f.value)}
                  disabled={f.value !== "all" && counts[f.value] === 0}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-xs disabled:opacity-40",
                    filter === f.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "hover:bg-muted",
                  )}
                >
                  {f.label}{" "}
                  <span className="tabular-nums opacity-70">
                    {counts[f.value]}
                  </span>
                </button>
              ))}
            </div>
            <div className="rounded-md border">
              {shown.length > 0 && !mine.isPending && !mine.isError ? (
                <label className="bg-muted/50 flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-sm font-medium">
                  <Checkbox
                    checked={
                      allShown
                        ? true
                        : shownSelected > 0
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={toggleAllShown}
                    aria-label={`Select all ${shown.length} shown`}
                  />
                  Select all {shown.length} shown
                  {selected.size > 0 ? (
                    <span className="text-muted-foreground ml-auto text-xs font-normal tabular-nums">
                      {selected.size} selected
                    </span>
                  ) : null}
                </label>
              ) : null}
              <div
                role="listbox"
                aria-label="Your conversations"
                aria-multiselectable
                className="max-h-64 overflow-y-auto"
              >
                {mine.isPending ? (
                  <p className="text-muted-foreground flex items-center gap-2 p-3 text-sm">
                    <Loader2
                      className="size-3.5 animate-spin motion-reduce:hidden"
                      aria-hidden
                    />
                    Loading your conversations…
                  </p>
                ) : mine.isError ? (
                  <div className="flex items-center justify-between gap-2 p-3 text-sm">
                    <span className="text-muted-foreground">
                      {mine.error instanceof Error
                        ? mine.error.message
                        : "Couldn't load your conversations."}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => mine.refetch()}
                    >
                      Try again
                    </Button>
                  </div>
                ) : shown.length === 0 ? (
                  <p className="text-muted-foreground p-3 text-sm">
                    {query || filter !== "all"
                      ? "No match."
                      : "Nothing left to share."}
                  </p>
                ) : (
                  shown.map((c) => {
                    const Icon = KIND_ICON[c.kind];
                    const on = selected.has(c.ref);
                    return (
                      <div
                        key={c.ref}
                        role="option"
                        aria-selected={on}
                        tabIndex={0}
                        onClick={() => toggle(c.ref)}
                        onKeyDown={(e) => {
                          if (e.key === " " || e.key === "Enter") {
                            e.preventDefault();
                            toggle(c.ref);
                          }
                        }}
                        className={cn(
                          "hover:bg-muted flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm",
                          on && "bg-muted",
                        )}
                      >
                        <Checkbox
                          checked={on}
                          tabIndex={-1}
                          aria-hidden
                          className="pointer-events-none"
                        />
                        <Icon
                          className="text-muted-foreground size-4 shrink-0"
                          aria-hidden
                        />
                        <span className="truncate" translate="no">
                          {c.name}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
          <p className="text-muted-foreground text-xs text-pretty">
            Only you can ask {agentName} about{" "}
            {picked.length > 1 ? "them" : "it"}, in your own chat with it or
            your own schedules.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={share.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={picked.length === 0 || share.isPending}
          >
            {share.isPending ? (
              <>
                <Loader2
                  className="size-3.5 animate-spin motion-reduce:hidden"
                  aria-hidden
                />
                Sharing…
              </>
            ) : picked.length > 1 ? (
              `Share ${picked.length}`
            ) : (
              "Share"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
