"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Loader2,
  Lock,
  Search,
  UserRound,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { Badge } from "@onecli/ui/components/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import {
  useWorkspaceAccess,
  useSetWorkspaceAccess,
} from "@/hooks/use-workspace-access";
import { useOrgMembersList } from "@/hooks/use-org-members";
import { useGroups } from "@/hooks/use-groups";
import { usePlanGate } from "@/lib/plan-gate";

const PLACEHOLDER_EMAIL_SUFFIX = "@onecli.internal";

const setsDiffer = (a: Set<string>, b: Set<string>) => {
  if (a.size !== b.size) return true;
  for (const id of a) if (!b.has(id)) return true;
  return false;
};

interface WorkspaceAccessDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Share a workspace with organization members and groups. Since step 13b the
 * creator is a normal, removable row (badged "Creator") — removing everyone is
 * allowed but warns, because only org admins would then reach the workspace.
 * People sharing is a team-tier feature (gated by the parent card), group
 * sharing is enterprise (gated here).
 */
export const WorkspaceAccessDialog = ({
  workspaceId,
  open,
  onOpenChange,
}: WorkspaceAccessDialogProps) => {
  const planGate = usePlanGate();
  const groupsLocked = planGate.isLocked("groups");

  const {
    data: access,
    isPending: accessPending,
    isError: accessError,
  } = useWorkspaceAccess(workspaceId, open);
  const { data: orgMembersData, isPending: membersPending } =
    useOrgMembersList(open);
  const { data: groupsData, isPending: groupsPending } = useGroups(
    open && !groupsLocked,
  );
  const setAccess = useSetWorkspaceAccess();

  // The creator, identified only to badge their row — no longer pinned/retained.
  // "Creator" is provenance; management now rides the per-user owner role below.
  const creator = useMemo(
    () => access?.users.find((u) => u.isOwner) ?? null,
    [access],
  );

  // The creator's seeded binding is a normal row since 13b, so they're included
  // here and start selected like any other current share.
  const initialUsers = useMemo(
    () => new Set((access?.users ?? []).map((u) => u.userId)),
    [access],
  );
  const initialGroups = useMemo(
    () => new Set((access?.groups ?? []).map((g) => g.groupId)),
    [access],
  );
  // Seed each shared user's management role (step 13c); defaults to member.
  const initialRoles = useMemo(
    () =>
      new Map(
        (access?.users ?? []).map(
          (u) => [u.userId, u.role] as [string, "owner" | "member"],
        ),
      ),
    [access],
  );

  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  // Management role per selected user (step 13c). Only entries for selected
  // users are meaningful; a missing entry reads as "member".
  const [userRoles, setUserRoles] = useState<Map<string, "owner" | "member">>(
    () => new Map(),
  );
  // The dirty baseline is frozen at seed time so a background refetch can't
  // shift it under the edit buffer — otherwise Save could enable with no edits
  // and PUT a stale set over a concurrent change.
  const [baseline, setBaseline] = useState<{
    users: Set<string>;
    groups: Set<string>;
    roles: Map<string, "owner" | "member">;
  }>(() => ({ users: new Set(), groups: new Set(), roles: new Map() }));
  const [search, setSearch] = useState("");
  // Gates the last-binding warning: false until the edit buffer is seeded, so
  // the momentary empty selection between load and seed can't flash the warning.
  const [seeded, setSeeded] = useState(false);

  // Seed the edit buffer + baseline once per open, once data loads — guarded so
  // a background refetch can't clobber in-progress edits.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      setSeeded(false);
      setSearch("");
      return;
    }
    if (seededRef.current || accessPending) return;
    setSelectedUsers(new Set(initialUsers));
    setSelectedGroups(new Set(initialGroups));
    setUserRoles(new Map(initialRoles));
    setBaseline({
      users: new Set(initialUsers),
      groups: new Set(initialGroups),
      roles: new Map(initialRoles),
    });
    seededRef.current = true;
    setSeeded(true);
  }, [open, accessPending, initialUsers, initialGroups, initialRoles]);

  // Candidate people: all org members except placeholders. The creator is a
  // normal, removable (badged) row since 13b, so they're included here too.
  const candidatePeople = useMemo(() => {
    const members = orgMembersData ?? [];
    return members.filter((m) => !m.email.endsWith(PLACEHOLDER_EMAIL_SUFFIX));
  }, [orgMembersData]);

  const filteredPeople = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidatePeople;
    return candidatePeople.filter(
      (m) =>
        m.email.toLowerCase().includes(q) ||
        (m.name ?? "").toLowerCase().includes(q),
    );
  }, [candidatePeople, search]);

  const groups = useMemo(() => groupsData ?? [], [groupsData]);

  // A preserved user whose role changed also makes the form dirty (the set diff
  // covers adds/removes; this covers a member↔owner flip on a kept row).
  const rolesDiffer = [...selectedUsers].some(
    (id) =>
      baseline.users.has(id) &&
      (userRoles.get(id) ?? "member") !== (baseline.roles.get(id) ?? "member"),
  );

  const dirty =
    setsDiffer(selectedUsers, baseline.users) ||
    setsDiffer(selectedGroups, baseline.groups) ||
    rolesDiffer;

  // Soft last-binding guard: with nobody selected, only org admins could reach
  // the workspace. We warn (near Save) but never block — admins are the backstop
  // and the server allows it since 13b.
  const noBindings = selectedUsers.size + selectedGroups.size === 0;

  // Soft no-owner guard: bindings exist but none is an owner user (a groups-only
  // share included — groups carry no management role in v1), so only org admins
  // could manage the workspace. Warn (near Save) but never block.
  const noOwner =
    !noBindings &&
    ![...selectedUsers].some(
      (id) => (userRoles.get(id) ?? "member") === "owner",
    );

  const toggleUser = (userId: string) => {
    const isSelected = selectedUsers.has(userId);
    setSelectedUsers((prev) => {
      const next = new Set(prev);
      if (isSelected) next.delete(userId);
      else next.add(userId);
      return next;
    });
    // Adding a user grants a plain "member" role by default; removing drops it.
    setUserRoles((prev) => {
      const next = new Map(prev);
      if (isSelected) next.delete(userId);
      else next.set(userId, "member");
      return next;
    });
  };

  const setUserRole = (userId: string, role: "owner" | "member") =>
    setUserRoles((prev) => {
      const next = new Map(prev);
      next.set(userId, role);
      return next;
    });

  const toggleGroup = (groupId: string) =>
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });

  const handleSave = async () => {
    try {
      await setAccess.mutateAsync({
        workspaceId,
        users: [...selectedUsers].map((userId) => ({
          userId,
          role: userRoles.get(userId) ?? "member",
        })),
        groupIds: [...selectedGroups],
      });
      onOpenChange(false);
      toast.success("Workspace access updated");
    } catch {
      // the hook already toasts the server reason
    }
  };

  const initialLoading = accessPending || membersPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Manage workspace access</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Choose who can access this workspace. Members can use it; owners
            (and org admins) can also rename, share, or delete it.
          </DialogDescription>
        </DialogHeader>

        {/* Section headers + the People filter stay fixed; each list scrolls in
            its own bounded, vh-capped native scroller (a Radix ScrollArea can't
            scroll under max-height) so the search and the Groups section stay
            reachable even with hundreds of members. */}
        <div className="space-y-4 px-6 pb-2">
          {initialLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
            </div>
          ) : accessError ? (
            // Never render the editable body on a failed load: with no owner and
            // empty selections, a blind Save would diff against the real rows and
            // silently remove shares the user can't see. Show an error instead.
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-sm font-medium">Couldn&apos;t load access</p>
              <p className="text-muted-foreground text-xs">
                Something went wrong. Close and reopen to try again.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">People</p>
                  {candidatePeople.length > 0 && (
                    <p
                      className="text-muted-foreground text-xs"
                      aria-live="polite"
                    >
                      <span className="text-foreground font-medium">
                        {selectedUsers.size}
                      </span>{" "}
                      of {candidatePeople.length} selected
                    </p>
                  )}
                </div>
                {candidatePeople.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-md border py-8 text-center">
                    <div className="bg-muted mb-3 flex size-10 items-center justify-center rounded-full">
                      <UserRound className="text-muted-foreground size-4" />
                    </div>
                    <p className="text-sm font-medium">No one to add</p>
                    <p className="text-muted-foreground text-xs">
                      Invite teammates to your organization first.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <Search
                        className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
                        aria-hidden="true"
                      />
                      <Input
                        placeholder="Filter people..."
                        aria-label="Filter people by name or email"
                        autoComplete="off"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="h-8 pl-8 text-sm"
                      />
                    </div>
                    <div className="divide-border max-h-[min(15rem,28vh)] divide-y overflow-y-auto rounded-md border">
                      {filteredPeople.map((member) => {
                        const isSelected = selectedUsers.has(member.userId);
                        return (
                          <div
                            key={member.userId}
                            className="hover:bg-muted/50 flex items-center gap-2 px-3 py-2.5 transition-colors"
                          >
                            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={() =>
                                  toggleUser(member.userId)
                                }
                              />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">
                                  {member.name ?? member.email}
                                </p>
                                {member.name && (
                                  <p className="text-muted-foreground truncate text-xs">
                                    {member.email}
                                  </p>
                                )}
                              </div>
                              {member.userId === creator?.userId && (
                                <Badge variant="secondary" className="shrink-0">
                                  Creator
                                </Badge>
                              )}
                            </label>
                            {isSelected && (
                              <Select
                                value={userRoles.get(member.userId) ?? "member"}
                                onValueChange={(v) =>
                                  setUserRole(
                                    member.userId,
                                    v === "owner" ? "owner" : "member",
                                  )
                                }
                              >
                                <SelectTrigger
                                  className="h-7! w-auto shrink-0 gap-1 rounded-md border-0 bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-muted hover:text-foreground dark:bg-transparent dark:hover:bg-muted"
                                  aria-label={`Role for ${member.name ?? member.email}`}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent position="popper" align="end">
                                  <SelectItem value="member">Member</SelectItem>
                                  <SelectItem value="owner">Owner</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                        );
                      })}
                      {filteredPeople.length === 0 && (
                        <p className="text-muted-foreground py-6 text-center text-xs">
                          No people match &ldquo;{search}&rdquo;
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <p className="text-xs font-medium">Groups</p>
                  {groupsLocked && (
                    <Lock className="text-muted-foreground size-3" />
                  )}
                </div>
                {groupsLocked ? (
                  <button
                    type="button"
                    onClick={() => planGate.guard("groups")}
                    className="border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground w-full rounded-md border px-3 py-3 text-left text-xs transition-colors"
                  >
                    Sharing with directory groups is an Enterprise feature.
                    Upgrade to enable it.
                  </button>
                ) : groupsPending ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="text-muted-foreground size-4 animate-spin" />
                  </div>
                ) : groups.length === 0 ? (
                  <p className="text-muted-foreground rounded-md border px-3 py-6 text-center text-xs">
                    No groups yet. Create groups in your organization&apos;s SSO
                    settings.
                  </p>
                ) : (
                  <div className="divide-border max-h-[min(11rem,22vh)] divide-y overflow-y-auto rounded-md border">
                    {groups.map((group) => (
                      <label
                        key={group.id}
                        className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors"
                      >
                        <Checkbox
                          checked={selectedGroups.has(group.id)}
                          onCheckedChange={() => toggleGroup(group.id)}
                        />
                        <UsersRound className="text-muted-foreground size-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {group.name}
                          </p>
                          <p className="text-muted-foreground truncate text-xs">
                            {group.memberCount}{" "}
                            {group.memberCount === 1 ? "member" : "members"}
                          </p>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {seeded && !initialLoading && !accessError && noBindings && (
          <div className="mx-6 mb-1 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle
              className="mt-px size-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              No one will be able to use this workspace. Only org admins will
              reach it.
            </span>
          </div>
        )}

        {seeded && !initialLoading && !accessError && noOwner && (
          <div className="mx-6 mb-1 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle
              className="mt-px size-3.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              No workspace owner set. Only org admins will be able to manage
              this workspace.
            </span>
          </div>
        )}

        <DialogFooter className="border-border/50 border-t px-6 py-4">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={setAccess.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={setAccess.isPending}
            disabled={initialLoading || accessError || !dirty}
          >
            {setAccess.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
