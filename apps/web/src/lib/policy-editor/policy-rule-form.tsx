"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  Gauge,
  Globe,
  Hand,
  KeyRound,
  ShieldBan,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import { Switch } from "@onecli/ui/components/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@onecli/ui/components/sheet";
import { cn } from "@onecli/ui/lib/utils";
import type {
  Connection,
  PageScope,
  PolicyRuleV2,
  ProjectionIdentity,
} from "@/lib/api";
import type {
  CreatePolicyRuleInput,
  UpdatePolicyRuleInput,
} from "@/lib/api/policy";
import { useCreatePolicyRule, useUpdatePolicyRule } from "@/hooks/use-policy";
import { useAgents } from "@/hooks/use-agents";
import { useConnections } from "@/hooks/use-connections";
import { useScopedSecrets } from "@/hooks/use-secrets";
// The condition builder + org identity picker are edition seams: EE aliases
// them to the real editors; the OSS modules are locked "available in OneCLI
// Cloud" surfaces (conditions) or inert (the org picker — OSS mounts no org
// scope).
import { ConditionBuilder } from "@/lib/components/condition-builder";
// Alias key on purpose (see editor-chrome's note): a relative import would
// bypass the edition seam.
import {
  IdentityLockHint,
  OrgIdentityPicker,
} from "@/lib/policy-editor/identity-picker";
import { RULE_SHEET_DESCRIPTION } from "@/lib/policy-editor/publish-mode";
import {
  AppTargetFields,
  type AppTargetState,
} from "./_components/app-target-fields";
import { isCloudOnlyApp } from "./_components/app-select";
import {
  SecretTargetFields,
  type SecretTargetState,
} from "./_components/secret-target-fields";
import type { RuleCondition } from "@onecli/api/validations/policy-rule";
import {
  isSessionPolicy,
  type PolicyTargetInput,
} from "@onecli/api/validations/policy";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const ANY_METHOD = "_any";
const ALL_AGENTS = "_all";

// The target kinds this editor authors. "App" fronts both specific connection
// targets and an "all connections at a level" app target (step 8); "Secret" names
// a credential; "Network" is a raw host/path rule.
type TargetKind = "network" | "app" | "secret";

/** The form's target state, flattened from a rule's target rows. */
interface DerivedTarget {
  kind: TargetKind;
  hostPattern: string;
  pathPattern: string;
  method: string;
  app: AppTargetState;
  secret: SecretTargetState;
  /** The rule's targets can't be faithfully round-tripped by this single-kind
   * form (they span >1 kind, or a shape it can't represent) — the editor then
   * preserves them untouched on save rather than truncating. */
  locked: boolean;
}

const emptyDerived = (): DerivedTarget => ({
  // New rules default to the App target — the most common kind to author.
  kind: "app",
  hostPattern: "",
  pathPattern: "",
  method: ANY_METHOD,
  app: {
    provider: "",
    mode: "specific",
    connectionIds: [],
    level: "project",
    tools: [],
    sessionPolicy: null,
  },
  secret: { mode: "specific", secretIds: [], level: "project" },
  locked: false,
});

/** The DTO types a rule's `conditions` as a behavioral array, but a granular
 * session policy is stored as an object. Narrow via the shared `isSessionPolicy`
 * predicate (so the object/array split can't drift from the API) and adapt to the
 * form's state shape — the single cast the DTO's array type can't otherwise
 * express. */
const conditionsAsSessionPolicy = (
  c: unknown,
): Record<string, unknown> | null =>
  isSessionPolicy(c) ? (c as Record<string, unknown>) : null;

/** Whether the single-kind form can faithfully round-trip a rule's targets. It
 * can't when they span more than one kind family (network / app+connection /
 * secret), or a within-family shape it doesn't model: an app-permission app
 * target (no `connectionScope`), >1 network/app target, an app+connection mix, or
 * a secret specific+"all" mix. Load-independent (reads only kinds + which
 * scope/id fields are set), so it holds before connections resolve. Only
 * reachable for API/CLI/SDK-authored rules — the editor only ever writes one
 * representable kind. */
const isUnrepresentable = (targets: PolicyRuleV2["targets"]): boolean => {
  const family = (kind: string) => (kind === "connection" ? "app" : kind);
  const families = new Set(targets.map((t) => family(t.kind)));
  const appTargets = targets.filter((t) => t.kind === "app");
  const connTargets = targets.filter((t) => t.kind === "connection");
  const netTargets = targets.filter((t) => t.kind === "network");
  const secretScoped = targets.filter(
    (t) => t.kind === "secret" && t.secretScope != null,
  );
  const secretSpecific = targets.filter(
    (t) => t.kind === "secret" && t.secretId != null,
  );
  // The specific-mode form authors ONE tool set shared across all the rule's
  // connection targets. Rows carrying DIFFERENT tool sets (API/CLI-authored)
  // can't be represented by the single picker → lock + preserve.
  const connToolSigs = new Set(
    connTargets.map((t) =>
      t.kind === "connection" ? [...t.tools].sort().join(",") : "",
    ),
  );
  return (
    families.size > 1 ||
    netTargets.length > 1 ||
    appTargets.length > 1 ||
    appTargets.some((t) => t.kind === "app" && t.connectionScope == null) ||
    (appTargets.length > 0 && connTargets.length > 0) ||
    connToolSigs.size > 1 ||
    secretScoped.length > 1 ||
    (secretScoped.length > 0 && secretSpecific.length > 0)
  );
};

/** Flatten a rule's target rows into the editable form state. An `app` target
 * with a `connectionScope` → App/all; `connection` rows → App/specific (its
 * provider inferred from the loaded connections); a `secret` → Secret; a
 * `network` → Network. A rule the form can't faithfully represent is `locked`
 * (its targets are preserved untouched on save). */
const deriveTarget = (
  rule: PolicyRuleV2 | null,
  connections: Connection[],
): DerivedTarget => {
  const base = emptyDerived();
  const targets = rule?.targets ?? [];
  const connTargets = targets.flatMap((t) =>
    t.kind === "connection" ? [t.connectionId] : [],
  );
  // All the rule's connection targets share one tool set (the form authors it
  // that way; non-uniform sets are locked by `isUnrepresentable`), so read it
  // off the first connection target.
  const connTools = targets.find((t) => t.kind === "connection")?.tools ?? [];
  // The specific-mode form scopes the tools picker + connection checkboxes to a
  // SINGLE provider and cross-applies one tool set to every connection target.
  // An API-authored rule whose connections span >1 provider can't be edited
  // safely (a save would cross-write provider-0's tools to the others) — lock
  // it. Load-dependent (needs the connections list); dialog-authored rules are
  // always single-provider, so this only fires on API/CLI rows.
  const connProviders = new Set(
    connTargets
      .map((id) => connections.find((c) => c.id === id)?.provider)
      .filter((p): p is string => !!p),
  );
  // Lock when the form can't faithfully represent the rule's targets. An EXISTING
  // rule with no targets is inert — a non-default rule with empty targets now
  // matches NOTHING (fail-closed), typically an orphan whose sole target was
  // deleted (authoring new empty-target rules is blocked API-side). This
  // single-kind form can't express it (it always authors one concrete target), so
  // lock it to preserve it untouched. Edit-only: the CREATE form also starts
  // target-less but must stay editable.
  const locked =
    isUnrepresentable(targets) ||
    (rule !== null && targets.length === 0) ||
    connProviders.size > 1;
  const appAll = targets.find(
    (t) => t.kind === "app" && t.connectionScope != null,
  );
  const secretAll = targets.find(
    (t) => t.kind === "secret" && t.secretScope != null,
  );
  const secretSpecific = targets.flatMap((t) =>
    t.kind === "secret" && t.secretId != null ? [t.secretId] : [],
  );
  const networkT = targets.find((t) => t.kind === "network");

  if (appAll && appAll.kind === "app" && appAll.connectionScope) {
    return {
      ...base,
      locked,
      kind: "app",
      app: {
        provider: appAll.provider,
        mode: "all",
        connectionIds: [],
        level: appAll.connectionScope,
        // Read the tool narrowing back so an edit re-checks the same tools;
        // empty = the whole app.
        tools: appAll.tools ?? [],
        // "All connections" has no single-connection resource scope.
        sessionPolicy: null,
      },
    };
  }
  if (connTargets.length > 0) {
    const provider =
      connections.find((c) => c.id === connTargets[0])?.provider ?? "";
    return {
      ...base,
      locked,
      kind: "app",
      app: {
        provider,
        mode: "specific",
        connectionIds: connTargets,
        level: "project",
        tools: connTools,
        // A SINGLE connection's object conditions are its granular session policy;
        // multi-connection / behavioral-array conditions carry no resource scope.
        sessionPolicy:
          connTargets.length === 1
            ? conditionsAsSessionPolicy(rule?.conditions)
            : null,
      },
    };
  }
  if (secretAll && secretAll.kind === "secret" && secretAll.secretScope) {
    return {
      ...base,
      locked,
      kind: "secret",
      secret: { mode: "all", secretIds: [], level: secretAll.secretScope },
    };
  }
  if (secretSpecific.length > 0) {
    return {
      ...base,
      locked,
      kind: "secret",
      secret: { mode: "specific", secretIds: secretSpecific, level: "project" },
    };
  }
  if (networkT && networkT.kind === "network") {
    return {
      ...base,
      locked,
      kind: "network",
      hostPattern: networkT.hostPattern,
      pathPattern: networkT.pathPattern ?? "",
      method: networkT.method ?? ANY_METHOD,
    };
  }
  return { ...base, locked };
};

export interface PolicyRuleFormProps {
  scope: PageScope;
  /** The rule being edited, or null to create a new one. */
  rule: PolicyRuleV2 | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The editor's create/edit surface: a right-side drawer for a single custom rule
 * (agent identity + a network / app / secret target + Allow/Block + independent
 * approval/rate-limit modifiers + conditions). Edits the DRAFT; the parent's
 * Publish applies. An app/connection/secret target gates its hosts (permit on
 * allow, block on block) and, on an allow, names the credential(s) to inject.
 */
export const PolicyRuleForm = ({
  scope,
  rule,
  open,
  onOpenChange,
}: PolicyRuleFormProps) => {
  const isEdit = rule !== null;
  // Agents are project-scoped; at org scope there's no project context to load
  // them (and org guardrails apply to all agents — agent groups arrive step 6).
  const isProject = scope === "project";
  const { data: agents = [] } = useAgents(isProject);
  const { data: connections = [] } = useConnections(scope);
  // Scope-aware secrets for the Secret target picker: the org page reads
  // /v1/org/secrets (the project-scoped /v1/secrets 401s at org scope — no
  // X-Project-Id) and returns the org's/project's OWN secrets (no partner). INERT
  // until POLICY_EDITING_ENABLED flips on.
  const { data: secrets = [] } = useScopedSecrets(scope);
  // A rule may only reference resources OWNED at its own level — a PROJECT rule
  // its project's, an ORG rule the org's (`assertTargetsValid` 422s a cross-level
  // pick). Org resources are governed at the org level, so a project's config
  // never even sees them. Filter both pickers to what's actually saveable.
  const targetScope = isProject ? "project" : "organization";
  const scopedSecrets = secrets.filter((s) => s.scope === targetScope);
  const scopedConnections = connections.filter((c) => c.scope === targetScope);
  const createMutation = useCreatePolicyRule(scope);
  const updateMutation = useUpdatePolicyRule(scope);
  const saving = createMutation.isPending || updateMutation.isPending;

  const nameRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLInputElement>(null);
  const targetKindRef = useRef<HTMLDivElement>(null);

  // Form state — hand-rolled useState, the house convention (no react-hook-form).
  const initial = deriveTarget(rule, connections);
  const [name, setName] = useState(rule?.name ?? "");
  const [nameTouched, setNameTouched] = useState(false);
  const [hostTouched, setHostTouched] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [identities, setIdentities] = useState<ProjectionIdentity[]>(
    rule?.identities ?? [],
  );
  const [targetKind, setTargetKind] = useState<TargetKind>(initial.kind);
  const [hostPattern, setHostPattern] = useState(initial.hostPattern);
  const [pathPattern, setPathPattern] = useState(initial.pathPattern);
  const [method, setMethod] = useState<string>(initial.method);
  const [appTarget, setAppTarget] = useState<AppTargetState>(initial.app);
  const [secretTarget, setSecretTarget] = useState<SecretTargetState>(
    initial.secret,
  );
  // A rule whose targets this single-kind form can't faithfully represent (see
  // `isUnrepresentable`): the target section goes read-only and the targets are
  // preserved untouched on save, never truncated.
  const [targetLocked, setTargetLocked] = useState(initial.locked);
  const [action, setAction] = useState<"allow" | "block">(
    rule?.action ?? "allow",
  );
  const [requireApproval, setRequireApproval] = useState(
    rule?.requireApproval ?? false,
  );
  const [rateLimitOn, setRateLimitOn] = useState(rule?.rateLimit != null);
  const [rateLimit, setRateLimit] = useState(String(rule?.rateLimit ?? 100));
  const [rateWindow, setRateWindow] = useState(
    rule?.rateLimitWindow ?? "minute",
  );
  // Stored conditions were validated as RuleCondition on write; the DTO widens
  // their literal target/operator to strings, so narrow them back on load.
  const [conditions, setConditions] = useState<RuleCondition[]>(
    isSessionPolicy(rule?.conditions)
      ? []
      : ((rule?.conditions ?? []) as RuleCondition[]),
  );
  // Project rules carry at most one agent identity (or none = all agents); the
  // Select below reads/writes it. Org rules use the multi-kind picker directly.
  const projectAgentId = identities.find((i) => i.type === "agent")?.id ?? "";
  // A granular App target: an ALLOW on exactly one specific connection whose
  // resource scope (session policy) is set — its `conditions` carry that policy,
  // not behavioral rules. Drives the payload routing. Gated on `allow` because a
  // Block injects nothing (the API rejects a session policy on a Block); the
  // Resources picker is likewise hidden on a Block.
  const appGranular =
    targetKind === "app" &&
    appTarget.mode === "specific" &&
    appTarget.connectionIds.length === 1 &&
    appTarget.sessionPolicy != null &&
    action === "allow";

  // The form instance is reused across opens; re-seed from the current rule each
  // time the drawer opens (or the edited rule changes) — else Edit shows stale /
  // blank fields and a save would overwrite the rule with them.
  useEffect(() => {
    if (!open) return;
    const d = deriveTarget(rule, connections);
    setName(rule?.name ?? "");
    setNameTouched(false);
    setHostTouched(false);
    setSubmitAttempted(false);
    setIdentities(rule?.identities ?? []);
    setTargetKind(d.kind);
    setHostPattern(d.hostPattern);
    setPathPattern(d.pathPattern);
    setMethod(d.method);
    setAppTarget(d.app);
    setSecretTarget(d.secret);
    setTargetLocked(d.locked);
    setAction(rule?.action ?? "allow");
    setRequireApproval(rule?.requireApproval ?? false);
    setRateLimitOn(rule?.rateLimit != null);
    setRateLimit(String(rule?.rateLimit ?? 100));
    setRateWindow(rule?.rateLimitWindow ?? "minute");
    setConditions(
      isSessionPolicy(rule?.conditions)
        ? []
        : ((rule?.conditions ?? []) as RuleCondition[]),
    );
    // `connections` is intentionally omitted: the seed reconstructs the App
    // target's provider from the connections loaded at open time, but must not
    // re-run (clobbering edits) when React Query later refetches them. The
    // late-resolve effect below backfills a missing provider once they load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule]);

  // The seed reconstructs an App/specific rule's provider from the connections
  // loaded at open time; on a cold cache `useConnections` may resolve AFTER the
  // drawer opens, leaving the provider blank (and the rule unsaveable). Backfill
  // it once connections arrive — but ONLY when it's still empty, so a user's own
  // choice is never clobbered. Infers from ANY selected connection that resolves
  // (not just the first), so it's robust to load order.
  useEffect(() => {
    if (!open || targetKind !== "app" || appTarget.mode !== "specific") return;
    if (appTarget.provider || appTarget.connectionIds.length === 0) return;
    const provider = connections.find((c) =>
      appTarget.connectionIds.includes(c.id),
    )?.provider;
    if (provider) setAppTarget((prev) => ({ ...prev, provider }));
  }, [open, connections, targetKind, appTarget]);

  const nameError = useMemo(() => {
    const trimmed = name.trim();
    if (!trimmed) return "Name is required.";
    if (trimmed.length > 255) return "Name is too long.";
    return null;
  }, [name]);
  // The selected app is cloud-only in this edition (OSS's EE-stub registry):
  // the target would be dead (the OSS gateway's base catalog can't resolve
  // it), so the save locks and AppTargetFields renders the locked callout.
  // A target-locked rule is exempt — its targets are preserved as-is and the
  // save edits modifiers only.
  const appCloudLocked =
    targetKind === "app" && !targetLocked && isCloudOnlyApp(appTarget.provider);
  const targetError = useMemo(() => {
    // A locked rule's targets are read-only and preserved as-is — nothing to
    // validate (and the fieldset is disabled).
    if (targetLocked) return null;
    if (targetKind === "network")
      return hostPattern.trim() ? null : "Host is required.";
    if (targetKind === "secret") {
      // Specific mode needs ≥1 secret; "all" mode always has a level.
      if (secretTarget.mode === "specific")
        return secretTarget.secretIds.length > 0
          ? null
          : "Select at least one secret.";
      return null;
    }
    // App: a provider is required; specific mode needs ≥1 connection, "all" mode
    // always has a level.
    if (!appTarget.provider) return "Select an app.";
    // Cloud-only app: the locked callout owns the messaging (and the save is
    // disabled), so the connection-count error would only mislead.
    if (isCloudOnlyApp(appTarget.provider)) return null;
    if (appTarget.mode === "specific")
      return appTarget.connectionIds.length > 0
        ? null
        : "Select at least one connection.";
    return null;
  }, [targetLocked, targetKind, hostPattern, secretTarget, appTarget]);
  const showNameError = (nameTouched || submitAttempted) && nameError;
  const showTargetError = (hostTouched || submitAttempted) && targetError;
  const showHostError = showTargetError && targetKind === "network";
  // Modifiers are only valid on Allow (mirrors the server's 422).
  const modifiersDisabled = action === "block";
  const isValid = !nameError && !targetError && !appCloudLocked;

  const handleSubmit = async () => {
    setSubmitAttempted(true);
    if (!isValid) {
      // Guide the user to the first field to fix.
      if (nameError) nameRef.current?.focus();
      else if (targetKind === "network") hostRef.current?.focus();
      // App/Secret errors live inside the composite pickers; steer focus to the
      // Target section's active kind tab so it's not left on the Save button.
      else
        targetKindRef.current
          ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
          ?.focus();
      return;
    }
    const chosenMethod = METHODS.find((m) => m === method); // undefined = Any
    // Build the target rows from the chosen kind (fixing the prior always-network
    // build, which silently dropped a non-network target on save). App/Secret
    // "specific" fans out to one connection/secret target per selected id; "all"
    // is a single target carrying the level as `connectionScope`/`secretScope`.
    const targets: PolicyTargetInput[] =
      targetKind === "secret"
        ? secretTarget.mode === "specific"
          ? secretTarget.secretIds.map((id) => ({
              kind: "secret",
              secretId: id,
            }))
          : [{ kind: "secret", secretScope: secretTarget.level }]
        : targetKind === "app"
          ? appTarget.mode === "specific"
            ? appTarget.connectionIds.map((id) => ({
                kind: "connection",
                connectionId: id,
                // Every connection target of the rule carries the same tool
                // narrowing; empty = the connection's whole app.
                ...(appTarget.tools.length ? { tools: appTarget.tools } : {}),
              }))
            : [
                {
                  kind: "app",
                  provider: appTarget.provider,
                  connectionScope: appTarget.level,
                  // Tools narrow which endpoints the rule matches; empty = the
                  // whole app. Injection still covers all connections at the
                  // level (connectionScope is injection-only).
                  ...(appTarget.tools.length ? { tools: appTarget.tools } : {}),
                },
              ]
          : [
              {
                kind: "network",
                hostPattern: hostPattern.trim(),
                ...(pathPattern.trim()
                  ? { pathPattern: pathPattern.trim() }
                  : {}),
                ...(chosenMethod ? { method: chosenMethod } : {}),
              },
            ];
    // Modifiers apply to allowed requests only; Block clears them.
    const approval = action === "allow" && requireApproval;
    const rateOn = action === "allow" && rateLimitOn;
    const rateValue = rateOn ? Math.max(1, Number(rateLimit) || 1) : null;
    const rateWin = rateOn ? rateWindow : null;
    // A granular App target carries its scope in `conditions` as the session-policy
    // object; otherwise conditions are the behavioral (body-contains) rules.
    const finalConditions = (
      appGranular
        ? appTarget.sessionPolicy
        : conditions.length
          ? conditions
          : null
    ) as UpdatePolicyRuleInput["conditions"];

    try {
      if (isEdit) {
        // Update accepts null to clear a previously-set modifier. When the rule's
        // targets are locked (unrepresentable here), OMIT `targets` so the service
        // leaves the existing rows untouched — never truncates them.
        const input: UpdatePolicyRuleInput = {
          name: name.trim(),
          action,
          identities,
          ...(targetLocked ? {} : { targets }),
          conditions: finalConditions,
          requireApproval: approval,
          rateLimit: rateValue,
          rateLimitWindow: rateWin,
        };
        await updateMutation.mutateAsync({ id: rule.id, input });
      } else {
        // Create omits an unset modifier rather than nulling it.
        const input: CreatePolicyRuleInput = {
          name: name.trim(),
          action,
          identities,
          targets,
          requireApproval: approval,
          ...(finalConditions
            ? {
                conditions:
                  finalConditions as CreatePolicyRuleInput["conditions"],
              }
            : {}),
          ...(rateOn && rateWin
            ? { rateLimit: rateValue ?? 1, rateLimitWindow: rateWin }
            : {}),
        };
        await createMutation.mutateAsync(input);
      }
      onOpenChange(false);
    } catch {
      // The mutation hook surfaces the error via a toast; keep the drawer open.
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
      >
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>{isEdit ? "Edit Rule" : "New Rule"}</SheetTitle>
          <SheetDescription>{RULE_SHEET_DESCRIPTION}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto overscroll-contain px-6 py-5">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="rule-name">Name</Label>
            <Input
              id="rule-name"
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setNameTouched(true)}
              placeholder="e.g. Block internal admin API"
              aria-invalid={showNameError ? true : undefined}
              className={cn(showNameError && "border-destructive")}
              autoComplete="off"
              spellCheck={false}
            />
            {showNameError && (
              <p className="text-xs text-destructive" role="alert">
                {nameError}
              </p>
            )}
          </div>

          {/* Applies to */}
          <div className="space-y-1.5">
            <Label htmlFor="rule-agent">Applies to</Label>
            {isProject ? (
              <>
                <Select
                  value={projectAgentId || ALL_AGENTS}
                  onValueChange={(v) =>
                    setIdentities(
                      v === ALL_AGENTS ? [] : [{ type: "agent", id: v }],
                    )
                  }
                >
                  <SelectTrigger id="rule-agent" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_AGENTS}>All agents</SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* Null in EE; the OSS locked-capability hint. */}
                <IdentityLockHint />
              </>
            ) : (
              // Org scope: target directory identities (agent-groups / users /
              // user-groups), or none = all agents in the organization.
              <OrgIdentityPicker
                id="rule-agent"
                value={identities}
                onChange={setIdentities}
              />
            )}
          </div>

          {/* Target */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Target</legend>
            <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
              {targetLocked ? (
                <p className="rounded-md border border-dashed bg-background px-3 py-2 text-xs text-muted-foreground">
                  This rule&apos;s targets were authored outside this editor and
                  can&apos;t be edited here. They&apos;re shown on the rule row
                  and preserved unchanged when you save edits made here.
                </p>
              ) : (
                <>
                  {/* Kind picker: selectable cards, matching the Allow/Block
                      ActionCards below (no segmented track, no shadow). */}
                  <div ref={targetKindRef} className="grid grid-cols-3 gap-2">
                    {(
                      [
                        {
                          kind: "app",
                          icon: <Boxes aria-hidden />,
                          label: "App",
                        },
                        {
                          kind: "secret",
                          icon: <KeyRound aria-hidden />,
                          label: "Secret",
                        },
                        {
                          kind: "network",
                          icon: <Globe aria-hidden />,
                          label: "Network",
                        },
                      ] as const
                    ).map(({ kind, icon, label }) => (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => setTargetKind(kind)}
                        aria-pressed={targetKind === kind}
                        className={cn(
                          "flex items-center justify-center gap-2 rounded-lg border bg-card p-3 text-sm font-medium transition-colors [&_svg]:size-4",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          targetKind === kind
                            ? "border-primary text-foreground"
                            : "text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                        )}
                      >
                        {icon}
                        {label}
                      </button>
                    ))}
                  </div>

                  {targetKind === "app" && (
                    <AppTargetFields
                      value={appTarget}
                      onChange={setAppTarget}
                      connections={scopedConnections}
                      isOrgRule={!isProject}
                      action={action}
                      hasBehavioralConditions={conditions.length > 0}
                      cloudLocked={appCloudLocked}
                      showError={!!showTargetError}
                      error={targetError}
                    />
                  )}

                  {targetKind === "secret" && (
                    <SecretTargetFields
                      value={secretTarget}
                      onChange={setSecretTarget}
                      secrets={scopedSecrets}
                      isOrgRule={!isProject}
                      showError={!!showTargetError}
                      error={targetError}
                    />
                  )}

                  {targetKind === "network" && (
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="rule-host">Host</Label>
                        <Input
                          id="rule-host"
                          ref={hostRef}
                          value={hostPattern}
                          onChange={(e) => setHostPattern(e.target.value)}
                          onBlur={() => setHostTouched(true)}
                          placeholder="api.example.com or *.example.com"
                          aria-invalid={showHostError ? true : undefined}
                          className={cn(
                            "bg-card font-mono text-sm",
                            showHostError && "border-destructive",
                          )}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        {showHostError && (
                          <p className="text-xs text-destructive" role="alert">
                            {targetError}
                          </p>
                        )}
                      </div>
                      <div className="grid grid-cols-[1fr_auto] gap-3">
                        <div className="space-y-1.5">
                          <Label htmlFor="rule-path">Path</Label>
                          <Input
                            id="rule-path"
                            value={pathPattern}
                            onChange={(e) => setPathPattern(e.target.value)}
                            placeholder="/v1/* (any path if blank)"
                            autoComplete="off"
                            spellCheck={false}
                            className="bg-card font-mono text-sm"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="rule-method">Method</Label>
                          <Select value={method} onValueChange={setMethod}>
                            <SelectTrigger
                              id="rule-method"
                              className="w-28 bg-card"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={ANY_METHOD}>Any</SelectItem>
                              {METHODS.map((m) => (
                                <SelectItem key={m} value={m}>
                                  {m}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </fieldset>

          {/* Action */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Action</legend>
            <div className="grid grid-cols-2 gap-3">
              <ActionCard
                selected={action === "allow"}
                onSelect={() => setAction("allow")}
                icon={
                  <ShieldCheck
                    className="size-5 text-emerald-600 dark:text-emerald-400"
                    aria-hidden
                  />
                }
                label="Allow"
                hint="Let the request through"
                tone="emerald"
              />
              <ActionCard
                selected={action === "block"}
                onSelect={() => setAction("block")}
                icon={
                  <ShieldBan className="size-5 text-destructive" aria-hidden />
                }
                label="Block"
                hint="Deny the request"
                tone="destructive"
              />
            </div>

            {/* Modifiers (Allow only) */}
            <div className="space-y-3 rounded-lg border p-3">
              <ModifierRow
                icon={
                  <Hand
                    className="size-4 text-blue-600 dark:text-blue-400"
                    aria-hidden
                  />
                }
                label="Require approval"
                hint="Hold the request until a human approves it"
                checked={requireApproval && !modifiersDisabled}
                disabled={modifiersDisabled}
                onCheckedChange={setRequireApproval}
              />
              <ModifierRow
                icon={
                  <Gauge
                    className="size-4 text-amber-600 dark:text-amber-400"
                    aria-hidden
                  />
                }
                label="Rate limit"
                hint="Cap how often the request may run"
                checked={rateLimitOn && !modifiersDisabled}
                disabled={modifiersDisabled}
                onCheckedChange={setRateLimitOn}
              />
              {rateLimitOn && !modifiersDisabled && (
                <div className="flex items-center gap-2 pl-6">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={1_000_000}
                    step={1}
                    value={rateLimit}
                    onChange={(e) => setRateLimit(e.target.value)}
                    className="w-24 tabular-nums"
                    aria-label="Rate limit count"
                  />
                  <span className="text-sm text-muted-foreground">per</span>
                  <Select
                    value={rateWindow}
                    onValueChange={(v) => {
                      if (v === "minute" || v === "hour" || v === "day")
                        setRateWindow(v);
                    }}
                  >
                    <SelectTrigger
                      className="w-28"
                      aria-label="Rate limit window"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="minute">minute</SelectItem>
                      <SelectItem value="hour">hour</SelectItem>
                      <SelectItem value="day">day</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {modifiersDisabled && (
                <p className="text-xs text-muted-foreground">
                  Approval &amp; rate limits apply to allowed requests only.
                </p>
              )}
            </div>
          </fieldset>

          {/* Conditions — behavioral (body-contains) rules. Hidden for a
              connection target (App → specific): a connection's conditions are its
              granular session policy, authored via "Resources" under the App
              target above, not body-contains rules. */}
          {!(targetKind === "app" && appTarget.mode === "specific") && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Conditions</legend>
              <ConditionBuilder
                conditions={conditions}
                onChange={setConditions}
              />
              {/* Whether conditions gate matching depends on the target: a
                secret, or a WHOLE-app (no-tools) app/connection target, matches
                host-only and ignores conditions; a tool-narrowed target runs
                the tool fan-out, which honors conditions like a network rule
                (so no note is shown then). */}
              {targetKind === "secret" && (
                <p className="text-xs text-muted-foreground">
                  Conditions don&apos;t apply to this target type — it matches
                  its hosts regardless of request content.
                </p>
              )}
              {targetKind === "app" &&
                appTarget.tools.length === 0 &&
                appTarget.mode === "all" && (
                  <p className="text-xs text-muted-foreground">
                    Conditions don&apos;t apply to a whole-app target — it
                    matches the app&apos;s hosts regardless of request content.
                  </p>
                )}
            </fieldset>
          )}
          {/* The Conditions editor is hidden for a specific-connection target, but
              the rule may still carry behavioral conditions (authored earlier or
              via the API). Surface them (read-only) so they aren't invisible —
              they are preserved untouched on save. */}
          {targetKind === "app" &&
            appTarget.mode === "specific" &&
            conditions.length > 0 && (
              <p className="text-xs text-muted-foreground">
                This rule has {conditions.length} request-content condition
                {conditions.length === 1 ? "" : "s"} that aren&apos;t editable
                here — they&apos;re preserved unchanged when you save.
              </p>
            )}
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            loading={saving}
            disabled={appCloudLocked}
          >
            {saving
              ? isEdit
                ? "Saving…"
                : "Creating…"
              : isEdit
                ? "Save Rule"
                : "Create Rule"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

interface ActionCardProps {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
  tone: "emerald" | "destructive";
}

const ActionCard = ({
  selected,
  onSelect,
  icon,
  label,
  hint,
  tone,
}: ActionCardProps) => (
  <button
    type="button"
    onClick={onSelect}
    aria-pressed={selected}
    className={cn(
      "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      selected
        ? tone === "emerald"
          ? "border-emerald-500 bg-emerald-500/5"
          : "border-destructive bg-destructive/5"
        : "hover:bg-muted/50",
    )}
  >
    <div className="flex items-center gap-2">
      {icon}
      <span className="font-medium">{label}</span>
    </div>
    <span className="text-xs text-muted-foreground">{hint}</span>
  </button>
);

interface ModifierRowProps {
  icon: React.ReactNode;
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}

const ModifierRow = ({
  icon,
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: ModifierRowProps) => {
  const id = `mod-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        {icon}
        <div>
          <Label
            htmlFor={id}
            className={cn(disabled && "text-muted-foreground")}
          >
            {label}
          </Label>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
};
