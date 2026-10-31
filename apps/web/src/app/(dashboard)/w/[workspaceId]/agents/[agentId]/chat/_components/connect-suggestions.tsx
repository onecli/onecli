"use client";

import { memo, useRef, useState } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import {
  extractConnectSuggestions,
  type CardSuggestion,
} from "@/lib/chat/connect-links";
import { resolveConnectRow, type Known } from "@/lib/chat/connect-row-state";
import {
  WORKSPACE_PATH_RE,
  agentSectionPath,
  connectionsPath,
} from "@/lib/navigation";
import { withConnectLinkAgent } from "@/lib/connect-link-agent";
import { connectPopupHeight, openConnectPopup } from "@/lib/connect-popup";
import { queryKeys } from "@/lib/api/keys";
import { useConnections } from "@/hooks/use-connections";
import { useAgentGrants, useInvalidateGrants } from "@/hooks/use-grants";
import { useAppPermissionDefinitions } from "@/hooks/use-app-permissions";
import { defaultGrantConsentForAll } from "@/lib/api/default-grant";
import { useManageConnectionState } from "@/hooks/use-manage-connection-state";
import { useAppMessages } from "@/hooks/use-app-connected";
import { useEffectiveCredentials } from "@/lib/api/policy-visibility";
import type { Connection } from "@/lib/api";
import { ManagePermissionsDialog } from "../../_components/manage-permissions-dialog";
import { AttachConnectionDialog } from "../../_components/attach-connection-dialog";
import { ConnectAppPickerDialog } from "../../_components/connect-app-picker-dialog";
import { ConnectCardRow } from "./connect-card-row";
import { ConnectSuggestionRow } from "./connect-suggestion-row";

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
 * The card is STATE-AWARE, and the state is THIS agent's
 * (`resolveConnectRow`): an app reads "Connected" only once this agent
 * holds one of its accounts (a workspace grant or an organization rule),
 * with Manage (the agent page's own permissions dialog, opened in place,
 * under the same read-only law: `useManageConnectionState`). An account the
 * workspace holds but this agent does not reads "Connected, not attached to
 * this agent" with Attach: a new connection is no longer on for every
 * agent, so the workspace pool alone says nothing about this one. A
 * connect started FROM this card carries this agent, so the new account
 * lands switched on for it alone (the API's connecting-agent grant), with
 * the same default and the same consent line as the "Connect an app"
 * picker; scoping down afterwards is exactly what Manage is for.
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

/** The card itself, for callers that already know which apps to offer (the
 * empty-thread greeting). Same buttons, same popup. */
export interface ChannelSuggestion {
  id: string;
  name: string;
  icon: string;
  label: string;
}

/** Hoisted so the default is one stable identity — a fresh `[]` per render
 * is the classic way to defeat a memo on a caller. */
const NO_CHANNEL_SUGGESTIONS: ChannelSuggestion[] = [];

export const ConnectorSuggestionsCard = ({
  suggestions,
  channels = NO_CHANNEL_SUGGESTIONS,
  hideHeader = false,
  bare = false,
}: {
  suggestions: CardSuggestion[];
  /** Chat-app rows ("talk to this agent on Slack"). A channel is a bot
   * install on the agent's Channels page, not an OAuth credential (Slack is
   * no longer in the app registry at all), so these rows carry their own
   * name/icon and link there instead of opening the connect popup. */
  channels?: ChannelSuggestion[];
  /** Drop the "Apps that could help" header. The greeting already says why
   * the card is there, so the header would repeat it. */
  hideHeader?: boolean;
  /** Just the app rows: no consent line, no "browse all apps" footer. The
   * onboarding greeting's single Gmail row, where the message above it
   * already says what to do (its own "Add different tools" button is the
   * catalog door there). */
  bare?: boolean;
}) => {
  const pathname = usePathname();
  const router = useRouter();
  const workspaceId = pathname.match(WORKSPACE_PATH_RE)?.[1];
  // The agent whose chat this is, whose attach state the rows show. The chat
  // only renders inside /agents/[agentId], but stay defensive (tests render
  // without a router): no id, no agent-scoped dialogs.
  const params = useParams<{ agentId?: string }>();
  const agentId = params?.agentId ?? "";
  const connectionsQuery = useConnections("workspace");
  const connections = connectionsQuery.data ?? [];
  // Which connections THIS agent holds: its workspace grants, plus what an
  // organization rule grants it (the same effective read the attach
  // dialog's locked rows use; useManageConnectionState fetches it per agent
  // too, so this is a cache hit). It decides every row's state, so until
  // BOTH resolve the card claims neither "attached" nor "not attached": a
  // cold cache saying either about the other would be a false claim.
  const agentGrantsQuery = useAgentGrants(agentId);
  const effectiveCredentialsQuery = useEffectiveCredentials(agentId);
  const pool: Known<readonly Connection[]> = connectionsQuery.isSuccess
    ? connectionsQuery.data
    : connectionsQuery.isError
      ? "failed"
      : "pending";
  const held: Known<ReadonlySet<string>> =
    agentGrantsQuery.isSuccess && effectiveCredentialsQuery.isSuccess
      ? new Set([
          ...agentGrantsQuery.data.connections.map((g) => g.connectionId),
          ...effectiveCredentialsQuery.data.connections
            .filter((c) => c.provenance.some((p) => p.scope === "organization"))
            .map((c) => c.id),
        ])
      : agentGrantsQuery.isError || effectiveCredentialsQuery.isError
        ? "failed"
        : "pending";
  // The way out of a failed read: refetch only what failed (a query that
  // already succeeded would be a needless round trip).
  const failedQueries = [
    connectionsQuery,
    agentGrantsQuery,
    effectiveCredentialsQuery,
  ].filter((q) => q.isError);
  const retrying = failedQueries.some((q) => q.isFetching);
  const retry = () => {
    for (const q of failedQueries) void q.refetch();
  };
  // The id, not a snapshot: the dialog reads the live row, so a reconnect
  // from inside it (which refetches the list) shows the refreshed grant.
  const [manageId, setManageId] = useState<string | null>(null);
  const manageConnection = connections.find((c) => c.id === manageId) ?? null;
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
  // React only to what THIS card initiated: a global message listener also
  // hears popups opened elsewhere (another tab, the connections page).
  const initiated = useRef(new Set<string>());
  const queryClient = useQueryClient();
  const invalidateGrants = useInvalidateGrants();

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

  // Re-authorize one existing account in place. Claimed like a connect, so
  // its landing refreshes the list and a cleared needs-reconnect flag shows.
  const reconnect = (app: CardSuggestion["app"], connectionId: string) => {
    initiated.current.add(app.id);
    openPopupOrExplain(app.id, {
      connectionId,
      workspaceId,
      height: connectPopupHeight(app),
    });
  };

  useAppMessages({
    onConnected: ({ provider }) => {
      if (!provider || !initiated.current.has(provider)) return;
      initiated.current.delete(provider);
      // The pool changed even without a fresh id (the callback dedupes a
      // repeat connect onto the existing account), and either way it arrives
      // switched on for this agent: refresh the list, the grant views (this
      // card's Attach/Manage state) and the count badges.
      invalidateGrants();
      void queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
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
      // The connect that follows the setup is still this agent's.
      router.push(
        withConnectLinkAgent(
          connectionsPath(
            { pathname },
            `/apps/${encodeURIComponent(provider)}`,
          ),
          agentId,
        ),
      );
    },
  });

  // Every row's state, decided once per render for THIS agent.
  const rows = suggestions.map((suggestion) => ({
    suggestion,
    state: resolveConnectRow({
      provider: suggestion.app.id,
      kind: suggestion.kind,
      connectionId: suggestion.connectionId,
      org: suggestion.org,
      connections: pool,
      heldConnectionIds: held,
    }),
  }));
  // The consent line belongs to the Connect clicks only: what a NEW account
  // may do, said where that click happens.
  const toConnect = rows.filter(({ state }) => state.type === "connect");
  const hasUnconnected = toConnect.length > 0;
  // What connecting grants, said only once the catalog is known (a loading
  // catalog must not read as "full access" or as "needs approval").
  const { data: definitions, isSuccess: definitionsKnown } =
    useAppPermissionDefinitions();
  const grantLine = definitionsKnown
    ? ` ${defaultGrantConsentForAll(
        toConnect.map(({ suggestion }) =>
          (definitions ?? []).find((d) => d.provider === suggestion.app.id),
        ),
      )}`
    : "";

  const openAttach = (provider: string) => {
    setAttachProvider(provider);
    setAttachOpen(true);
  };

  return (
    <>
      {/* Full width up to the cap, so the card keeps one size across states
          instead of shrinking to its longest line; `text-start` so a
          centered host (the empty-thread welcome) never centers its rows. */}
      <div className="bg-card w-full max-w-md divide-y overflow-hidden rounded-xl border text-start">
        {/* The TITLE is what `hideHeader` drops (the greeting's own words
            already say why the card is there). The CONSENT LINE is not part
            of that trade: what a new account may do has to be said where the
            click happens. Most of all on the greeting card, which is the
            first connect UI a new user ever meets. */}
        {!bare && (!hideHeader || hasUnconnected) && (
          <div className="px-4 py-2.5">
            {!hideHeader && (
              <div className="flex items-center gap-2">
                <Plug className="text-muted-foreground size-4" aria-hidden />
                <span className="text-sm font-medium">
                  Apps that could help
                </span>
              </div>
            )}
            {hasUnconnected && (
              <p
                className={cn(
                  "text-muted-foreground text-xs text-pretty",
                  !hideHeader && "mt-0.5",
                )}
              >
                Only this agent gets access.{grantLine}
              </p>
            )}
          </div>
        )}
        {rows.map(({ suggestion, state }) => (
          <ConnectSuggestionRow
            key={suggestion.app.id}
            suggestion={suggestion}
            state={state}
            pathname={pathname}
            manageReady={grantsReady}
            retrying={retrying}
            onRetry={retry}
            onConnect={() => {
              initiated.current.add(suggestion.app.id);
              openPopupOrExplain(suggestion.app.id, {
                agentName: suggestion.agentName,
                agentId,
                workspaceId,
                height: connectPopupHeight(suggestion.app),
              });
            }}
            onReconnect={(connectionId) =>
              reconnect(suggestion.app, connectionId)
            }
            // The attach dialog needs an agent; without one (the defensive
            // router-less render) its row stays in the unknown state anyway,
            // since this agent's grants never resolve.
            onAttach={() => openAttach(suggestion.app.id)}
            onManage={setManageId}
          />
        ))}
        {channels.map(({ id, name, icon, label }) => (
          <ConnectCardRow
            key={`channel-${id}`}
            icon={icon}
            name={name}
            status={<span className="text-muted-foreground">{label}</span>}
            action={
              agentId ? (
                <Button
                  size="xs"
                  aria-label={`Set up ${name} for this agent`}
                  onClick={() =>
                    router.push(agentSectionPath(pathname, agentId, "channels"))
                  }
                >
                  Set up
                </Button>
              ) : undefined
            }
          />
        ))}
        {/* Fenced like the dialog below: without an agent there is no
            auto-grant contract to offer, so no door either. */}
        {agentId && !bare && (
          <div className="bg-muted/40 text-muted-foreground px-4 py-2.5 text-xs">
            Looking for something else?{" "}
            <button
              type="button"
              onClick={() => {
                setPickerMounted(true);
                setPickerOpen(true);
              }}
              className="text-foreground focus-visible:ring-ring/50 cursor-pointer rounded-sm font-medium underline underline-offset-2 outline-none hover:opacity-80 focus-visible:ring-[3px]"
            >
              Browse all apps
            </button>
          </div>
        )}
      </div>

      {/* The same agent-scoped picker the Connections section's Add button
          opens, to connect any catalog app without leaving the chat. The
          card's rows only re-render for SUGGESTED providers, so the landing
          is confirmed with a toast instead. */}
      {agentId && pickerMounted && (
        <ConnectAppPickerDialog
          agentId={agentId}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onConnected={() => toast.success("Connected and on for this agent.")}
        />
      )}

      {agentId && (
        <ManagePermissionsDialog
          agentId={agentId}
          connection={manageConnection}
          grant={manageGrant}
          readOnly={manageReadOnly}
          readOnlyReason={manageReadOnlyReason}
          onClose={() => setManageId(null)}
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
            // the landing refreshes the pool and this agent's grants.
            const suggestion = suggestions.find(
              (s) => s.app.id === attachProvider,
            );
            initiated.current.add(attachProvider);
            openPopupOrExplain(attachProvider, {
              agentName: suggestion?.agentName,
              agentId,
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
