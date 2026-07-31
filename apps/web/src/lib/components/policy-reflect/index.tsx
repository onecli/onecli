// Policy reflections over the v2 engine: the connection Agent-access dialog
// (editable since attach-model step 4) and the read-only agent Credential
// access view. SHARED — every edition (OSS included) renders the real
// reflections; there is no edition swap here.

export { ConnectionAgentsReflection } from "./connection-agents-reflection";
export { CredentialAccessReflection } from "./credential-access-reflection";

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
