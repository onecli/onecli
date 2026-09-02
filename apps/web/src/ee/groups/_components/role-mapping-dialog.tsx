"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { useRoleMappingPreview } from "@/hooks/use-role-mappings";
import type { RoleMappingRow } from "@/lib/api";

type Role = "admin" | "member";

interface RoleMappingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The mapping being edited; `null` for a new mapping. */
  mapping: RoleMappingRow | null;
  /** Groups that don't yet have a mapping (create mode only). */
  availableGroups: { id: string; name: string }[];
  pending: boolean;
  onSubmit: (input: { groupId: string; role: Role }) => Promise<void>;
}

/**
 * Create / edit a group→role mapping: pick a group (create only) and the org
 * role its members receive, with a live "N members would change role" preview.
 */
export const RoleMappingDialog = ({
  open,
  onOpenChange,
  mapping,
  availableGroups,
  pending,
  onSubmit,
}: RoleMappingDialogProps) => {
  const [groupId, setGroupId] = useState(mapping?.groupId ?? "");
  const [role, setRole] = useState<Role>(mapping?.role ?? "member");

  useEffect(() => {
    if (open) {
      setGroupId(mapping?.groupId ?? "");
      setRole(mapping?.role ?? "member");
    }
  }, [open, mapping]);

  const preview = useRoleMappingPreview(
    open && groupId !== "" ? { groupId, role } : null,
  );

  const valid = groupId !== "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || pending) return;
    try {
      await onSubmit({ groupId, role });
    } catch {
      // The mutation hook surfaces the error toast; keep the dialog open.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mapping ? "Edit role mapping" : "New role mapping"}
          </DialogTitle>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Members of the group receive this org role. When someone is in
            several mapped groups the highest-priority mapping wins; owners are
            never changed.
          </p>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="role-mapping-group">Group</Label>
            {mapping ? (
              <div className="text-sm font-medium">{mapping.groupName}</div>
            ) : (
              <Select value={groupId} onValueChange={setGroupId}>
                <SelectTrigger id="role-mapping-group">
                  <SelectValue placeholder="Select a group" />
                </SelectTrigger>
                <SelectContent>
                  {availableGroups.length === 0 ? (
                    <div className="text-muted-foreground px-2 py-1.5 text-xs">
                      No groups available to map.
                    </div>
                  ) : (
                    availableGroups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="role-mapping-role">Role</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v === "admin" ? "admin" : "member")}
            >
              <SelectTrigger id="role-mapping-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {groupId !== "" && preview.data && (
            <p className="text-muted-foreground text-xs">
              {preview.data.affectedCount === 0
                ? "No members would change role."
                : `${preview.data.affectedCount} member${
                    preview.data.affectedCount === 1 ? "" : "s"
                  } would change role when you save.`}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={pending}
              disabled={!valid || pending}
            >
              {pending ? "Saving..." : mapping ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
