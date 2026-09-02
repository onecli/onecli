"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  MoreVertical,
  Plus,
  ShieldCheck,
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
import { usePlanGate } from "@/lib/plan-gate";
import { useGroups } from "@/hooks/use-groups";
import {
  useRoleMappings,
  useCreateRoleMapping,
  useUpdateRoleMapping,
  useDeleteRoleMapping,
  useReorderRoleMappings,
} from "@/hooks/use-role-mappings";
import type { RoleMappingRow } from "@/lib/api";
import { RoleMappingDialog } from "./role-mapping-dialog";

/**
 * Group→role mappings: an org role is granted to the members of a group,
 * priority-ordered (top wins). Applied immediately on save and re-applied on
 * SCIM sync + SSO login; a mapped member's role becomes IdP-managed.
 */
export const RoleMappingList = () => {
  const planGate = usePlanGate();
  const { data, isPending, isFetching } = useRoleMappings();
  const { data: groupsData } = useGroups();
  const createMapping = useCreateRoleMapping();
  const updateMapping = useUpdateRoleMapping();
  const deleteMapping = useDeleteRoleMapping();
  const reorder = useReorderRoleMappings();

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<RoleMappingRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoleMappingRow | null>(null);

  const mappings = data ?? [];
  const mappedGroupIds = new Set(mappings.map((m) => m.groupId));
  const availableGroups = (groupsData ?? [])
    .filter((g) => !mappedGroupIds.has(g.id))
    .map((g) => ({ id: g.id, name: g.name }));
  // Also block reorder while the list refetches after a reorder — until the
  // fresh order lands, `mappings` is stale and a fast click would swap from it.
  const reorderBusy = reorder.isPending || isFetching;

  const handleNew = () => {
    if (planGate.guard("groups")) return;
    setCreateOpen(true);
  };

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= mappings.length || reorderBusy) return;
    const next = mappings.map((m) => m.id);
    const moved = next[index];
    const displaced = next[target];
    if (moved === undefined || displaced === undefined) return;
    next[index] = displaced;
    next[target] = moved;
    reorder.mutate(next);
  };

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Role mappings</h2>
          <p className="text-muted-foreground text-sm">
            Grant an org role to a group&rsquo;s members. The highest-priority
            mapping wins, owners are never changed.
          </p>
        </div>
        <Button size="sm" className="shrink-0" onClick={handleNew}>
          <Plus className="size-3.5" />
          New mapping
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border">
        {isPending ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
          </div>
        ) : mappings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="bg-muted mb-3 flex size-10 items-center justify-center rounded-full">
              <ShieldCheck className="text-muted-foreground size-4" />
            </div>
            <p className="text-sm font-medium">No role mappings yet</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Map a group to a role to manage members&rsquo; access from your
              directory.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-muted-foreground h-10 w-[76px] pl-4 text-xs font-medium tracking-wide uppercase">
                  Order
                </TableHead>
                <TableHead className="text-muted-foreground h-10 text-xs font-medium tracking-wide uppercase">
                  Group
                </TableHead>
                <TableHead className="text-muted-foreground h-10 w-[120px] text-xs font-medium tracking-wide uppercase">
                  Role
                </TableHead>
                <TableHead className="h-10 w-[64px] pr-4 text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {mappings.map((mapping, index) => (
                <TableRow
                  key={mapping.id}
                  className="h-14 hover:bg-transparent"
                >
                  <TableCell className="pl-4">
                    <div className="flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Move up"
                        disabled={index === 0 || reorderBusy}
                        onClick={() => move(index, -1)}
                      >
                        <ChevronUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Move down"
                        disabled={index === mappings.length - 1 || reorderBusy}
                        onClick={() => move(index, 1)}
                      >
                        <ChevronDown />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-baseline gap-2 overflow-hidden">
                      <span className="truncate text-sm font-medium">
                        {mapping.groupName}
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                        {mapping.memberCount} member
                        {mapping.memberCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        mapping.role === "admin" ? "secondary" : "outline"
                      }
                      className="text-xs capitalize"
                    >
                      {mapping.role}
                    </Badge>
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Actions for the ${mapping.groupName} mapping`}
                        >
                          <MoreVertical />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => setEditTarget(mapping)}
                        >
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeleteTarget(mapping)}
                        >
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <RoleMappingDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        mapping={null}
        availableGroups={availableGroups}
        pending={createMapping.isPending}
        onSubmit={async ({ groupId, role }) => {
          await createMapping.mutateAsync({ groupId, role });
          setCreateOpen(false);
        }}
      />

      {/* Mounted only while editing so the dialog never morphs to create-mode
          during its close animation (mapping stays non-null throughout). */}
      {editTarget && (
        <RoleMappingDialog
          open
          onOpenChange={(open) => !open && setEditTarget(null)}
          mapping={editTarget}
          availableGroups={[]}
          pending={updateMapping.isPending}
          onSubmit={async ({ role }) => {
            await updateMapping.mutateAsync({
              id: editTarget.id,
              input: { role },
            });
            setEditTarget(null);
          }}
        />
      )}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this role mapping?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.groupName} stops granting a role. Members also in
              another role-mapped group are re-resolved to that group&rsquo;s
              role; everyone else keeps their current role.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMapping.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (!deleteTarget) return;
                deleteMapping.mutate(deleteTarget.id, {
                  onSuccess: () => setDeleteTarget(null),
                });
              }}
              disabled={deleteMapping.isPending}
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              {deleteMapping.isPending ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
};
