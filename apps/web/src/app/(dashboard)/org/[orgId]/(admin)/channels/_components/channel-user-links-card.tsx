"use client";

import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@onecli/ui/components/card";
import { Input } from "@onecli/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@onecli/ui/components/table";
import {
  useAddChannelUserLink,
  useOrgChannels,
  useRemoveChannelUserLink,
} from "@/hooks/use-org-channels";
import { useOrgMembersList } from "@/hooks/use-org-members";

/**
 * Slack member ↔ platform user links — the identity bridge approvals ride
 * (who clicked Approve in Slack must be a member someone actually authorized).
 *
 * AUTOMATIC by default: a Slack member is matched to their OneCLI account by
 * verified email the first time they message an agent or click a card, so
 * there is nothing to set up. This card is the rare ESCAPE HATCH (different
 * emails in each place, a workspace that hides emails, a wrong match), so it
 * stays folded under one line until an admin needs it: an open table and a
 * "Link manually" button read like a required setup step. Hidden entirely
 * until Slack is connected: links belong to a workspace.
 */
export const ChannelUserLinksCard = () => {
  const { data, isPending } = useOrgChannels();
  const addLink = useAddChannelUserLink();
  const removeLink = useRemoveChannelUserLink();
  const [expanded, setExpanded] = useState(false);

  const slackConnected = (data?.integrations ?? []).some(
    (i) => i.provider === "slack",
  );
  // The directory API backs the member picker; where it isn't available (a
  // 403 on builds without the directory surface), fall back to a raw user-id
  // field rather than hiding manual links entirely. Fetched only once the
  // card is unfolded: the directory is paged in full, and the default view
  // never shows a member.
  const members = useOrgMembersList(expanded);

  // The manual form is the RARE path (auto email-match covers most members),
  // so it stays folded behind one small button until an admin needs it.
  // Opening/closing the fold unmounts the control that had focus, so focus
  // is handed off by hand (the integration card's paste-fold pattern): into
  // the first field on open, back to the disclosure on Cancel.
  const [formOpen, setFormOpen] = useState(false);
  const disclosureRef = useRef<HTMLButtonElement>(null);
  const restoreDisclosureFocus = useRef(false);
  useEffect(() => {
    if (formOpen || !restoreDisclosureFocus.current) return;
    restoreDisclosureFocus.current = false;
    disclosureRef.current?.focus();
  }, [formOpen]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [manualUserId, setManualUserId] = useState("");
  const [externalUserId, setExternalUserId] = useState("");

  const links = data?.userLinks ?? [];
  const usePicker = !members.isError;
  const userId = (usePicker ? selectedUserId : manualUserId).trim();
  const ready = userId.length > 0 && externalUserId.trim().length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    addLink.mutate(
      {
        provider: "slack",
        externalUserId: externalUserId.trim(),
        userId,
      },
      {
        onSuccess: () => {
          setSelectedUserId("");
          setManualUserId("");
          setExternalUserId("");
          setFormOpen(false);
          toast.success("Link added");
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  if (isPending || !slackConnected) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <CardTitle>People</CardTitle>
            <CardDescription className="mt-1.5">
              Teammates are matched to their OneCLI account automatically, by
              their Slack email, the first time they message an agent.
              {links.length > 0 &&
                ` ${links.length === 1 ? "1 person" : `${links.length} people`} matched so far.`}
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide" : "Manage"}
          </Button>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-4">
          {!formOpen && (
            <button
              ref={disclosureRef}
              type="button"
              className="text-muted-foreground hover:text-foreground -my-1 py-1 text-xs underline underline-offset-2"
              onClick={() => setFormOpen(true)}
            >
              Someone uses a different email in Slack? Link them by hand
            </button>
          )}
          {formOpen && (
            <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
              {usePicker ? (
                <Select
                  value={selectedUserId || undefined}
                  onValueChange={setSelectedUserId}
                >
                  {/* Focus hand-off: the disclosure that had focus just
                        unmounted. */}
                  <SelectTrigger
                    className="w-56"
                    aria-label="Member"
                    autoFocus={formOpen}
                  >
                    <SelectValue placeholder="Pick a member" />
                  </SelectTrigger>
                  <SelectContent>
                    {(members.data ?? []).map((m) => (
                      <SelectItem key={m.userId} value={m.userId}>
                        {m.name ?? m.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={manualUserId}
                  onChange={(e) => setManualUserId(e.target.value)}
                  placeholder="User ID"
                  aria-label="User ID"
                  className="w-56 font-mono text-sm"
                  autoFocus={formOpen}
                />
              )}
              <Input
                value={externalUserId}
                onChange={(e) => setExternalUserId(e.target.value)}
                placeholder="U0123ABCDEF"
                aria-label="Slack member ID"
                className="w-44 font-mono text-sm"
              />
              <Button
                type="submit"
                variant="outline"
                disabled={!ready || addLink.isPending}
                loading={addLink.isPending}
              >
                {addLink.isPending ? "Adding…" : "Add link"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  restoreDisclosureFocus.current = true;
                  setFormOpen(false);
                }}
              >
                Cancel
              </Button>
              <p className="text-muted-foreground w-full text-xs">
                The Slack member ID is on the member&apos;s Slack profile:
                three-dot menu, then Copy member ID.
              </p>
            </form>
          )}

          {links.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No one matched yet. That happens on its own the first time a
              teammate messages an agent.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Slack member ID</TableHead>
                  <TableHead>Linked via</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {links.map((link) => (
                  <TableRow key={link.id}>
                    <TableCell>
                      <span className="text-sm">
                        {link.user.name ?? link.user.email}
                      </span>
                      {link.user.name && (
                        <span className="text-muted-foreground ml-2 text-xs">
                          {link.user.email}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {link.externalUserId}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {link.linkedVia === "email" ? "Email match" : "Manual"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Remove link for ${link.user.email}`}
                        // Instant: the row leaves on click; the hook
                        // confirms, or puts it back and says why.
                        onClick={() =>
                          removeLink.mutate({
                            provider: "slack",
                            linkId: link.id,
                          })
                        }
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      )}
    </Card>
  );
};
