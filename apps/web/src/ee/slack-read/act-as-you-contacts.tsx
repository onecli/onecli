"use client";

import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, UserMinus } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@onecli/ui/components/alert-dialog";
import { Button, buttonVariants } from "@onecli/ui/components/button";
import { useAppMessages } from "@/hooks/use-app-connected";
import { queryKeys } from "@/lib/api/keys";
import { ContactRowFrame } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/contacts/_components/contact-row-frame";
import type {
  ActAsYouGroup,
  ActAsYouRowExtras,
  ActAsYouSlot,
  AsYouCells,
} from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/contacts/_components/act-as-you-slot";
import type { ConversationKind, MyConversation, ReadGrant } from "./api";
import {
  useDeleteReadGrant,
  useMyConversations,
  useShareConversations,
  useSlackReadConnection,
  useSlackReadGrants,
} from "./hooks";
import { AsYouModeCell, granterName } from "./as-you-mode-cell";
import { AddReadGrantDialog } from "./add-read-grant-dialog";
import { KIND_ICON } from "./read-constants";
import { YourSlackRow } from "./your-slack-row";

export interface ActAsYouContactsProps {
  agentId: string;
  agentName: string;
  /** The free Contacts list, given what "acts as you" adds to it. */
  children: (slot: ActAsYouSlot) => ReactNode;
}

const PEOPLE_KINDS: readonly ConversationKind[] = ["dm", "group_dm"];
const CHANNEL_KINDS: readonly ConversationKind[] = [
  "channel",
  "private_channel",
];

const inGroup = (group: ActAsYouGroup, kind: ConversationKind) =>
  (group === "people" ? PEOPLE_KINDS : CHANNEL_KINDS).includes(kind);

/** The contact row a share belongs under: a DM's other person, or the
 *  channel itself. Null when there is none (a group DM, an old DM). */
const rowRefOf = (grant: ReadGrant): string | null =>
  grant.subjectKind === "dm"
    ? grant.counterpartRef
    : CHANNEL_KINDS.includes(grant.subjectKind)
      ? grant.externalRef
      : null;

/**
 * "Acts as you" folded into Contacts (licensed: granular_access). Owns the
 * viewer's Slack connection, every share on the agent, and the viewer's own
 * conversations, and hands the free list a slot: the top line, the
 * "Reads as you" / "Writes as you" cells of each row (a tri-state when
 * shared, "+ Enable" where the viewer has the conversation, else a dash), and rows for
 * shares no contact matches.
 */
export const ActAsYouContacts = ({
  agentId,
  agentName,
  children,
}: ActAsYouContactsProps) => {
  const connection = useSlackReadConnection(agentId);
  const grants = useSlackReadGrants(agentId);
  const connected = connection.data?.connected ?? false;
  const canWrite = connection.data?.canWrite ?? false;
  const mine = useMyConversations(agentId, connected);
  const share = useShareConversations(agentId);
  const remove = useDeleteReadGrant(agentId);
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<ReadGrant | null>(null);
  const qc = useQueryClient();
  // The connect popup lands on the Slack page, which hands the result to
  // its opener (this page).
  useAppMessages({
    onConnected: ({ provider }) => {
      if (provider !== "slack-read") return;
      void qc.invalidateQueries({
        queryKey: queryKeys.channels.slackRead(agentId),
      });
      toast.success("Your Slack is connected");
    },
  });

  const all = grants.data?.grants ?? [];
  const conversations = mine.data?.conversations ?? [];

  const dash = (
    <span className="text-muted-foreground text-sm" aria-label="Not shared">
      -
    </span>
  );

  /** The two cells for a row that HAS a share: the viewer's own first,
   *  else the first other person's (read-only). */
  const grantCells = (matched: ReadGrant[]): AsYouCells => {
    const g = matched.find((m) => m.mine) ?? matched[0]!;
    return {
      reads: (
        <AsYouModeCell
          agentId={agentId}
          agentName={agentName}
          grant={g}
          which="read"
          canWrite={canWrite}
        />
      ),
      writes: (
        <AsYouModeCell
          agentId={agentId}
          agentName={agentName}
          grant={g}
          which="write"
          canWrite={canWrite}
        />
      ),
    };
  };

  const stopAction = (grant: ReadGrant, several: boolean) => ({
    label:
      several && !grant.mine
        ? `Stop acting as ${granterName(grant)} here`
        : "Stop acting as you here",
    icon: <UserMinus className="size-4" aria-hidden />,
    onSelect: () => setRemoving(grant),
  });

  const myConversationFor = (
    group: ActAsYouGroup,
    ref: string,
  ): MyConversation | undefined =>
    conversations.find((c) =>
      group === "people"
        ? c.kind === "dm" && c.counterpartRef === ref
        : CHANNEL_KINDS.includes(c.kind) && c.ref === ref,
    );

  const shareOne = (c: MyConversation, label: string) =>
    share.mutate(
      { externalRefs: [c.ref] },
      {
        onSuccess: () =>
          toast.success(`${agentName} can act as you with ${label}`),
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Share failed"),
      },
    );

  const forRow = (
    group: ActAsYouGroup,
    ref: string,
    label: string,
  ): ActAsYouRowExtras => {
    const matched = all.filter(
      (g) => inGroup(group, g.subjectKind) && rowRefOf(g) === ref,
    );
    if (matched.length > 0) {
      return {
        cells: grantCells(matched),
        actions: matched.map((g) => stopAction(g, matched.length > 1)),
      };
    }
    // Never on the viewer's own row: acting as you with yourself is moot.
    const ownRow = group === "people" && ref === connection.data?.slackUserId;
    const c = connected && !ownRow ? myConversationFor(group, ref) : undefined;
    return {
      cells: {
        reads: c ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={share.isPending}
            onClick={() => shareOne(c, label)}
            aria-label={`Let ${agentName} act as you with ${label}`}
          >
            <Plus className="size-3.5" aria-hidden />
            Enable
          </Button>
        ) : (
          dash
        ),
        writes: dash,
      },
      actions: [],
    };
  };

  const standaloneRows = (group: ActAsYouGroup, contactRefs: string[]) => {
    const known = new Set(contactRefs);
    return all
      .filter((g) => {
        if (!inGroup(group, g.subjectKind)) return false;
        const rowRef = rowRefOf(g);
        return rowRef === null || !known.has(rowRef);
      })
      .map((g) => {
        const KindIcon = KIND_ICON[g.subjectKind];
        return (
          <div key={g.id} data-testid="as-you-standalone">
            <ContactRowFrame
              label={g.subjectLabel ?? g.externalRef}
              mono={group === "channels"}
              leading={
                <KindIcon
                  className="text-muted-foreground size-4 shrink-0"
                  aria-hidden
                />
              }
              status={
                <span className="text-muted-foreground text-xs">
                  {group === "channels" ? "Not a member" : "No DMs yet"}
                </span>
              }
              asYou={grantCells([g])}
              actions={[stopAction(g, true)]}
              disabled={remove.isPending}
            />
          </div>
        );
      });
  };

  const removingLabel = removing
    ? (removing.subjectLabel ?? removing.externalRef)
    : "";

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <YourSlackRow agentId={agentId} agentName={agentName} />
      </div>
      {connected && (
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="size-3.5" aria-hidden />
          Share conversations
        </Button>
      )}
      <AddReadGrantDialog
        agentId={agentId}
        agentName={agentName}
        open={addOpen}
        onOpenChange={setAddOpen}
        grantedRefs={all.filter((g) => g.mine).map((g) => g.externalRef)}
      />
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-pretty">
              Stop acting as {removing ? granterName(removing) : "you"} in{" "}
              <span translate="no">{removingLabel}</span>?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              <span translate="no">{agentName}</span> won&apos;t be able to read
              it or send there as{" "}
              {removing?.mine !== false
                ? "you anymore. You can share it again any time."
                : `${granterName(removing)} anymore.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (!removing) return;
                remove.mutate(removing.id, {
                  onSuccess: () => {
                    setRemoving(null);
                    toast.success(`Stopped acting as you in ${removingLabel}`);
                  },
                  onError: (err) => {
                    setRemoving(null);
                    toast.error(
                      err instanceof Error ? err.message : "Remove failed",
                    );
                  },
                });
              }}
              disabled={remove.isPending}
              className={buttonVariants({ variant: "destructive" })}
            >
              {remove.isPending ? (
                <>
                  <Loader2
                    className="size-3.5 animate-spin motion-reduce:hidden"
                    aria-hidden
                  />
                  Stopping…
                </>
              ) : (
                "Stop"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  return <>{children({ columns: true, header, forRow, standaloneRows })}</>;
};
