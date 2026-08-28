"use client";

import { memo, useRef, useState } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { AppDefinition } from "@onecli/api/apps/types";
import { Plug, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { AppIcon } from "@/lib/components/app-icon";
import { extractConnectSuggestions } from "@/lib/chat/connect-links";
import { WORKSPACE_PATH_RE, connectionsPath } from "@/lib/navigation";
import { connectPopupHeight, openConnectPopup } from "@/lib/connect-popup";
import { queryKeys } from "@/lib/api/keys";
import { useConnections } from "@/hooks/use-connections";
import { useAgentGrants, useSetConnectionGrant } from "@/hooks/use-grants";
import { useManageConnectionState } from "@/hooks/use-manage-connection-state";
import { useAppMessages } from "@/hooks/use-app-connected";
import { useEffectiveCredentials } from "@/lib/api/policy-visibility";
import type { Connection } from "@/lib/api";
import { ManagePermissionsDialog } from "../../_components/manage-permissions-dialog";
import { AttachConnectionDialog } from "./attach-connection-dialog";
import { ConnectAppPickerDialog } from "../../_components/connect-app-picker-dialog";

/**
 * The chat's rendering of a gateway "connect this app" link — a card in
 * place of a bare URL. The gateway's app_not_connected refusal hands the
 * agent a `connect_url` of the shape `…/connections?connect=<provider>…`;
 * the agent relays it verbatim, and a raw link would bounce the user through
 * the connections page. Detected here instead, and the Connect button opens
 * the OAuth POPUP directly (`openConnectPopup` — the same window the
 * connections page opens), so the user never leaves the chat and the agent
 * retries once the credential lands.
 *
 * The card is STATE-AWARE: once the provider has a connection it flips to
 * "Connected" with Reconnect and Manage (the agent page's own permissions
 * dialog, opened in place, under the same read-only law —
 * `useManageConnectionState`). A connect initiated FROM this card also
 * grants the current agent full access to the new connection automatically —
 * the user asked from this agent's chat, so wiring the agent up is the whole
 * point; scoping down afterwards is exactly what Manage is for.
 */

/** The card under an agent answer that carried connect links. Memoized on
 * the one string prop for the same reason ChatMarkdown is: the thread
 * re-renders on every stream read, and the extraction regex must run only
 * when a turn's text actually changed. Also a thin gate — most turns carry
 * no connect link, and the inner card pulls live queries (connections,
 * grants) that must not run — or demand a QueryClient — for every bubble. */
export const ConnectorSuggestions = memo(({ text }: { text: string }) => {
  const suggestions = extractConnectSuggestions(text);
  if (suggestions.length === 0) return null;
  return <ConnectorSuggestionsCard suggestions={suggestions} />;
});
ConnectorSuggestions.displayName = "ConnectorSuggestions";

const ConnectorSuggestionsCard = ({
  suggestions,
}: {
  suggestions: {
    app: AppDefinition;
    agentName?: string;
    kind: "connect" | "attach";
  }[];
}) => {
  const pathname = usePathname();
  const router = useRouter();
  const workspaceId = pathname.match(WORKSPACE_PATH_RE)?.[1];
  // The agent whose chat this is — the auto-grant target. The chat only
  // renders inside /agents/[agentId], but stay defensive (tests render
  // without a router): no id, no grant.
  const params = useParams<{ agentId?: string }>();
  const agentId = params?.agentId ?? "";
  const { data: connections = [] } = useConnections("workspace");
  // Which connections THIS agent already holds — decides whether the attach
  // row's button says Attach (none of this app's accounts granted yet) or
  // Manage (at least one is; the dialog then adjusts the set). Until the
  // query RESOLVES the card must not claim either way — a cold cache saying
  // "not attached" about an attached app would be a false negative.
  const agentGrantsQuery = useAgentGrants(agentId);
  const attachStateKnown = agentGrantsQuery.isSuccess;
  const grantedConnectionIds = new Set(
    (agentGrantsQuery.data?.connections ?? []).map((g) => g.connectionId),
  );
  // Org-rule-granted connections count as attached too — the same effective
  // read the attach dialog's locked rows use (already fetched per-agent by
  // useManageConnectionState, so this query is a cache hit).
  const { data: effectiveCredentials } = useEffectiveCredentials(agentId);
  const orgGrantedConnectionIds = new Set(
    (effectiveCredentials?.connections ?? [])
      .filter((c) => c.provenance.some((p) => p.scope === "organization"))
      .map((c) => c.id),
  );
  const setGrant = useSetConnectionGrant();
  const [manageConnection, setManageConnection] = useState<Connection | null>(
    null,
  );
  /** Provider whose Attach dialog is open (all of that app's connections,
   * each with an attach toggle for this agent). The provider survives the
   * close (open flips false) so Radix can play the exit animation instead
   * of snap-unmounting. */
  const [attachProvider, setAttachProvider] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Lazy-mount latch for the picker: a chat can carry many of these cards and
  // an unmounted dialog costs nothing, but once opened it must STAY mounted
  // (even closed) so an in-flight popup's landing still reaches its listener.
  const [pickerMounted, setPickerMounted] = useState(false);
  // The same read-only law as the agent page's Apps section: org-granted and
  // org-blocked connections open the dialog read-only, and it must not open
  // before grants resolve (it seeds its tri-state ONCE on open).
  const {
    grant: manageGrant,
    readOnly: manageReadOnly,
    readOnlyReason: manageReadOnlyReason,
    ready: grantsReady,
  } = useManageConnectionState(agentId, manageConnection);
  // Auto-grant only what THIS card initiated: a global message listener also
  // hears popups opened elsewhere (another tab, the connections page).
  const initiated = useRef(new Set<string>());
  const queryClient = useQueryClient();

  // Every popup this card opens goes through here: a blocked popup means no
  // message will ever land, so the claim is released and the user told —
  // the same branch the agent page's picker takes.
  const openPopupOrExplain = (
    provider: string,
    options: Parameters<typeof openConnectPopup>[1],
  ) => {
    const popup = openConnectPopup(provider, options);
    if (!popup) {
      initiated.current.delete(provider);
      toast.error("Popup blocked. Allow popups for this site and try again.");
    }
  };

  useAppMessages({
    onConnected: ({ provider, connectionId }) => {
      if (!provider || !initiated.current.has(provider)) return;
      initiated.current.delete(provider);
      // The pool changed even without a fresh id (the callback dedupes a
      // repeat connect onto the existing account) — refresh the list and the
      // count badges unconditionally, like the picker and connections tabs.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.connections.all(),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
      // Fresh connection from this chat: wire the current agent up with full
      // access. Reconnects carry no connectionId and keep their grants.
      if (connectionId && agentId) {
        setGrant.mutate({
          agentId,
          connectionId,
          input: { access: "full" },
        });
      }
    },
    // The popup reports an app that needs credentials configured before it
    // can connect (no platform defaults). The chat has no config surface, so
    // this is the one action that leaves it — same routing as the
    // connections tabs. Fenced on `initiated` like every claim here: the
    // embedded picker handles its own popups, and N cards on one thread must
    // not all navigate for one event.
    onConfigure: (provider) => {
      if (!initiated.current.has(provider)) return;
      initiated.current.delete(provider);
      router.push(
        connectionsPath({ pathname }, `/apps/${encodeURIComponent(provider)}`),
      );
    },
  });

  const connectionFor = (provider: string): Connection | undefined =>
    connections.find(
      (c) => c.provider === provider && c.status === "connected",
    );
  const hasUnconnected = suggestions.some(
    ({ app }) => connectionFor(app.id) === undefined,
  );

  return (
    <>
      <div className="bg-card max-w-md rounded-xl border">
        <div className="border-b px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Plug className="text-muted-foreground size-4" aria-hidden />
            <span className="text-sm font-medium">Apps that could help</span>
          </div>
          {/* The consent line: connecting from here also wires this agent up
              with full access (the auto-grant above) — said where the click
              happens, not after. */}
          {hasUnconnected && (
            <p className="text-muted-foreground mt-0.5 text-xs">
              Connecting gives this agent full access. Adjust it anytime under
              Manage.
            </p>
          )}
        </div>
        {suggestions.map(({ app, agentName, kind }) => {
          const connection = connectionFor(app.id);
          // Any of this app's accounts already granted to this agent → the
          // attach state is partially satisfied; the button reads Manage and
          // the status line counts what this agent holds. Same pool the
          // dialog shows (status-connected), workspace grants plus
          // org-rule-granted — a count the dialog's rows then agree with.
          const attachedCount = connections.filter(
            (c) =>
              c.provider === app.id &&
              c.status === "connected" &&
              (grantedConnectionIds.has(c.id) ||
                orgGrantedConnectionIds.has(c.id)),
          ).length;
          const anyAttached = attachedCount > 0;
          // An org-shared connection is usable here but not re-authable from
          // a workspace surface — the OAuth callback resolves connectionId in
          // workspace scope and would 404. Reconnect for those lives on the
          // org connections page.
          const reconnectableHere =
            connection &&
            (!connection.scope || connection.scope === "workspace");
          return (
            <div
              key={app.id}
              className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
            >
              <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg border dark:bg-white/10 dark:border-white/10">
                <AppIcon
                  icon={app.icon}
                  darkIcon={app.darkIcon}
                  name={app.name}
                  size={18}
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{app.name}</p>
                {connection ? (
                  kind === "attach" ? (
                    !attachStateKnown ? (
                      // Grants unresolved (or failed): the only honest claim
                      // is the connection's own state.
                      <p className="text-brand text-xs font-medium">
                        Connected
                      </p>
                    ) : anyAttached ? (
                      // Attached since the card rendered (or the poll lagged
                      // the grant): say what this agent holds now — attached
                      // is the accurate word (the count is grants, and a
                      // granted account can be expired).
                      <p className="text-brand text-xs font-medium">
                        {attachedCount} attached account
                        {attachedCount === 1 ? "" : "s"}
                      </p>
                    ) : (
                      // The gateway said access_restricted: an account exists
                      // but THIS agent has no grant — name the actual
                      // problem; Attach beside it is the fix.
                      <p className="text-muted-foreground text-xs">
                        Connected, not attached to this agent
                      </p>
                    )
                  ) : (
                    <p className="text-brand text-xs font-medium">Connected</p>
                  )
                ) : (
                  app.description && (
                    <p className="text-muted-foreground truncate text-xs">
                      {app.description}
                    </p>
                  )
                )}
              </div>
              {connection ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  {kind === "attach" ? (
                    // The problem is the missing grant, so the fix is the
                    // attach dialog: every connection of THIS app, each with
                    // a toggle for this agent. Once at least one account is
                    // attached the same door reads Manage — the job shifts
                    // from "get access" to "adjust which accounts".
                    <Button
                      size="xs"
                      variant={anyAttached ? "ghost" : "default"}
                      aria-label={`${anyAttached ? "Manage" : "Attach"} ${app.name} for this agent`}
                      // Also covers the router-less defensive branch: without
                      // an agentId the grants query never resolves, so the
                      // door (which needs one) stays shut.
                      disabled={!attachStateKnown}
                      onClick={() => {
                        setAttachProvider(app.id);
                        setAttachOpen(true);
                      }}
                    >
                      {anyAttached ? (
                        <>
                          <Settings2 className="size-3.5" aria-hidden />
                          Manage
                        </>
                      ) : (
                        "Attach"
                      )}
                    </Button>
                  ) : (
                    reconnectableHere && (
                      <Button
                        variant="ghost"
                        size="xs"
                        aria-label={`Reconnect ${app.name}`}
                        onClick={() =>
                          openPopupOrExplain(app.id, {
                            connectionId: connection.id,
                            workspaceId,
                            height: connectPopupHeight(app),
                          })
                        }
                      >
                        Reconnect
                      </Button>
                    )
                  )}
                  {/* Manage opens the same dialog Attach does — showing both
                      on an attach row would be two names for one door. */}
                  {kind !== "attach" && (
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={`Manage ${app.name} access`}
                      disabled={!grantsReady}
                      onClick={() => setManageConnection(connection)}
                    >
                      <Settings2 className="size-3.5" aria-hidden />
                      Manage
                    </Button>
                  )}
                </div>
              ) : (
                <Button
                  size="xs"
                  className="shrink-0"
                  aria-label={`Connect ${app.name}`}
                  onClick={() => {
                    initiated.current.add(app.id);
                    openPopupOrExplain(app.id, {
                      agentName,
                      workspaceId,
                      height: connectPopupHeight(app),
                    });
                  }}
                >
                  Connect
                </Button>
              )}
            </div>
          );
        })}
        {/* Fenced like the dialog below: without an agent there is no
            auto-grant contract to offer, so no door either. */}
        {agentId && (
          <div className="text-muted-foreground px-4 py-2 text-xs">
            Looking for something else?{" "}
            <button
              type="button"
              onClick={() => {
                setPickerMounted(true);
                setPickerOpen(true);
              }}
              className="text-foreground cursor-pointer underline underline-offset-2 hover:opacity-80"
            >
              Browse all apps
            </button>
          </div>
        )}
      </div>

      {/* The same agent-scoped picker the Connections section's Add button
          opens — connect any catalog app without leaving the chat; the new
          account is granted to this agent automatically. The card's rows only
          re-render for SUGGESTED providers, so the grant's landing is
          confirmed with a toast instead. */}
      {agentId && pickerMounted && (
        <ConnectAppPickerDialog
          agentId={agentId}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onGranted={() =>
            toast.success("Connected. This agent now has full access.")
          }
        />
      )}

      {agentId && (
        <ManagePermissionsDialog
          agentId={agentId}
          connection={manageConnection}
          grant={manageGrant}
          readOnly={manageReadOnly}
          readOnlyReason={manageReadOnlyReason}
          onClose={() => setManageConnection(null)}
        />
      )}

      {agentId && attachProvider && (
        <AttachConnectionDialog
          key={attachProvider}
          agentId={agentId}
          agentName={
            suggestions.find((s) => s.app.id === attachProvider)?.agentName
          }
          provider={attachProvider}
          open={attachOpen}
          onOpenChange={(open) => {
            if (!open) setAttachOpen(false);
          }}
          onConnectNew={() => {
            // Same claim + popup path as the card's Connect button — same
            // options too (agentName rides to the landing page's copy) — so
            // the landing auto-grants this agent and refreshes the pool.
            const suggestion = suggestions.find(
              (s) => s.app.id === attachProvider,
            );
            initiated.current.add(attachProvider);
            openPopupOrExplain(attachProvider, {
              agentName: suggestion?.agentName,
              workspaceId,
              ...(suggestion && {
                height: connectPopupHeight(suggestion.app),
              }),
            });
          }}
        />
      )}
    </>
  );
};
