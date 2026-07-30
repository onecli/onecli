"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { KeyRound, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import { useSecrets } from "@/hooks/use-secrets";
import { useAgentGrants } from "@/hooks/use-grants";
import { useEffectiveCredentials } from "@/lib/api/policy-visibility";
import { connectionsPath } from "@/lib/navigation";
import { SecretGrantRow } from "./secret-grant-row";

interface SecretGrantsTabProps {
  agentId: string;
  /** "secret" = generic secrets; "llm" = typed LLM keys (type !== "generic" —
   * the counts-service split). One tab component, two filters. */
  kind: "secret" | "llm";
}

const COPY = {
  secret: {
    empty: "No secrets yet",
    hint: "Add a secret first, then give this agent access to it here.",
    cta: "Go to Secrets",
    sub: "/custom",
    loading: "Loading secrets…",
    error: "Couldn't load secrets for this agent.",
  },
  llm: {
    empty: "No LLM keys yet",
    hint: "Add an LLM API key first, then give this agent access to it here.",
    cta: "Go to LLMs",
    sub: "/llms",
    loading: "Loading LLM keys…",
    error: "Couldn't load LLM keys for this agent.",
  },
} as const;

export const SecretGrantsTab = ({ agentId, kind }: SecretGrantsTabProps) => {
  const pathname = usePathname();
  const secretsQuery = useSecrets();
  const grantsQuery = useAgentGrants(agentId);
  const credentialsQuery = useEffectiveCredentials(agentId);
  const copy = COPY[kind];

  if (
    secretsQuery.isPending ||
    grantsQuery.isPending ||
    credentialsQuery.isPending
  ) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2
          className="text-muted-foreground size-5 animate-spin"
          aria-hidden
        />
        <span className="sr-only">{copy.loading}</span>
      </div>
    );
  }
  if (secretsQuery.isError || grantsQuery.isError) {
    return (
      <div
        role="alert"
        className="border-destructive/30 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border px-4 py-3 text-sm"
      >
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        {copy.error}
      </div>
    );
  }

  // Partner-scoped secrets are OUTSIDE the grants fence (a PUT naming one
  // 404s) — they never render as attachable rows.
  const pool = (secretsQuery.data ?? []).filter(
    (s) =>
      s.scope !== "partner" &&
      (kind === "secret" ? s.type === "generic" : s.type !== "generic"),
  );
  if (pool.length === 0) {
    return (
      <Card className="flex flex-col items-center justify-center py-16 text-center">
        <div className="bg-muted mb-4 flex size-12 items-center justify-center rounded-full">
          <KeyRound className="text-muted-foreground size-5" aria-hidden />
        </div>
        <p className="text-sm font-medium">{copy.empty}</p>
        <p className="text-muted-foreground mt-1 max-w-xs text-xs">
          {copy.hint}
        </p>
        <Button variant="outline" size="sm" className="mt-4" asChild>
          <Link href={connectionsPath({ pathname }, copy.sub)}>{copy.cta}</Link>
        </Button>
      </Card>
    );
  }

  const grants = grantsQuery.data;
  const grantedIds = new Set((grants?.secrets ?? []).map((s) => s.secretId));
  const credentialById = new Map(
    (credentialsQuery.data?.secrets ?? []).map((e) => [e.id, e]),
  );

  return (
    <div className="divide-y">
      {pool.map((secret) => {
        const credential = credentialById.get(secret.id);
        const granted = grantedIds.has(secret.id);
        const orgGranted =
          !granted &&
          (credential?.provenance.some((p) => p.scope === "organization") ??
            false);
        return (
          <SecretGrantRow
            key={secret.id}
            agentId={agentId}
            secret={secret}
            granted={granted}
            orgGranted={orgGranted}
            credentialStatus={credential?.status}
          />
        );
      })}
    </div>
  );
};
