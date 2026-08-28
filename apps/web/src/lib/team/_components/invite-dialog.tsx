"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
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
import { useCreateInvitation } from "@/hooks/use-invitations";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { RoleSelect } from "./role-select";

interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const isValidEmail = (email: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/**
 * Invite someone, then hand the inviter a link they can paste.
 *
 * The link is the delivery path that always works: a self-hosted deployment
 * with no email provider configured can still get somebody in. Email, where it
 * is configured, goes out on top of it — and the dialog says which happened,
 * rather than claiming "sent" on a box that sent nothing.
 */
export const InviteDialog = ({ open, onOpenChange }: InviteDialogProps) => {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [result, setResult] = useState<{
    joinUrl: string;
    emailed: boolean;
    email: string;
  } | null>(null);
  const createInvitation = useCreateInvitation();
  const { copied, copy } = useCopyToClipboard();

  const canSubmit = isValidEmail(email.trim()) && !createInvitation.isPending;

  const handleSend = () => {
    if (!canSubmit) return;
    const recipient = email.trim();
    createInvitation.mutate(
      { email: recipient, role },
      {
        onSuccess: (created) => setResult({ ...created, email: recipient }),
      },
    );
  };

  const reset = () => {
    setEmail("");
    setRole("member");
    setResult(null);
  };

  const handleClose = (value: boolean) => {
    if (!value) reset();
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {result ? "Invitation ready" : "Invite team members"}
          </DialogTitle>
          <DialogDescription>
            {result
              ? result.emailed
                ? `We emailed ${result.email}. You can also send them this link.`
                : `Send ${result.email} this link. No email provider is configured, so nothing was sent for you.`
              : "Invite people to join your organization by email."}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="flex items-center gap-2 py-2">
            <Input readOnly value={result.joinUrl} className="text-xs" />
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy invitation link"
              onClick={() => copy(result.joinUrl)}
            >
              {copied ? (
                <Check className="size-4" />
              ) : (
                <Copy className="size-4" />
              )}
            </Button>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <RoleSelect id="invite-role" value={role} onValueChange={setRole} />

            <div className="flex items-center gap-4">
              <Label htmlFor="invite-email" className="shrink-0">
                Email
              </Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSubmit) handleSend();
                }}
                autoFocus
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {result ? (
            <>
              <Button variant="ghost" onClick={reset}>
                Invite someone else
              </Button>
              <Button onClick={() => handleClose(false)}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleSend}
                loading={createInvitation.isPending}
                disabled={!canSubmit}
              >
                {createInvitation.isPending
                  ? "Inviting..."
                  : "Create invitation"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
