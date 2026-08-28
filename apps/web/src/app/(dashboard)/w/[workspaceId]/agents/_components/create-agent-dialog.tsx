"use client";

import { useMemo, useState } from "react";
import {
  Copy,
  Check,
  CircleCheck,
  KeyRound,
  TriangleAlert,
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
import { Label } from "@onecli/ui/components/label";
import { cn } from "@onecli/ui/lib/utils";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useCreateAgent } from "@/hooks/use-agents";
import { SecretDialog } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog";
import { validateDisplayName } from "@onecli/api/validations/display-name";
import { IDENTIFIER_REGEX } from "@onecli/api/validations/agent";
import { nameToIdentifier } from "@/lib/agents/agent-identifier";

interface CreateAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const CreateAgentDialog = ({
  open,
  onOpenChange,
}: CreateAgentDialogProps) => {
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [identifierTouched, setIdentifierTouched] = useState(false);
  const [createdIdentifier, setCreatedIdentifier] = useState<string | null>(
    null,
  );
  // Null until creation answers. False = the workspace has no LLM key, so the
  // agent cannot run yet — the one thing worth interrupting the success step
  // for, since everything else about a new agent is already usable.
  const [hasLlmKey, setHasLlmKey] = useState<boolean | null>(null);
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const { copied, copy } = useCopyToClipboard();
  const createAgent = useCreateAgent();

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

  const isValidIdentifier = IDENTIFIER_REGEX.test(identifier);

  const handleCreate = () => {
    if (!isNameValid || !isValidIdentifier) return;
    createAgent.mutate(
      { name, identifier },
      {
        onSuccess: (agent) => {
          setCreatedIdentifier(agent.identifier);
          setHasLlmKey(agent.llmKeys.length > 0);
          toast.success(
            agent.llmKeys.length > 0
              ? "Agent created and connected to your LLM key"
              : "Agent created",
          );
        },
      },
    );
  };

  const handleClose = (value: boolean) => {
    if (!value) {
      setName("");
      setNameTouched(false);
      setIdentifier("");
      setIdentifierTouched(false);
      setCreatedIdentifier(null);
      setHasLlmKey(null);
    }
    onOpenChange(value);
  };

  return (
    <>
      <Dialog open={open && !keyDialogOpen} onOpenChange={handleClose}>
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
                {hasLlmKey === true && (
                  <p className="text-muted-foreground mt-3 flex items-center gap-1.5 text-xs">
                    <KeyRound className="size-3.5 shrink-0" />
                    Your LLM key is attached, so this agent can run now.
                  </p>
                )}
                {hasLlmKey === false && (
                  <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                    <p className="flex items-center gap-1.5 text-xs font-medium">
                      <TriangleAlert className="size-3.5 shrink-0 text-amber-500" />
                      One step left: add an LLM key
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      This workspace has no LLM key yet, so the agent has
                      nothing to think with. Add one and it is attached
                      automatically.
                    </p>
                  </div>
                )}
              </div>
              <DialogFooter>
                {hasLlmKey === false ? (
                  <>
                    <Button variant="ghost" onClick={() => handleClose(false)}>
                      Later
                    </Button>
                    <Button onClick={() => setKeyDialogOpen(true)}>
                      <KeyRound className="size-3.5" />
                      Add LLM key
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => handleClose(false)} className="w-full">
                    Done
                  </Button>
                )}
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
                      ? "Must start with a letter or number and contain only lowercase letters, numbers, and hyphens."
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
                  loading={createAgent.isPending}
                  disabled={
                    !isNameValid || !isValidIdentifier || createAgent.isPending
                  }
                >
                  {createAgent.isPending ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      {/* The guided second step. The server attaches a newly created LLM key to
        every keyless agent, so saving here equips the agent just created —
        no extra attach call, and no way for the two to disagree. */}
      <SecretDialog
        open={keyDialogOpen}
        onOpenChange={setKeyDialogOpen}
        allowedTypes={["anthropic", "openai"]}
        onSaved={() => {
          setHasLlmKey(true);
          toast.success("LLM key added and attached to your agent");
          handleClose(false);
        }}
      />
    </>
  );
};
