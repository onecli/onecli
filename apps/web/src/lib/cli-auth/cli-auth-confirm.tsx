"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { BrandLogo } from "@/lib/components/brand-logo";
import { useCliConnectOptions, useConfirmCliSession } from "./hooks";

interface CliAuthConfirmProps {
  code?: string;
}

export const CliAuthConfirm = ({ code }: CliAuthConfirmProps) => {
  const { data, isPending, isError } = useCliConnectOptions();
  const confirm = useConfirmCliSession();
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );

  if (!code) {
    return (
      <Message
        title="Invalid link"
        description="This authentication link is missing a session code. Re-run the command in your terminal."
      />
    );
  }

  if (confirm.isSuccess) {
    return (
      <Layout>
        <div className="animate-in fade-in zoom-in-95 flex flex-col items-center gap-5 text-center duration-500">
          <div className="bg-brand/10 flex size-16 items-center justify-center rounded-full">
            <Check className="text-brand size-8" strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="font-[family-name:var(--font-serif)] text-3xl font-semibold tracking-tight">
              You&apos;re connected
            </h1>
            <p className="text-muted-foreground mt-2">
              You can close this tab and return to your terminal.
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  if (isPending) {
    return (
      <Layout>
        <div className="flex flex-col items-center gap-4 py-10">
          <div className="text-brand size-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
          <p className="text-muted-foreground text-sm">
            Loading your workspaces…
          </p>
        </div>
      </Layout>
    );
  }

  const orgs = data?.organizations ?? [];
  const orgsWithWorkspaces = orgs.filter((o) => o.workspaces.length > 0);
  const firstOrg = orgsWithWorkspaces[0];

  if (isError || !firstOrg) {
    return (
      <Message
        title={isError ? "Sign in to continue" : "No workspaces yet"}
        description={
          isError
            ? "Sign in to OneCLI, then reopen this link from your terminal."
            : "Create a workspace in the dashboard first, then reopen this link."
        }
        action={
          <Button asChild size="lg" variant="outline">
            <a href="/auth/login">Go to OneCLI</a>
          </Button>
        }
      />
    );
  }

  const activeOrgId = selectedOrgId ?? firstOrg.id;
  const activeOrg =
    orgsWithWorkspaces.find((o) => o.id === activeOrgId) ?? firstOrg;
  const activeWorkspaceId =
    selectedWorkspaceId ?? activeOrg.workspaces[0]?.id ?? null;

  return (
    <Layout>
      <div className="mb-8 text-center">
        <h1 className="font-[family-name:var(--font-serif)] text-4xl font-semibold tracking-tight">
          Connect your terminal
        </h1>
        <p className="text-muted-foreground mt-3 text-lg">
          Choose the workspace this CLI session will connect to.
        </p>
      </div>

      <div className="animate-in fade-in slide-in-from-bottom-2 w-full max-w-sm rounded-2xl border border-border/50 bg-card p-8 duration-500">
        <div className="space-y-5">
          {orgsWithWorkspaces.length > 1 && (
            <Field label="Organization">
              <Select
                value={activeOrgId}
                onValueChange={(v) => {
                  setSelectedOrgId(v);
                  setSelectedWorkspaceId(null);
                }}
              >
                <SelectTrigger className="w-full" aria-label="Organization">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {orgsWithWorkspaces.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          <Field label="Workspace">
            <Select
              value={activeWorkspaceId ?? undefined}
              onValueChange={setSelectedWorkspaceId}
            >
              <SelectTrigger className="w-full" aria-label="Workspace">
                <SelectValue placeholder="Select a workspace" />
              </SelectTrigger>
              <SelectContent>
                {activeOrg.workspaces.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name ?? "Untitled workspace"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {confirm.isError && (
            <p className="text-destructive text-sm">
              {confirm.error instanceof Error
                ? confirm.error.message
                : "Something went wrong. Please try again."}
            </p>
          )}

          <Button
            variant="brand"
            size="lg"
            className="w-full text-base"
            loading={confirm.isPending}
            disabled={!activeWorkspaceId || confirm.isPending}
            onClick={() =>
              activeWorkspaceId &&
              confirm.mutate({ code, workspaceId: activeWorkspaceId })
            }
          >
            {confirm.isPending ? "Connecting…" : "Confirm connection"}
          </Button>
        </div>
      </div>

      <p className="text-muted-foreground mt-6 max-w-xs text-center text-xs">
        Confirming shares this workspace&apos;s API key with your terminal.
      </p>
    </Layout>
  );
};

const Field = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div className="flex flex-col gap-1.5 text-left">
    <span className="text-muted-foreground text-xs font-medium">{label}</span>
    {children}
  </div>
);

const Message = ({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) => (
  <Layout>
    <div className="flex max-w-sm flex-col items-center gap-3 text-center">
      <h1 className="font-[family-name:var(--font-serif)] text-3xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="text-muted-foreground">{description}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  </Layout>
);

const Layout = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-background flex min-h-svh flex-col items-center justify-center px-6 pb-24">
    <BrandLogo />
    {children}
  </div>
);
