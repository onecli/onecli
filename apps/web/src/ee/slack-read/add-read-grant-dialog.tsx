"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Loader2, Search } from "lucide-react";
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
import type { ConversationKind, MyConversation, ReadAudience } from "./api";
import { useMyConversations, useShareConversations } from "./hooks";
import { AUDIENCE_ORDER, AUDIENCES, KIND_ICON } from "./read-grant-row";

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

const isPrivateMessage = (c: MyConversation) =>
  c.kind === "dm" || c.kind === "group_dm";

/**
 * Pick ONE OR MANY of your own Slack conversations for the agent to read,
 * and who may ask about them. Filter chips + "select all shown" make bulk
 * picks quick, but each pick still becomes its own grant (a snapshot: new
 * conversations are never added implicitly). New shares default to "Only
 * me", and sharing DMs with "Anyone" needs an explicit acknowledgement.
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
  const [audience, setAudience] = useState<ReadAudience>("granter_only");
  const [ackDms, setAckDms] = useState(false);

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
  const pickedDms = picked.filter(isPrivateMessage).length;
  const needsAck = audience === "anyone" && pickedDms > 0;
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
    setAudience("granter_only");
    setAckDms(false);
  };

  const submit = () => {
    if (picked.length === 0 || (needsAck && !ackDms)) return;
    share.mutate(
      { externalRefs: picked.map((c) => c.ref), audience },
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
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Who can ask about {picked.length > 1 ? "them" : "it"}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {AUDIENCE_ORDER.map((value) => {
                const option = AUDIENCES[value];
                const Icon = option.icon;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={audience === value}
                    onClick={() => {
                      setAudience(value);
                      setAckDms(false);
                    }}
                    className={cn(
                      "rounded-md border p-3 text-left",
                      audience === value
                        ? "border-primary ring-primary/20 ring-2"
                        : "hover:bg-muted",
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <Icon className="size-3.5" aria-hidden />
                      {option.label}
                    </span>
                    <span className="text-muted-foreground mt-1 block text-xs text-pretty">
                      {option.hint}
                    </span>
                  </button>
                );
              })}
            </div>
            {needsAck ? (
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                <Checkbox
                  checked={ackDms}
                  onCheckedChange={(v) => setAckDms(v === true)}
                  className="mt-0.5"
                />
                <span className="text-pretty">
                  <AlertTriangle
                    className="mr-1 inline size-3.5 text-amber-600"
                    aria-hidden
                  />
                  {pickedDms === 1
                    ? "1 private message is selected."
                    : `${pickedDms} private messages are selected.`}{" "}
                  Anyone {agentName} talks to will be able to ask about{" "}
                  {pickedDms === 1 ? "it" : "them"}. I understand.
                </span>
              </label>
            ) : null}
          </fieldset>
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
            disabled={
              picked.length === 0 || (needsAck && !ackDms) || share.isPending
            }
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
