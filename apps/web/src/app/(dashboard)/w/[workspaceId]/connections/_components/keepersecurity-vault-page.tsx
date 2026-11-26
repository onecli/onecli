"use client";

import { KeeperSecuritySetup } from "./keepersecurity-setup";
import { VaultPageFrame } from "./vault-page-frame";

/** The Keeper Security vault page: its route, and Settings > Apps > Vaults
 *  in the modal (`?settings=apps&vault=keepersecurity`). */
export const KeeperSecurityVaultPage = () => (
  <VaultPageFrame
    title="Keeper Security"
    description="Resolve secrets on-demand from Keeper Secrets Manager. Secret values are never stored on the server."
  >
    <KeeperSecuritySetup />
  </VaultPageFrame>
);
