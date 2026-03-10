"use client";

import { useState } from "react";
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
import { Label } from "@onecli/ui/components/label";
import { useAuth } from "@/providers/auth-provider";
import { updateSecret } from "@/lib/actions/secrets";

interface InjectionConfig {
  headerName: string;
  valueFormat: string;
}

interface EditSecretDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  secret: {
    id: string;
    name: string;
    type: string;
    hostPattern: string;
    pathPattern: string | null;
    injectionConfig: unknown;
  };
  onUpdated: () => void;
}

export const EditSecretDialog = ({
  open,
  onOpenChange,
  secret,
  onUpdated,
}: EditSecretDialogProps) => {
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);

  const config = secret.injectionConfig as InjectionConfig | null;

  const [newValue, setNewValue] = useState("");
  const [hostPattern, setHostPattern] = useState(secret.hostPattern);
  const [pathPattern, setPathPattern] = useState(secret.pathPattern ?? "");
  const [headerName, setHeaderName] = useState(config?.headerName ?? "");
  const [valueFormat, setValueFormat] = useState(config?.valueFormat ?? "");

  const hasChanges =
    newValue.trim() ||
    hostPattern.trim() !== secret.hostPattern ||
    (pathPattern.trim() || null) !== (secret.pathPattern ?? null) ||
    (secret.type === "generic" &&
      (headerName.trim() !== (config?.headerName ?? "") ||
        valueFormat.trim() !== (config?.valueFormat ?? "")));

  const isValid =
    hostPattern.trim() && (secret.type !== "generic" || headerName.trim());

  const handleSave = async () => {
    if (!user?.id || !isValid) return;
    setSaving(true);
    try {
      await updateSecret(
        secret.id,
        {
          value: newValue.trim() || undefined,
          hostPattern,
          pathPattern: pathPattern || null,
          injectionConfig:
            secret.type === "generic"
              ? { headerName, valueFormat: valueFormat || "{value}" }
              : undefined,
        },
        user.id,
      );
      onUpdated();
      toast.success("Secret updated");
      onOpenChange(false);
    } catch {
      toast.error("Failed to update secret");
    } finally {
      setSaving(false);
    }
  };

  const handleOpen = (value: boolean) => {
    if (value) {
      // Reset to current values when opening
      setNewValue("");
      setHostPattern(secret.hostPattern);
      setPathPattern(secret.pathPattern ?? "");
      setHeaderName(
        (secret.injectionConfig as InjectionConfig | null)?.headerName ?? "",
      );
      setValueFormat(
        (secret.injectionConfig as InjectionConfig | null)?.valueFormat ?? "",
      );
    }
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {secret.name}</DialogTitle>
          <DialogDescription>
            Update the secret&apos;s configuration. Leave the value field empty
            to keep the current value.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="edit-value">
              New value{" "}
              <span className="text-muted-foreground font-normal">
                (leave empty to keep current)
              </span>
            </Label>
            <Input
              id="edit-value"
              type="password"
              placeholder="Enter new secret value"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-host">Host pattern</Label>
            <Input
              id="edit-host"
              placeholder="e.g. api.anthropic.com"
              value={hostPattern}
              onChange={(e) => setHostPattern(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-path">
              Path pattern{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </Label>
            <Input
              id="edit-path"
              placeholder="e.g. /v1/*"
              value={pathPattern}
              onChange={(e) => setPathPattern(e.target.value)}
            />
          </div>

          {secret.type === "generic" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="edit-header">Header name</Label>
                <Input
                  id="edit-header"
                  placeholder="e.g. Authorization"
                  value={headerName}
                  onChange={(e) => setHeaderName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-format">
                  Value format{" "}
                  <span className="text-muted-foreground font-normal">
                    (optional)
                  </span>
                </Label>
                <Input
                  id="edit-format"
                  placeholder="e.g. Bearer {value}"
                  value={valueFormat}
                  onChange={(e) => setValueFormat(e.target.value)}
                />
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || !isValid || saving}
          >
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
