"use client";

import { Label } from "@onecli/ui/components/label";
import { Checkbox } from "@onecli/ui/components/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { cn } from "@onecli/ui/lib/utils";
import { getApp } from "@onecli/api/apps/registry";
import { AppSelect } from "./app-select";
import { AppToolsPicker } from "./app-tools-picker";
import { TeamBadge } from "@/lib/components/team-badge";
// Edition seam: EE aliases to the real granular resource editor; the OSS
// module is a locked "available on OneCLI Cloud" hint. Alias key on purpose —
// a relative import would bypass turbopack resolveAlias in EE builds.
import { ResourceScopeFields } from "@/lib/policy-editor/resource-scope";
import type { Connection } from "@/lib/api";

/** Display name for the locked callout; falls back to the raw id. */
const providerName = (id: string): string => getApp(id)?.name ?? id;

/** The App target's editable state. A rule's App target is authored one of two
 * ways: `specific` connections (→ `connection` targets) or `all` connections at a
 * level (→ an `app` target with a `connectionScope`). */
export interface AppTargetState {
  provider: string;
  mode: "specific" | "all";
  connectionIds: string[];
  /** Only meaningful for `mode === "all"`; the org/project level to inject. */
  level: "organization" | "project";
  /** The catalog tool ids the rule is narrowed to ([] = the whole app), in
   * BOTH modes — "all connections" and specific connection(s). Tools narrow
   * which endpoints the rule matches; injection is unaffected. */
  tools: string[];
  /** Granular per-resource scoping (repos/folders) for a SINGLE specific
   * connection — the rule's session-policy `conditions`. null = the whole
   * connection (all resources). Only meaningful when exactly one connection is
   * selected and its provider supports granular scoping. */
  sessionPolicy: Record<string, unknown> | null;
}

export interface AppTargetFieldsProps {
  value: AppTargetState;
  onChange: (next: AppTargetState) => void;
  /** Connections available at the rule's scope (already level-filtered by the
   * scope-aware `useConnections`). */
  connections: Connection[];
  /** An ORG rule may choose the injection level (org or project); a PROJECT rule
   * is fixed to its own project. */
  isOrgRule: boolean;
  /** The rule's action. Granular resource scoping only applies to an Allow (a
   * Block injects nothing, so a session policy would be silently inert), so the
   * Resources picker is shown only when this is `"allow"`. */
  action: "allow" | "block";
  /** Whether the rule carries behavioral (body-contains) conditions. A rule's
   * `conditions` is EITHER behavioral OR a session policy — never both — so the
   * Resources picker is hidden while behavioral conditions are present (else
   * authoring a session policy would silently discard them). */
  hasBehavioralConditions: boolean;
  /** The selected provider is a cloud-only app this edition can't connect
   * (OSS's EE-stub registry entries). The dead sub-fields (connections, tools,
   * resources) are replaced by a locked callout, and the form locks the save. */
  cloudLocked: boolean;
  showError: boolean;
  error: string | null;
}

/**
 * The App target authoring surface: pick a provider, then either specific
 * connection(s) of it, or "all connections" at a chosen level (an org rule can
 * reach down to project-level connections; a project rule is project-only).
 * On an allow rule the target permits the app's traffic (its catalog hosts)
 * and injects the chosen connections; on a block rule it blocks the app's
 * traffic. Mirrors {@link SecretTargetFields}.
 */
export const AppTargetFields = ({
  value,
  onChange,
  connections,
  isOrgRule,
  action,
  hasBehavioralConditions,
  cloudLocked,
  showError,
  error,
}: AppTargetFieldsProps) => {
  // The provider picker (AppSelect) lists the app CATALOG, not existing
  // connections — an "all connections at a level" rule must be authorable for an
  // app with no connection at the current scope. Connections only feed the
  // specific-mode checkboxes below.
  const providerConnections = connections.filter(
    (c) => c.provider === value.provider,
  );
  // Granular per-resource scoping is authored for a SINGLE specific connection
  // (matches the per-connection session-policy model).
  const singleConnection =
    value.mode === "specific" && value.connectionIds.length === 1
      ? providerConnections.find((c) => c.id === value.connectionIds[0])
      : undefined;

  const toggleConnection = (id: string, checked: boolean) => {
    const next = checked
      ? [...value.connectionIds, id]
      : value.connectionIds.filter((c) => c !== id);
    // Any change to the selection invalidates the session policy — it scopes ONE
    // specific connection and is authored per-connection via ResourceScopeFields.
    onChange({ ...value, connectionIds: next, sessionPolicy: null });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="rule-app-provider">Provider</Label>
        <AppSelect
          id="rule-app-provider"
          value={value.provider}
          // Changing provider clears the connection + tool selections AND the
          // session policy (all three are provider-specific).
          onChange={(provider) =>
            onChange({
              ...value,
              provider,
              connectionIds: [],
              tools: [],
              sessionPolicy: null,
            })
          }
          invalid={showError && !value.provider}
        />
      </div>

      {/* A cloud-only app (this edition can't connect it): the sub-fields
          below would author a dead rule, so they're replaced by the locked
          callout and the form locks the save. House pattern: the
          condition-builder OSS stub's dashed card. */}
      {cloudLocked ? (
        // role="status": the callout appears dynamically when a cloud-only app
        // is picked (and the Save button leaves the tab order), so announce it.
        <div
          role="status"
          className="flex items-center gap-2.5 rounded-md border border-dashed px-3 py-2.5"
        >
          <TeamBadge />
          <p className="text-muted-foreground text-xs">
            {providerName(value.provider)} connections are available on{" "}
            <a
              href="https://app.onecli.sh"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              OneCLI Cloud
            </a>
            .
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="rule-app-mode">Connections</Label>
            <Select
              value={value.mode}
              onValueChange={(mode) =>
                onChange({
                  ...value,
                  mode: mode === "all" ? "all" : "specific",
                  // Session policy is per-connection; the connection context changes
                  // with the mode, so drop it.
                  sessionPolicy: null,
                })
              }
            >
              <SelectTrigger id="rule-app-mode" className="w-full bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="specific">Specific connection(s)</SelectItem>
                <SelectItem value="all">All connections</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {value.mode === "specific" ? (
            <fieldset className="space-y-2 rounded-lg border bg-card p-3">
              <legend className="px-1 text-xs text-muted-foreground">
                These connections
              </legend>
              {providerConnections.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {value.provider
                    ? "No connections for this app in this scope."
                    : "Pick an app first."}
                </p>
              ) : (
                providerConnections.map((c) => {
                  const id = `conn-${c.id}`;
                  return (
                    <div key={c.id} className="flex items-center gap-2">
                      <Checkbox
                        id={id}
                        checked={value.connectionIds.includes(c.id)}
                        onCheckedChange={(checked) =>
                          toggleConnection(c.id, checked === true)
                        }
                      />
                      <Label htmlFor={id} className="font-normal">
                        {c.label ?? c.id}
                      </Label>
                    </div>
                  );
                })
              )}
            </fieldset>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="rule-app-level">At level</Label>
              {isOrgRule ? (
                <Select
                  value={value.level}
                  onValueChange={(level) =>
                    onChange({
                      ...value,
                      level:
                        level === "organization" ? "organization" : "project",
                    })
                  }
                >
                  <SelectTrigger id="rule-app-level" className="w-full bg-card">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="organization">
                      Organization connections
                    </SelectItem>
                    <SelectItem value="project">
                      Project connections (each project uses its own)
                    </SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  All of this project&apos;s {value.provider || "app"}{" "}
                  connections.
                </p>
              )}
            </div>
          )}

          {/* Granular resource scoping applies only to an Allow (a Block injects
          nothing) and is mutually exclusive with behavioral conditions (a rule's
          `conditions` is one or the other), so it's hidden while those exist. */}
          {singleConnection &&
            action === "allow" &&
            !hasBehavioralConditions && (
              <ResourceScopeFields
                connection={singleConnection}
                policy={value.sessionPolicy}
                onChange={(sessionPolicy) =>
                  onChange({ ...value, sessionPolicy })
                }
              />
            )}

          {value.provider && (
            <div className="space-y-1.5">
              <Label htmlFor="rule-app-tools">Tools</Label>
              <AppToolsPicker
                id="rule-app-tools"
                provider={value.provider}
                value={value.tools}
                onChange={(tools) => onChange({ ...value, tools })}
              />
              <p className="text-xs text-muted-foreground">
                Empty covers the whole app; narrow to specific tools to limit
                which operations this rule matches.
              </p>
            </div>
          )}
        </>
      )}

      {showError && error && (
        <p className={cn("text-xs text-destructive")} role="alert">
          {error}
        </p>
      )}
    </div>
  );
};
