"use client";

import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Button } from "@onecli/ui/components/button";

// OSS surfaces for the step-9.7b flag-ON branches (step 9.5). The EE editions
// alias this module to `@/ee/policy-reflect` (next.config.js
// POLICY_REFLECT_ALIASES), which exports the real read-only reflections with
// the SAME names and props. In OSS:
//
// - The per-app panel's write retired at the cutover (the legacy permissions
//   PUT 410s), so its surface is a "managed as policy rules" pointer card.
// - The two equipment surfaces (per-connection agent access, per-agent
//   credential access) KEEP their legacy editors — their writes stay open and
//   flow into the enforced generation through the OSS coherence bridge until
//   step 10 — so `REFLECTIONS_AVAILABLE = false` routes their call sites to
//   the legacy branch, and those two components here are unreachable.

/** Whether the read-only reflection dialogs exist in this edition. Call sites
 * branch `policyEditingEnabled && REFLECTIONS_AVAILABLE` — EE renders the
 * reflections; OSS keeps the (bridge-live) legacy equipment editors. */
export const REFLECTIONS_AVAILABLE = false;

export interface AppPermissionsReflectionProps {
  provider: string;
  appName: string;
  pageScope?: "project" | "organization";
}

/** The OSS per-app surface at editing-on: tool permissions are ordinary
 * policy rules now — point at the console. */
export const AppPermissionsReflection = ({
  appName,
}: AppPermissionsReflectionProps) => (
  <div className="bg-card flex flex-col items-start gap-3 rounded-xl border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
    <div className="flex items-start gap-2.5">
      <ShieldCheck
        className="text-muted-foreground mt-0.5 size-4 shrink-0"
        aria-hidden
      />
      <div>
        <p className="text-sm font-medium">
          Tool permissions are managed as policy rules
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          Allow, block, or require approval for {appName} tools with rules on
          the Policy page.
        </p>
      </div>
    </div>
    <Button asChild variant="outline" size="sm">
      <Link href="/policy">Manage in Policy</Link>
    </Button>
  </div>
);

export interface ConnectionAgentsReflectionProps {
  connectionId: string;
  connectionLabel: string;
  appName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const ConnectionAgentsReflection =
  ({}: ConnectionAgentsReflectionProps) => null;

export interface CredentialAccessReflectionProps {
  agent: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const CredentialAccessReflection =
  ({}: CredentialAccessReflectionProps) => null;
