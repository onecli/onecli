"use client";

import { OnePasswordSetup } from "./onepassword-setup";
import { VaultPageFrame } from "./vault-page-frame";

/** The 1Password vault page: its route, and Settings > Apps > Vaults in
 *  the modal (`?settings=apps&vault=onepassword`). */
export const OnePasswordVaultPage = () => (
  <VaultPageFrame
    title="1Password"
    description="Resolve secrets on-demand from 1Password using a service account. Nothing is stored on the server."
  >
    <OnePasswordSetup />
  </VaultPageFrame>
);
