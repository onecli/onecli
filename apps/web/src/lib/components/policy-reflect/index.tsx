// The step-9.7b read-only policy reflections. Since step 10 these are SHARED —
// every edition (OSS included) renders the real reflections that read the v2
// policy engine; the old edition alias/null-stub swap is retired.

export { AppPermissionsReflection } from "./app-permissions-reflection";
export { ConnectionAgentsReflection } from "./connection-agents-reflection";
export { CredentialAccessReflection } from "./credential-access-reflection";

export interface AppPermissionsReflectionProps {
  provider: string;
  appName: string;
  pageScope?: "project" | "organization";
  /** The provider's connections (project + inherited). With ≥2 at project
   * scope the panel offers a per-account selector — decisions bind to the
   * winning connection since step 1, so accounts can genuinely differ. */
  connections?: { id: string; label: string | null }[];
}

export interface ConnectionAgentsReflectionProps {
  connectionId: string;
  connectionLabel: string;
  appName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opened straight off a successful connect: the header reads as success and
   * frames the rows as the setup step, rather than as an audit of an
   * established connection. Same rows, same writes. */
  justConnected?: boolean;
}

export interface CredentialAccessReflectionProps {
  agent: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
