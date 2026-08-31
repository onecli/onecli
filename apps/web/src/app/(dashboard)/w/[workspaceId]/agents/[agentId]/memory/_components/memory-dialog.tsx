"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { Textarea } from "@onecli/ui/components/textarea";
import {
  useCreateMemory,
  useDeleteMemory,
  useMemory,
  useUpdateMemory,
} from "@/hooks/use-memories";
import type { AgentMemorySummary } from "@/lib/api";

/**
 * Create/edit one memory. The key is IMMUTABLE after create — it is the
 * agent's own upsert handle (and step 9's file name), so a rename would
 * orphan the model's references; the input renders disabled on edit. The
 * server is the validator and its message surfaces verbatim.
 */
export interface MemoryDialogProps {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null = create. The list row is body-free; the dialog fetches content. */
  editing: AgentMemorySummary | null;
}

export const MemoryDialog = ({
  agentId,
  open,
  onOpenChange,
  editing,
}: MemoryDialogProps) => {
  const create = useCreateMemory(agentId);
  const update = useUpdateMemory(agentId);
  const remove = useDeleteMemory(agentId);
  const detail = useMemory(agentId, open && editing ? editing.id : null);

  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [contentSeeded, setContentSeeded] = useState(false);

  // Re-seed the form whenever the dialog opens on a different target.
  useEffect(() => {
    if (!open) return;
    setContentSeeded(false);
    if (editing) {
      setKey(editing.key);
      setTitle(editing.title ?? "");
      setDescription(editing.description ?? "");
      setContent("");
    } else {
      setKey("");
      setTitle("");
      setDescription("");
      setContent("");
    }
  }, [open, editing]);

  // The content arrives with the detail fetch on edit — seeded ONCE per
  // open/target, deliberately: the detail query refetches on window focus,
  // and a data-identity dependency would wipe what the user has typed.
  useEffect(() => {
    if (!open || !editing || contentSeeded || !detail.data) return;
    setContent(detail.data.content);
    setContentSeeded(true);
  }, [open, editing, contentSeeded, detail.data]);

  const busy = create.isPending || update.isPending || remove.isPending;
  const contentReady = !editing || contentSeeded;

  const submit = () => {
    const handlers = {
      onSuccess: () => {
        toast.success(editing ? "Memory saved" : "Memory created");
        onOpenChange(false);
      },
      onError: (error: Error) => toast.error(String(error.message)),
    };
    if (editing) {
      update.mutate(
        {
          memoryId: editing.id,
          patch: {
            title: title.trim() === "" ? null : title.trim(),
            description: description.trim() === "" ? null : description.trim(),
            content,
          },
        },
        handlers,
      );
    } else {
      create.mutate(
        {
          key: key.trim(),
          content,
          ...(title.trim() && { title: title.trim() }),
          ...(description.trim() && { description: description.trim() }),
        },
        handlers,
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The FRAME is fixed and the fields scroll inside it — a memory body
          runs to 100k characters, and a dialog that grew with it would carry
          its own Save button off a screen that cannot scroll. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit memory" : "New memory"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Your edit is live from the agent's next read; the previous version stays in history."
              : "A durable fact the agent carries into every conversation."}
          </DialogDescription>
        </DialogHeader>

        {/* `-m-1 p-1`: a focus ring is a box-shadow and adds nothing to
            scrollable overflow, so an edge field's ring needs the gutter. */}
        <DialogBody className="-m-1 space-y-4 p-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="memory-key">Key</Label>
              <Input
                id="memory-key"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="deploy-notes"
                className="font-mono"
                maxLength={80}
                disabled={editing !== null}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="memory-title">Title (optional)</Label>
              <Input
                id="memory-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Deploy notes"
                maxLength={120}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="memory-description">Description (optional)</Label>
            <Input
              id="memory-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="One line: the agent's index entry"
              maxLength={300}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="memory-content">Content</Label>
            {contentReady ? (
              <Textarea
                id="memory-content"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="Markdown. Facts, decisions, findings. Never credentials."
                rows={8}
                // `field-sizing-content` grows the field with the body it
                // holds; uncapped, a long memory would claim the whole
                // scrolling region and hide the fields above it.
                className="max-h-[min(24rem,40dvh)]"
                // Mirrors MEMORY_FILE_CONTENT_MAX_CHARS. Hardcoded on purpose,
                // NOT imported from @onecli/agent-protocol: that barrel now
                // pulls in memory-file.ts's `node:crypto` (the checksum), and
                // the client bundle must not. The server is the authority —
                // its 422 message states the same number — so this is only a
                // client-side courtesy cap.
                maxLength={100_000}
              />
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </div>
        </DialogBody>

        <DialogFooter className="gap-2 sm:justify-between">
          {editing ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(editing.id, {
                  onSuccess: () => {
                    toast.success("Memory deleted");
                    onOpenChange(false);
                  },
                  onError: (error) => toast.error(String(error.message)),
                })
              }
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
                !contentReady ||
                content.trim() === "" ||
                (!editing && key.trim() === "")
              }
              loading={create.isPending || update.isPending}
              onClick={submit}
            >
              {editing ? "Save" : "Create"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
