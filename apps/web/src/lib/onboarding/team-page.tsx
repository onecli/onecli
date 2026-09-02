"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Plus, X } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { cn } from "@onecli/ui/lib/utils";
import { toast } from "sonner";
import { agentChatGreetingPath } from "@/lib/navigation";
import { useInviteTeammates } from "@/hooks/use-invitations";
import { useOnboarding } from "./onboarding-context";
import { useStepGuard } from "./use-step-guard";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Invite the team while the agent boots. Every employee gets one — this is
 * the teams half of the mission, placed right after the personal wow so the
 * momentum carries. Skippable: chat with the agent is one click away either
 * way. Invitations go through the same POST /v1/org/invitations as the team
 * page (admin gate, seat cap, audit trail, delivery included). */
export default function TeamPage() {
  const router = useRouter();
  const { createdAgentId, workspaceId, completing, handleComplete } =
    useOnboarding();
  const allowed = useStepGuard("team");
  const invite = useInviteTeammates();

  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  // Both buttons share the completing flag — remember which one was pressed
  // so the spinner lands on it, not on its neighbor.
  const [skipping, setSkipping] = useState(false);

  const chatDestination =
    createdAgentId && workspaceId
      ? agentChatGreetingPath(workspaceId, createdAgentId)
      : undefined;

  // The chat page is a heavy surface and it is where both buttons land —
  // fetch it while the user types.
  useEffect(() => {
    if (chatDestination) router.prefetch(chatDestination);
  }, [router, chatDestination]);

  if (!allowed) return null;

  const sending = invite.isPending;
  const busy = sending || completing;

  /** Commit the draft into the chip list. Returns the full recipient list
   * (chips + committed draft), or null when the draft is invalid — one source
   * of truth for what gets chipped AND what gets invited. */
  const addDraft = (): string[] | null => {
    const email = draft.trim().toLowerCase();
    if (!email) return emails;
    if (!EMAIL_RE.test(email)) {
      setDraftError("That doesn't look like an email address.");
      return null;
    }
    const next = emails.includes(email) ? emails : [...emails, email];
    setEmails(next);
    setDraft("");
    return next;
  };

  const finish = async () => {
    // The unadded draft counts — typing an address and clicking Continue
    // means "invite this person", not "I changed my mind".
    const all = addDraft();
    if (!all) return;
    if (all.length > 0) {
      try {
        const result = await invite.mutateAsync({
          emails: all,
          workspaceId,
        });
        if (result.invited === 0) {
          // Nothing went through: stay here so the user can retry or skip
          // deliberately. A wall of 403s is a permission state, not a
          // transient failure — say so instead of implying retry.
          toast.error(
            result.failed.every((f) => f.status === 403)
              ? "Only organization admins can invite teammates. Skip to continue."
              : "Couldn't send the invitations. Please try again.",
          );
          return;
        }
        if (result.failed.length > 0) {
          toast.error(
            `Couldn't invite: ${result.failed.map((f) => f.email).join(", ")}. Everyone else is in.`,
          );
        } else {
          toast.success(
            all.length === 1
              ? "Invitation sent"
              : `${all.length} invitations sent`,
          );
        }
      } catch {
        toast.error("Couldn't send the invitations. Please try again.");
        return;
      }
    }
    await handleComplete(chatDestination);
  };

  const skip = async () => {
    setSkipping(true);
    await handleComplete(chatDestination);
    setSkipping(false);
  };

  return (
    <div className="flex w-full flex-col items-center text-center">
      <h1 className="font-serif text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        Invite your team
      </h1>
      <p className="text-muted-foreground mt-3 max-w-md text-balance">
        Everyone gets their own agent, under your policies.
      </p>

      <form
        className="mt-8 w-full max-w-md text-left"
        onSubmit={(e) => {
          e.preventDefault();
          addDraft();
        }}
      >
        <Label htmlFor="invite-email" className="sr-only">
          Teammate email
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="invite-email"
            name="invite-email"
            type="email"
            autoComplete="off"
            spellCheck={false}
            placeholder="teammate@company.com"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setDraftError(null);
            }}
            disabled={busy}
            aria-invalid={!!draftError}
            aria-describedby={draftError ? "invite-email-error" : undefined}
            className={cn(draftError && "border-destructive")}
          />
          <Button
            type="submit"
            variant="outline"
            aria-label="Add email"
            disabled={busy}
          >
            <Plus className="size-4" aria-hidden />
          </Button>
        </div>
        {draftError && (
          <p
            id="invite-email-error"
            role="alert"
            className="text-destructive mt-2 text-xs"
          >
            {draftError}
          </p>
        )}
      </form>

      {emails.length > 0 && (
        <ul className="mt-3 flex w-full max-w-md flex-wrap gap-2">
          {emails.map((email) => (
            <li
              key={email}
              className="bg-muted flex max-w-full items-center gap-1.5 rounded-full py-1 pr-1.5 pl-3 text-sm"
            >
              <span className="truncate">{email}</span>
              <button
                type="button"
                aria-label={`Remove ${email}`}
                className="hover:bg-foreground/10 focus-visible:ring-ring/50 relative shrink-0 rounded-full p-1 outline-none focus-visible:ring-[3px] after:absolute after:-inset-2"
                onClick={() =>
                  setEmails((prev) => prev.filter((e) => e !== email))
                }
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8 flex w-full max-w-md flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:items-center">
        <Button
          variant="ghost"
          size="lg"
          onClick={() => void skip()}
          disabled={busy}
          loading={skipping && completing}
        >
          Skip
        </Button>
        <Button
          variant="brand"
          size="lg"
          onClick={() => void finish()}
          loading={sending || (completing && !skipping)}
        >
          {emails.length > 0 || draft.trim()
            ? "Send invites & meet your agent"
            : "Meet your agent"}
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
