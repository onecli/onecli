// Policy reflections over the v2 engine: the post-connect Agent-access dialog
// (editable since attach-model step 4) and the read-only agent Credential
// access view. SHARED — every edition (OSS included) renders the real
// reflections; there is no edition swap here.

export { ConnectionAgentsReflection } from "./connection-agents-reflection";
export { CredentialAccessReflection } from "./credential-access-reflection";

export interface ConnectionAgentsReflectionProps {
  connectionId: string;
  appName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export interface CredentialAccessReflectionProps {
  agent: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
