"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, Users } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { useGroupMembers, useSetGroupMembers } from "@/hooks/use-groups";
import { useOrgMembersList } from "@/hooks/use-org-members";
import type { GroupRow } from "@/lib/api";

interface GroupMembersDialogProps {
  group: GroupRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Member picker over the org's members (the directory read). SCIM-managed
 * groups are read-only here — membership syncs from the IdP.
 */
export const GroupMembersDialog = ({
  group,
  open,
  onOpenChange,
}: GroupMembersDialogProps) => {
  const readOnly = group.source === "scim";

  const { data: orgMembersData, isPending: membersPending } =
    useOrgMembersList(open);
  const { data: groupMembersData, isPending: groupPending } = useGroupMembers(
    group.id,
    open,
  );
  const setMembers = useSetGroupMembers();

  const isPending = membersPending || groupPending;
  const orgMembers = useMemo(() => orgMembersData ?? [], [orgMembersData]);

  const initialSelected = useMemo(
    () => new Set((groupMembersData ?? []).map((m) => m.userId)),
    [groupMembersData],
  );

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  // Seed the edit buffer once per open, once data loads — guarded so a
  // background refetch can't clobber in-progress edits.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!open) {
      seededRef.current = false;
      setSearch("");
      return;
    }
    if (seededRef.current || isPending) return;
    setSelected(new Set(initialSelected));
    seededRef.current = true;
  }, [open, isPending, initialSelected]);

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return orgMembers;
    return orgMembers.filter(
      (m) =>
        m.email.toLowerCase().includes(q) ||
        (m.name ?? "").toLowerCase().includes(q),
    );
  }, [orgMembers, search]);

  const dirty = useMemo(() => {
    if (selected.size !== initialSelected.size) return true;
    for (const id of selected) if (!initialSelected.has(id)) return true;
    return false;
  }, [selected, initialSelected]);

  const toggle = (userId: string) => {
    if (readOnly) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  // Bulk actions act on every member, not just the filtered view.
  const selectAll = () => setSelected(new Set(orgMembers.map((m) => m.userId)));
  const clearAll = () => setSelected(new Set());

  const handleSave = async () => {
    setSaving(true);
    try {
      await setMembers.mutateAsync({
        groupId: group.id,
        userIds: [...selected],
      });
      onOpenChange(false);
      toast.success("Group members updated");
    } catch {
      // the hook already toasts the server reason
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Members of {group.name}</DialogTitle>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {readOnly
              ? "This group is managed by your identity provider. Membership syncs from the IdP."
              : "Pick which organization members belong to this group."}
          </p>
        </DialogHeader>

        <div className="px-6 pb-1">
          {isPending ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground size-4 animate-spin" />
            </div>
          ) : orgMembers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="bg-muted mb-3 flex size-10 items-center justify-center rounded-full">
                <Users className="text-muted-foreground size-4" />
              </div>
              <p className="text-sm font-medium">No members found</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="relative">
                <Search
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
                  aria-hidden="true"
                />
                <Input
                  placeholder="Filter members..."
                  aria-label="Filter members by name or email"
                  autoComplete="off"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 pl-8 text-sm"
                />
              </div>

              {!readOnly && (
                <div className="flex items-center justify-between">
                  <p
                    className="text-muted-foreground text-xs"
                    aria-live="polite"
                  >
                    <span className="text-foreground font-medium">
                      {selected.size}
                    </span>{" "}
                    of {orgMembers.length} selected
                  </p>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={selectAll}
                      className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                    >
                      Select all
                    </button>
                    <span className="text-muted-foreground/40 text-xs">/</span>
                    <button
                      type="button"
                      onClick={clearAll}
                      className="text-muted-foreground hover:text-foreground text-xs transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

              {/* A native max-height scroller (a Radix ScrollArea can't scroll
                  under max-height — its viewport needs a definite height). */}
              <div className="max-h-[min(24rem,50vh)] overflow-y-auto rounded-md border">
                <div className="divide-border divide-y">
                  {filteredMembers.map((member) => (
                    <label
                      key={member.userId}
                      className={
                        readOnly
                          ? "flex items-center gap-3 px-3 py-2.5"
                          : "hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors"
                      }
                    >
                      <Checkbox
                        checked={selected.has(member.userId)}
                        disabled={readOnly}
                        onCheckedChange={() => toggle(member.userId)}
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
                    </label>
                  ))}

                  {filteredMembers.length === 0 && (
                    <p className="text-muted-foreground py-6 text-center text-xs">
                      No members match &ldquo;{search}&rdquo;
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="border-border/50 border-t px-6 py-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button
              onClick={handleSave}
              loading={saving}
              disabled={isPending || !dirty}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
