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
import { createSecret } from "@/lib/actions/secrets";

const SECRET_TYPES = [
  {
    value: "anthropic" as const,
    label: "Anthropic API Key",
    hostDefault: "api.anthropic.com",
  },
  {
    value: "generic" as const,
    label: "Generic Secret",
    hostDefault: "",
  },
];

interface CreateSecretDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

export const CreateSecretDialog = ({
  open,
  onOpenChange,
  onCreated,
}: CreateSecretDialogProps) => {
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);

  const [name, setName] = useState("");
  const [type, setType] = useState<"anthropic" | "generic">("anthropic");
  const [value, setValue] = useState("");
  const [hostPattern, setHostPattern] = useState("api.anthropic.com");
  const [pathPattern, setPathPattern] = useState("");
  const [headerName, setHeaderName] = useState("Authorization");
  const [valueFormat, setValueFormat] = useState("Bearer {value}");

  const resetForm = () => {
    setName("");
    setType("anthropic");
    setValue("");
    setHostPattern("api.anthropic.com");
    setPathPattern("");
    setHeaderName("Authorization");
    setValueFormat("Bearer {value}");
  };

  const handleTypeChange = (newType: "anthropic" | "generic") => {
    setType(newType);
    const config = SECRET_TYPES.find((t) => t.value === newType);
    if (config?.hostDefault) {
      setHostPattern(config.hostDefault);
    } else {
      setHostPattern("");
    }
  };

  const isValid =
    name.trim() &&
    value.trim() &&
    hostPattern.trim() &&
    (type !== "generic" || headerName.trim());

  const handleCreate = async () => {
    if (!user?.id || !isValid) return;
    setCreating(true);
    try {
      await createSecret(
        {
          name,
          type,
          value,
          hostPattern,
          pathPattern: pathPattern || undefined,
          injectionConfig:
            type === "generic"
              ? { headerName, valueFormat: valueFormat || "{value}" }
              : null,
        },
        user.id,
      );
      onCreated();
      toast.success("Secret created");
      handleClose(false);
    } catch {
      toast.error("Failed to create secret");
    } finally {
      setCreating(false);
    }
  };

  const handleClose = (value: boolean) => {
    if (!value) resetForm();
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add secret</DialogTitle>
          <DialogDescription>
            Store an encrypted credential for the proxy to inject into requests.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="secret-name">Name</Label>
            <Input
              id="secret-name"
              placeholder="e.g. Anthropic Production Key"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label>Type</Label>
            <div className="flex gap-2">
              {SECRET_TYPES.map((t) => (
                <Button
                  key={t.value}
                  type="button"
                  variant={type === t.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => handleTypeChange(t.value)}
                >
                  {t.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="secret-value">Secret value</Label>
            <Input
              id="secret-value"
              type="password"
              placeholder={
                type === "anthropic" ? "sk-ant-api03-..." : "Enter secret value"
              }
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Encrypted at rest. You won&apos;t be able to view this value
              again.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="secret-host">Host pattern</Label>
            <Input
              id="secret-host"
              placeholder="e.g. api.anthropic.com or *.example.com"
              value={hostPattern}
              onChange={(e) => setHostPattern(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              The host this secret applies to. Use{" "}
              <code className="text-xs">*.example.com</code> for wildcard
              subdomains.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="secret-path">
              Path pattern{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </Label>
            <Input
              id="secret-path"
              placeholder="e.g. /v1/*"
              value={pathPattern}
              onChange={(e) => setPathPattern(e.target.value)}
            />
          </div>

          {type === "generic" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="secret-header">Header name</Label>
                <Input
                  id="secret-header"
                  placeholder="e.g. Authorization"
                  value={headerName}
                  onChange={(e) => setHeaderName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="secret-format">
                  Value format{" "}
                  <span className="text-muted-foreground font-normal">
                    (optional)
                  </span>
                </Label>
                <Input
                  id="secret-format"
                  placeholder="e.g. Bearer {value}"
                  value={valueFormat}
                  onChange={(e) => setValueFormat(e.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  Use <code className="text-xs">{"{value}"}</code> as a
                  placeholder for the secret. Defaults to the raw value.
                </p>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!isValid || creating}>
            {creating ? "Creating..." : "Add Secret"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
