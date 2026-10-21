// The "choose agents" windows over the v2 engine: the post-connect Agent-access
// dialog for an app account (editable since attach-model step 4) and its twin
// for a custom connection. SHARED: every edition (OSS included) renders the
// real reflections; there is no edition swap here.

export { ConnectionAgentsReflection } from "./connection-agents-reflection";
export { SecretAgentsDialog } from "./secret-agents-dialog";

export interface ConnectionAgentsReflectionProps {
  connectionId: string;
  appName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export interface SecretAgentsDialogProps {
  secretId: string;
  secretName: string;
  /** Opened straight after the secret was added: "<name> added", with the
   * success mark and the starts-off-for-everyone copy. Otherwise (its card's
   * Agents button) "<name> agents", stating only what the switches do. */
  justAdded?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
