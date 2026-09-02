"use client";

import {
  Ban,
  CircleCheck,
  CircleMinus,
  KeyRound,
  Loader2,
  Plug,
  TriangleAlert,
} from "lucide-react";
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
import { cn } from "@onecli/ui/lib/utils";
import type {
  CredentialAccessStatus,
  CredentialProvenance,
  EffectiveCredentialEntry,
} from "@/lib/api/policy-visibility";
import { useEffectiveCredentials } from "@/lib/api/policy-visibility";
import type { CredentialAccessReflectionProps } from "@/lib/components/policy-reflect";

// The "Credential access" dialog (step 9.7b), framed around EFFECTIVE
// access (the user decision — lead with what the agent can DO under the rules,
// not the raw injection view). Each credential the agent can inject is tagged
// Usable / Limited / Blocked.

const STATUS_META = {
  usable: {
    label: "Usable",
    icon: CircleCheck,
    className:
      "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
  },
  limited: {
    label: "Limited",
    icon: CircleMinus,
    className:
      "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  },
  blocked: {
    label: "Blocked",
    icon: Ban,
    className: "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  },
  unknown: {
    label: "Network only",
    className: "bg-muted text-muted-foreground",
  },
} as const satisfies Record<
  CredentialAccessStatus,
  { label: string; className: string; icon?: typeof CircleCheck }
>;

/** Non-interactive status pill (a span, not a disabled control) with a text
 * label — the effective-access headline for a credential row. */
const StatusPill = ({ status }: { status: CredentialAccessStatus }) => {
  const meta = STATUS_META[status];
  const Icon = "icon" in meta ? meta.icon : undefined;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        meta.className,
      )}
    >
      {Icon && <Icon className="size-3.5" aria-hidden="true" />}
      {meta.label}
    </span>
  );
};

const provenanceLabel = (provenance: CredentialProvenance[]): string[] =>
  provenance.map((p) => {
    if ("redacted" in p) return "Organization rule";
    // Colon (not " · ") inside the ref so the outer " · " join stays clean.
    return `Rule: ${p.rule.name}`;
  });

/** Provider id → display name (the house `getApp().name ?? id` idiom). */
const providerName = (provider: string): string =>
  getApp(provider)?.name ?? provider;

const entryName = (entry: EffectiveCredentialEntry): string =>
  entry.kind === "secret"
    ? entry.name
    : (entry.label ?? providerName(entry.provider));

const entryDetail = (entry: EffectiveCredentialEntry): string | null =>
  entry.kind === "secret"
    ? entry.host
    : entry.label
      ? providerName(entry.provider)
      : null;

const entryKey = (entry: EffectiveCredentialEntry): string =>
  `${entry.kind}:${entry.id}`;

const EntryRow = ({ entry }: { entry: EffectiveCredentialEntry }) => {
  // One truncating line: "host · Assigned · Rule: X" (each part is dot-free).
  const subline = [entryDetail(entry), ...provenanceLabel(entry.provenance)]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-sm leading-tight">{entryName(entry)}</p>
        {subline && (
          <p className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground">
            {subline}
          </p>
        )}
      </div>
      <StatusPill status={entry.status} />
    </div>
  );
};

const Section = ({
  icon: Icon,
  label,
  entries,
  emptyLabel,
}: {
  icon: typeof KeyRound;
  label: string;
  entries: EffectiveCredentialEntry[];
  emptyLabel: string;
}) => (
  <>
    <div className="mt-3 flex items-center gap-2 rounded-md bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground first:mt-0">
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </div>
    {entries.length === 0 ? (
      <p className="py-2.5 text-xs text-muted-foreground">{emptyLabel}</p>
    ) : (
      <div className="divide-y">
        {entries.map((entry) => (
          <EntryRow key={entryKey(entry)} entry={entry} />
        ))}
      </div>
    )}
  </>
);

export const CredentialAccessReflection = ({
  agent,
  open,
  onOpenChange,
}: CredentialAccessReflectionProps) => {
  const {
    data: result,
    isPending,
    isError,
  } = useEffectiveCredentials(agent.id, open);
  const isEmpty =
    !!result && result.secrets.length === 0 && result.connections.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Credential access for {agent.name}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            What this agent can use, decided by Policy rules.
          </DialogDescription>
        </DialogHeader>

        {/* Native max-height scroller (not a Radix ScrollArea, which clips under
            a max-height) so long lists stay reachable. */}
        <div className="max-h-[min(28rem,60vh)] overflow-y-auto overscroll-contain px-6 pb-2">
          {isPending ? (
            <div className="flex items-center justify-center py-10">
              <Loader2
                className="size-5 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
              <span className="sr-only">Loading credential access…</span>
            </div>
          ) : isError ? (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
              Couldn&apos;t load credential access for {agent.name}.
            </div>
          ) : isEmpty ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="flex size-10 items-center justify-center rounded-full bg-muted dark:bg-white/10 dark:border-white/10">
                <KeyRound
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
              </div>
              <div>
                <p className="text-sm font-medium">No credentials yet</p>
                <p className="text-xs text-muted-foreground">
                  No secrets or connections are available to this agent.
                </p>
              </div>
            </div>
          ) : result ? (
            <>
              <Section
                icon={KeyRound}
                label="Secrets"
                entries={result.secrets}
                emptyLabel="No secrets available to this agent."
              />
              <Section
                icon={Plug}
                label="App connections"
                entries={result.connections}
                emptyLabel="No connections available to this agent."
              />
            </>
          ) : null}
        </div>

        {result && !isEmpty && (
          <p className="px-6 pb-2 text-[11px] text-muted-foreground">
            This agent is limited to the credentials above; the rules decide
            what each one can do.
          </p>
        )}

        {/* No "Manage in Policy" escape hatch: the workspace policy page is gone
            (step 6), and this dialog's own rows plus the agent page are where
            credential access is changed now. */}
        <DialogFooter className="border-border/50 border-t px-6 py-4">
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
