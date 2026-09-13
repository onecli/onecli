"use client";

import { useState } from "react";
import { CheckCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Textarea } from "@onecli/ui/components/textarea";
import type { PendingActionApprovalItem } from "@/lib/api/channel-approvals";
import { useDecideChannelAction } from "@/hooks/use-approvals";
import { formatAge } from "./format-age";

interface ActionApprovalRowProps {
  item: PendingActionApprovalItem;
}

/**
 * One pending one-shot action approval in the bell — THE decide surface for
 * these (the agent's channels page keeps settings only). Approve/Reject
 * inline; the dialog carries the full ask plus the two decisions Slack's
 * buttons can't: Approve + always allow, and Reject with a reason.
 */
export const ActionApprovalRow = ({ item }: ActionApprovalRowProps) => {
  const decide = useDecideChannelAction(item.agentId);
  const [dialog, setDialog] = useState<"closed" | "details" | "reject">(
    "closed",
  );
  const [reason, setReason] = useState("");

  const pending = decide.isPending;
  const submit = (
    decision: "approve" | "approve_always" | "reject",
    reasonText?: string,
  ) =>
    decide.mutate(
      {
        approvalId: item.id,
        decision,
        ...(reasonText ? { reason: reasonText } : {}),
      },
      {
        onSuccess: (outcome) => {
          setDialog("closed");
          setReason("");
          if (outcome.kind === "already_settled") {
            toast.info("Already decided elsewhere.");
          } else if (decision === "reject") {
            toast.success("Rejected. The agent was told.");
          } else if (outcome.status === "failed") {
            toast.error("Approved, but it failed. The agent was told.");
          } else {
            toast.success(
              decision === "approve_always"
                ? "Done. This recipient is now always allowed."
                : "Approved and done.",
            );
          }
        },
        onError: (err) => toast.error(String(err)),
      },
    );

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{item.summary}</p>
          <p className="text-muted-foreground truncate text-xs">
            {item.agentName} · asks your approval
          </p>
        </div>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {formatAge(item.createdAt)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setDialog("details")}
          className="text-muted-foreground hover:text-foreground"
        >
          Details
        </Button>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            disabled={pending}
            onClick={() => setDialog("reject")}
          >
            Reject
          </Button>
          <Button
            size="xs"
            disabled={pending}
            onClick={() => submit("approve")}
          >
            {pending ? (
              <Loader2
                aria-hidden="true"
                className="size-3 animate-spin motion-reduce:hidden"
              />
            ) : (
              "Approve"
            )}
          </Button>
        </div>
      </div>

      <Dialog
        open={dialog === "details"}
        onOpenChange={(open) => !open && setDialog("closed")}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approval requested</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>
                  <Badge variant="secondary">{item.agentName}</Badge>
                </p>
                <p className="text-foreground text-sm break-words">
                  {item.summary}
                </p>
                <p className="text-xs">
                  Nothing happens until you decide. Asked{" "}
                  {formatAge(item.createdAt)} ago.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setDialog("reject")}
            >
              Reject
            </Button>
            <div className="flex gap-2">
              {item.offersAlwaysAllow && (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => submit("approve_always")}
                >
                  <CheckCheck aria-hidden="true" className="size-4" />
                  Approve + always allow
                </Button>
              )}
              <Button disabled={pending} onClick={() => submit("approve")}>
                Approve
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog === "reject"}
        onOpenChange={(open) => !open && setDialog("closed")}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this request?</DialogTitle>
            <DialogDescription>
              The reason is passed back to {item.agentName} verbatim. It turns a
              dead-end no into a steer.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Rejection reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional: why not, or what to do instead…"
            maxLength={500}
            rows={3}
          />
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setDialog("closed")}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => submit("reject", reason.trim() || undefined)}
            >
              {pending ? (
                <Loader2
                  aria-hidden="true"
                  className="size-4 animate-spin motion-reduce:hidden"
                />
              ) : (
                "Reject"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
