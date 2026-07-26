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
}

export interface ConnectionAgentsReflectionProps {
  connectionId: string;
  connectionLabel: string;
  appName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export interface CredentialAccessReflectionProps {
  agent: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
