"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MoreVertical,
  Trash2,
  X,
  UserRoundCheck,
  UserRoundX,
  LogOut,
  Shield,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Avatar, AvatarFallback } from "@onecli/ui/components/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
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
import {
  removeTeamMember,
  getWorkspacesDeletedOnRemove,
} from "@/lib/team/actions";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { useInvitations, useCancelInvitation } from "@/hooks/use-invitations";
import { useUpdateOrgMember } from "@/hooks/use-org-members";
import { getInitials } from "@/lib/user-display";
import { LeaveOrgDialog } from "./leave-org-dialog";
import { ManageAccessDialog } from "@/ee/team/_components/manage-access-dialog";
import type { TeamMember } from "@onecli/api/ee/services/team-service";

interface MemberListProps {
  members: TeamMember[];
  currentUserId: string;
  isAdmin: boolean;
  orgName: string;
}

const capitalize = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1);

export const MemberList = ({
  members,
  currentUserId,
  isAdmin,
  orgName,
}: MemberListProps) => {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Admin-only data — a non-admin never renders the invitations section, and
  // the route would refuse them anyway.
  const { data: invitations = [] } = useInvitations(isAdmin);
  const cancelInvitation = useCancelInvitation();
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{
    userId: string;
    email: string;
  } | null>(null);
  // What removing them destroys, loaded when the dialog opens: their personal
  // workspaces and the chat apps that go with them. Each must be acknowledged.
  const [removeWorkspaces, setRemoveWorkspaces] = useState<
    { id: string; name: string | null; channelApps: { provider: string }[] }[]
  >([]);
  const [ackedWorkspaces, setAckedWorkspaces] = useState(
    () => new Set<string>(),
  );
  const [suspendTarget, setSuspendTarget] = useState<{
    userId: string;
    email: string;
  } | null>(null);
  const [manageTarget, setManageTarget] = useState<{
    userId: string;
    email: string;
    role: "admin" | "member";
    ssoExempt: boolean;
    roleManagedByIdp: boolean;
  } | null>(null);
  const updateMember = useUpdateOrgMember();

  // Load what removal destroys as the dialog opens; reset when it closes.
  useEffect(() => {
    if (!removeTarget) {
      setRemoveWorkspaces([]);
      setAckedWorkspaces(new Set());
      return;
    }
    getWorkspacesDeletedOnRemove(removeTarget.userId)
      .then(setRemoveWorkspaces)
      .catch(() => setRemoveWorkspaces([]));
  }, [removeTarget]);

  const removeAcknowledged =
    removeWorkspaces.length === 0 ||
    ackedWorkspaces.size === removeWorkspaces.length;
  const removeTotalApps = removeWorkspaces.reduce(
    (n, p) => n + p.channelApps.length,
    0,
  );

  const toggleAckedWorkspace = (workspaceId: string) =>
    setAckedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });

  const handleRemove = () => {
    if (!removeTarget || !removeAcknowledged) return;
    startTransition(async () => {
      const result = await removeTeamMember(removeTarget.userId);
      if (!result.ok) {
        toast.error(result.error);
      } else {
        toast.success("Member removed");
        router.refresh();
      }
      setRemoveTarget(null);
    });
  };

  const handleSuspend = () => {
    if (!suspendTarget) return;
    updateMember.mutate(
      { userId: suspendTarget.userId, input: { status: "suspended" } },
      {
        onSuccess: () => {
          toast.success("Member suspended");
          setSuspendTarget(null);
          router.refresh();
        },
        onError: () => setSuspendTarget(null),
      },
    );
  };

  const handleReinstate = (userId: string) => {
    updateMember.mutate(
      { userId, input: { status: "active" } },
      {
        onSuccess: () => {
          toast.success("Member reinstated");
          router.refresh();
        },
      },
    );
  };

  const handleCancelInvite = (invitationId: string) => {
    cancelInvitation.mutate(invitationId);
  };

  const totalCount = members.length + invitations.length;

  return (
    <>
      <section className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-10 pl-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Member
              </TableHead>
              <TableHead className="h-10 w-[100px] text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Role
              </TableHead>
              <TableHead className="h-10 w-auto pr-4 text-right md:w-[160px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const isYou = member.userId === currentUserId;
              const isOwner = member.role === "owner";
              const isSuspended = member.status === "suspended";

              return (
                <TableRow key={member.userId} className="h-14">
                  <TableCell className="pl-4">
                    <div className="flex items-center gap-3">
                      <Avatar className="hidden size-9 md:flex">
                        <AvatarFallback className="text-xs">
                          {getInitials(member.name, member.email)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex items-center gap-2 overflow-hidden">
                        <span className="truncate text-sm">{member.email}</span>
                        {isYou && (
                          <Badge
                            variant="outline"
                            className="rounded px-1.5 py-0 text-[10px] font-medium"
                          >
                            YOU
                          </Badge>
                        )}
                        {isSuspended && (
                          <Badge
                            variant="outline"
                            className="rounded border-red-300 bg-red-50 px-1.5 py-0 text-[10px] font-semibold text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400"
                          >
                            SUSPENDED
                          </Badge>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {capitalize(member.role)}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    {isYou && !isOwner ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm">
                            <MoreVertical className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setLeaveConfirmOpen(true)}
                          >
                            <LogOut />
                            Leave organization
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      isAdmin &&
                      !isOwner &&
                      !isYou && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm">
                              <MoreVertical className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() =>
                                setManageTarget({
                                  userId: member.userId,
                                  email: member.email,
                                  role: member.role as "admin" | "member",
                                  ssoExempt: member.ssoExempt,
                                  roleManagedByIdp:
                                    member.roleManagedByIdp ?? false,
                                })
                              }
                            >
                              <Shield />
                              Manage access
                            </DropdownMenuItem>
                            {isSuspended ? (
                              <DropdownMenuItem
                                disabled={updateMember.isPending}
                                onClick={() => handleReinstate(member.userId)}
                              >
                                <UserRoundCheck />
                                Reinstate member
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                onClick={() =>
                                  setSuspendTarget({
                                    userId: member.userId,
                                    email: member.email,
                                  })
                                }
                              >
                                <UserRoundX />
                                Suspend member
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() =>
                                setRemoveTarget({
                                  userId: member.userId,
                                  email: member.email,
                                })
                              }
                            >
                              <Trash2 />
                              Remove member
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )
                    )}
                  </TableCell>
                </TableRow>
              );
            })}

            {invitations.map((inv) => (
              <TableRow key={inv.id} className="h-14">
                <TableCell className="pl-4">
                  <div className="flex items-center gap-3">
                    <Avatar className="hidden size-9 md:flex">
                      <AvatarFallback className="text-xs">
                        {inv.email.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex items-center gap-2 overflow-hidden">
                      <span className="text-muted-foreground truncate text-sm">
                        {inv.email}
                      </span>
                      <Badge
                        variant="outline"
                        className="rounded border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] font-semibold text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-400"
                      >
                        INVITED
                      </Badge>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {capitalize(inv.role)}
                </TableCell>
                <TableCell className="pr-4 text-right">
                  {isAdmin && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleCancelInvite(inv.id)}
                          disabled={pending}
                        >
                          <X className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Cancel invitation</TooltipContent>
                    </Tooltip>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="text-muted-foreground border-t px-4 py-3 text-sm">
          {totalCount} {totalCount === 1 ? "member" : "members"}
        </div>
      </section>

      <AlertDialog
        open={!!removeTarget}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove member</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                {removeWorkspaces.length > 0 && (
                  <>
                    <p>
                      Acknowledge each workspace that will be permanently
                      deleted:
                    </p>
                    <div className="rounded-md border">
                      {removeWorkspaces.map((workspace) => (
                        <label
                          key={workspace.id}
                          className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 border-b px-4 py-3 last:border-b-0"
                        >
                          <Checkbox
                            checked={ackedWorkspaces.has(workspace.id)}
                            onCheckedChange={() =>
                              toggleAckedWorkspace(workspace.id)
                            }
                          />
                          <span className="text-foreground text-sm font-medium">
                            {workspace.name ?? "Untitled"}
                            {workspace.channelApps.length > 0 && (
                              <span className="text-muted-foreground ml-2 font-normal">
                                · uninstalls{" "}
                                {workspace.channelApps.length === 1
                                  ? "1 chat app"
                                  : `${workspace.channelApps.length} chat apps`}
                              </span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  </>
                )}
                <p>
                  Are you sure you want to remove{" "}
                  <span className="text-foreground font-medium">
                    {removeTarget?.email}
                  </span>{" "}
                  from {orgName}?
                  {removeTotalApps > 0 &&
                    " Their chat apps are uninstalled from your chat workspace, and anyone talking to them there loses the agent."}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleRemove();
              }}
              disabled={pending || !removeAcknowledged}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pending ? "Removing..." : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!suspendTarget}
        onOpenChange={(open) => !open && setSuspendTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend member</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="text-foreground font-medium">
                {suspendTarget?.email}
              </span>{" "}
              immediately loses all access to {orgName}. Their workspaces, API
              keys, and settings are preserved, and you can reinstate them at
              any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateMember.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleSuspend();
              }}
              disabled={updateMember.isPending}
            >
              {updateMember.isPending ? "Suspending..." : "Suspend"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <LeaveOrgDialog
        open={leaveConfirmOpen}
        onOpenChange={setLeaveConfirmOpen}
        orgName={orgName}
      />

      {manageTarget && (
        <ManageAccessDialog
          open={!!manageTarget}
          onOpenChange={(open) => !open && setManageTarget(null)}
          userId={manageTarget.userId}
          email={manageTarget.email}
          currentRole={manageTarget.role}
          currentSsoExempt={manageTarget.ssoExempt}
          roleManagedByIdp={manageTarget.roleManagedByIdp}
        />
      )}
    </>
  );
};
