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
import {
  SkillFilesEditor,
  skillFileElementId,
  skillFileProblem,
} from "./skill-files-editor";

/**
 * Create/edit one skill (both doors — the tier decides which hooks fire).
 * The name is IMMUTABLE after create: it is the directory name inside every
 * sandbox and the agent's own reference — renaming is delete + create. The
 * server is the validator; its message surfaces verbatim.
 */

/** The GOVERNING cap is the server's: body + every extra file together. A
 * body-only counter would let a user fill it and still 422 on the sum. */
const SKILL_TOTAL_MAX = 32_000;

/** The footer line's id, so the Save/Create button is described by it. */
const BLOCKER_ID = "skill-save-blocker";

/** Why a Create/Save click did not save: the words for the footer, and the
 *  input the caret goes to. */
interface SaveBlocker {
  message: string;
  focusId: string;
}

const requiredBlocker = (focusId: string): SaveBlocker => ({
  message: "Fill in the required fields.",
  focusId,
});

/** Every required field carries the same mark, so "required" is read from
 *  one glance at the form rather than discovered at the Create button. */
const Required = () => (
  <span aria-hidden className="text-destructive ml-0.5">
    *
  </span>
);

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
  /** Set by a Create/Save click on an invalid form: validation shows up when
   *  the user asks for it, never while they are still typing. */
  const [attempted, setAttempted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Re-seed on open/target change; the body arrives with the detail fetch.
  useEffect(() => {
    if (!open) return;
    setAttempted(false);
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
  const totalChars =
    content.length + files.reduce((sum, file) => sum + file.content.length, 0);
  const overBudget = totalChars > SKILL_TOTAL_MAX;

  const missingName = !editing && name.trim() === "";
  const missingDescription = description.trim() === "";
  const missingContent = bodyReady && content.trim() === "";
  const badFile = files
    .map((file, index) => ({ index, problem: skillFileProblem(file) }))
    .find((row) => row.problem !== null);
  /**
   * The first thing stopping a save, in form order, or null when it can save.
   * ONE answer drives both the footer sentence and the caret, so the words and
   * the focus can never point at different problems. The button stays live: a
   * dead, unexplained button gave the user nothing to act on, while a click
   * always produces an answer.
   */
  const findBlocker = (): SaveBlocker | null => {
    if (missingName) return requiredBlocker("skill-name");
    if (missingDescription) return requiredBlocker("skill-description");
    if (missingContent) return requiredBlocker("skill-content");
    if (badFile?.problem) {
      return {
        message: "Fix the highlighted file.",
        focusId: skillFileElementId(badFile.index, badFile.problem.field),
      };
    }
    if (overBudget) {
      return {
        message: "Too long to save. Shorten the instructions or files.",
        focusId: "skill-content",
      };
    }
    return null;
  };
  const blocker = findBlocker();
  /** Only after a real attempt, and each mark clears as its field is fixed. */
  const blockerShown = attempted && blocker !== null;

  const submit = () => {
    if (!bodyReady || busy) return;
    // The click IS the validation request: mark what is wrong and stop here,
    // so nothing is ever rejected silently.
    if (blocker) {
      setAttempted(true);
      // Put the caret on the problem, so the answer is not just visible but
      // reachable in a long, scrolling dialog (focus scrolls it into view).
      document.getElementById(blocker.focusId)?.focus();
      return;
    }
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
              <Label htmlFor="skill-name">
                Name
                {/* Immutable once created: nothing left to fill in. */}
                {!editing && <Required />}
              </Label>
              <Input
                id="skill-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="release-checklist"
                required={!editing}
                aria-invalid={attempted && missingName}
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
            <Label htmlFor="skill-description">
              Description
              <Required />
            </Label>
            <Input
              id="skill-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="One line: how the agent decides when to use it"
              required
              aria-invalid={attempted && missingDescription}
              maxLength={500}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="skill-content">
                Instructions (SKILL.md body)
                <Required />
              </Label>
              {/* Counts the body AND the files, because the server's cap is
                  their sum, and says so in words, not colour alone. */}
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
                required
                aria-invalid={attempted && (missingContent || overBudget)}
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
              hasBody={content.trim() !== ""}
              showErrors={attempted}
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
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Short, and beside the button it explains. A tooltip on a
                disabled button is unreachable by keyboard and invisible on
                touch, so this stays visible text. The region is ALWAYS
                mounted (sr-only while empty, so it takes no room): a live
                region inserted together with its text is often not
                announced at all. */}
            <p
              id={BLOCKER_ID}
              role="status"
              className={blockerShown ? "text-destructive text-xs" : "sr-only"}
            >
              {blockerShown ? blocker.message : ""}
            </p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              // Never dead: clicking an incomplete form is how the user asks
              // what is missing (`submit` marks the fields).
              disabled={busy || !bodyReady}
              aria-describedby={blockerShown ? BLOCKER_ID : undefined}
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
