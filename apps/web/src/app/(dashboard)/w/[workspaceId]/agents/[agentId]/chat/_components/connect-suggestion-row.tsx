"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { githubOrgAccessStatus } from "@onecli/api/lib/github-org-access";
import type { CardSuggestion } from "@/lib/chat/connect-links";
import type { ConnectRowState } from "@/lib/chat/connect-row-state";
import type { Connection } from "@/lib/api";
import { connectionsPath } from "@/lib/navigation";
import { ConnectCardRow } from "./connect-card-row";

/** An org-shared connection is usable here but not re-authorizable from a
 * workspace surface: the OAuth callback resolves the connection in
 * workspace scope and would 404. Its reconnect lives on the org page. */
const reconnectableHere = (connection: Connection) =>
  !connection.scope || connection.scope === "workspace";

/**
 * One suggested app on the chat's connect card, in the state
 * `resolveConnectRow` decided for THIS agent. Exactly one action per row:
 *
 * - `connect` → Connect (the OAuth popup, carrying this agent)
 * - `not_attached` → Attach (the attach dialog: this app's accounts, each
 *   with a switch for this agent)
 * - `attached` → Manage (one account: its permissions dialog; several, or
 *   an attach row: the attach dialog, which lists each)
 * - `needs_reconnect` → Reconnect (re-authorize that account)
 * - `org_access` → Fix Access (the organization's fix steps)
 * - `unknown` → no action until this agent's access resolves: a door whose
 *   label could still flip between Attach and Manage would lie either way.
 *   A failed read offers Try again instead.
 *
 * A healthy account offers no Reconnect: re-authorizing a working login is
 * not a next step, and the Manage dialog and the agent's Connections page
 * both keep it for the rare case it is wanted.
 */
export const ConnectSuggestionRow = ({
  suggestion: { app, kind },
  state,
  pathname,
  manageReady,
  retrying,
  onConnect,
  onReconnect,
  onAttach,
  onManage,
  onRetry,
}: {
  suggestion: CardSuggestion;
  state: ConnectRowState;
  /** The current route, for the Fix Access link's workspace. */
  pathname: string;
  /** The permissions dialog seeds once on open: gate Manage on its data. */
  manageReady: boolean;
  /** A Try again is in flight. */
  retrying: boolean;
  onConnect: () => void;
  onReconnect: (connectionId: string) => void;
  onAttach: () => void;
  onManage: (connectionId: string) => void;
  /** Refetch whatever failed to say what this agent holds. */
  onRetry: () => void;
}) => {
  const row = (status: ReactNode, action?: ReactNode) => (
    <ConnectCardRow
      icon={app.icon}
      darkIcon={app.darkIcon}
      name={app.name}
      status={status}
      action={action}
    />
  );
  const manageButton = (
    label: string,
    onClick: () => void,
    disabled = false,
  ) => (
    <Button
      variant="outline"
      size="xs"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Settings2 aria-hidden />
      Manage
    </Button>
  );

  switch (state.type) {
    case "org_access":
      return row(
        <span className="font-medium text-amber-700 dark:text-amber-400">
          <span translate="no">{state.issue.org}</span> &middot;{" "}
          {githubOrgAccessStatus(state.issue.reason)}
        </span>,
        <Button size="xs" asChild>
          <Link
            aria-label={`Fix ${app.name} access for ${state.issue.org}`}
            href={connectionsPath(
              { pathname },
              `/apps/${encodeURIComponent(app.id)}?org_access=${encodeURIComponent(state.issue.org)}`,
            )}
          >
            Fix Access
          </Link>
        </Button>,
      );

    case "needs_reconnect": {
      const { connection } = state;
      return row(
        <span className="text-destructive font-medium">
          Needs reconnect
          {connection.label && (
            <span translate="no"> &middot; {connection.label}</span>
          )}
        </span>,
        reconnectableHere(connection) ? (
          <Button
            size="xs"
            aria-label={`Reconnect ${app.name}`}
            onClick={() => onReconnect(connection.id)}
          >
            <RefreshCw aria-hidden />
            Reconnect
          </Button>
        ) : (
          <span className="text-muted-foreground text-xs">
            Ask an org admin to reconnect
          </span>
        ),
      );
    }

    case "connect":
      return row(
        <span className="text-muted-foreground">{app.description}</span>,
        <Button
          size="xs"
          aria-label={`Connect ${app.name}`}
          onClick={onConnect}
        >
          Connect
        </Button>,
      );

    case "unknown":
      return state.failed
        ? row(
            <span className="text-muted-foreground">
              Couldn&apos;t check access
            </span>,
            <Button
              variant="outline"
              size="xs"
              aria-label={`${retrying ? "Retrying" : "Try again"} for ${app.name}`}
              loading={retrying}
              onClick={onRetry}
            >
              {retrying ? "Retrying…" : "Try again"}
            </Button>,
          )
        : row(<span className="text-muted-foreground">Checking access…</span>);

    case "not_attached":
      return row(
        <span className="text-muted-foreground">
          Connected, not attached to this agent
        </span>,
        <Button
          size="xs"
          aria-label={`Attach ${app.name} for this agent`}
          onClick={onAttach}
        >
          Attach
        </Button>,
      );

    case "attached": {
      const count = state.connections.length;
      // The gateway said this agent lacked a grant: the count of what it
      // holds now is the answer, and the door stays the attach dialog.
      if (kind === "attach") {
        return row(
          <span className="text-brand font-medium">
            {count} attached account{count === 1 ? "" : "s"}
          </span>,
          manageButton(`Manage ${app.name} for this agent`, onAttach),
        );
      }
      if (count > 1) {
        return row(
          <span className="text-brand font-medium">
            Connected &middot; {count} accounts
          </span>,
          manageButton(`Manage ${app.name} for this agent`, onAttach),
        );
      }
      const { primary } = state;
      return row(
        <>
          <span className="text-brand font-medium">Connected</span>
          {primary.label && (
            <span className="text-muted-foreground" translate="no">
              {" "}
              &middot; {primary.label}
            </span>
          )}
        </>,
        manageButton(
          `Manage ${app.name} access`,
          () => onManage(primary.id),
          !manageReady,
        ),
      );
    }
    default: {
      // A new ConnectRowState variant must get a row here: this fails to
      // compile until it does, instead of silently rendering nothing.
      const unhandled: never = state;
      return unhandled;
    }
  }
};
