"use client";

import { useState } from "react";
import {
  Eye,
  Loader2,
  Lock,
  MoreVertical,
  Plus,
  UsersRound,
} from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Badge } from "@onecli/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { usePlanGate } from "@/lib/plan-gate";
import {
  useGroups,
  useCreateGroup,
  useRenameGroup,
  useDeleteGroup,
} from "@/hooks/use-groups";
import type { GroupRow } from "@/lib/api";
import { NameDialog } from "./name-dialog";
import { DeleteGroupDialog } from "./delete-group-dialog";
import { GroupMembersDialog } from "./group-members-dialog";

/**
 * The human-group collection: SCIM-managed rows ("scim" source) show a lock
 * badge and refuse manual edits server-side; manual groups get the full
 * rename / delete / members management.
 */
export const GroupList = () => {
  const planGate = usePlanGate();
  const { data, isPending } = useGroups();
  const createGroup = useCreateGroup();
  const renameGroup = useRenameGroup();
  const deleteGroup = useDeleteGroup();

  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<GroupRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GroupRow | null>(null);
  const [membersTarget, setMembersTarget] = useState<GroupRow | null>(null);

  const groups = data ?? [];

  const handleNewGroup = () => {
    if (planGate.guard("groups")) return;
    setCreateOpen(true);
  };

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Member groups</h2>
          <p className="text-muted-foreground text-sm">
            Managed here or synced from your identity provider.
          </p>
        </div>
        <Button size="sm" className="shrink-0" onClick={handleNewGroup}>
          <Plus className="size-3.5" />
          New group
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border">
        {isPending ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
          </div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="bg-muted mb-3 flex size-10 items-center justify-center rounded-full">
              <UsersRound className="text-muted-foreground size-4" />
            </div>
            <p className="text-sm font-medium">No groups yet</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Create a group to organize members for group-level access.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-muted-foreground h-10 pl-4 text-xs font-medium tracking-wide uppercase">
                  Group
                </TableHead>
                <TableHead className="text-muted-foreground h-10 w-[110px] text-xs font-medium tracking-wide uppercase">
                  Members
                </TableHead>
                <TableHead className="h-10 w-auto pr-4 text-right md:w-[220px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => {
                const scimManaged = group.source === "scim";
                return (
                  // No row hover: rows aren't clickable here, and the wash
                  // fights the buttons' own hover states.
                  <TableRow
                    key={group.id}
                    className="h-14 hover:bg-transparent"
                  >
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-3">
                        <div className="bg-muted hidden size-9 shrink-0 items-center justify-center rounded-full md:flex">
                          <UsersRound className="text-muted-foreground size-4" />
                        </div>
                        <div className="flex items-center gap-2 overflow-hidden">
                          <span className="truncate text-sm font-medium">
                            {group.name}
                          </span>
                          {scimManaged && (
                            <Badge
                              variant="outline"
                              className="shrink-0 text-xs"
                              title="Managed by your identity provider. Membership and name sync from the IdP"
                            >
                              <Lock className="size-3" />
                              IdP
                            </Badge>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm tabular-nums">
                      {group.memberCount}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => setMembersTarget(group)}
                        >
                          {scimManaged ? <Eye /> : <UsersRound />}
                          {scimManaged ? "View members" : "Manage members"}
                        </Button>
                        {!scimManaged && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label={`Actions for ${group.name}`}
                              >
                                <MoreVertical />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => setRenameTarget(group)}
                              >
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setDeleteTarget(group)}
                              >
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <NameDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New group"
        description="Groups collect members so access can be granted to a whole team at once."
        submitLabel="Create"
        pendingLabel="Creating..."
        pending={createGroup.isPending}
        onSubmit={async (name) => {
          await createGroup.mutateAsync(name);
          setCreateOpen(false);
        }}
      />

      <NameDialog
        open={renameTarget !== null}
        onOpenChange={(open) => !open && setRenameTarget(null)}
        title="Rename group"
        description="Renaming does not change the group's members or anything granted to it."
        submitLabel="Rename"
        pendingLabel="Renaming..."
        initialName={renameTarget?.name ?? ""}
        pending={renameGroup.isPending}
        onSubmit={async (name) => {
          if (!renameTarget) return;
          await renameGroup.mutateAsync({ groupId: renameTarget.id, name });
          setRenameTarget(null);
        }}
      />

      <DeleteGroupDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        groupName={deleteTarget?.name ?? ""}
        pending={deleteGroup.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          deleteGroup.mutate(deleteTarget.id, {
            onSuccess: () => setDeleteTarget(null),
          });
        }}
      />

      {membersTarget && (
        <GroupMembersDialog
          group={membersTarget}
          open
          onOpenChange={(open) => !open && setMembersTarget(null)}
        />
      )}
    </section>
  );
};
