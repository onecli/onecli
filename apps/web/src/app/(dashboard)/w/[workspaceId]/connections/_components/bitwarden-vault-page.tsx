"use client";

import { BitwardenSetup } from "./bitwarden-setup";
import { VaultPageFrame } from "./vault-page-frame";

/** The Bitwarden vault page: its route, and Settings > Apps > Vaults in
 *  the modal (`?settings=apps&vault=bitwarden`). */
export const BitwardenVaultPage = () => (
  <VaultPageFrame
    title="Bitwarden"
    description="Fetch credentials on-demand from your Bitwarden vault. Nothing is stored on the server."
  >
    <BitwardenSetup />
  </VaultPageFrame>
);
