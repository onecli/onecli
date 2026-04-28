"use client";

import { useMemo, useState } from "react";
import { Copy, Check, CircleCheck } from "lucide-react";
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
import { cn } from "@onecli/ui/lib/utils";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { createAgent } from "@/lib/actions/agents";
import { validateDisplayName } from "@/lib/validations/display-name";

interface CreateAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

const nameToIdentifier = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

export const CreateAgentDialog = ({
  open,
  onOpenChange,
  onCreated,
}: CreateAgentDialogProps) => {
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [identifierTouched, setIdentifierTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdIdentifier, setCreatedIdentifier] = useState<string | null>(
    null,
  );
  const { copied, copy } = useCopyToClipboard();

  const nameError = useMemo(() => validateDisplayName(name), [name]);
  const showNameError = nameTouched && nameError !== null;
  const isNameValid = name.trim().length > 0 && nameError === null;

  const handleNameChange = (value: string) => {
    setName(value);
    if (!identifierTouched) {
      setIdentifier(nameToIdentifier(value));
    }
  };

  const handleIdentifierChange = (value: string) => {
    setIdentifierTouched(true);
    setIdentifier(value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  };

  const isValidIdentifier = /^[a-z][a-z0-9-]{0,49}$/.test(identifier);

  const handleCreate = async () => {
    if (!isNameValid || !isValidIdentifier) return;
    setCreating(true);
    try {
      const agent = await createAgent(name, identifier);
      setCreatedIdentifier(agent.identifier);
      onCreated();
      toast.success("Agent created");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create agent",
      );
    } finally {
      setCreating(false);
    }
  };

  const handleClose = (value: boolean) => {
    if (!value) {
      setName("");
      setNameTouched(false);
      setIdentifier("");
      setIdentifierTouched(false);
      setCreatedIdentifier(null);
    }
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        {createdIdentifier ? (
          <>
            <div className="flex flex-col items-center pt-2 text-center">
              <div className="bg-brand/10 mb-3 flex size-10 items-center justify-center rounded-full">
                <CircleCheck className="size-5 text-brand" />
              </div>
              <DialogHeader className="items-center">
                <DialogTitle>Agent created</DialogTitle>
                <DialogDescription>
                  Use this identifier to select the agent in the SDK.
                </DialogDescription>
              </DialogHeader>
            </div>
            <div className="py-2">
              <div className="bg-muted flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
                <code className="min-w-0 truncate font-mono text-sm font-medium">
                  {createdIdentifier}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  onClick={() => copy(createdIdentifier)}
                >
                  {copied ? (
                    <Check className="size-3.5 text-brand" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => handleClose(false)} className="w-full">
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create agent</DialogTitle>
              <DialogDescription>
                Give your agent a name to identify it in the dashboard.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-2">
                <Label htmlFor="agent-name">Name</Label>
                <Input
                  id="agent-name"
                  placeholder="e.g. Production Claude"
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  onBlur={() => setNameTouched(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && isNameValid && isValidIdentifier)
                      handleCreate();
                  }}
                  autoFocus
                  className={cn(showNameError && "border-destructive")}
                />
                {showNameError && (
                  <p className="text-destructive text-xs">{nameError}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-identifier">Identifier</Label>
                <Input
                  id="agent-identifier"
                  placeholder="e.g. production"
                  value={identifier}
                  onChange={(e) => handleIdentifierChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && isNameValid && isValidIdentifier)
                      handleCreate();
                  }}
                />
                <p
                  className={`text-xs ${
                    identifier && !isValidIdentifier
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }`}
                >
                  {identifier && !isValidIdentifier
                    ? "Must start with a letter and contain only lowercase letters, numbers, and hyphens."
                    : "Used to select this agent in the SDK. Lowercase letters, numbers, and hyphens."}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setNameTouched(true);
                  if (isNameValid && isValidIdentifier) handleCreate();
                }}
                loading={creating}
                disabled={!isNameValid || !isValidIdentifier || creating}
              >
                {creating ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
