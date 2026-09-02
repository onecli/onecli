"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { Textarea } from "@onecli/ui/components/textarea";
import { useAgents } from "@/hooks/use-agents";
import {
  useCreateOrgSkill,
  useCreateSkill,
  useDeleteOrgSkill,
  useDeleteSkill,
  useOrgSkill,
  useSkill,
  useUpdateOrgSkill,
  useUpdateSkill,
} from "@/hooks/use-skills";
import type { SkillFileInput, SkillSummary } from "@/lib/api";
import { SkillFilesEditor, skillFileProblem } from "./skill-files-editor";

/**
 * Create/edit one skill (both doors — the tier decides which hooks fire).
 * The name is IMMUTABLE after create: it is the directory name inside every
 * sandbox and the agent's own reference — renaming is delete + create. The
 * server is the validator; its message surfaces verbatim.
 */

/** The GOVERNING cap is the server's: body + every extra file together. A
 * body-only counter would let a user fill it and still 422 on the sum. */
const SKILL_TOTAL_MAX = 32_000;

export interface SkillDialogProps {
  tier: "agent" | "organization";
  /** The agent door's subject: the default audience for a new skill. */
  agentId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null = create. The list row is body-free; the dialog fetches content. */
  editing: SkillSummary | null;
}

export const SkillDialog = ({
  tier,
  agentId,
  open,
  onOpenChange,
  editing,
}: SkillDialogProps) => {
  const isOrg = tier === "organization";
  const create = useCreateSkill();
  const update = useUpdateSkill();
  const remove = useDeleteSkill();
  const orgCreate = useCreateOrgSkill();
  const orgUpdate = useUpdateOrgSkill();
  const orgRemove = useDeleteOrgSkill();
  const agents = useAgents();
  const workspaceDetail = useSkill(
    !isOrg && open && editing ? editing.id : null,
  );
  const orgDetail = useOrgSkill(isOrg && open && editing ? editing.id : null);
  const detail = isOrg ? orgDetail : workspaceDetail;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [files, setFiles] = useState<SkillFileInput[]>([]);
  // An agent id or "workspace" — the create-time scope picker. On the agent
  // door it defaults to THIS agent: you are standing in its section, so the
  // narrow, obvious choice is the default and widening is deliberate.
  const [audience, setAudience] = useState(agentId ?? "workspace");
  const [bodySeeded, setBodySeeded] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Re-seed on open/target change; the body arrives with the detail fetch.
  useEffect(() => {
    if (!open) return;
    setBodySeeded(false);
    setAudience(agentId ?? "workspace");
    if (editing) {
      setName(editing.name);
      setDescription(editing.description);
      setContent("");
      setFiles([]);
    } else {
      setName("");
      setDescription("");
      setContent("");
      setFiles([]);
    }
  }, [open, editing, agentId]);

  // Seeded ONCE per open (the memory-dialog lesson): the detail query
  // refetches on window focus, and a data-identity dependency would wipe
  // what the user has typed.
  useEffect(() => {
    if (!open || !editing || bodySeeded || !detail.data) return;
    setContent(detail.data.content);
    setFiles(detail.data.files);
    setBodySeeded(true);
  }, [open, editing, bodySeeded, detail.data]);

  const hostedAgents = (agents.data ?? []).filter(
    (agent) => agent.kind === "hosted",
  );
  const busy =
    create.isPending ||
    update.isPending ||
    remove.isPending ||
    orgCreate.isPending ||
    orgUpdate.isPending ||
    orgRemove.isPending;
  const bodyReady = !editing || bodySeeded;
  const filesValid = files.every((file) => skillFileProblem(file) === null);
  const totalChars =
    content.length + files.reduce((sum, file) => sum + file.content.length, 0);
  const overBudget = totalChars > SKILL_TOTAL_MAX;

  const submit = () => {
    // Only fully-blank rows are dropped. A row with a path but no content is
    // a validation problem (`skillFileProblem`), never a silent deletion.
    const cleanFiles = files
      .map((file) => ({ path: file.path.trim(), content: file.content }))
      .filter((file) => file.path !== "" || file.content !== "");
    const handlers = {
      onSuccess: () => {
        toast.success(editing ? "Skill saved" : "Skill created");
        onOpenChange(false);
      },
      onError: (error: Error) => toast.error(String(error.message)),
    };
    if (editing) {
      const payload = {
        skillId: editing.id,
        patch: {
          description: description.trim(),
          content,
          files: cleanFiles,
        },
      };
      if (isOrg) orgUpdate.mutate(payload, handlers);
      else update.mutate(payload, handlers);
      return;
    }
    const input = {
      name: name.trim(),
      description: description.trim(),
      content,
      ...(cleanFiles.length > 0 && { files: cleanFiles }),
    };
    if (isOrg) {
      orgCreate.mutate(input, handlers);
    } else {
      create.mutate(
        audience === "workspace" ? input : { ...input, agentId: audience },
        handlers,
      );
    }
  };

  const removeSkill = () => {
    if (!editing) return;
    const handlers = {
      onSuccess: () => {
        toast.success("Skill deleted");
        setConfirmOpen(false);
        onOpenChange(false);
      },
      onError: (error: Error) => toast.error(String(error.message)),
    };
    if (isOrg) orgRemove.mutate(editing.id, handlers);
    else remove.mutate(editing.id, handlers);
  };

  // Deleting is not undoable, and the prune carries it into every sandbox in
  // scope within seconds — an org-tier delete strips the files from every
  // hosted agent in the organization. Confirm first (the house standard).
  const confirmDialog = editing && (
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{editing.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {isOrg
              ? "It is removed from every hosted agent in this organization. This cannot be undone."
              : "It is removed from the agents carrying it within seconds. This cannot be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            // Keep the confirm open across the request (Radix closes on
            // click) and close it ourselves when the mutation resolves.
            onClick={(event) => {
              event.preventDefault();
              removeSkill();
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The FRAME is fixed and the fields scroll inside it — with a 12-row
          body and five file blocks, scrolling the whole dialog would carry
          Save out of the viewport. A plain div, not ScrollArea: a Radix
          viewport under a max-h parent clips silently. */}
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit skill" : "New skill"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes reach every running agent within seconds."
              : isOrg
                ? "Reaches every hosted agent in every workspace of the organization."
                : "Reusable instructions your agents load while they work."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="skill-name">Name</Label>
              <Input
                id="skill-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="release-checklist"
                className="font-mono"
                maxLength={64}
                spellCheck={false}
                autoComplete="off"
                disabled={editing !== null}
              />
            </div>
            {!isOrg && !editing && (
              <div className="space-y-1.5">
                <Label htmlFor="skill-audience">Who gets it</Label>
                <Select value={audience} onValueChange={setAudience}>
                  <SelectTrigger id="skill-audience" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* This agent first: it is the door you came through. */}
                    {agentId !== undefined && (
                      <SelectItem value={agentId}>Only this agent</SelectItem>
                    )}
                    <SelectItem value="workspace">
                      Everyone in this workspace
                    </SelectItem>
                    {hostedAgents
                      .filter((agent) => agent.id !== agentId)
                      .map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          Only {agent.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-description">Description</Label>
            <Input
              id="skill-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="One line: how the agent decides when to use it"
              maxLength={500}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="skill-content">
                Instructions (SKILL.md body)
              </Label>
              {/* Counts the body AND the files, because the server's cap is
                  their sum — and says so in words, not colour alone. */}
              <span
                aria-live="polite"
                className={`text-xs ${overBudget ? "text-destructive" : "text-muted-foreground"}`}
              >
                {totalChars.toLocaleString()} /{" "}
                {SKILL_TOTAL_MAX.toLocaleString()}
                {overBudget && " (too long to save)"}
              </span>
            </div>
            {bodyReady ? (
              <Textarea
                id="skill-content"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="Markdown the agent follows when it loads this skill."
                rows={12}
                className="resize-y font-mono"
              />
            ) : (
              <Skeleton className="h-56 w-full" />
            )}
          </div>

          {bodyReady ? (
            <SkillFilesEditor
              files={files}
              onChange={setFiles}
              disabled={busy}
            />
          ) : (
            <Skeleton className="h-10 w-full" />
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {editing ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              loading={remove.isPending || orgRemove.isPending}
              onClick={() => setConfirmOpen(true)}
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                busy ||
                !bodyReady ||
                !filesValid ||
                content.trim() === "" ||
                description.trim() === "" ||
                (!editing && name.trim() === "") ||
                overBudget
              }
              loading={
                create.isPending ||
                update.isPending ||
                orgCreate.isPending ||
                orgUpdate.isPending
              }
              onClick={submit}
            >
              {editing ? "Save" : "Create"}
            </Button>
          </div>
        </DialogFooter>
        {confirmDialog}
      </DialogContent>
    </Dialog>
  );
};
