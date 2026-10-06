"use client";

import { useState } from "react";
import { Loader2, Plus, TriangleAlert } from "lucide-react";
import { getApp } from "@onecli/api/apps/registry";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import type { Connection } from "@/lib/api";
import { useAgentGrants } from "@/hooks/use-grants";
import { useConnections } from "@/hooks/use-connections";
import { useAppPermissionDefinitions } from "@/hooks/use-app-permissions";
import { useEffectiveCredentials } from "@/lib/api/policy-visibility";
import { useManageConnectionState } from "@/hooks/use-manage-connection-state";
import { ConnectionGrantRow } from "../../_components/connection-grant-row";
import { ManagePermissionsDialog } from "../../_components/manage-permissions-dialog";

/**
 * The chat card's Attach door: every connection of ONE app, each with a
 * toggle that attaches it to (or detaches it from) THIS agent. The inverse
 * orientation of the post-connect "turn on the agents" dialog — there the
 * rows are agents for one connection; here they are connections for one
 * agent — because the reader arrived from "this agent lacks access", already
 * knowing which agent.
 *
 * Toggling on grants full access (the card's stated consent contract); the
 * agent page's Apps section remains the place to narrow tools afterwards.
 * The rows ARE the agent page's rows — ConnectionGrantRow, fed the same
 * per-connection derivation as AppsTab — so every law that surface enforces
 * (org-granted locked on, org-blocked frozen in the ON direction but still
 * detachable, the effective-status pill, Manage only where a catalog exists)
 * holds here without a second implementation.
 *
 * With nothing to attach yet and a connect door wired, the same dialog reads
 * as Connect: the only constructive step is connecting, and the Slack card's
 * Connect button deep-links here (`?attach=`). Its copy states the workspace
 * auto-attach contract like every other connect door does, because a new
 * account lands on for every agent of the workspace, not only this one.
 */
export const AttachConnectionDialog = ({
  agentId,
  agentName,
  provider,
  open,
  onOpenChange,
  onConnectNew,
}: {
  agentId: string;
  agentName?: string;
  provider: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open the app's OAuth popup to add an account: the first one (the
   * Connect state) or another. Omitted → no connect button (e.g. surfaces
   * without popup wiring). */
  onConnectNew?: () => void;
}) => {
  const app = getApp(provider);
  const appName = app?.name ?? provider;
  const connectionsQuery = useConnections("workspace");
  const grantsQuery = useAgentGrants(agentId);
  // Feeds the per-row org laws (org-granted provenance, org-blocked, status
  // pill) — part of the row-render gate for the same reason grants are.
  const credentialsQuery = useEffectiveCredentials(agentId);
  const { data: definitions = [] } = useAppPermissionDefinitions();

  // The per-row Manage door: the agent page's permissions side drawer,
  // targeted at ONE connection. Same read-only law as every Manage surface.
  const [manageConnection, setManageConnection] = useState<Connection | null>(
    null,
  );
  const {
    grant: manageGrant,
    readOnly: manageReadOnly,
    readOnlyReason: manageReadOnlyReason,
  } = useManageConnectionState(agentId, manageConnection);

  const pool = (connectionsQuery.data ?? []).filter(
    (c) => c.provider === provider && c.status === "connected",
  );
  // Toggles never render over unknown grant state — pending OR failed (the
  // AppsTab rule: a blind toggle would write against invisible state).
  const isPending =
    connectionsQuery.isPending ||
    grantsQuery.isPending ||
    credentialsQuery.isPending;
  const isError =
    connectionsQuery.isError || grantsQuery.isError || credentialsQuery.isError;
  const failed = [connectionsQuery, grantsQuery, credentialsQuery].filter(
    (q) => q.isError,
  );
  const isRetrying = failed.some((q) => q.isFetching);
  const retry = () => {
    for (const q of failed) void q.refetch();
  };

  const grantByConnection = new Map(
    (grantsQuery.data?.connections ?? []).map((g) => [g.connectionId, g]),
  );
  const credentialByConnection = new Map(
    (credentialsQuery.data?.connections ?? []).map((e) => [e.id, e]),
  );
  const hasCatalog = definitions.some((d) => d.provider === provider);
  // Until the pool resolves the dialog cannot know whether it is a Connect
  // or an Attach dialog, so the header names only the app: a cold deep-link
  // landing must not say "Attach" and then flip to "Connect" (the exact
  // mismatch this state exists to remove).
  const known = !isPending && !isError;
  // Nothing to attach yet and a connect door: the only constructive step IS
  // connecting, so the dialog says Connect. The popup still needs this
  // click, because a browser blocks one opened without a user gesture.
  const connectFirst = known && pool.length === 0 && onConnectNew !== undefined;
  const who = agentName ?? "this agent";
  const title = !known
    ? appName
    : connectFirst
      ? `Connect ${appName}`
      : `Attach ${appName}`;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-xl"
          // No description while unresolved: the body's status or alert
          // carries the message, so opt out of Radix's describedby link.
          {...(!known && { "aria-describedby": undefined })}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {known && (
              <DialogDescription>
                {connectFirst ? (
                  // The consent line every connect door states where the
                  // click happens (the in-chat card, the app picker): the
                  // API attaches a new account to every agent of the
                  // workspace, not only this one.
                  <>
                    A new account is on for every agent in this workspace, {who}{" "}
                    included, with full access. Adjust access anytime from the
                    agent&apos;s Connections section.
                  </>
                ) : (
                  <>
                    Turn on the {appName} accounts {who} should be able to use.
                    Turning one on grants full access immediately. Adjust access
                    anytime from the agent&apos;s Connections section.
                  </>
                )}
              </DialogDescription>
            )}
          </DialogHeader>
          {isPending ? (
            // role="status": the swap to rows (or the empty state) is
            // announced when this region resolves.
            <div
              role="status"
              className="flex items-center justify-center py-8"
            >
              <Loader2
                className="text-muted-foreground size-5 animate-spin"
                aria-hidden
              />
              <span className="sr-only">Loading connections…</span>
            </div>
          ) : isError ? (
            <div className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border px-4 py-3 text-sm">
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              {/* The alert is the message alone: a live region around the
                  button would re-announce it on every label change. */}
              <span role="alert" className="min-w-0 flex-1">
                Couldn&apos;t load {appName} accounts for this agent.
              </span>
              {/* The way out of the error: refetch what failed (a query that
                  already succeeded is a no-op cache read). */}
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                loading={isRetrying}
                onClick={retry}
              >
                {isRetrying ? "Retrying…" : "Try again"}
              </Button>
            </div>
          ) : pool.length === 0 ? (
            // The Connect state needs no body: its description already says
            // what connecting does, and its footer holds the one action.
            connectFirst ? null : (
              <p className="text-muted-foreground py-4 text-sm">
                No connected {appName} accounts in this workspace yet.
              </p>
            )
          ) : (
            // Bounded like every sibling list dialog (the reflection dialog's
            // exact scroller) — a many-account pool must not outgrow the
            // viewport and strand the top rows or the footer.
            <div className="max-h-[min(24rem,50vh)] min-w-0 divide-y overflow-y-auto overscroll-contain">
              {pool.map((connection) => {
                const grant = grantByConnection.get(connection.id);
                const credential = credentialByConnection.get(connection.id);
                const orgGranted =
                  grant === undefined &&
                  (credential?.provenance.some(
                    (p) => p.scope === "organization",
                  ) ??
                    false);
                return (
                  <ConnectionGrantRow
                    key={connection.id}
                    agentId={agentId}
                    connection={connection}
                    grant={grant}
                    orgGranted={orgGranted}
                    credentialStatus={credential?.status}
                    credentialOrgBlocked={
                      credential?.kind === "connection" && credential.orgBlocked
                    }
                    hasCatalog={hasCatalog}
                    onManage={() => setManageConnection(connection)}
                  />
                );
              })}
            </div>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            {onConnectNew && known && !connectFirst ? (
              // The secondary door beside the list: at least one account
              // exists here, so "another" is true. Hidden until the pool
              // resolves (its label and role are unknown while loading, and
              // a failed load's way forward is Try again). The visible text
              // IS the accessible name (label-in-name).
              <Button variant="outline" onClick={onConnectNew}>
                <Plus className="size-3.5" aria-hidden />
                Connect another account
              </Button>
            ) : (
              <span />
            )}
            {/* The confirm pair reads Cancel, then the primary action on the
                right (the cron and memory dialogs' order). The dismiss
                button keeps its slot across every state, so focus resting on
                it survives the loading swap. Cancel before anything is
                known or done; Done otherwise (never "Close": the corner X
                already carries that name). */}
            <div className="flex justify-end gap-2">
              <Button
                variant={known && !connectFirst ? "default" : "outline"}
                onClick={() => onOpenChange(false)}
              >
                {connectFirst || isPending ? "Cancel" : "Done"}
              </Button>
              {connectFirst && (
                <Button onClick={onConnectNew}>Connect {appName}</Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManagePermissionsDialog
        agentId={agentId}
        connection={manageConnection}
        grant={manageGrant}
        readOnly={manageReadOnly}
        readOnlyReason={manageReadOnlyReason}
        onClose={() => setManageConnection(null)}
      />
    </>
  );
};
